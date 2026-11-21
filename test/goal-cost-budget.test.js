import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBackup, planBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { DshAdapter } from '../src/adapters/dsh.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { Company } from '../src/core/domain.js';
import { reserveGoalCost } from '../src/core/goal-cost-budget.js';
import { Store } from '../src/core/store.js';
import { OWNER, SYSTEM } from '../src/core/util.js';
import { createRoutes } from '../src/host/http.js';
import { Engine } from '../src/runtime/engine.js';
import { Conversations } from '../src/runtime/conversations.js';
import { WorkspaceManager } from '../src/runtime/workspaces.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';
import { simulateFixtureCleanup } from './fixture-trace.js';

function goal(f, costLimitUsd, options = {}) {
  return f.command('goal.create', { projectId: f.project.id, templateId: f.template.id, title: 'Fixed-cost test goal',
    description: 'Isolated execution', acceptance: 'Verify execution', plan: false, costLimitUsd, ...options });
}

function budget(store, goalId) { return store.require('goalCostBudgets', goalId); }
function rows(store) { return store.list('goalCostAttempts'); }
function state(store, task) { return store.require('tasks', task.id); }
function receipt(row, amountMicros, override = {}) {
  return { final: true, authorizationId: row.authorizationId, attemptId: row.id, currency: 'USD', amountMicros,
    receiptId: 'fixture-' + row.id, ...override };
}

function fixedCostAdapter(f, { quoteFor = () => '7', amountFor = () => '3', beforeResult, onDispose, throwOnStart = false } = {}) {
  const primary = f.adapter;
  const calls = [], authorizations = [];
  const route = { provider: 'simulation', model: 'fixed-cost-fixture', llmProvider: 'test-channel', reasoningEffort: null };
  const read = (prefix, attemptId) => {
    try { return JSON.parse(readFileSync(path.join(f.root, prefix + attemptId), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  };
  const save = (prefix, attemptId, value) => writeFileSync(path.join(f.root, prefix + attemptId), JSON.stringify(value));
  const adapter = {
    inspectTaskRoute: () => ({ selection: { status: 'selected', chosen: route } }),
    start: input => primary.start(input),
    reconcile: attempt => read('process-', attempt.id) ?? { status: 'unknown', reason: 'No process proof yet' },
    canSteer: () => true,
    taskCost: {
      id: 'virtual-fixed-cost.v1',
      quote: ({ task, route }) => ({ route, quoteId: 'fixture-rate-v1', currency: 'USD', upperMicros: quoteFor(task) }),
      readReceipt: authorization => read('cost-', authorization.id),
      reconcile: authorization => read('process-', authorization.id),
      async start(input) {
        const { authorization, assertCurrent, task } = input;
        assertCurrent();
        assert.equal(authorization.status, 'reserved');
        assert.deepEqual(authorization.route, route);
        assert.equal(authorization.taskId, task.id);
        authorizations.push(authorization);
        if (throwOnStart) throw new Error('Injected startup exit without an activation');
        assertCurrent();
        calls.push(task.id);
        const activation = await primary.start(input);
        return { ...activation, model: route.model,
          result: activation.result.then(async output => {
            await beforeResult?.(input);
            return output;
          }),
          async dispose() {
            await activation.dispose();
            const cleanup = { authorizationId: authorization.authorizationId, status: 'stopped', cleanupConfirmed: true };
            save('process-', authorization.id, cleanup);
            const amount = amountFor(task);
            if (amount !== null) save('cost-', authorization.id, receipt(authorization, amount));
            onDispose?.();
            return cleanup;
          },
        };
      },
    },
  };
  return { adapter, calls, authorizations, save, route };
}

function waiting(f, task, predicate) {
  return until(() => predicate(state(f.store, task)), undefined, taskWaitDiagnostics(f, task.id));
}

async function scopedCommand(runtime, name, args, requestId, status = 200) {
  const endpoint = createRoutes(runtime).find(route => route.path === '/api/acms/command');
  const value = await endpoint.fetch(new Request('http://localhost/api/acms/command', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args, requestId }) }));
  const body = await value.json();
  assert.equal(value.status, status, JSON.stringify(body));
  return body.value ?? body.error;
}

test('a paid review with rejected evidence settles the same attempt once after confirmed cleanup', async t => {
  const f = await fixture(t);
  const target = goal(f, '0.000020');
  const author = f.task({ goalId: target.id });
  const fixed = fixedCostAdapter(f, { beforeResult: async ({ task, attempt }) => {
    if (task.kind !== 'review') return;
    const { workspacePath } = attempt.reviewContext.evidence[0];
    await unlink(path.join(task.workspace.path, workspacePath));
  } });
  f.engine.adapter = fixed.adapter;
  await f.start();
  await waiting(f, author, task => task.status === 'succeeded');
  const review = f.command('review.request', { id: author.id });
  await until(() => state(f.store, review).status === 'blocked' && budget(f.store, target.id).settledAttempts === 2,
    undefined, taskWaitDiagnostics(f, review.id));
  const attempt = f.store.get('attempts', state(f.store, review).activeAttemptId);
  assert.equal(attempt.reviewResultRejected.code, 'REVIEW_EVIDENCE_CHANGED');
  assert.equal(attempt.cleanupPending, false);
  assert.equal(f.store.require('goalCostAttempts', attempt.id).status, 'settled');
  assert.equal(budget(f.store, target.id).settledMicros, '6');
  assert.equal(f.store.list('verifications').some(row => row.attemptId === attempt.id), false);
  await f.engine.stop(); await f.start();
  assert.equal(budget(f.store, target.id).settledMicros, '6');
  assert.deepEqual(fixed.calls, [author.id, review.id]);
});

test('only owners opt in at creation, and an unpriced planner is held without starting or consuming a retry', async t => {
  const f = await fixture(t), ordinary = f.task();
  f.adapter.inspectTaskRoute = () => ({ selection: { status: 'selected',
    chosen: { provider: 'simulation', model: 'known-unpriced-model', llmProvider: null } } });
  const args = { projectId: f.project.id, title: 'Owner amount', description: 'Authorizes dispatch', acceptance: 'Check proof', costLimitUsd: '0' };
  assert.throws(() => f.command('goal.create', args, SYSTEM), { code: 'OWNER_REQUIRED' });
  assert.throws(() => goal(f, '1.0000001'), { code: 'INVALID_INPUT' });
  assert.equal(f.store.list('goals').length, 1);
  const strict = await scopedCommand(f, 'goal.create', args, 'cost-goal-create');
  const planner = f.store.list('tasks').find(task => task.goalId === strict.id);
  assert.equal(planner.kind, 'plan');
  await f.start();
  await waiting(f, planner, task => task.status === 'blocked' && task.costBudgetHold?.code === 'COST_BOUND_UNKNOWN');
  await waiting(f, ordinary, task => task.status === 'succeeded');
  assert.equal(state(f.store, planner).attempts, 0);
  assert.deepEqual(f.adapter.calls.map(call => call.task.id), [ordinary.id]);
  assert.equal(rows(f.store).length, 0);
  assert.equal(f.store.list('tasks').filter(task => task.goalId === strict.id).length, 1);
  const summary = f.company.snapshot().goals.find(record => record.id === strict.id).costBudget;
  assert.equal(summary.settledAttempts, 0);
  assert.equal(summary.limitMicros, '0');
  assert.equal(f.company.snapshot().goals.find(record => record.id === f.goal.id).costBudget, undefined);
  const extension = { id: strict.id, additionalCostUsd: '0.01' };
  assert.throws(() => f.command('goal.cost_budget.extend', extension, SYSTEM), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('goal.cost_budget.extend', { ...extension, id: f.goal.id }), { code: 'COST_BUDGET_DISABLED' });
  const added = await scopedCommand(f, 'goal.cost_budget.extend', extension, 'one-cost-extension');
  assert.deepEqual(await scopedCommand(f, 'goal.cost_budget.extend', extension, 'one-cost-extension'), added);
  assert.equal(budget(f.store, strict.id).limitMicros, '10000');
  assert.equal(state(f.store, planner).costBudgetHold.code, 'COST_BOUND_UNKNOWN');
});

test('paid planning uses the same ledger, and its confirmed charge can stop implementation from dispatch', async t => {
  const f = await fixture(t, async input => input.task.kind === 'plan' ? {
    outcome: 'planned', summary: 'Plan under a fixed-cost fixture',
    tasks: [{ key: 'required', title: 'Required task', description: 'Build a file', acceptance: 'File exists', dependencies: [],
      importance: 'required', modelBasis: 'Use the fixed model' }],
    costPlan: { acceptanceBasis: 'Verify file', reworkBasis: 'Allow rework' },
  } : defaultSimulation(input));
  const priced = fixedCostAdapter(f, { quoteFor: () => '7', amountFor: () => '7' });
  planEstimates(priced, { amounts: { required: '7' }, acceptance: '0', rework: '0' });
  f.engine.adapter = priced.adapter;
  const target = goal(f, '0.000010', { plan: true });
  const planner = f.store.list('tasks').find(task => task.goalId === target.id && task.kind === 'plan');
  await f.start();
  const plan = await proposalFor(f, target);
  assert.equal(plan.costPlan.status, 'shortfall');
  assert.equal(plan.costPlan.submitted.availableMicros, '3');
  assert(!f.store.list('tasks').some(task => task.goalId === target.id && task.kind === 'work'));
  assert.deepEqual(priced.calls, [planner.id]);
  assert.equal(rows(f.store).length, 1);
  assert.equal(rows(f.store)[0].amountMicros, '7');
  assert.equal(budget(f.store, target.id).settledMicros, '7');
});

