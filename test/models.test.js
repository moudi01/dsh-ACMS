import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapters/dsh.js';
import { initialModelBinding, modelName } from '../src/client/models.js';
import { Store } from '../src/core/store.js';

function setup(policy = { allowedProviders: [], allowedModels: [], maxConcurrent: 4 }) {
  const requests = [];
  const entries = [
    { name: 'unsupported-provider', config: { model: 'gpt-6-astra' }, capabilities: {} },
    { name: 'unregistered-model', config: { model: 'gpt-6-astra' }, capabilities: {} },
    { name: 'fixed-model-provider', config: { model: 'gpt-6.1-sol' }, capabilities: {} },
    { name: 'codex', config: {}, capabilities: {} },
    { name: 'spawn', prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true } },
    { name: 'fork', prepareContinuable() {}, inheritsParentContext: true, capabilities: { agentOptions: true, depthLimit: true } },
  ];
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) },
    llm: { listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'secondary', name: 'Secondary' }], listModels: async provider => [{ id: 'deepseek-flash', provider, name: 'DeepSeek Flash' }], resolveModelInfo: async () => ({}) },
  };
  const ctx = { get: key => services[key], agents: { create: async () => ({ agent: { id: 'parent' }, dispose: async () => {} }) },
    subagents: { providers: new Map(entries.map(p => [p.name, p])), startActivation: async request => { requests.push(request); return { childId: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { outcome: 'completed', summary: 'Fixture' } }), dispose: async () => {} }; } } };
  return { adapter: new DshAdapter(ctx, { policy: () => policy }, '.'), ctx, services, requests };
}
test('native live messages use the real parent and exact child; independent chat streams text without tools', async () => {
  const { adapter, ctx, services } = setup(); const signal = new AbortController().signal;
  const messages = []; ctx.subagents.sendMessage = async (...args) => { messages.push(args); return 'native-receipt'; };
  const agent = { provider: 'spawn', model: 'deepseek-flash', llmProvider: 'deepseek' };
  const activation = await adapter.start({ agent, task: { workspace: { path: '.' } }, attempt: { id: 'a', contextKey: 'context' }, prompt: 'task', signal });
  assert(adapter.canSteer({ id: 'a' }));
  await adapter.steer({ id: 'a', childId: 'child' }, 'new direction', signal);
  assert.equal(messages[0][0], adapter.parent.agent); assert.equal(messages[0][1], 'child');
  await assert.rejects(adapter.steer({ id: 'a', childId: 'another-child' }, 'wrong', signal), { code: 'CHAT_STALE' });
  ctx.agents.get = () => ({ session: { deriveMessages: () => [{ role: 'assistant', id: 'm', content: [{ type: 'text', text: 'public' }, { type: 'reasoning', text: 'private' }] }] } });
  assert.deepEqual(await adapter.taskMessages({ childId: 'child' }), [{ id: 'm', text: 'public' }]);
  await activation.dispose(); assert.equal(adapter.canSteer({ id: 'a' }), false);
  let accepted = 0, observed;
  services.llm.stream = async function* (input) { observed = input; yield { type: 'reasoning-delta', text: 'private' }; yield { type: 'text-delta', text: 'answer' }; yield { type: 'finish', reason: 'stop' }; };
  assert.equal(await adapter.chat({ agent, prompt: 'question', signal, onAccepted: () => accepted++, onText: () => {} }), 'answer');
  assert.deepEqual(observed.tools, []); assert.equal(accepted, 1);
});
test('model catalog deduplicates real model IDs and keeps separate executor/backend routes', async () => {
  const { adapter } = setup(); const catalog = await adapter.modelCatalog();
  assert.deepEqual(catalog.models.map(m => m.id), ['deepseek-flash']);
  assert.equal(catalog.models[0].routes[0].provider, 'spawn');
  assert.equal(catalog.models[0].routes.length, 4);
  assert.equal(catalog.defaultSelection.model, 'deepseek-flash');
  assert(!catalog.models.some(m => m.routes.some(r => r.provider === 'codex')), 'Unspecified Codex defaults must not be guessed');
});
test('unsupported providers are rejected; native model carries exact LLM route', async () => {
  const { adapter, requests } = setup(); const signal = new AbortController().signal;
  const start = agent => adapter.start({ agent, task: { workspace: { path: '.' } }, attempt: { id: 'a', contextKey: 'context' }, prompt: 'Fixture', signal });
  const native = await start({ provider: 'spawn', model: 'deepseek-flash', llmProvider: 'secondary' }); await native.result; await native.dispose();
  assert.deepEqual(requests[0].request.agentOptions, { provider: 'secondary', model: 'deepseek-flash' });
  await assert.rejects(adapter.choose({ provider: 'unsupported-provider', model: 'gpt-6.1-sol' }), { code: 'NO_PROVIDER' });
  await assert.rejects(adapter.choose({ provider: 'spawn', model: 'deepseek-flash', llmProvider: 'removed' }), { code: 'MODEL_UNAVAILABLE' });
});
test('automatic selection respects model/provider restrictions including unsupported fixed models without explicit model', async () => {
  const { adapter } = setup({ allowedProviders: ['unsupported-provider', 'spawn'], allowedModels: ['deepseek-flash'] });
  const selected = await adapter.choose({ provider: 'auto', model: '' }); assert.equal(selected.name, 'spawn'); assert.equal(selected.model, 'deepseek-flash');
  assert.deepEqual((await adapter.modelCatalog()).models.map(m => m.id), ['deepseek-flash']);
  await assert.rejects(adapter.choose({ provider: 'unsupported-provider', model: '' }), { code: 'NO_PROVIDER' });
  await assert.rejects(adapter.choose({ provider: 'fixed-model-provider', model: 'gpt-6.1-sol' }), { code: 'NO_PROVIDER' });
});
test('unavailable catalogs never infer unsupported providers', async () => {
  const { adapter, services } = setup(); services.llm.listModels = async () => { throw new Error('Unavailable'); };
  const catalog = await adapter.modelCatalog(); assert.equal(catalog.warnings.length, 2); assert(!catalog.models.some(m => m.id === 'gpt-6-astra')); assert(catalog.models.some(m => m.id === 'deepseek-flash'));
});
test('unregistered role editors require reselection instead of guessing removed model identities', async () => {
  const { adapter } = setup(); const runtime = { providers: adapter.providers(), modelCatalog: await adapter.modelCatalog() };
  const fixed = initialModelBinding({ id: 'old', provider: 'unregistered-model', model: '' }, runtime);
  assert.equal(fixed.model, ''); assert.equal(fixed.provider, 'unregistered-model');
  assert.equal(initialModelBinding({ id: 'unknown', provider: 'codex' }, runtime).model, '');
  assert.equal(initialModelBinding({ id: 'auto', provider: 'auto', model: '' }, runtime).provider, 'auto');
  assert.equal(modelName({ provider: 'auto' }, runtime), 'deepseek-flash');
});
test('model capabilities distinguish source, task continuity and parent inheritance', async () => {
  const { adapter } = setup(); const catalog = await adapter.modelCatalog();
  const native = catalog.models.find(m => m.id === 'deepseek-flash').routes;
  assert.equal(native.find(r => r.provider === 'spawn').origin, 'internal'); assert.equal(native.find(r => r.provider === 'spawn').persistent, false);
  assert.equal(native.find(r => r.provider === 'fork').inheritsParentContext, true);
});
test('native reasoning metadata is validated and passed to the actual activation', async () => {
  const { adapter, services, requests } = setup();
  services.llm.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' } });
  const agent = { provider: 'spawn', model: 'deepseek-flash', llmProvider: 'deepseek', reasoningEffort: 'low' };
  const details = await adapter.modelDetails(agent); assert.equal(details.reasoning.effective, 'low'); assert.equal(details.reasoning.configured, 'max');
  const activation = await adapter.start({ agent, task: { workspace: { path: '.' } }, attempt: { id: 'reasoning', contextKey: 'reasoning' }, prompt: 'Fixture', signal: new AbortController().signal });
  await activation.result; await activation.dispose(); assert.equal(requests[0].request.agentOptions.reasoningEffort, 'low');
  await assert.rejects(adapter.modelDetails({ ...agent, reasoningEffort: 'invented' }), { code: 'REASONING_UNSUPPORTED' });
});
test('connectivity checks make a real route call, retain failure reasons, disable failed defaults, and can recover', async t => {
  const { adapter, services } = setup(); const store = new Store(':memory:'); t.after(() => store.close()); adapter.company.store = store;
  const input = { provider: 'spawn', model: 'deepseek-flash', llmProvider: 'deepseek' }; let calls = 0;
  services.llm.stream = async function* (request) { calls++; assert.deepEqual(request.tools, []); assert.equal(request.maxTokens, 64); throw new Error('HTTP 401 with secret api_key=do-not-leak'); };
  const failure = await adapter.probeModel(input); assert.equal(calls, 1); assert.equal(failure.status, 'unavailable'); assert(failure.reason.includes('401')); assert(!JSON.stringify(failure).includes('do-not-leak'));
  assert.equal(adapter.activeProbes, 0); await assert.rejects(adapter.choose(input), { code: 'MODEL_UNAVAILABLE' });
  services.llm.stream = async function* () { calls++; yield { type: 'finish', reason: 'stop' }; };
  const success = await adapter.probeModel(input); assert.equal(calls, 2); assert.equal(success.status, 'available'); assert.equal((await adapter.choose(input)).name, 'spawn');
});
test('paired model metadata stays local; only explicit probe runs the external process', async t => {
  const { adapter } = setup(); const store = new Store(':memory:'); t.after(() => store.close()); adapter.company.store = store;
  let calls = 0; adapter.paired = { list: () => [{ id: 'paired:fixture', name: 'Fixture runtime', model: 'gpt-fixture', persistent: true, reasoningEffort: 'high' }], run: async (_id, input) => { calls++; assert.equal(input.mode, 'probe'); assert.equal(input.contextKey, null); return { reasoningEffort: 'xhigh', output: 'OK' }; } };
  const input = { provider: 'paired:fixture', model: 'gpt-fixture' };
  const details = await adapter.modelDetails(input); assert.equal(details.reasoning.effective, 'high'); assert.equal(calls, 0);
  const catalog = await adapter.modelCatalog(); const external = catalog.models.find(m => m.id === 'gpt-fixture').routes[0]; assert.equal(external.origin, 'external'); assert.equal(external.inheritsParentContext, false);
  const result = await adapter.probeModel(input); assert.equal(calls, 1); assert.equal(result.reasoning.effective, 'xhigh');
  await assert.rejects(adapter.choose({ ...input, reasoningEffort: 'low' }), { code: 'REASONING_UNSUPPORTED' });
});
