import test from 'node:test';
import assert from 'node:assert/strict';
import { DshAdapter } from '../src/adapters/dsh.js';
import { Store } from '../src/core/store.js';

function fixture() {
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
  const providers = new Map([
    ['spawn', { name: 'spawn', prepareContinuable() {}, inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true } }],
    ['fork', { name: 'fork', prepareContinuable() {}, inheritsParentContext: true, capabilities: { agentOptions: true, depthLimit: true } }]
  ]);
  const ctx = { get: key => services[key], agents: { create: async () => ({ agent: { id: 'parent' }, dispose: async () => {} }) }, subagents: { providers, startActivation: async () => { throw new Error('not used'); } } };
  const adapter = new DshAdapter(ctx, { policy: () => ({ allowedProviders: [], allowedModels: [] }), store }, '.');
  return { adapter, services, store };
}

test('chat keeps the selected fallback route and its details consistent when a preference is unavailable', async t => {
  const { adapter, services, store } = fixture(); t.after(() => store.close());
  services.llm.resolveModelInfo = async (provider, model) => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'max' }], defaultEffort: model === 'm2' ? 'max' : 'low' } });
  const infoCalls = []; const resolve = services.llm.resolveModelInfo;
  services.llm.resolveModelInfo = async (provider, model, signal) => { infoCalls.push([provider, model]); return resolve(provider, model, signal); };
  const healthKey = adapter.healthKey({ provider: 'spawn', llmProvider: 'deepseek', model: 'm2' });
  store.transaction(() => {
    store.put('modelPreferences', { id: 'model', order: [{ id: 'pref_m2', model: 'm2', provider: 'spawn', llmProvider: 'deepseek' }], updatedBy: { kind: 'owner', id: 'owner' } });
    store.put('modelHealth', { id: healthKey, status: 'unavailable', reason: 'fixture route unavailable', checkedAt: new Date().toISOString() });
  });
  let observed;
  services.llm.stream = async function* (input) { observed = input; yield { type: 'text-delta', text: 'answer' }; yield { type: 'finish', reason: 'stop' }; };
  const text = await adapter.chat({ agent: { provider: 'auto', model: '' }, prompt: 'question', signal: new AbortController().signal, onAccepted: () => {}, onText: () => {} });
  assert.equal(text, 'answer');
  assert.deepEqual(infoCalls, [['deepseek', 'm1']], 'details are read for the selected fallback route only');
  assert.equal(observed.model, 'm1');
  assert.equal(observed.provider, 'deepseek');
  assert.equal(observed.reasoningEffort, 'low', 'the requested depth matches the selected route details');
});