test('concurrent work cannot reuse reserved funds and can resume after an exact smaller receipt', async t => {
  const f = await fixture(t), target = goal(f, '0.000010');
  const first = f.task({ goalId: target.id, title: 'First priority', priority: 100 });
  const second = f.task({ goalId: target.id, title: 'Second priority', priority: 80 });
  const { promise: paused, resolve: release } = Promise.withResolvers();
  t.after(release);
  const priced = fixedCostAdapter(f, { beforeResult: ({ signal }) =>
    Promise.race([paused, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]) });
  f.engine.adapter = priced.adapter;
  await f.start();
  const held = await until(() => [first, second].find(task => state(f.store, task).costBudgetHold?.code === 'COST_LIMIT_REACHED'),
    undefined, () => ({ tasks: [first, second].map(task => taskWaitDiagnostics(f, task.id)()), cost: budget(f.store, target.id) }));
  const admitted = [first, second].find(task => task.id !== held.id);
  assert.deepEqual(priced.calls, [admitted.id]);
  assert.equal(state(f.store, held).attempts, 0);
  assert.equal(budget(f.store, target.id).reservedMicros, '7');
  assert.equal(budget(f.store, target.id).settledMicros, '0');
  assert.equal(rows(f.store).length, 1);
  assert.equal(f.store.get('agents', admitted.agentId).provider, 'auto');
  const original = rows(f.store)[0];
  const concurrentReader = new Store(f.store.filename);
  try {
    const attempt = concurrentReader.require('attempts', original.id);
    const bound = { executorId: original.executorId, quoteId: original.quoteId, route: original.route,
      currency: original.currency, upperMicros: original.upperMicros };
    assert.deepEqual(concurrentReader.transaction(() => reserveGoalCost(concurrentReader, attempt, bound, original.route)).authorization, original);
    assert.throws(() => concurrentReader.transaction(() => reserveGoalCost(concurrentReader, attempt,
      { ...bound, quoteId: 'changed-quote' }, original.route)), { code: 'COST_AUTHORIZATION_STALE' });
    assert.equal(budget(concurrentReader, target.id).reservedMicros, '7');
    assert.equal(budget(concurrentReader, target.id).reservedAttempts, 1);
  } finally { concurrentReader.close(); }
  const conversations = new Conversations(f.company, f.engine, priced.adapter, f.dataDir);
  const chat = conversations.open({ agentId: admitted.agentId, taskId: admitted.id });
  assert.equal((await conversations.view(chat.id)).mode, 'restart');
  assert.throws(() => conversations.send({ conversationId: chat.id, text: 'Do not bypass the cost gate',
    mode: 'steer', expectedAttemptId: rows(f.store)[0].id, requestId: 'unreserved-steer' }), { code: 'CHAT_COST_BUDGET' });
  release();
  await waiting(f, held, task => task.status === 'succeeded');
  await until(() => budget(f.store, target.id).settledAttempts === 2, undefined, () => budget(f.store, target.id));
  assert.deepEqual(priced.calls, [admitted.id, held.id]);
  assert.equal(budget(f.store, target.id).reservedMicros, '0');
  assert.equal(budget(f.store, target.id).settledMicros, '6');
  assert.equal(f.store.list('attempts').find(row => row.taskId === held.id && row.preflightOnly).status, 'failed');
  assert(rows(f.store).every(row => f.store.require('attempts', row.id).provider === row.route.provider));
});

test('stale and delayed charges remain reserved through purge, disk restart and repeated receipt reads', async t => {
  const f = await fixture(t), target = goal(f, '0.000007'), task = f.task({ goalId: target.id });
  const priced = fixedCostAdapter(f, { amountFor: () => null });
  f.engine.adapter = priced.adapter;
  await f.start();
  await waiting(f, task, current => current.status === 'succeeded' && rows(f.store)[0]?.status === 'awaiting-receipt');
  const row = rows(f.store)[0], deleted = f.command('task.delete', { id: task.id });
  f.command('task.purge', { id: task.id, confirmTitle: task.title, expectedRevision: deleted.revision });
  assert.equal(f.store.get('attempts', row.id), null);
  await f.engine.stop();

  const reopened = new Store(f.store.filename);
  const company = new Company(reopened);
  const recovered = fixedCostAdapter(f);
  const engine = new Engine(company, recovered.adapter, new WorkspaceManager(f.dataDir, company), { intervalMs: 20 });
  recovered.save('cost-', row.id, receipt(row, '1', { authorizationId: 'another-issued-authorization' }));
  try {
    await engine.start();
    assert.equal(budget(reopened, target.id).reservedMicros, '7');
    assert.equal(budget(reopened, target.id).awaitingReceiptAttempts, 1);
    recovered.save('cost-', row.id, receipt(row, '0'));
    engine.nextCostReceiptCheck = 0;
    engine.kick();
    await until(() => budget(reopened, target.id).settledAttempts === 1, undefined, () => budget(reopened, target.id));
    assert.equal(reopened.require('goalCostAttempts', row.id).amountMicros, '0');
    assert.equal(budget(reopened, target.id).reservedMicros, '0');
    recovered.save('cost-', row.id, receipt(row, '4', { receiptId: 'duplicate-final' }));
    engine.nextCostReceiptCheck = 0;
    await engine.tick();
    assert.equal(budget(reopened, target.id).settledMicros, '0');
    assert.equal(budget(reopened, target.id).settledAttempts, 1);
    assert.deepEqual(recovered.calls, []);
  } finally { await engine.stop(); reopened.close(); }
});

test('a startup failure with no activation keeps its reservation until restart verifies process and charge', async t => {
  const f = await fixture(t), target = goal(f, '0.000007'), task = f.task({ goalId: target.id });
  const priced = fixedCostAdapter(f, { throwOnStart: true });
  f.engine.adapter = priced.adapter;
  await f.start();
  await waiting(f, task, current => current.status === 'reconciling' &&
    f.store.get('attempts', current.activeAttemptId)?.cleanupPending === true);
  const row = rows(f.store)[0];
  assert.equal(row.status, 'reserved');
  f.command('goal.pause', { id: target.id, afterCurrent: true });
  await f.engine.stop();

  const reopened = new Store(f.store.filename), recovered = fixedCostAdapter(f);
  const company = new Company(reopened);
  const engine = new Engine(company, recovered.adapter, new WorkspaceManager(f.dataDir, company), { intervalMs: 20 });
  recovered.save('cost-', row.id, receipt(row, '0'));
  recovered.save('process-', row.id, { authorizationId: row.authorizationId, status: 'stopped', cleanupConfirmed: false });
  try {
    await engine.start();
    assert.equal(reopened.require('goalCostAttempts', row.id).status, 'reserved');
    assert.equal(budget(reopened, target.id).reservedMicros, '7');
    assert.equal(state(reopened, task).status, 'reconciling');
    recovered.save('process-', row.id, { authorizationId: 'foreign-authorization', status: 'stopped', cleanupConfirmed: true });
    company.command(OWNER, 'check-wrong-process-proof', 'task.reconcile', { id: task.id });
    await until(() => reopened.require('attempts', row.id).recovery?.reason === '结束回执未匹配本次金额预留。',
      undefined, () => reopened.require('attempts', row.id).recovery);
    assert.equal(budget(reopened, target.id).reservedMicros, '7');
    recovered.save('process-', row.id, { authorizationId: row.authorizationId, status: 'stopped', cleanupConfirmed: true });
    company.command(OWNER, 'recover-priced-attempt', 'task.reconcile', { id: task.id });
    await until(() => budget(reopened, target.id).settledAttempts === 1, undefined,
      () => ({ cost: budget(reopened, target.id), task: state(reopened, task).status, error: engine.lastError }));
    assert.equal(reopened.require('goalCostAttempts', row.id).amountMicros, '0');
    assert.equal(budget(reopened, target.id).reservedMicros, '0');
    assert.deepEqual(recovered.calls, []);
    assert.equal(reopened.require('goals', target.id).executionControl.state, 'paused');
  } finally { await engine.stop(); reopened.close(); }
});


test('pausing at the reservation commit forbids launch, keeps retry counts and closes the provably unused authorization', async t => {
  const f = await fixture(t), target = goal(f, '0.000007'), task = f.task({ goalId: target.id });
  const priced = fixedCostAdapter(f);
  f.engine.adapter = priced.adapter;
  f.store.events.on('event', event => {
    if (event.type === 'goal.cost_budget.reserved' && event.goalId === target.id) {
      f.command('goal.pause', { id: target.id, afterCurrent: true });
    }
  });
  await f.start();
  await until(() => rows(f.store)[0]?.status === 'settled', undefined, () => budget(f.store, target.id));
  const row = rows(f.store)[0];
  assert.equal(row.source, 'host-no-dispatch');
  assert.equal(row.amountMicros, '0');
  assert.equal(budget(f.store, target.id).reportedAttempts, 0);
  assert.equal(budget(f.store, target.id).reservedMicros, '0');
  assert.equal(state(f.store, task).attempts, 0);
  assert.equal(f.store.require('attempts', row.id).preflightOnly, true);
  assert.equal(f.store.require('goals', target.id).executionControl.state, 'paused');
  assert.deepEqual(priced.calls, []);
});

test('an authenticated overrun is recorded and aborts overlapping attempts without opening repairs', async t => {
  const f = await fixture(t), target = goal(f, '0.000020');
  const first = f.task({ goalId: target.id, title: 'Over-budget fixture' });
  const second = f.task({ goalId: target.id, title: 'Overlapping fixture' });
  const other = f.task();
  const gates = new Map([first, second].map(task => [task.id, Promise.withResolvers()]));
  const priced = fixedCostAdapter(f, { amountFor: task => task.id === first.id ? '9' : '2',
    beforeResult: ({ task, signal }) => Promise.race([gates.get(task.id).promise,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]) });
  f.engine.adapter = priced.adapter;
  await f.start();
  await until(() => priced.calls.length === 2, undefined, () => [first, second].map(task => taskWaitDiagnostics(f, task.id)()));
  gates.get(first.id).resolve();
  await waiting(f, second, task => task.status === 'blocked' && task.costBudgetHold?.code === 'COST_CONTRACT_BREACH');
  await waiting(f, other, task => task.status === 'succeeded');
  await until(() => budget(f.store, target.id).settledAttempts === 2, undefined, () => budget(f.store, target.id));
  const ledger = budget(f.store, target.id);
  assert.equal(ledger.breach.amountMicros, '9');
  assert.equal(ledger.settledMicros, '11');
  assert.equal(ledger.reservedMicros, '0');
  assert.equal(f.company.snapshot().goals.find(record => record.id === target.id).costBudget.availableMicros, '0');
  assert.equal(f.store.list('tasks').filter(task => task.goalId === target.id).length, 2);
  assert.throws(() => f.command('goal.cost_budget.extend', { id: target.id, additionalCostUsd: '1' }), { code: 'COST_CONTRACT_BREACH' });
});


