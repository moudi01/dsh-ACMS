import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DshAdapter } from '../src/adapters/dsh.js';
import { createRoutes } from '../src/host/http.js';
import { SYSTEM } from '../src/core/util.js';
import { modelCostRateUnit, modelCostRatesFile, readModelCostRates } from '../src/runtime/model-cost-rates.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const premium = 'fixture-premium', economy = 'fixture-economy', channel = 'local-prices';
const rate = (uncachedInputMicros, outputMicros) => ({ uncachedInputMicros, outputMicros });
const reasoning = { efforts: [{ id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' };

function sheet({ first = rate('900000', '1200000'), second = rate('400000', '700000'), expiresAt = '2099-01-01T00:00:00Z', scope } = {}) {
  return { schema: 'acms-model-route-rates/1', unit: modelCostRateUnit, source: '本地固定费率测试', expiresAt,
    groups: [{ id: scope === 'task-review' ? 'review-documents' : 'documents', ...(scope ? { scope } : {}),
      provider: 'spawn', llmProvider: channel, reasoningEffort: 'medium',
      models: [{ model: premium, rates: first }, { model: economy, rates: second }] }] };
}

function saveRates(f, content = sheet()) {
  return writeFile(path.join(f.dataDir, modelCostRatesFile), typeof content === 'string' ? content : JSON.stringify(content));
}

async function ownerCommand(f, name, args, status = 200) {
  const command = createRoutes(f).find(route => route.path === '/api/acms/command');
  const response = await command.fetch(new Request('http://localhost/api/acms/command', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, requestId: randomUUID() }),
  }));
  const payload = await response.json();
  assert.equal(response.status, status, JSON.stringify(payload));
  return payload.value ?? payload.error;
}

function fakeNative(f, { beforeDetails, activation } = {}) {
  const calls = [], probes = [];
  const defaultSelection = { provider: channel, model: premium, reasoningEffort: 'medium' };
  const services = {
    agentDefaultModel: { currentSelection: () => defaultSelection },
    llm: {
      listProviders: () => [{ id: channel, name: 'Fixture' }],
      listModels: async provider => [premium, economy].map(id => ({ id, provider, reasoning })),
      resolveModelInfo: async (provider, model) => { await beforeDetails?.(provider, model); return { reasoning }; },
      stream: async function* () { probes.push(true); throw new Error('Route selection must not probe'); },
    },
  };
  const subagent = (name, inheritsParentContext) => ({ name, inheritsParentContext, capabilities: { agentOptions: true, depthLimit: true }, prepareContinuable() {} });
  const ctx = { get: key => services[key],
    agents: { create: async () => ({ agent: { id: 'fixture-parent' }, dispose: async () => {} }) },
    subagents: {
      providers: new Map([['spawn', subagent('spawn', false)], ['fork', subagent('fork', true)]]),
      async startActivation({ request, provider, label }) {
        const taskId = label.split(':')[2];
        calls.push({ taskId, provider, options: request.agentOptions, contextKey: label, cwd: request.cwd });
        const custom = await activation?.(request, calls.length);
        const review = f.store.require('tasks', taskId).kind === 'review';
        const output = { stopReason: 'completed', structured: review ? { outcome: 'reviewed', decision: 'approve', summary: 'Offline review approved' } :
          { outcome: 'completed', artifacts: [{ path: 'report.md' }] } };
        if (!custom && !review) await writeFile(path.join(request.cwd, 'report.md'), '# Offline fixture\n');
        return { childId: 'fixture-' + calls.length, result: Promise.resolve(custom ?? output), dispose: async () => {} };
      },
    },
  };
  const adapter = new DshAdapter(ctx, f.company, f.dataDir, { paired: { list: () => [], close: async () => {} } });
  f.engine.adapter = adapter;
  return { adapter, calls, probes, defaultSelection, services };
}

