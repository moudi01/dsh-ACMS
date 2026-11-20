import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
    tasks: [{ key: 'required', title: 'Required task', description: 'Build a file', acceptance: 'File exists', dependencies: [] }],
  } : defaultSimulation(input));
  const priced = fixedCostAdapter(f, { quoteFor: () => '7', amountFor: () => '7' });
  f.engine.adapter = priced.adapter;
  const target = goal(f, '0.000010', { plan: true });
  const planner = f.store.list('tasks').find(task => task.goalId === target.id && task.kind === 'plan');
  await f.start();
  await until(() => f.store.list('tasks').some(task => task.goalId === target.id && task.kind === 'work' && task.costBudgetHold?.code === 'COST_LIMIT_REACHED'),
    undefined, () => ({ ...taskWaitDiagnostics(f, planner.id)(), cost: budget(f.store, target.id), engineError: f.engine.lastError }));
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