for (const mode of ['denied', 'withdrawn', 'cancelled']) {
  test('a host crash after cost launch is ' + mode + ' leaves capacity free on restart', async t => {
    const f = await fixture(t), target = goal(f, '0.000007');
    const strict = f.task({ goalId: target.id, title: 'Blocked strict task', priority: 100 });
    const independent = f.task({ title: 'Independent task', priority: 50 });
    f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
    const runner = fileURLToPath(new URL('./fixtures/goal-cost-crash.mjs', import.meta.url));
    const terminated = spawnSync(process.execPath, [runner, f.dataDir, target.id, mode], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(terminated.status, 73, terminated.error?.message ?? terminated.stderr);
    const attempt = f.store.list('attempts').find(row => row.taskId === strict.id);
    assert.equal(attempt.preflightOnly, true);
    assert.equal(attempt.cleanupPending, false);
    assert.equal(attempt.status, mode === 'denied' ? 'failed' : 'interrupted');
    assert.equal(state(f.store, independent).status, 'ready');
    assert.equal(state(f.store, strict).attempts, 0);
    assert.equal(budget(f.store, target.id).reservedMicros, '0');
    assert.deepEqual(rows(f.store).map(row => row.source), mode === 'denied' ? [] : ['host-no-dispatch']);

    const dsh = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir);
    let recoveries = 0;
    f.engine.adapter = { start: input => f.adapter.start(input), reconcile: saved => {
      recoveries++;
      return dsh.reconcile(saved);
    } };
    await f.start();
    await waiting(f, independent, task => task.status === 'succeeded');
    assert.equal(recoveries, 0);
    assert.deepEqual(f.adapter.calls.map(call => call.task.id), [independent.id]);
    assert.equal(f.store.list('attempts').find(row => row.id === attempt.id).cleanupPending, false);
    assert.equal(f.store.page(0, 100).entries.filter(event => event.entityId === attempt.id && event.type === 'attempt.cleanup.confirmed').length, 1);
    assert.equal(f.store.get('agents', strict.agentId).status, mode === 'cancelled' ? 'retired' : 'available');
  });
}


test('a stale live host cannot mark paid cleanup after ownership changes at the transaction boundary', async t => {
  const f = await fixture(t), target = goal(f, '0.000007'), task = f.task({ goalId: target.id });
  let disposed = false, checked = 0, transferred = false;
  const priced = fixedCostAdapter(f, { onDispose: () => { disposed = true; } });
  f.engine.adapter = priced.adapter;
  const successor = new Store(f.store.filename);
  const owns = f.store.ownsLease.bind(f.store);
  f.store.ownsLease = (owner, epoch) => {
    const result = owns(owner, epoch);
    if (result && disposed && !f.store.inTransaction && new Error().stack.includes('at Engine.execute')) {
      if (++checked === 2) {
        // Simulate ownership changing just after the stale host's outer read.
        assert.equal(successor.db.prepare("UPDATE leases SET owner='successor', epoch=epoch+1 WHERE resource='scheduler'").run().changes, 1);
        transferred = true;
      }
    }
    return result;
  };
  try {
    await f.start();
    await until(() => transferred && !f.engine.live.size, undefined, () => ({
      transferred, checked, task: taskWaitDiagnostics(f, task.id)(), budget: budget(f.store, target.id), error: f.engine.lastError,
    }));
    const row = rows(f.store)[0];
    assert.equal(row.status, 'reserved');
    assert.equal(budget(f.store, target.id).awaitingReceiptAttempts, 0);
    assert.equal(f.store.require('attempts', row.id).cleanupPending, true);
    assert.equal(budget(f.store, target.id).reservedMicros, '7');
  } finally {
    f.store.ownsLease = owns;
    await f.engine.stop();
    successor.close();
  }
});


function budgetedProposal({ requiredDependsOnOptional = false, allRequired = false } = {}) {
  const node = (key, importance, dependencies = []) => ({ key, title: key, description: 'Prove work for ' + key,
    acceptance: 'A file exists', dependencies, importance, modelBasis: 'Fixed adapter supports the required tools.',
    amountMicros: '0' }); // Untrusted numbers must never become an estimate.
  return { outcome: 'planned', summary: 'Budgeted fixture plan', rationale: 'Only core and validate are necessary.',
    minimumOutcome: 'Core file with independent verification', nonGoals: ['Optional enhancements can wait'],
    costPlan: { acceptanceBasis: 'Run configured evidence checks.', reworkBasis: 'Allow one bounded correction.' },
    tasks: [node('core', 'required', requiredDependsOnOptional ? ['bonus'] : []), node('validate', 'required', ['core']),
      node('bonus', allRequired ? 'required' : 'optional')] };
}

function planEstimates(priced, { amounts = { core: '8', validate: '6', bonus: '25' }, acceptance = '5', rework = '4' } = {}) {
  const calls = [];
  priced.adapter.taskCost.estimatePlan = context => {
    calls.push(context);
    const basis = 'Isolated fixed price source';
    return { currency: 'USD', quoteId: 'fixed-plan-v1',
      acceptance: { micros: acceptance, basis }, rework: { micros: rework, basis },
      tasks: context.tasks.map(({ key }) => ({ key, micros: amounts[key], route: priced.route, basis })) };
  };
  return calls;
}

async function proposalFor(f, target) {
  return until(() => {
    const plan = f.store.list('plans').find(item => item.goalId === target.id && item.approvalStatus !== 'superseded');
    return plan && !f.store.require('attempts', plan.attemptId).cleanupPending ? plan : null;
  }, undefined, () => ({ tasks: f.store.list('tasks').filter(task => task.goalId === target.id).map(task => [task.kind, task.status, task.feedback]),
    plans: f.store.list('plans').filter(item => item.goalId === target.id).map(item => item.approvalStatus), engineError: f.engine.lastError }));
}

function planDecision(plan, action, reason) {
  return { planId: plan.id, fingerprint: plan.fingerprint, generation: plan.generation,
    goalContractVersion: plan.goalContractVersion, action, reason };
}

async function scopedForecast(runtime, goalId, status = 200) {
  const route = createRoutes(runtime).find(item => item.path === '/api/acms/cost/forecast');
  assert.deepEqual(route.methods, ['GET']);
  const response = await route.fetch(new Request(`http://localhost/api/acms/cost/forecast?${new URLSearchParams({ goalId })}`));
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

async function approveForecastPlan(f, target) {
  await f.start();
  const plan = await proposalFor(f, target);
  await until(() => budget(f.store, target.id).settledAttempts === 1, undefined, () => budget(f.store, target.id));
  f.command('company.pause', { afterCurrent: true });
  return scopedCommand(f, 'plan.approval.decide', planDecision(plan, 'approve', 'Approve the fixed-price scope'), 'approve-forecast');
}

test('completion forecast combines concurrent caps, zero estimates and trusted receipts without double counting', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal({ allRequired: true }) : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const parallel = Promise.withResolvers(), finalWork = Promise.withResolvers();
  const priced = fixedCostAdapter(f, {
    quoteFor: task => task.kind === 'plan' ? '4' : task.title === 'validate' ? '1' : '18',
    amountFor: task => task.kind === 'plan' ? '2' : task.title === 'bonus' ? null : '0',
    beforeResult: ({ task }) => task.kind === 'plan' ? null : task.title === 'validate' ? finalWork.promise : parallel.promise,
  });
  t.after(() => { parallel.resolve(); finalWork.resolve(); });
  planEstimates(priced, { amounts: { core: '2', validate: '0', bonus: '3' }, acceptance: '2', rework: '1' });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const initial = await scopedForecast(f, target.id);
  assert.deepEqual(initial.coverage, { selected: 3, unstarted: 3, reserved: 0, delivered: 0, deferred: 0, unknown: 0, outsidePlan: 0 });
  assert.equal(initial.plan.fingerprint, plan.fingerprint);
  assert.equal(initial.ledger.settledMicros, '2');
  assert.equal(initial.unstartedMicros, '5');
  assert.equal(initial.completionMicros, '10');
  assert.equal(initial.headroomMicros, '30');
  assert.equal(initial.acceptance.remainingMicros, '2');
  assert.equal(initial.rework.remainingMicros, '1');
  assert.deepEqual(await scopedForecast(f, f.goal.id), { goalId: f.goal.id, enabled: false });
  assert.equal((await scopedForecast(f, 'not-a-goal', 404)).error.code, 'NOT_FOUND');
  assert.deepEqual(priced.calls, [plan.taskId]); // The reads did not dispatch.

  f.command('company.resume');
  await until(() => priced.calls.length === 3, undefined, () => ({ calls: priced.calls, ledger: budget(f.store, target.id) }));
  const concurrent = await scopedForecast(f, target.id);
  assert.deepEqual(concurrent.coverage, { selected: 3, unstarted: 1, reserved: 2, delivered: 0, deferred: 0, unknown: 0, outsidePlan: 0 });
  assert.equal(concurrent.ledger.reservedMicros, '36');
  assert.equal(concurrent.unstartedMicros, '0');
  assert.equal(concurrent.completionMicros, '41');
  assert.equal(concurrent.completionBasis, 'forecast');
  assert.equal(concurrent.headroomMicros, '-1');
  assert.equal(concurrent.status, 'over-limit');

  parallel.resolve();
  await until(() => priced.calls.length === 4 && budget(f.store, target.id).awaitingReceiptAttempts === 1,
    undefined, () => ({ calls: priced.calls, ledger: budget(f.store, target.id) }));
  const progress = await scopedForecast(f, target.id);
  assert.equal(progress.acceptance.state, 'unknown');
  assert.equal(progress.acceptance.remainingMicros, null);
  assert.equal(progress.rework.remainingMicros, '1');
  assert.equal(progress.completionMicros, null);
  assert.ok(progress.reasons.includes('phase-remaining-unknown'));

  finalWork.resolve();
  await until(() => f.store.require('goals', target.id).status === 'succeeded' &&
    budget(f.store, target.id).reservedAttempts === 1, undefined, () => budget(f.store, target.id));
  const delivered = await scopedForecast(f, target.id);
  assert.equal(delivered.ledger.reportedAttempts, 3);
  assert.equal(delivered.ledger.settledMicros, '2');
  assert.equal(delivered.ledger.reservedMicros, '18');
  assert.equal(delivered.acceptance.remainingMicros, '0');
  assert.equal(delivered.rework.remainingMicros, '0');
  assert.equal(delivered.completionMicros, null);
  assert.equal(delivered.headroomMicros, null);
  assert.equal(delivered.coveredMicros, '20');
  assert.deepEqual(delivered.reasons, ['awaiting-cost-receipt']);
  await f.engine.stop();

  const backup = path.join(f.root, 'forecast-backup'), restoredDir = path.join(f.root, 'forecast-restored');
  await applyBackup(await planBackup({ dataDir: f.dataDir, out: backup }));
  assert.equal((await restoreBackup({ backup, target: restoredDir })).startable, true);
  const restoredStore = new Store(path.join(restoredDir, 'company.db'));
  try {
    const read = await scopedForecast({ ...f, company: new Company(restoredStore) }, target.id);
    const snapshot = ({ asOf, ...fields }) => fields;
    assert.deepEqual(snapshot(read), snapshot(delivered));
  } finally { restoredStore.close(); }
});