const selectedAttempt = (f, task, generation = task.generation) => [...f.store.attemptUsageRows('task', task.id)]
  .map(({ attempt }) => attempt).find(attempt => attempt.taskGeneration === generation && attempt.selection);
const finish = (f, task) => until(() => f.store.require('tasks', task.id).status === 'succeeded', undefined, taskWaitDiagnostics(f, task.id));

test('owner opt-in compares native rates through normal dispatch and disablement preserves attempt history', async t => {
  const f = await fixture(t);
  const native = fakeNative(f);
  await saveRates(f);
  const actor = f.command('agent.save', { name: 'Fixture worker', role: 'worker', provider: 'auto' });
  const args = { goalId: f.goal.id, title: 'Owner-scoped document', agentId: actor.id };
  const ordinary = await ownerCommand(f, 'task.create', { ...args, title: 'Usual document' });
  const opted = await ownerCommand(f, 'task.create', { ...args, costRouting: true });
  await f.start();
  await finish(f, ordinary);
  await finish(f, opted);
  assert.equal(ordinary.costRouting, undefined);
  assert.deepEqual(native.calls.map(call => [call.taskId, call.provider, call.options]), [
    [ordinary.id, 'spawn', { provider: channel, model: premium, reasoningEffort: 'medium' }],
    [opted.id, 'spawn', { provider: channel, model: economy, reasoningEffort: 'medium' }],
  ]);
  const priced = selectedAttempt(f, opted);
  assert.equal(priced.selection.costComparison.reason, 'lower-listed-rates');
  assert.deepEqual(priced.selection.costComparison.rates, rate('400000', '700000'));
  assert.equal(priced.selection.costComparison.baseline.reasoningEffort, 'medium');
  assert.equal(priced.selection.costComparison.sourceFingerprint, readModelCostRates(f.dataDir).fingerprint);
  assert.equal(priced.model, economy);
  assert.equal(priced.reasoningEffort, 'medium');
  assert.equal(selectedAttempt(f, ordinary).selection.costComparison, undefined);

  const revised = await ownerCommand(f, 'task.edit', { id: opted.id, patch: { costRouting: false } });
  assert.equal(revised.costRouting, false);
  await finish(f, revised);
  assert.equal(native.calls.at(-1).options.model, premium);
  assert.equal(selectedAttempt(f, revised).selection.costComparison, undefined);
  assert.deepEqual(selectedAttempt(f, opted), priced);
  assert.deepEqual(native.probes, []);
});

test('a manually requested task review compares explicitly scoped rates in its own workspace and context', async t => {
  const f = await fixture(t);
  const native = fakeNative(f);
  const task = f.task({ title: 'Reviewed document', costRouting: true });
  const mixedRates = sheet();
  await saveRates(f, mixedRates);
  await f.start();
  await finish(f, task);

  const ordinary = await ownerCommand(f, 'review.request', { id: task.id });
  await finish(f, ordinary);
  assert.equal(ordinary.costRouting, undefined);
  assert.equal(selectedAttempt(f, ordinary).selection.costComparison, undefined);

  const workRatesOnly = await ownerCommand(f, 'review.request', { id: task.id, costRouting: true });
  await finish(f, workRatesOnly);
  assert.equal(selectedAttempt(f, workRatesOnly).model, premium);
  assert.equal(selectedAttempt(f, workRatesOnly).selection.costComparison.reason, 'unpriced-default');

  mixedRates.groups.push(...sheet({ scope: 'task-review' }).groups);
  await saveRates(f, mixedRates);
  const review = await ownerCommand(f, 'review.request', { id: task.id, costRouting: true });
  await finish(f, review);
  const authorAttempt = selectedAttempt(f, task);
  const reviewAttempt = selectedAttempt(f, review);
  const authorCall = native.calls.find(call => call.taskId === task.id);
  const reviewCall = native.calls.find(call => call.taskId === review.id);
  assert.notEqual(review.agentId, task.agentId);
  assert.equal(review.requirements.isolation, 'independent-review');
  assert.equal(f.store.require('tasks', review.id).passed, true);
  assert.equal(f.store.require('tasks', review.id).workspace.mode, 'review-copy');
  assert.notEqual(reviewCall.cwd, authorCall.cwd);
  assert.notEqual(reviewCall.contextKey, authorCall.contextKey);
  assert.equal(reviewAttempt.reviewContext.source.taskId, task.id);
  assert.equal(reviewAttempt.reviewContext.source.artifactHash, f.store.require('tasks', task.id).artifactHash);
  assert.equal(authorAttempt.selection.costComparison.group, 'documents');
  assert.equal(reviewAttempt.selection.costComparison.group, 'review-documents');
  assert.equal(reviewAttempt.selection.costComparison.reason, 'lower-listed-rates');
  assert.deepEqual([reviewAttempt.provider, reviewAttempt.model, reviewAttempt.reasoningEffort], ['spawn', economy, 'medium']);
  assert.deepEqual(reviewCall.options, { provider: channel, model: economy, reasoningEffort: 'medium' });
  const requested = f.store.page().entries.find(event => event.type === 'review.requested' && event.entityId === review.id);
  assert.equal(requested.actor, 'owner');
  assert.equal(requested.costRouting, true);
  assert.deepEqual(native.probes, []);
});

