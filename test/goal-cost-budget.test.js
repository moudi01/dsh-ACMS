import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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


function budgetedProposal({ requiredDependsOnOptional = false } = {}) {
  const node = (key, importance, dependencies = []) => ({ key, title: key, description: 'Prove work for ' + key,
    acceptance: 'A file exists', dependencies, importance, modelBasis: 'Fixed adapter supports the required tools.',
    amountMicros: '0' }); // Untrusted numbers must never become an estimate.
  return { outcome: 'planned', summary: 'Budgeted fixture plan', rationale: 'Only core and validate are necessary.',
    minimumOutcome: 'Core file with independent verification', nonGoals: ['Optional enhancements can wait'],
    costPlan: { acceptanceBasis: 'Run configured evidence checks.', reworkBasis: 'Allow one bounded correction.' },
    tasks: [node('core', 'required', requiredDependsOnOptional ? ['bonus'] : []), node('validate', 'required', ['core']),
      node('bonus', 'optional')] };
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
  const f = await fixture(t, input => input.task.kind === 'plan' ? budgetedProposal() : defaultSimulation(input));
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
  assert.deepEqual(initial.coverage, { selected: 3, unstarted: 3, reserved: 0, delivered: 0, unknown: 0, outsidePlan: 0 });
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
  assert.deepEqual(concurrent.coverage, { selected: 3, unstarted: 1, reserved: 2, delivered: 0, unknown: 0, outsidePlan: 0 });
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
  assert.deepEqual(progress.coverage, { selected: 2, unstarted: 1, reserved: 0, delivered: 0, unknown: 1, outsidePlan: 0 });
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
  assert.deepEqual(changed.coverage, { selected: 2, unstarted: 1, reserved: 0, delivered: 0, unknown: 1, outsidePlan: 1 });
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