test('completion forecast keeps prior retry charges and purged task charges without reusing an original estimate', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const retried = Promise.withResolvers();
  let coreRuns = 0;
  const priced = fixedCostAdapter(f, { beforeResult: ({ task }) => {
    if (task.title !== 'core') return;
    if (++coreRuns === 1) throw new Error('Fixture first execution fails');
    return retried.promise;
  } });
  t.after(() => retried.resolve());
  planEstimates(priced);
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const validate = f.store.require('tasks', plan.nodes.find(node => node.key === 'validate').taskId);
  f.command('company.resume');
  await until(() => coreRuns === 2, undefined, () => ({ calls: priced.calls, ledger: budget(f.store, target.id) }));
  const progress = await scopedForecast(f, target.id);
  assert.equal(progress.ledger.settledMicros, '6');
  assert.equal(progress.ledger.reservedMicros, '7');
  assert.equal(progress.unstartedMicros, '6');
  assert.deepEqual(progress.coverage, { selected: 2, unstarted: 1, reserved: 0, delivered: 0, deferred: 0, unknown: 1, outsidePlan: 0 });
  assert.equal(progress.rework.remainingMicros, null);
  assert.equal(progress.completionMicros, null);
  assert.ok(progress.reasons.includes('retry-or-progress-unknown'));

  retried.resolve();
  await until(() => f.store.require('goals', target.id).status === 'succeeded' &&
    budget(f.store, target.id).settledAttempts === 4, undefined, () => budget(f.store, target.id));
  const done = await scopedForecast(f, target.id);
  assert.equal(done.completionMicros, '12');
  await scopedCommand(f, 'task.delete', { id: validate.id }, 'delete-forecast-task');
  await scopedCommand(f, 'task.purge', { id: validate.id, confirmTitle: validate.title }, 'purge-forecast-task');
  assert.equal(f.store.get('tasks', validate.id), null);
  assert.equal([...f.store.attemptUsageRows('task', validate.id)].length, 0);
  const purged = await scopedForecast(f, target.id);
  assert.equal(purged.ledger.settledMicros, '12');
  assert.equal(purged.ledger.reportedAttempts, 4);
  assert.equal(purged.completionMicros, null);
  assert.ok(purged.reasons.includes('work-changed'));
});

test('completion forecast discloses stale quotations, unpriced new work and changed dependencies', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const priced = fixedCostAdapter(f);
  planEstimates(priced);
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  assert.equal((await scopedForecast(f, target.id)).completionMicros, '26');
  const estimate = priced.adapter.taskCost.estimatePlan;
  priced.adapter.taskCost.estimatePlan = input => ({ ...estimate(input), quoteId: 'fixed-plan-expired' });
  const stale = await scopedForecast(f, target.id);
  assert.equal(stale.plan.state, 'quote-stale');
  assert.equal(stale.completionMicros, null);
  assert.equal(stale.completionBasis, null);
  assert.equal(stale.unstartedMicros, null);
  assert.equal(stale.ledger.settledMicros, '3');
  let extra;
  const writer = new Store(f.store.filename);
  try {
    const otherOwner = new Company(writer);
    priced.adapter.taskCost.estimatePlan = input => {
      extra ??= otherOwner.command(OWNER, 'add-unpriced-work', 'task.create', { goalId: target.id, title: 'Additional owner work' });
      return estimate(input);
    };
    const snapshot = await scopedForecast(f, target.id);
    assert.equal(snapshot.completionMicros, '26');
    assert.equal(snapshot.coverage.outsidePlan, 0);
  } finally {
    writer.close();
    priced.adapter.taskCost.estimatePlan = estimate;
  }
  assert.equal((await scopedForecast(f, target.id)).coverage.outsidePlan, 1);
  const validate = f.store.require('tasks', plan.nodes.find(node => node.key === 'validate').taskId);
  const revised = await scopedCommand(f, 'task.dependencies', { id: validate.id, dependencies: [extra.id] }, 'change-forecast-dependency');
  assert.equal(revised.generation, validate.generation);
  const changed = await scopedForecast(f, target.id);
  assert.equal(changed.completionMicros, null);
  assert.equal(changed.unstartedMicros, '8');
  assert.deepEqual(changed.coverage, { selected: 2, unstarted: 1, reserved: 0, delivered: 0, deferred: 0, unknown: 1, outsidePlan: 1 });
  assert.ok(changed.reasons.includes('unpriced-work'));
  assert.ok(changed.reasons.includes('work-changed'));
  assert.deepEqual(priced.calls, [plan.taskId]);
  const core = f.store.require('tasks', plan.nodes.find(node => node.key === 'core').taskId);
  await scopedCommand(f, 'task.dependencies', { id: validate.id, dependencies: [core.id] }, 'restore-forecast-dependency');
  await scopedCommand(f, 'task.edit', { id: core.id, patch: { acceptance: 'Updated inputs for downstream tasks' } }, 'edit-forecast-input');
  const edited = await scopedForecast(f, target.id);
  assert.equal(edited.coverage.unknown, 2);
  assert.equal(edited.coverage.unstarted, 0);
  assert.equal(edited.unstartedMicros, '0');
});

function optionalFixtureProposal(chain = false) {
  const proposal = budgetedProposal();
  const bonus = proposal.tasks.find(node => node.key === 'bonus');
  bonus.priority = 100;
  if (chain) proposal.tasks.push({ ...bonus, key: 'bonus-next', title: 'bonus-next', dependencies: ['bonus'] });
  return proposal;
}

function optionalDecision(target, plan, seed, taskIds = [seed.id]) {
  return { id: target.id, taskId: seed.id, taskIds, holdAttemptId: seed.costBudgetHold?.attemptId,
    planFingerprint: plan.fingerprint, reason: 'Keep the funded minimum and its checks' };
}

const optionalHold = task => task.costBudgetHold?.code === 'COST_OPTIONAL_DEFERRED';
const planTask = (store, plan, key) => store.require('tasks', plan.nodes.find(node => node.key === key).taskId);

function waitOptionalDecision(store, goalId) {
  const current = () => store.require('goals', goalId).costBudgetDeferralRequest;
  return until(() => ['applied', 'not-applied'].includes(current()?.status) ? current() : null, undefined, current);
}

test('optional dispatch waits for late settlement and resumes from its durable hold after restart', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? optionalFixtureProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const priced = fixedCostAdapter(f, { quoteFor: task => task.title === 'bonus' ? '20' : task.title === 'core' ? '18' : '7',
    amountFor: task => task.title === 'core' ? null : '3' });
  const estimates = { amounts: { core: '8', validate: '6', bonus: '1' } };
  planEstimates(priced, estimates);
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus');
  const validate = planTask(f.store, plan, 'validate');
  f.command('company.resume');
  await waiting(f, bonus, optionalHold);
  await waiting(f, validate, task => task.status === 'succeeded');
  await until(() => budget(f.store, target.id).awaitingReceiptAttempts === 1, undefined, () => budget(f.store, target.id));
  const before = f.store.require('tasks', bonus.id);
  assert.equal(before.costBudgetHold.bound.upperMicros, '20');
  assert.equal(before.attempts, 0);
  assert(!priced.calls.includes(bonus.id));
  assert.equal(budget(f.store, target.id).reservedMicros, '18');
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional', optionalDecision(target, plan, before), 'do-not-defer-late', 409)).code, 'COST_OPTIONAL_PENDING');
  await f.engine.stop();

  const store = new Store(f.store.filename), company = new Company(store);
  const recovered = fixedCostAdapter(f, { quoteFor: task => task.title === 'bonus' ? '20' : '7' });
  planEstimates(recovered, estimates);
  const engine = new Engine(company, recovered.adapter, new WorkspaceManager(f.dataDir, company), { intervalMs: 20 });
  const runtime = { ...f, store, company, engine, adapter: recovered.adapter, workspaces: engine.workspaces };
  try {
    await engine.start();
    await engine.tick();
    assert(optionalHold(store.require('tasks', bonus.id)));
    assert.equal(store.require('tasks', bonus.id).workspace.path, before.workspace.path);
    assert.deepEqual(recovered.calls, []);
    company.command(OWNER, 'settle-before-releasing-optional', 'company.pause', { afterCurrent: true });
    const theHeld = rows(store).find(row => row.status === 'awaiting-receipt');
    recovered.save('cost-', theHeld.id, receipt(theHeld, '3'));
    engine.nextCostReceiptCheck = 0;
    engine.nextOptionalCostCheck = 0;
    engine.kick();
    await until(() => budget(store, target.id).awaitingReceiptAttempts === 0, undefined, () => budget(store, target.id));
    assert.equal((await scopedCommand(runtime, 'goal.cost_budget.defer_optional', optionalDecision(target, plan, before),
      'refuse-after-late-budget-release', 409)).code, 'COST_OPTIONAL_STALE');
    company.command(OWNER, 'allow-released-optional', 'company.resume');
    engine.kick();
    await until(() => store.require('goals', target.id).status === 'succeeded' && budget(store, target.id).settledAttempts === 4,
      undefined, () => ({ ledger: budget(store, target.id), bonus: state(store, bonus), error: engine.lastError }));
    assert.deepEqual(recovered.calls, [bonus.id]);
    assert.equal(budget(store, target.id).limitMicros, '40');
    assert.equal(budget(store, target.id).settledMicros, '12');
    assert.equal(store.require('tasks', bonus.id).costBudgetHold, null);
    assert.equal(store.activityPage({ goalId: target.id }).entries.filter(event => event.type === 'goal.cost_budget.optional_deferred').length, 0);
  } finally { await engine.stop(); store.close(); }
});

test('a required task with no currently certified cap keeps optional work waiting instead of spending its estimate', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? optionalFixtureProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  let certified = false;
  const priced = fixedCostAdapter(f, { quoteFor: task => task.title === 'core' && !certified ? undefined : '7' });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1' } });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus'), core = planTask(f.store, plan, 'core');
  await scopedCommand(f, 'task.pause', { id: bonus.id }, 'wait-for-required-pricing');
  f.command('company.resume');
  await waiting(f, core, task => task.costBudgetHold?.code === 'COST_BOUND_UNKNOWN');
  await scopedCommand(f, 'task.resume', { id: bonus.id }, 'ask-to-recheck-optional');
  await waiting(f, bonus, task => optionalHold(task) && task.costBudgetHold.reasonCode === 'coverage-unknown');
  assert.deepEqual(priced.calls, [plan.taskId]);
  assert.equal(state(f.store, bonus).costBudgetHold.balance.requiredMicros, null);
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional', optionalDecision(target, plan, state(f.store, bonus)),
    'refuse-unknown-required-cost', 409)).code, 'COST_OPTIONAL_STALE');
  certified = true;
  await scopedCommand(f, 'task.resume', { id: core.id }, 'verify-required-price');
  await until(() => f.store.require('goals', target.id).status === 'succeeded' && budget(f.store, target.id).reservedAttempts === 0,
    undefined, () => ({ ledger: budget(f.store, target.id), goal: f.store.require('goals', target.id), error: f.engine.lastError }));
  assert(priced.calls.indexOf(core.id) < priced.calls.indexOf(bonus.id));
  assert.equal(budget(f.store, target.id).limitMicros, '40');
});