test('review rate opt-in is owner-only and cannot reconfigure an existing review or a final review', async t => {
  const f = await fixture(t);
  const source = f.task();
  f.store.put('tasks', { ...source, status: 'succeeded', artifactHash: 'fixed-delivery', lastAuthorId: source.agentId });
  assert.throws(() => f.command('review.request', { id: source.id, costRouting: true }, SYSTEM), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('review.request', { id: source.id, costRouting: 'true' }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.command('review.request', { goalId: source.goalId, costRouting: true }), { code: 'INVALID_INPUT' });
  const review = await ownerCommand(f, 'review.request', { id: source.id });
  const duplicate = await ownerCommand(f, 'review.request', { id: source.id, costRouting: true });
  assert.deepEqual(duplicate, review);
  assert.equal(f.store.require('tasks', review.id).costRouting, undefined);
  const final = await ownerCommand(f, 'review.request', { goalId: source.goalId });
  assert.equal(final.reviewScope, 'goal');
  assert.equal(final.costRouting, undefined);
});

test('review rate comparison respects unknown rates, explicit routes, preferences and capabilities', async t => {
  const f = await fixture(t);
  const { adapter, probes } = fakeNative(f);
  const source = f.task();
  f.store.put('tasks', { ...source, status: 'succeeded', artifactHash: 'fixed-delivery', lastAuthorId: source.agentId });
  const review = await ownerCommand(f, 'review.request', { id: source.id, costRouting: true });
  const reviewer = f.store.require('agents', review.agentId);
  const select = async (task = review, agent = reviewer) => (await adapter.inspectTaskRoute(task, agent)).selection;

  await saveRates(f, sheet({ scope: 'task-review', second: null }));
  const unknown = await select();
  assert.equal(unknown.chosen.model, premium);
  assert.equal(unknown.costComparison.reason, 'unknown-rates');
  assert.equal(unknown.costComparison.rates, undefined);
  await saveRates(f, sheet({ scope: 'task-review' }));
  assert.equal((await select()).chosen.model, economy);

  const bound = await select(review, { ...reviewer, model: premium, reasoningEffort: 'high' });
  assert.equal(bound.chosen.model, premium);
  assert.equal(bound.chosen.reasoningEffort, 'high');
  assert.equal(bound.costComparison.reason, 'binding-or-preference');
  await ownerCommand(f, 'model.preferences.set', { order: [{ model: premium }] });
  const preferred = await select();
  assert.equal(preferred.chosen.model, premium);
  assert.equal(preferred.preferenceIndex, 0);
  assert.equal(preferred.costComparison.reason, 'binding-or-preference');
  await ownerCommand(f, 'model.preferences.clear', {});

  const spawn = adapter.ctx.subagents.providers.get('spawn');
  delete spawn.inheritsParentContext;
  const unknownContext = await select();
  assert.equal(unknownContext.chosen.model, premium);
  assert.equal(unknownContext.costComparison.reason, 'protected-task');
  spawn.inheritsParentContext = false;
  f.command('policy.update', { patch: { allowedModels: [premium] } });
  assert.equal((await select()).chosen.model, premium);
  const final = await select({ ...review, reviewScope: 'goal' });
  assert.equal(final.costComparison.reason, 'protected-task');
  const automatic = await select({ ...review, origin: { kind: 'template' } });
  assert.equal(automatic.costComparison.reason, 'protected-task');
  assert.deepEqual(probes, []);
});

test('host rate failures, tied prices and conflicting rate trade-offs keep the stable route', async t => {
  const f = await fixture(t);
  const { adapter, probes, defaultSelection, services } = fakeNative(f);
  const agent = { provider: 'auto', model: '' };
  const task = { id: 'no-execution', kind: 'work', generation: 1, costRouting: true };
  async function observe(reason, sourceState) {
    const result = (await adapter.inspectTaskRoute(task, agent)).selection;
    assert.equal(result.chosen.model, premium);
    assert.equal(result.costComparison.reason, reason);
    assert.equal(result.costComparison.sourceState, sourceState);
    assert.equal(result.costComparison.rates, undefined);
  }
  services.llm.listModels = async provider => [premium, economy].map(id => ({ id, provider, reasoning, cost: rate('0', '0') }));
  await observe('rates-unavailable', 'missing');
  await saveRates(f, '{bad-json');
  await observe('rates-unavailable', 'invalid');
  await saveRates(f, ' '.repeat(65537));
  await observe('rates-unavailable', 'too-large');
  await saveRates(f, sheet({ expiresAt: '2001-01-01T00:00:00Z' }));
  await observe('rates-unavailable', 'expired');
  await saveRates(f, sheet({ expiresAt: '2099-01-01T00:00:00.500Z' }));
  assert.equal(readModelCostRates(f.dataDir).state, 'ready');
  await saveRates(f, sheet({ second: null }));
  await observe('unknown-rates', 'ready');
  const same = rate('1', '1');
  await saveRates(f, sheet({ first: same, second: same }));
  await observe('default-listed-rates', 'ready');
  await saveRates(f, sheet({ first: rate('100', '200'), second: rate('200', '100') }));
  await observe('incomparable-rates', 'ready');
  await saveRates(f);
  services.llm.listModels = async provider => [{ id: premium, provider, reasoning },
    { id: economy, provider, reasoning: { ...reasoning, defaultEffort: 'high' } }];
  await observe('no-comparable-peer', 'ready');
  defaultSelection.reasoningEffort = null;
  services.llm.listModels = async provider => [premium, economy].map(id => ({ id, provider }));
  await observe('unknown-depth', undefined);
  assert.deepEqual(probes, []);
});

test('explicit requirements, preferences, authorization and context protection precede local rate comparison', async t => {
  const f = await fixture(t);
  const { adapter } = fakeNative(f);
  await saveRates(f);
  const agent = { provider: 'auto', model: '' };
  const task = { id: 'option', kind: 'work', generation: 1, costRouting: true };
  const route = async (patch = {}, who = agent) => (await adapter.inspectTaskRoute({ ...task, ...patch }, who)).selection;
  assert.equal((await route()).chosen.model, economy);
  const bound = await route({}, { model: premium, reasoningEffort: 'high' });
  assert.equal(bound.chosen.model, premium);
  assert.equal(bound.chosen.reasoningEffort, 'high');
  assert.equal(bound.costComparison.reason, 'binding-or-preference');
  const required = await route({ requirements: { model: premium, reasoningEffort: 'high', tools: 'required' } });
  assert.equal(required.chosen.reasoningEffort, 'high');
  assert.equal(required.costComparison.reason, 'protected-task');
  for (const patch of [{ kind: 'review' }, { requirements: { continuity: 'preferred' } }, { requirements: { inheritsParentContext: true } }]) {
    const result = await route(patch);
    assert.equal(result.chosen.model, premium);
    assert.equal(result.costComparison.reason, 'protected-task');
  }
  await ownerCommand(f, 'model.preferences.set', { order: [{ model: premium }, { model: economy }] });
  const preferred = await route();
  assert.equal(preferred.chosen.model, premium);
  assert.equal(preferred.preferenceIndex, 0);
  assert.equal(preferred.costComparison.reason, 'binding-or-preference');
  await ownerCommand(f, 'model.preferences.clear', {});
  const spawn = adapter.ctx.subagents.providers.get('spawn');
  delete spawn.inheritsParentContext;
  assert.equal((await route()).costComparison.reason, 'protected-task');
  spawn.inheritsParentContext = false;
  assert.equal((await route()).chosen.model, economy);
  const failed = { provider: 'spawn', llmProvider: channel, model: economy, reasoningEffort: 'medium' };
  f.store.transaction(() => f.store.put('modelHealth', { id: adapter.healthKey(failed), status: 'unavailable', checkedAt: new Date().toISOString() }));
  assert.equal((await route()).chosen.model, premium);
  f.command('policy.update', { patch: { allowedModels: [premium] } });
  assert.equal((await route()).chosen.model, premium);
  f.command('policy.update', { patch: { allowedProviders: ['fork'], allowedModels: [premium, economy] } });
  const allowed = await route();
  assert.equal(allowed.chosen.provider, 'fork');
  assert.equal(allowed.chosen.model, premium);
  assert.equal(allowed.costComparison.reason, 'protected-task');
});

test('agents and their management batches cannot enable owner cost routing', async t => {
  const f = await fixture(t);
  const manager = f.store.require('agents', 'manager');
  const task = f.task({ agentId: manager.id });
  const actor = { kind: 'agent', id: manager.id, goalId: f.goal.id, grants: manager.grants };
  const args = { goalId: f.goal.id, title: 'Unauthorized price scope' };
  assert.throws(() => f.command('task.create', { ...args, costRouting: true }, actor), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('task.edit', { id: task.id, patch: { costRouting: true } }, actor), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('task.create', { ...args, requirements: { costRouting: true } }, actor), { code: 'INVALID_INPUT' });
  f.store.transaction(() => f.store.put('tasks', { ...task, status: 'running' }));
  assert.throws(() => f.company.runActions(actor, { taskId: task.id, generation: task.generation, batchId: 'no-price-grant',
    actions: [{ command: 'task.create', args: { ...args, costRouting: true } }] }), { code: 'OWNER_REQUIRED' });
  assert.equal(f.store.require('tasks', task.id).costRouting, undefined);
  assert.equal(f.store.tasksForGoal(f.goal.id).length, 1);
});

test('local rate evidence does not authorize native execution under a strict amount limit', async t => {
  const f = await fixture(t);
  const native = fakeNative(f);
  await saveRates(f, sheet({ second: rate('0', '0') }));
  const goal = await ownerCommand(f, 'goal.create', { projectId: f.project.id, title: 'Strict amount',
    description: 'Test local listed rates', acceptance: 'Require a trusted per-attempt bound', plan: false, costLimitUsd: '1' });
  const task = await ownerCommand(f, 'task.create', { goalId: goal.id, title: 'Zero listed rates', costRouting: true });
  const agent = f.store.require('agents', task.agentId);
  assert.equal((await native.adapter.inspectTaskRoute(task, agent)).selection.chosen.model, economy);
  await f.start();
  await until(() => f.store.require('tasks', task.id).costBudgetHold?.code === 'COST_BOUND_UNKNOWN',
    undefined, taskWaitDiagnostics(f, task.id));
  assert.equal(f.store.require('tasks', task.id).attempts, 0);
  assert.equal(f.store.list('goalCostAttempts').length, 0);
  assert.deepEqual(native.calls, []);
  assert.deepEqual(native.probes, []);
});

test('changing the local rate file after preflight causes a fresh route before activation', async t => {
  const f = await fixture(t);
  let changed = false;
  const native = fakeNative(f, { beforeDetails: async (_provider, model) => {
    if (model === economy && !changed) {
      changed = true;
      await saveRates(f, sheet({ first: rate('1', '2'), second: rate('2', '3') }));
    }
  } });
  await saveRates(f);
  const task = await ownerCommand(f, 'task.create', { title: 'Check current prices', goalId: f.goal.id, costRouting: true });
  await f.start();
  await finish(f, task);
  assert.equal(changed, true);
  assert.deepEqual(native.calls.map(call => call.options), [{ provider: channel, model: premium, reasoningEffort: 'medium' }]);
  const attempts = [...f.store.attemptUsageRows('task', task.id)].map(r => r.attempt);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].preflightOnly, true);
  assert.equal(f.store.require('tasks', task.id).attempts, 1);
  assert.equal(attempts[0].selection.costComparison.sourceFingerprint, readModelCostRates(f.dataDir).fingerprint);
  assert.deepEqual(native.probes, []);
});

