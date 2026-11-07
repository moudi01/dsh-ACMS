import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapters/dsh.js';
import { Store } from '../src/core/store.js';

function adapterFixture(policy = { allowedProviders: [], allowedModels: [] }) {
  const store = new Store(':memory:');
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'm1', reasoningEffort: 'low' }) },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async provider => [{ id: 'm1', provider, name: 'M1' }, { id: 'm2', provider, name: 'M2' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [], defaultEffort: null } }),
      stream: async function* () { throw new Error('no stream'); }
    }
  };
  const requests = [];
  const providers = new Map([
    ['spawn', { name: 'spawn', prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true } }],
    ['fork', { name: 'fork', prepareContinuable() {}, inheritsParentContext: true, capabilities: { agentOptions: true, depthLimit: true } }]
  ]);
  const ctx = { get: key => services[key], agents: { create: async () => ({ agent: { id: 'parent' }, dispose: async () => {} }) },
    subagents: { providers, startActivation: async request => { requests.push(request); return { childId: 'child', result: Promise.resolve({ stopReason: 'completed', structured: { outcome: 'completed', summary: 'fixture' } }), dispose: async () => {} }; } } };
  const adapter = new DshAdapter(ctx, { policy: () => policy, store }, '.');
  return { adapter, services, store, requests };
}

test('route details use the selected model and llmProvider per route', async t => {
  const { adapter, services, requests, store } = adapterFixture(); t.after(() => store.close());
  const calls = [];
  services.llm.resolveModelInfo = async (provider, model) => {
    calls.push([provider, model]);
    return { reasoning: { efforts: [{ id: 'low' }, { id: 'max' }], defaultEffort: model === 'm2' ? 'max' : 'low' } };
  };
  const m1 = await adapter.modelDetails({ provider: 'spawn', model: 'm1' });
  const m2 = await adapter.modelDetails({ provider: 'spawn', model: 'm2' });
  assert.equal(m1.reasoning.effective, 'low');
  assert.equal(m2.reasoning.effective, 'max');
  assert.deepEqual(calls, [['deepseek', 'm1'], ['deepseek', 'm2']]);
  assert.equal(m2.llmProvider, 'deepseek');
  const cachedM1 = await adapter.modelDetails({ provider: 'spawn', model: 'm1' });
  assert.equal(cachedM1.reasoning.effective, 'low');
  assert.equal(calls.length, 2, 'an unchanged route reuses its cached details');
  store.transaction(() => store.put('attempts', { id: 'route-consistency', taskId: 't', goalId: 'g', agentId: 'a', kind: 'work', status: 'preparing', contextKey: 'ctx', startedAt: new Date().toISOString(), taskGeneration: 1 }));
  const activation = await adapter.start({ agent: { provider: 'auto', model: '' }, task: { workspace: { path: '.' }, requirements: { model: 'm2' } }, attempt: { id: 'route-consistency', contextKey: 'ctx' }, prompt: 'work', signal: new AbortController().signal });
  await activation.result; await activation.dispose();
  assert.deepEqual(requests[0].request.agentOptions, { provider: 'deepseek', model: 'm2', reasoningEffort: 'max' });
  const saved = store.get('attempts', 'route-consistency');
  assert.equal(saved.selection.chosen.model, 'm2');
  assert.equal(saved.selection.chosen.reasoningEffort, 'max');
  assert.equal(saved.model, 'm2');
  assert.equal(saved.reasoningEffort, 'max');
});

test('preference for an unauthorized entrance reports unauthorized_provider when another entrance offers the model', async t => {
  const { adapter, store } = adapterFixture({ allowedProviders: ['spawn'], allowedModels: [] }); t.after(() => store.close());
  store.transaction(() => store.put('modelPreferences', { id: 'model', order: [{ id: 'pref_fork', model: 'm1', provider: 'fork', llmProvider: 'deepseek' }], updatedBy: { kind: 'owner', id: 'owner' } }));
  const selection = await adapter.select({ provider: 'auto', model: '' });
  assert.equal(selection.status, 'selected');
  assert.equal(selection.chosen.provider, 'spawn');
  assert.equal(selection.binding.mode, 'default');
  const fallback = selection.fallbacks.find(f => f.model === 'm1' && f.provider === 'fork');
  assert.equal(fallback.reason, 'unauthorized_provider');
  assert(!selection.fallbacks.some(f => f.model === 'm1' && f.reason === 'route_mismatch'));
});