test('owner can defer the unstarted optional chain and deliver the approved required candidate and review', async t => {
  let reviewed;
  const f = await fixture(t, async input => {
    const { task } = input;
    if (task.kind === 'plan') return optionalFixtureProposal(true);
    if (task.kind === 'review') {
      reviewed = task.reviewTargets.map(target => target.id).sort();
      assert.equal(await readFile(path.join(task.workspace.path, 'core.txt'), 'utf8'), 'core');
      assert.equal(await readFile(path.join(task.workspace.path, 'validate.txt'), 'utf8'), 'validate');
      await assert.rejects(readFile(path.join(task.workspace.path, 'bonus.txt')), { code: 'ENOENT' });
      return defaultSimulation(input);
    }
    await writeFile(path.join(task.workspace.path, task.title + '.txt'), task.title);
    return { outcome: 'completed', summary: 'A fixture output', artifacts: [{ path: task.title + '.txt' }] };
  });
  const check = "const fs=require('node:fs'); if(fs.existsSync('validate.txt')&&!fs.existsSync('core.txt'))process.exit(8)";
  f.command('project.save', { id: f.project.id, planApproval: true, checks: [{ id: 'joint', command: process.execPath, args: ['-e', check] }] });
  simulateFixtureCleanup(f.workspaces);
  const target = goal(f, '0.000035', { plan: true, templateId: 'base', deliveryMode: 'copy-composite' });
  const priced = fixedCostAdapter(f, { quoteFor: task => task.title === 'bonus' ? '20' : '7',
    amountFor: task => task.kind === 'work' ? '4' : '3' });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1', 'bonus-next': '1' } });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus'), next = planTask(f.store, plan, 'bonus-next');
  const work = ['core', 'validate'].map(key => planTask(f.store, plan, key));
  f.command('company.resume');
  await waiting(f, bonus, optionalHold);
  await until(() => work.every(task => state(f.store, task).status === 'succeeded') && budget(f.store, target.id).reservedAttempts === 0,
    45000, () => ({ ledger: budget(f.store, target.id), work: work.map(task => taskWaitDiagnostics(f, task.id)()), error: f.engine.lastError }));
  assert.equal(priced.calls.length, 3);
  assert.equal(f.company.latestGoalReview(target.id), null);
  const before = f.company.deliveryHash(target.id);
  const held = state(f.store, bonus);
  const partial = await scopedCommand(f, 'goal.cost_budget.defer_optional', optionalDecision(target, plan, held), 'refuse-truncated-chain', 409);
  assert.equal(partial.code, 'COST_OPTIONAL_STALE');
  const args = optionalDecision(target, plan, held, [bonus.id, next.id]);
  assert.throws(() => f.command('goal.cost_budget.defer_optional', args, SYSTEM), { code: 'OWNER_REQUIRED' });
  await scopedCommand(f, 'task.pause', { id: next.id }, 'independent-optional-pause');
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'preserve-paused-optional', 409)).code, 'COST_OPTIONAL_SCOPE');
  assert.equal(state(f.store, next).status, 'paused');
  await scopedCommand(f, 'task.resume', { id: next.id }, 'restore-optional-before-decision');
  const queued = await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'defer-chain');
  assert.equal(queued.costBudgetDeferralRequest.status, 'queued');
  assert.equal((await waitOptionalDecision(f.store, target.id)).status, 'applied');
  assert.equal(state(f.store, bonus).status, 'deferred');
  assert.equal(state(f.store, bonus).workspace.path, held.workspace.path);
  assert.equal(state(f.store, next).status, 'deferred');
  assert.notEqual(f.company.deliveryHash(target.id), before);
  assert.equal((await scopedCommand(f, 'task.resume', { id: bonus.id }, 'no-reopening', 409)).code, 'COST_OPTIONAL_SCOPE');
  await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'defer-chain');
  await until(() => f.store.require('goals', target.id).status === 'succeeded' && budget(f.store, target.id).settledAttempts === 4,
    45000, () => ({ goal: f.store.require('goals', target.id), reviews: f.store.list('tasks').filter(task => task.kind === 'review'), error: f.engine.lastError }));
  const completed = f.store.require('goals', target.id);
  assert.deepEqual(reviewed, work.map(task => task.id).sort());
  assert.deepEqual(completed.composition.inputs.map(row => row.taskId).sort(), reviewed);
  assert.equal(f.company.latestGoalReview(target.id).deliveryHash, completed.completedDeliveryHash);
  assert.equal(completed.acceptance, target.acceptance);
  assert.equal(completed.contractVersion, target.contractVersion);
  assert.equal(budget(f.store, target.id).limitMicros, '35');
  const forecast = await scopedForecast(f, target.id);
  assert.equal(forecast.coverage.deferred, 2);
  assert.equal(forecast.completionMicros, '14');
  const decisions = f.store.activityPage({ goalId: target.id }).entries.filter(event => event.type === 'goal.cost_budget.optional_deferred');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].data.costBasis.bound.upperMicros, '20');
  assert.deepEqual(priced.calls.slice(0, 3), [plan.taskId, ...work.map(task => task.id)]);
  const checked = [...f.store.attemptUsageRows('task', bonus.id)].filter(({ attempt }) => attempt.costDeferralRequestId);
  assert.equal(checked.length, 1);
  assert.equal(checked[0].attempt.preflightOnly, true);
  assert.equal(f.store.get('goalCostAttempts', checked[0].attempt.id), null);

  for (const step of ['delete', 'restore', 'delete', 'purge']) {
    await scopedCommand(f, 'task.' + step, { id: next.id, ...(step === 'purge' ? { confirmTitle: next.title } : {}) }, randomUUID());
    const refreshed = await scopedForecast(f, target.id);
    assert.equal(refreshed.completionMicros, '14');
    assert.equal(refreshed.coverage.deferred, 2);
    assert.equal(f.company.deliveryHash(target.id), completed.completedDeliveryHash);
  }
  assert.equal(f.store.get('tasks', next.id), null);
  assert.equal(f.store.activityPage({ goalId: target.id }).entries.filter(event => event.type === 'goal.cost_budget.optional_deferred').length, 1);
});

test('editing an approved optional task preserves budget protection but invalidates its strict deferral eligibility', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? optionalFixtureProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const priced = fixedCostAdapter(f, { quoteFor: task => task.title === 'bonus' ? '29' : '7',
    amountFor: task => task.title === 'bonus' ? '29' : '3' });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1' } });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus'), core = planTask(f.store, plan, 'core');
  const validate = planTask(f.store, plan, 'validate');
  await scopedCommand(f, 'task.pause', { id: core.id }, 'hold-core-during-edit');
  f.command('company.resume');
  await waiting(f, bonus, optionalHold);
  await scopedCommand(f, 'task.edit', { id: bonus.id, patch: { description: 'Clarify the same optional output' } }, 'clarify-optional-scope');
  await waiting(f, bonus, current => current.generation === 2 && optionalHold(current));
  assert.equal(budget(f.store, target.id).settledMicros, '3');
  assert(!priced.calls.includes(bonus.id));
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional',
    optionalDecision(target, plan, state(f.store, bonus)), 'invalid-edited-scope', 409)).code, 'COST_OPTIONAL_SCOPE');
  await scopedCommand(f, 'task.resume', { id: core.id }, 'release-funded-minimum');
  await waiting(f, validate, task => task.status === 'succeeded');
  assert.deepEqual(priced.calls, [plan.taskId, core.id, validate.id]);
  assert.equal(budget(f.store, target.id).limitMicros, '40');
  assert(optionalHold(state(f.store, bonus)));
});

test('owner deferral confirmation obtains a current cap without launching and preserves newly affordable work', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? optionalFixtureProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000035', { plan: true });
  let cap = '20';
  const checked = [];
  const priced = fixedCostAdapter(f, { quoteFor: task => {
    if (task.title !== 'bonus') return '7';
    checked.push(cap);
    return cap;
  }, amountFor: task => task.kind === 'work' ? '4' : '3' });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1' } });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus'), validate = planTask(f.store, plan, 'validate');
  f.command('company.resume');
  await waiting(f, bonus, optionalHold);
  await waiting(f, validate, task => task.status === 'succeeded');
  await until(() => budget(f.store, target.id).reservedAttempts === 0, undefined, () => budget(f.store, target.id));
  const args = optionalDecision(target, plan, state(f.store, bonus));
  const original = f.workspaces.prepare.bind(f.workspaces);
  f.workspaces.prepare = (task, attempt) => {
    if (attempt.costDeferralRequestId) throw new Error('Test preparation unavailable');
    return original(task, attempt);
  };
  await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'check-preparation-unavailable');
  assert.match((await waitOptionalDecision(f.store, target.id)).result, /核价准备未完成/);
  assert(!priced.calls.includes(bonus.id));

  const preparing = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.workspaces.prepare = async (task, attempt) => {
    if (attempt.costDeferralRequestId) {
      preparing.resolve(attempt.id);
      await release.promise;
    }
    return original(task, attempt);
  };
  await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'check-while-owner-pauses');
  const pausedAttempt = await preparing.promise;
  await scopedCommand(f, 'goal.pause', { id: target.id, afterCurrent: true }, 'pause-optional-verification');
  release.resolve();
  assert.equal((await waitOptionalDecision(f.store, target.id)).status, 'not-applied');
  await until(() => f.store.require('attempts', pausedAttempt).cleanupPending === false, undefined, taskWaitDiagnostics(f, bonus.id));
  assert(!priced.calls.includes(bonus.id));
  f.workspaces.prepare = original;
  await scopedCommand(f, 'goal.resume', { id: target.id }, 'resume-optional-verification');

  cap = undefined;
  await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'check-unknown-cap');
  assert.match((await waitOptionalDecision(f.store, target.id)).result, /上界无法核实/);
  assert(!priced.calls.includes(bonus.id));
  cap = '5';
  const requested = await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'check-cheaper-cap');
  const result = await waitOptionalDecision(f.store, target.id);
  assert.equal(result.id, requested.costBudgetDeferralRequest.id);
  assert.equal(result.status, 'not-applied');
  assert.match(result.result, /足够余量/);
  assert.deepEqual(checked, ['20', undefined, '5']);
  assert.equal(state(f.store, bonus).costBudgetHold.bound.upperMicros, '5');
  assert.equal(state(f.store, bonus).attempts, 0);
  assert.equal(budget(f.store, target.id).settledMicros, '11');
  assert(!priced.calls.includes(bonus.id));
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'check-cheaper-cap')).costBudgetDeferralRequest.id, result.id);
  await scopedCommand(f, 'task.resume', { id: bonus.id }, 'approve-normal-dispatch-after-verification');
  await waiting(f, bonus, task => task.status === 'succeeded');
  assert.equal(priced.calls.filter(id => id === bonus.id).length, 1);
  assert.equal(priced.authorizations.find(row => row.taskId === bonus.id).upperMicros, '5');
  assert.equal(budget(f.store, target.id).limitMicros, '35');
});