test('the same native task retry retains its eligible route and depth after rates change', async t => {
  const f = await fixture(t);
  const native = fakeNative(f, { activation: async (_request, next) => {
    if (next !== 1) return;
    await saveRates(f, sheet({ first: rate('1', '1'), second: rate('2', '2') }));
    return { stopReason: 'error', diagnostic: 'Recoverable local fixture failure' };
  } });
  await saveRates(f);
  const task = await ownerCommand(f, 'task.create', { title: 'Retain a selected route', goalId: f.goal.id, costRouting: true });
  await f.start();
  await finish(f, task);
  const attempt = selectedAttempt(f, task);
  assert.equal(attempt.selection.costComparison.reason, 'retry-route');
  assert.notEqual(attempt.selection.costComparison.previousAttemptId, attempt.id);
  assert.deepEqual(native.calls.map(call => call.options), Array.from({ length: 2 },
    () => ({ provider: channel, model: economy, reasoningEffort: 'medium' })));
  assert.deepEqual(native.probes, []);
});

test('a native retry rechecks the same-depth route when the DSH default changes after preflight', async t => {
  const f = await fixture(t);
  let changedDuringRetry = false;
  const native = fakeNative(f, {
    beforeDetails: async (_provider, model) => {
      if (model !== economy || native.calls.length !== 1 || changedDuringRetry) return;
      changedDuringRetry = true;
      native.defaultSelection.reasoningEffort = 'high';
    },
    activation: async (_request, next) => {
      if (next !== 1) return;
      native.adapter.metadata.clear();
      return { stopReason: 'error', diagnostic: 'Recoverable local fixture failure' };
    },
  });
  await saveRates(f);
  const task = await ownerCommand(f, 'task.create', { title: 'Revalidate retry depth before dispatch', goalId: f.goal.id, costRouting: true });
  await f.start();
  await finish(f, task);
  assert.equal(changedDuringRetry, true);
  assert.deepEqual(native.calls.map(call => call.options), [
    { provider: channel, model: economy, reasoningEffort: 'medium' },
    { provider: channel, model: premium, reasoningEffort: 'high' },
  ]);
  const attempts = [...f.store.attemptUsageRows('task', task.id)].map(({ attempt }) => attempt);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[1].preflightOnly, true);
  assert.equal(attempts[1].selection.costComparison.reason, 'retry-route');
  assert.equal(attempts[0].selection.costComparison.reason, 'retry-route-unavailable');
  assert.notEqual(attempts[1].selection.costComparison.defaultFingerprint, attempts[0].selection.costComparison.defaultFingerprint);
  assert.equal(f.store.require('tasks', task.id).attempts, 2);
  assert.deepEqual(native.probes, []);
});