async function prepareOptionalQuoteCrash(t, beforePause = () => {}) {
  const f = await fixture(t, input => input.task.kind === 'plan' ? optionalFixtureProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000035', { plan: true });
  const priced = fixedCostAdapter(f, { quoteFor: task => task.title === 'bonus' ? '20' : '7',
    amountFor: task => task.kind === 'work' ? '4' : '3' });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1' } });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus'), validate = planTask(f.store, plan, 'validate');
  f.command('company.resume');
  await waiting(f, bonus, optionalHold);
  await waiting(f, validate, task => task.status === 'succeeded');
  await until(() => budget(f.store, target.id).reservedAttempts === 0, undefined, () => budget(f.store, target.id));
  f.command('company.pause', { afterCurrent: true });
  beforePause(f);
  const args = optionalDecision(target, plan, state(f.store, bonus));
  const request = (await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'queue-before-host-exit')).costBudgetDeferralRequest;
  assert.equal(request.status, 'queued');
  await f.engine.stop();
  const runner = fileURLToPath(new URL('./fixtures/goal-cost-crash.mjs', import.meta.url));
  const run = (mode, exitCode) => {
    const terminated = spawnSync(process.execPath, [runner, f.dataDir, target.id, mode], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(terminated.status, exitCode, terminated.error?.message ?? terminated.stderr);
  };
  return { f, target, priced, plan, bonus, validate, args, request, run };
}

test('a host crash while preparing a quote expires the decision without a paid claim or a retry', async t => {
  const { f, target, priced, plan, bonus, validate, args, request, run } = await prepareOptionalQuoteCrash(t);
  run('optional-quote', 73);
  const attempt = f.store.list('attempts').find(row => row.costDeferralRequestId === request.id);
  assert.equal(attempt.status, 'preparing');
  assert.equal(state(f.store, bonus).attempts, 0);
  await f.start();
  const result = await waitOptionalDecision(f.store, target.id);
  assert.equal(result.status, 'not-applied');
  assert.match(result.result, /宿主重启/);
  assert.equal(f.store.require('attempts', attempt.id).cleanupPending, false);
  assert(optionalHold(state(f.store, bonus)));
  assert.deepEqual(priced.calls, [plan.taskId, planTask(f.store, plan, 'core').id, validate.id]);
  assert.equal(budget(f.store, target.id).settledMicros, '11');
  assert.equal(f.store.get('goalCostAttempts', attempt.id), null);
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional', args, 'queue-before-host-exit')).costBudgetDeferralRequest.id, request.id);
  assert.equal(f.store.list('attempts').filter(row => row.costDeferralRequestId === request.id).length, 1);
});

test('a recovered quote cleanup and its request survive another crash at receipt removal', { skip: process.platform !== 'win32' }, async t => {
  let independent;
  const { f, target, priced, bonus, request, run } = await prepareOptionalQuoteCrash(t, f => {
    f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
    independent = f.task({ title: 'Work waiting for the one occupied slot' });
  });
  run('optional-quote-check', 73);
  const attempt = f.store.list('attempts').find(row => row.costDeferralRequestId === request.id);
  assert.equal(attempt.status, 'reconciling');
  assert.equal(attempt.cleanupPending, true);
  assert.equal(attempt.cleanupUncertain, true);
  assert.equal(attempt.hostCheck.checkId, 'fixture-quote-preparation');
  const receiptPath = path.join(f.dataDir, 'check-receipts', attempt.hostCheck.id + '.json');
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
  await f.start();
  await f.engine.tick();
  assert.equal(f.store.require('attempts', attempt.id).cleanupPending, true);
  assert.equal(f.store.require('goals', target.id).costBudgetDeferralRequest.status, 'checking');
  assert.equal(state(f.store, independent).status, 'ready');
  await f.engine.stop();

  await rename(path.join(f.dataDir, 'delayed-quote-receipt.json'), receiptPath);
  run('optional-quote-recover', 75);
  const closed = f.store.require('attempts', attempt.id);
  assert.equal(closed.status, 'interrupted');
  assert.equal(closed.cleanupPending, false);
  assert.equal(closed.cleanupUncertain, false);
  assert.equal(closed.hostCheck, null);
  assert.deepEqual(closed.hostCheckCleanup, { id: attempt.hostCheck.id, checkId: 'fixture-quote-preparation', exitCode: 0, quoteRequestId: request.id });
  assert.equal(f.store.require('goals', target.id).costBudgetDeferralRequest.status, 'not-applied');
  await assert.rejects(readFile(receiptPath), { code: 'ENOENT' });
  await f.start();
  await waiting(f, independent, task => task.status === 'succeeded');
  assert(optionalHold(state(f.store, bonus)));
  assert.equal(state(f.store, bonus).attempts, 0);
  assert(!priced.calls.includes(bonus.id));
  assert.equal(f.store.get('goalCostAttempts', attempt.id), null);
  assert.equal(budget(f.store, target.id).settledMicros, '11');
  const events = f.store.page(0, 200).entries.filter(event => event.entityId === attempt.id && event.type === 'attempt.cleanup.confirmed');
  assert.equal(events.length, 1);
});

test('an optional task that becomes a required dependency keeps its ordinary admission and owner pause', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? optionalFixtureProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const priced = fixedCostAdapter(f, { quoteFor: task => task.title === 'bonus' ? '26' : '7' });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1' } });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const bonus = planTask(f.store, plan, 'bonus'), core = planTask(f.store, plan, 'core');
  await scopedCommand(f, 'task.pause', { id: core.id }, 'pause-core-before-dynamic');
  f.command('company.resume');
  await waiting(f, bonus, optionalHold);
  const old = optionalDecision(target, plan, state(f.store, bonus));
  await scopedCommand(f, 'task.dependencies', { id: core.id, dependencies: [bonus.id] }, 'make-optional-input-required');
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional', old, 'reject-stale-required-input', 409)).code, 'COST_OPTIONAL_STALE');
  f.engine.nextOptionalCostCheck = 0;
  f.engine.kick();
  await waiting(f, bonus, task => task.status === 'succeeded');
  assert.equal(state(f.store, core).status, 'paused');
  assert(!priced.calls.includes(core.id));
  assert.equal(f.store.require('goals', target.id).costBudgetDeferrals, undefined);
  assert.equal(priced.authorizations.find(auth => auth.taskId === bonus.id).upperMicros, '26');
  await scopedCommand(f, 'task.resume', { id: core.id }, 'resume-required-work');
  await until(() => f.store.require('goals', target.id).status === 'succeeded', undefined, taskWaitDiagnostics(f, core.id));
  assert.equal(budget(f.store, target.id).limitMicros, '40');
});

test('two prepared optionals do not share headroom and ordinary continue refreshes only the current bound', async t => {
  const f = await fixture(t, input => {
    if (input.task.kind !== 'plan') return defaultSimulation(input);
    const proposal = optionalFixtureProposal();
    proposal.tasks.push({ ...proposal.tasks.at(-1), key: 'bonus-peer', title: 'bonus-peer' });
    return proposal;
  });
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const optionalGates = new Map([['bonus', Promise.withResolvers()], ['bonus-peer', Promise.withResolvers()]]);
  const liveQuotes = new Map([['bonus', '20'], ['bonus-peer', '20']]);
  const priced = fixedCostAdapter(f, { quoteFor: task => liveQuotes.get(task.title) ?? '7',
    amountFor: task => liveQuotes.has(task.title) ? '1' : '3',
    beforeResult: ({ task }) => optionalGates.get(task.title)?.promise });
  t.after(() => { for (const gate of optionalGates.values()) gate.resolve(); });
  planEstimates(priced, { amounts: { core: '8', validate: '6', bonus: '1', 'bonus-peer': '1' }, acceptance: '0', rework: '0' });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const options = ['bonus', 'bonus-peer'].map(key => planTask(f.store, plan, key));
  f.command('company.resume');
  const waitingTask = await until(() => options.find(task => optionalHold(state(f.store, task))),
    undefined, () => options.map(task => taskWaitDiagnostics(f, task.id)()));
  const paid = options.find(task => task.id !== waitingTask.id);
  assert(priced.calls.includes(paid.id));
  assert(!priced.calls.includes(waitingTask.id));
  const first = state(f.store, waitingTask).costBudgetHold;
  assert.equal(first.bound.upperMicros, '20');
  liveQuotes.set(waitingTask.title, '30');
  await scopedCommand(f, 'task.resume', { id: waitingTask.id }, 'fresh-higher-cap');
  await waiting(f, waitingTask, task => optionalHold(task) && task.costBudgetHold.attemptId !== first.attemptId);
  assert.equal(state(f.store, waitingTask).costBudgetHold.bound.upperMicros, '30');
  assert.equal((await scopedCommand(f, 'goal.cost_budget.defer_optional',
    { ...optionalDecision(target, plan, state(f.store, waitingTask)), holdAttemptId: first.attemptId }, 'stale-quote-decision', 409)).code, 'COST_OPTIONAL_STALE');
  liveQuotes.set(waitingTask.title, '1');
  await scopedCommand(f, 'task.resume', { id: waitingTask.id }, 'fresh-lower-cap');
  await until(() => priced.calls.includes(waitingTask.id), undefined, taskWaitDiagnostics(f, waitingTask.id));
  const current = priced.authorizations.find(row => row.taskId === waitingTask.id);
  assert.equal(current.upperMicros, '1');
  assert.equal(budget(f.store, target.id).limitMicros, '40');
  for (const gate of optionalGates.values()) gate.resolve();
  await until(() => f.store.require('goals', target.id).status === 'succeeded' && budget(f.store, target.id).reservedAttempts === 0,
    undefined, () => ({ ledger: budget(f.store, target.id), error: f.engine.lastError }));
  assert.equal(budget(f.store, target.id).settledMicros, '11');
  assert.equal(priced.calls.filter(id => id === waitingTask.id).length, 1);
});

test('completion forecast keeps a late receipt unknown even when both approved phase reserves are zero', async t => {
  const f = await fixture(t, input => {
    if (input.task.kind !== 'plan') return defaultSimulation(input);
    const { tasks, ...proposal } = budgetedProposal();
    return { ...proposal, tasks: tasks.slice(0, 1) };
  });
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000007', { plan: true });
  const priced = fixedCostAdapter(f, { amountFor: task => task.kind === 'plan' ? '0' : null });
  planEstimates(priced, { amounts: { core: '0' }, acceptance: '0', rework: '0' });
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  const initial = await scopedForecast(f, target.id);
  assert.equal(initial.unstartedMicros, '0');
  assert.equal(initial.coverage.unstarted, 1);
  assert.equal(initial.completionMicros, '0');
  assert.equal(initial.acceptance.state, 'no-reserve');
  assert.equal(initial.rework.state, 'no-reserve');
  f.command('company.resume');
  await until(() => f.store.require('goals', target.id).status === 'succeeded' &&
    budget(f.store, target.id).awaitingReceiptAttempts === 1, undefined, () => budget(f.store, target.id));
  const waitingForReceipt = await scopedForecast(f, target.id);
  assert.equal(waitingForReceipt.completionMicros, null);
  assert.equal(waitingForReceipt.headroomMicros, null);
  assert.equal(waitingForReceipt.ledger.settledMicros, '0');
  assert.equal(waitingForReceipt.ledger.reportedAttempts, 1);
  assert.equal(waitingForReceipt.ledger.reservedMicros, '7');
  assert.equal(waitingForReceipt.coveredMicros, '7');
  assert.deepEqual(waitingForReceipt.reasons, ['awaiting-cost-receipt']);
  delete priced.adapter.taskCost.estimatePlan;
  const noQuote = await scopedForecast(f, target.id);
  assert.equal(noQuote.plan.state, 'quote-stale');
  assert.equal(noQuote.completionBasis, null);
  assert.equal(noQuote.completionMicros, null);
  assert.equal(noQuote.coveredMicros, '7');
  assert.deepEqual(noQuote.reasons, ['awaiting-cost-receipt']);
  const authorization = priced.authorizations.find(row => row.taskId === plan.nodes[0].taskId);
  priced.save('cost-', authorization.id, receipt(authorization, '0'));
  f.engine.nextCostReceiptCheck = 0;
  f.engine.kick();
  await until(() => budget(f.store, target.id).settledAttempts === 2, undefined, () => budget(f.store, target.id));
  const settled = await scopedForecast(f, target.id);
  assert.equal(settled.completionMicros, '0');
  assert.equal(settled.completionBasis, 'settled');
  assert.equal(settled.headroomMicros, '7');
  assert.equal(settled.ledger.reportedAttempts, 2);
  assert.deepEqual(settled.reasons, []);
});

test('completion forecast preserves the fully settled total after the approved quote becomes unavailable', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  const priced = fixedCostAdapter(f);
  planEstimates(priced);
  f.engine.adapter = priced.adapter;
  const plan = await approveForecastPlan(f, target);
  f.command('company.resume');
  await until(() => f.store.require('goals', target.id).status === 'succeeded' &&
    budget(f.store, target.id).settledAttempts === 3, undefined, () => budget(f.store, target.id));
  const current = await scopedForecast(f, target.id);
  assert.equal(current.completionMicros, '9');
  assert.equal(current.headroomMicros, '31');
  assert.equal(current.plan.state, 'current');
  delete priced.adapter.taskCost.estimatePlan;
  const historical = await scopedForecast(f, target.id);
  assert.deepEqual(historical.plan, { ...current.plan, state: 'quote-stale' });
  assert.equal(historical.plan.quoteId, plan.costPlan.estimate.quoteId);
  assert.deepEqual(historical.ledger, current.ledger);
  assert.equal(historical.coverage.delivered, 2);
  assert.equal(historical.unstartedMicros, '0');
  assert.equal(historical.acceptance.state, 'finished');
  assert.equal(historical.rework.state, 'finished');
  assert.equal(historical.completionBasis, 'settled');
  assert.equal(historical.completionMicros, '9');
  assert.equal(historical.headroomMicros, '31');
  assert.deepEqual(historical.reasons, []);
});

test('budget planning commits a host-estimated minimum and defers optional scope without an extra owner approval', async t => {
  let contract;
  const f = await fixture(t, input => {
    if (input.task.kind !== 'plan') return defaultSimulation(input);
    contract = JSON.parse(input.prompt.split('CONTRACT:\n').at(-1));
    return budgetedProposal();
  });
  const priced = fixedCostAdapter(f);
  const estimates = planEstimates(priced);
  f.engine.adapter = priced.adapter;
  const target = goal(f, '0.000040', { plan: true });
  const premature = { goalId: target.id, title: 'Work outside root plan' };
  assert.throws(() => f.task(premature), { code: 'PLAN_APPROVAL_REQUIRED' });
  assert.throws(() => f.command('task.create', premature, SYSTEM), { code: 'PLAN_APPROVAL_REQUIRED' });
  assert.throws(() => f.command('task.create', premature, { kind: 'agent', id: 'manager', goalId: target.id, grants: ['task.create'] }),
    { code: 'PLAN_APPROVAL_REQUIRED' });
  await f.start();
  const plan = await proposalFor(f, target);
  assert.equal(contract.costPlanning.availableMicros, '40');
  assert.equal(contract.costPlanning.reservedAttempts, 0);
  assert.equal(contract.costPlanning.reportedAttempts, 0);
  assert.equal(plan.costPlan.submitted.availableMicros, '33');
  assert.equal(plan.costPlan.submitted.reservedMicros, '7');
  assert.equal(plan.costPlan.minimumMicros, '23');
  assert.equal(plan.costPlan.fullMicros, '48');
  assert.equal(plan.costPlan.estimate.tasks.find(row => row.key === 'core').estimate.micros, '8');
  assert.equal(plan.costPlan.estimate.acceptance.micros, '5');
  assert.equal(plan.costPlan.estimate.rework.micros, '4');
  assert.equal(plan.costPlan.estimate.quoteId, 'fixed-plan-v1');
  assert.equal(estimates.length, 1);
  assert.equal(estimates[0].tasks[0].amountMicros, undefined);
  assert.equal(plan.approvalStatus, 'approved');
  assert.equal(plan.costRelease.kind, 'automatic');
  assert.equal(plan.ownerDecision, undefined);
  assert.deepEqual(plan.nodes.map(row => row.key), ['core', 'validate']);
  assert.deepEqual(plan.nodes[1].dependencies, [plan.nodes[0].taskId]);
  assert.equal(f.store.require('goals', target.id).planApproval.approvedPlanId, plan.id);
  await until(() => plan.nodes.every(row => f.store.require('tasks', row.taskId).status === 'succeeded'), undefined,
    () => plan.nodes.map(row => taskWaitDiagnostics(f, row.taskId)()));
  assert.equal(priced.calls.length, 3);
});

test('insufficient minimum leaves no implementation until explicit addition and same-version owner approval after restart', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  const priced = fixedCostAdapter(f, { amountFor: task => task.kind === 'plan' ? '7' : '3' });
  const initialEstimates = planEstimates(priced);
  f.engine.adapter = priced.adapter;
  const target = goal(f, '0.000020', { plan: true });
  await f.start();
  const plan = await proposalFor(f, target);
  const root = f.store.require('tasks', plan.taskId);
  assert.equal(plan.costPlan.status, 'shortfall');
  assert.equal(plan.costPlan.minimumMicros, '23');
  assert.equal(plan.costPlan.submitted.availableMicros, '13');
  assert.equal(root.status, 'blocked');
  assert.deepEqual(priced.calls, [root.id]);
  const approve = planDecision(plan, 'approve', 'Fund the verified minimum');
  assert.equal((await scopedCommand(f, 'plan.approval.decide', approve, 'insufficient-approval', 409)).code, 'COST_PLAN_LIMIT');
  assert.equal((await scopedCommand(f, 'task.resume', { id: root.id }, 'ordinary-continue', 409)).code, 'PLAN_APPROVAL_REQUIRED');
  assert.equal(budget(f.store, target.id).limitMicros, '20');
  assert.equal(f.store.list('tasks').filter(task => task.goalId === target.id).length, 1);
  await f.engine.stop();

  const reopened = new Store(f.store.filename), company = new Company(reopened);
  const recovered = fixedCostAdapter(f);
  const restartedEstimates = planEstimates(recovered);
  const underlyingEstimate = recovered.adapter.taskCost.estimatePlan;
  recovered.adapter.taskCost.estimatePlan = input => {
    const quoted = underlyingEstimate(input);
    return { ...quoted, tasks: [...quoted.tasks].reverse() };
  };
  const engine = new Engine(company, recovered.adapter, new WorkspaceManager(f.dataDir, company), { intervalMs: 20 });
  const runtime = { ...f, store: reopened, company, adapter: recovered.adapter, engine, workspaces: engine.workspaces };
  try {
    await engine.start();
    assert.equal(reopened.require('plans', plan.id).fingerprint, plan.fingerprint);
    assert.equal(reopened.require('tasks', root.id).status, 'blocked');
    assert.deepEqual(recovered.calls, []);
    await scopedCommand(runtime, 'goal.cost_budget.extend', { id: target.id, additionalCostUsd: '0.000050' }, 'explicit-funding');
    assert.equal(reopened.require('goals', target.id).planApproval.approvedPlanId, undefined);
    const approved = await scopedCommand(runtime, 'plan.approval.decide', approve, 'same-plan-approval');
    assert.equal(approved.costRelease.kind, 'owner');
    assert.equal(approved.costRelease.balance.availableMicros, '63');
    assert.deepEqual(restartedEstimates, [initialEstimates[0]]);
    assert.deepEqual(initialEstimates[1], initialEstimates[0]);
    assert.deepEqual(approved.nodes.map(node => node.key), ['core', 'validate']);
    assert.deepEqual(await scopedCommand(runtime, 'plan.approval.decide', approve, 'same-plan-approval'), approved);
    assert.deepEqual(await scopedCommand(runtime, 'plan.approval.decide', approve, 'new-id-same-approval'), approved);
    await until(() => approved.nodes.every(row => reopened.require('tasks', row.taskId).status === 'succeeded'), undefined,
      () => approved.nodes.map(row => ({ taskId: row.taskId, status: reopened.require('tasks', row.taskId).status })));
    assert.equal(recovered.calls.length, 2);
    assert.equal(reopened.list('plans').filter(item => item.goalId === target.id).length, 1);
  } finally { await engine.stop(); reopened.close(); }
});

test('missing estimates and a required dependency on optional scope both hold proposals without work', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ?
    budgetedProposal({ requiredDependsOnOptional: input.task.title.includes('Dependency') }) : defaultSimulation(input));
  const priced = fixedCostAdapter(f);
  f.engine.adapter = priced.adapter; // The ordinary cost contract can quote a live attempt but not a plan.
  const missing = goal(f, '0.000100', { plan: true, title: 'Missing estimate' });
  const dependency = goal(f, '0.000100', { plan: true, title: 'Dependency outside minimum' });
  await f.start();
  const [missingPlan, dependencyPlan] = await Promise.all([proposalFor(f, missing), proposalFor(f, dependency)]);
  assert.equal(missingPlan.costPlan.status, 'incomplete');
  assert.equal(dependencyPlan.costPlan.status, 'incomplete');
  assert.match(dependencyPlan.costPlan.reason, /依赖可选/);
  assert.equal(missingPlan.costPlan.minimumMicros, null);
  assert.equal(dependencyPlan.costPlan.minimumMicros, null);
  for (const plan of [missingPlan, dependencyPlan]) {
    assert.equal((await scopedCommand(f, 'plan.approval.decide', planDecision(plan, 'approve', 'Incomplete proof'),
      'incomplete-' + plan.id, 409)).code, 'COST_PLAN_ESTIMATE_REQUIRED');
    assert(!f.store.list('tasks').some(task => task.goalId === plan.goalId && task.kind === 'work'));
  }
  assert.equal(priced.calls.length, 2);
});

test('the human plan gate remains independent and rechecks the accepted estimate context before approval', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  const priced = fixedCostAdapter(f);
  planEstimates(priced);
  f.engine.adapter = priced.adapter;
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000100', { plan: true });
  await f.start();
  const plan = await proposalFor(f, target);
  assert.equal(plan.costPlan.status, 'fits');
  assert.deepEqual(plan.costPlan.selectedKeys, ['core', 'validate', 'bonus']);
  assert.equal(plan.approvalStatus, 'pending');
  assert.deepEqual(priced.calls, [plan.taskId]);
  f.command('project.save', { id: f.project.id, checks: [{ id: 'new-check', command: process.execPath, args: ['--version'] }] });
  const approve = planDecision(plan, 'approve', 'Recheck project policy');
  assert.equal((await scopedCommand(f, 'plan.approval.decide', approve, 'stale-approval', 409)).code, 'COST_PLAN_ESTIMATE_STALE');
  assert.deepEqual(priced.calls, [plan.taskId]);
  const returned = await scopedCommand(f, 'plan.approval.decide', planDecision(plan, 'revise', 'Refresh checks'), 'return-with-changed-checks');
  assert.equal(returned.approvalStatus, 'returned');
  const renewed = await until(() => f.store.list('plans').find(item => item.goalId === target.id && item.generation === plan.generation + 1 &&
    !f.store.require('attempts', item.attemptId).cleanupPending), undefined,
  () => taskWaitDiagnostics(f, plan.taskId)());
  assert.equal(renewed.approvalStatus, 'pending');
  assert.notEqual(renewed.costPlan.contextVersion, plan.costPlan.contextVersion);
  const approved = await scopedCommand(f, 'plan.approval.decide', planDecision(renewed, 'approve', 'Accept the full affordable plan'), 'full-plan');
  assert.deepEqual(approved.nodes.map(row => row.key), ['core', 'validate', 'bonus']);
});


test('an unknown planning charge keeps its reservation in both the submitted estimate and the live approval balance', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  const priced = fixedCostAdapter(f, { amountFor: task => task.kind === 'plan' ? null : '3' });
  planEstimates(priced);
  f.engine.adapter = priced.adapter;
  const target = goal(f, '0.000027', { plan: true });
  await f.start();
  const plan = await proposalFor(f, target), args = planDecision(plan, 'approve', 'Consider the verified minimum');
  assert.equal(plan.costPlan.status, 'shortfall');
  assert.equal(plan.costPlan.submitted.reportedAttempts, 0);
  assert.equal(plan.costPlan.submitted.reservedAttempts, 1);
  assert.equal(plan.costPlan.submitted.availableMicros, '20');
  assert.equal(budget(f.store, target.id).awaitingReceiptAttempts, 1);
  assert.equal((await scopedCommand(f, 'plan.approval.decide', args, 'awaiting-receipt', 409)).code, 'COST_PLAN_LIMIT');
  const row = rows(f.store).find(entry => entry.taskId === plan.taskId);
  priced.save('cost-', row.id, receipt(row, '4'));
  f.engine.nextCostReceiptCheck = 0;
  f.engine.kick();
  await until(() => budget(f.store, target.id).reportedAttempts === 1);
  assert.equal(budget(f.store, target.id).settledMicros, '4');
  assert.equal(f.store.require('plans', plan.id).costPlan.submitted.availableMicros, '20');
  assert.deepEqual(priced.calls, [plan.taskId]);
  const approved = await scopedCommand(f, 'plan.approval.decide', args, 'confirmed-receipt');
  assert.equal(approved.costRelease.balance.availableMicros, '23');
  assert.deepEqual(approved.nodes.map(entry => entry.key), ['core', 'validate']);
});

test('only unimplemented open legacy strict roots receive the new planning gate on startup', async t => {
  const f = await fixture(t);
  const create = title => goal(f, '0.000040', { plan: true, title });
  const pending = create('Legacy pending');
  const deleted = create('Legacy deleted planner');
  const cancelled = create('Legacy cancelled goal');
  const completed = create('Legacy accepted plan');
  const approved = create('Legacy owner approval');
  const manual = goal(f, '0.000040', { title: 'Legacy manual' });
  const rootFor = id => f.store.list('tasks').find(item => item.goalId === id && item.kind === 'plan');
  const expectedApproval = { ...approved.planApproval, costPlanning: undefined, approvedPlanId: 'existing-owner-approval' };
  f.store.transaction(() => {
    for (const target of [pending, deleted, cancelled, completed]) f.store.put('goals', { ...target, planApproval: null });
    f.store.put('goals', { ...approved, planApproval: expectedApproval });
    f.store.put('goals', { ...f.store.require('goals', cancelled.id), status: 'cancelled' });
    const oldRoot = rootFor(deleted.id);
    f.store.put('tasks', { ...oldRoot, status: 'deleted' });
    const completeRoot = rootFor(completed.id);
    f.store.put('plans', { id: completeRoot.id + ':g1', taskId: completeRoot.id, goalId: completed.id, acceptedAt: '2026-11-19T00:00:00Z' });
  });
  const reopened = new Store(f.store.filename);
  try {
    new Company(reopened);
    assert.deepEqual(reopened.require('goals', pending.id).planApproval, { taskId: rootFor(pending.id).id, costPlanning: true });
    for (const target of [deleted, cancelled, completed, manual]) assert(!reopened.require('goals', target.id).planApproval);
    const retained = reopened.require('goals', approved.id).planApproval;
    assert.deepEqual(retained, { taskId: approved.planApproval.taskId, project: false, template: false, approvedPlanId: 'existing-owner-approval' });
    const revision = reopened.require('goals', pending.id).revision;
    new Company(reopened);
    assert.equal(reopened.require('goals', pending.id).revision, revision);
  } finally { reopened.close(); }
});


test('owner HTTP refuses a changed or missing trusted quote and preserves the original plan until repriced', async t => {
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
  const priced = fixedCostAdapter(f);
  const oldRates = planEstimates(priced, { amounts: { core: '8', validate: '7', bonus: '25' }, acceptance: '5', rework: '5' });
  f.engine.adapter = priced.adapter;
  f.command('project.save', { id: f.project.id, planApproval: true });
  const target = goal(f, '0.000040', { plan: true });
  await f.start();
  const original = await proposalFor(f, target);
  assert.equal(original.costPlan.minimumMicros, '25');
  assert.equal(budget(f.store, target.id).settledMicros, '3');
  assert.equal(f.company.snapshot().goals.find(item => item.id === target.id).costBudget.availableMicros, '37');
  assert.equal(oldRates.length, 1);

  const currentRates = { amounts: { core: '28', validate: '26', bonus: '25' }, acceptance: '5', rework: '5' };
  const estimateCalls = planEstimates(priced, currentRates);
  const approve = planDecision(original, 'approve', 'Approve the reviewed version');
  assert.equal((await scopedCommand(f, 'plan.approval.decide', approve, 'changed-rates-approval', 409)).code, 'COST_PLAN_ESTIMATE_STALE');
  assert.equal(estimateCalls.length, 1);
  assert.ok(!f.store.list('tasks').some(task => task.goalId === target.id && task.kind === 'work'));
  assert.deepEqual(f.store.require('plans', original.id), original);
  assert.deepEqual(priced.calls, [original.taskId]);

  delete priced.adapter.taskCost.estimatePlan;
  assert.equal((await scopedCommand(f, 'plan.approval.decide', { ...approve, planCostSource: original.costPlan.estimate },
    'missing-current-estimator', 409)).code, 'COST_PLAN_ESTIMATE_STALE');
  assert.deepEqual(f.store.require('plans', original.id), original);
  assert.deepEqual(priced.calls, [original.taskId]);

  planEstimates(priced, currentRates);
  const returned = await scopedCommand(f, 'plan.approval.decide', planDecision(original, 'revise', 'Verify the higher rates'), 'return-stale-plan');
  assert.equal(returned.approvalStatus, 'returned');
  assert.deepEqual(returned.costPlan, original.costPlan);
  const revised = await until(() => f.store.list('plans').find(plan => plan.goalId === target.id && plan.generation === original.generation + 1 &&
    !f.store.require('attempts', plan.attemptId).cleanupPending), undefined, taskWaitDiagnostics(f, original.taskId));
  assert.equal(revised.costPlan.minimumMicros, '64');
  assert.equal(revised.costPlan.status, 'shortfall');
  assert.notEqual(revised.costPlan.estimateFingerprint, original.costPlan.estimateFingerprint);
  assert.equal((await scopedCommand(f, 'plan.approval.decide', approve, 'old-version-after-return', 409)).code, 'STALE_PLAN_APPROVAL');
  assert.equal((await scopedCommand(f, 'plan.approval.decide', planDecision(revised, 'approve', 'Still insufficient'),
    'repriced-plan-insufficient', 409)).code, 'COST_PLAN_LIMIT');
  assert.deepEqual(priced.calls, [original.taskId, original.taskId]);
  assert(!f.store.list('tasks').some(task => task.goalId === target.id && task.kind === 'work'));
});
