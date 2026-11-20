import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../src/adapters/dsh.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { createRoutes } from '../src/host/http.js';
import { Store } from '../src/core/store.js';
import { executionIdentity, ExecutionReceipt, readExecution } from '../src/runtime/execution-receipt.js';
import { withAttemptUsage } from '../src/runtime/attempt-usage.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const runner = fileURLToPath(new URL('./fixtures/recovery-runtime.mjs', import.meta.url));
async function view(f, params, status = 200, pathname = '/api/acms/usage') {
  const route = createRoutes(f).find(route => route.path === pathname);
  const response = await route.fetch(new Request(`http://127.0.0.1${pathname}?${new URLSearchParams(params)}`));
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

const summary = (f, params, status) => view(f, params, status, '/api/acms/usage/summary');

test('full usage summaries cover retained attempts independently of page, route group, and other goals', async t => {
  const f = await fixture(t), a = f.task(), b = f.task();
  const other = f.command('goal.create', { projectId: f.project.id, title: 'Other goal', description: 'Separate scope', acceptance: 'Independent', plan: false });
  const outside = f.task({ goalId: other.id });
  const huge = Number.MAX_SAFE_INTEGER;
  const saved = { taskId: a.id, goalId: f.goal.id, kind: 'work', status: 'completed', provider: 'paired:chosen', llmProvider: 'observed-channel',
    model: 'chosen-model', reasoningEffort: 'high', startedAt: '2026-11-20T07:59:59+08:00',
    selection: { binding: { provider: 'requested', model: 'requested-model', reasoningEffort: 'low' }, chosen: { provider: 'paired:chosen' } } };
  const receipt = n => ({ source: 'codex-app-server', threadId: 'fixture', turnId: 'fixture-turn', finishedAt: '2026-11-20T00:01:00Z',
    counts: { inputTokens: null, cachedInputTokens: 0, cacheWriteInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: n } });
  f.store.transaction(() => {
    f.store.put('attempts', { ...saved, id: 'attempt_zero', taskId: b.id, reasoningEffort: 'low',
      startedAt: '2026-11-20T08:30:00+08:00', meteredUsage: receipt(0) });
    f.store.put('attempts', { ...saved, id: 'attempt_preflight', taskId: b.id, status: 'failed', preflightOnly: true,
      startedAt: '2026-11-20T10:00:00Z' });
    for (let index = 0; index < 33; index++) f.store.put('attempts', {
      ...saved, id: `attempt_counted_${index}`, meteredUsage: receipt(huge),
    });
    f.store.put('attempts', { ...saved, id: 'attempt_reserved', status: 'running', startedAt: '2026-11-20T00:15:00Z',
      childId: 'attempt_reserved', execution: { runtime: 'codex-app-server' } });
    f.store.put('attempts', { ...saved, id: 'attempt_legacy', startedAt: '2026-11-20',
      provider: 'auto', model: 'unverified', progress: { tokenUsage: { totalTokens: 999999 } } });
    f.store.put('attempts', { ...saved, id: 'attempt_other_goal', goalId: other.id, taskId: outside.id, meteredUsage: receipt(1000) });
  });
  const aggregate = await summary(f, { goalId: f.goal.id, limit: 1 });
  const amount = (33n * BigInt(huge)).toString();
  assert.deepEqual(aggregate.coverage, { reported: 34, pending: 1, unknown: 1, 'not-executed': 1 });
  assert.deepEqual(aggregate.summary.totalTokens, { reported: 34, subtotal: amount });
  assert.deepEqual(aggregate.summary.inputTokens, { reported: 0, subtotal: null });
  assert.deepEqual(aggregate.summary.cachedInputTokens, { reported: 34, subtotal: '0' });
  assert.equal(aggregate.groups.length, 1);
  assert.equal(aggregate.attemptPage, undefined);
  const second = await summary(f, { goalId: f.goal.id, limit: 1, after: aggregate.nextAfter });
  assert.deepEqual(second.summary, aggregate.summary);
  assert.deepEqual(second.coverage, aggregate.coverage);
  const knownGroups = [...aggregate.groups, ...second.groups];
  const high = knownGroups.find(group => group.reasoningEffort === 'high');
  const low = knownGroups.find(group => group.reasoningEffort === 'low');
  assert.deepEqual(['provider', 'llmProvider', 'model'].map(key => high[key]), ['paired:chosen', 'observed-channel', 'chosen-model']);
  assert.equal(high.coverage.reported, 33);
  assert.equal(high.coverage.pending, 0);
  assert.deepEqual(low.summary.totalTokens, { reported: 1, subtotal: '0' });
  const missing = await summary(f, { goalId: f.goal.id, limit: 1, after: second.nextAfter });
  assert.equal(missing.groups[0].provider, null);
  assert.deepEqual(missing.groups[0].coverage, { reported: 0, pending: 1, unknown: 1, 'not-executed': 1 });
  assert.equal(missing.groups[0].summary.totalTokens.subtotal, null);
  assert.equal(missing.nextAfter, null);
  const task = await summary(f, { taskId: b.id });
  assert.equal(task.scope, 'task');
  assert.deepEqual(task.summary.totalTokens, { reported: 1, subtotal: '0' });
  assert.equal(task.coverage['not-executed'], 1);
  assert.equal((await summary(f, { goalId: other.id })).summary.totalTokens.subtotal, '1000');

  const date = await summary(f, { goalId: f.goal.id, groupBy: 'date', limit: 2 });
  assert.equal(date.dateBasis, 'started-at-utc');
  assert.deepEqual(date.groups.map(({ dateUtc }) => dateUtc), ['2026-11-20', '2026-11-19']);
  assert.deepEqual(date.groups[0].coverage, { reported: 1, pending: 1, unknown: 0, 'not-executed': 1 });
  assert.equal(date.groups[1].summary.totalTokens.subtotal, amount);
  const undated = await summary(f, { goalId: f.goal.id, groupBy: 'date', limit: 2, after: date.nextAfter });
  assert.equal(undated.groups[0].dateUtc, null);
  assert.equal(undated.groups[0].coverage.unknown, 1);

  const priorView = await view(f, { goalId: f.goal.id });
  assert.equal(priorView.attempts.length, 30);
  assert.equal(priorView.coverage.reported, 28);
  assert(priorView.nextBefore);
  const combined = await summary(f, { goalId: f.goal.id, attemptBefore: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(combined.attemptPage, priorView);
  const older = await summary(f, { goalId: f.goal.id, attemptBefore: combined.attemptPage.nextBefore });
  assert.deepEqual(older.attemptPage, await view(f, { goalId: f.goal.id, before: priorView.nextBefore }));
  assert.deepEqual(older.summary, aggregate.summary);
  assert.equal((await summary(f, { goalId: f.goal.id, groupBy: 'unknown' }, 400)).error.code, 'INVALID_INPUT');
  assert.equal((await summary(f, { taskId: b.id, limit: 101 }, 400)).error.code, 'INVALID_INPUT');
  assert.equal((await summary(f, { taskId: b.id, attemptBefore: 0 }, 400)).error.code, 'INVALID_INPUT');
  assert.equal((await summary(f, { taskId: b.id, groupBy: 'date', after: aggregate.nextAfter }, 400)).error.code, 'INVALID_INPUT');
});

test('a registered long model can round-trip every route cursor', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), long = f.task({ title: 'Long paired route' }), short = f.task({ title: 'Short simulated route' });
  const paired = new PairedRuntimes(f.company, f.dataDir);
  const invite = await paired.invite();
  const token = JSON.parse(invite.prompt.slice(invite.prompt.indexOf('{\n  "protocol"'), invite.prompt.lastIndexOf('\n完成后'))).token;
  const calls = path.join(f.root, 'long-model-calls.jsonl'), model = 'm'.repeat(4096);
  await writeFile(invite.responseFile, JSON.stringify({ protocol: 'acms.runner.v1', inviteId: invite.id, token,
    name: 'Long model fixture', model, command: process.execPath, args: [runner, 'runner', calls, 'complete'], persistent: false }));
  const candidate = await paired.inspect(invite.id);
  await paired.accept(invite.id, candidate.fingerprint);
  const adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  f.engine.adapter = { start: input => (input.task.id === long.id ? adapter : f.adapter).start(input),
    reconcile: attempt => (attempt.taskId === long.id ? adapter : f.adapter).reconcile(attempt) };
  f.store.put('attempts', { id: 'attempt_old_unverified', taskId: long.id, goalId: f.goal.id, status: 'completed', provider: 'auto' });
  await f.start();
  const diagnostics = () => [long, short].map(task => taskWaitDiagnostics(f, task.id)());
  await until(() => {
    const states = [long, short].map(task => f.store.require('tasks', task.id).status);
    assert(!states.some(status => ['blocked', 'failed', 'cancelled', 'reconciling'].includes(status)), JSON.stringify(diagnostics()));
    return states.every(status => status === 'succeeded');
  }, 45000, diagnostics);
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1);

  let after;
  const routes = [];
  for (let index = 0; index < 3; index++) {
    const page = await summary(f, { goalId: f.goal.id, limit: 1, ...(after ? { after } : {}) });
    assert.equal(page.groups.length, 1);
    assert.equal(page.groups[0].coverage.unknown, 1);
    assert.equal(page.coverage.unknown, 3);
    if (index < 2) assert.match(page.nextAfter, /^0:[a-f0-9]{64}$/);
    routes.push(page.groups[0]);
    after = page.nextAfter;
  }
  assert.equal(after, null);
  assert.equal(routes[2].provider, null);
  assert.equal(routes.find(group => group.provider === candidate.id)?.model, model);
  assert(routes.some(group => group.provider === 'simulation'));
  assert.equal(new Set(routes.map(group => group.key)).size, routes.length);
});

test('usage attempts use the scoped expression indexes on upgraded stores', async t => {
  const f = await fixture(t), task = f.task();
  f.store.db.exec('DROP INDEX attempts_usage_by_goal; DROP INDEX attempts_usage_by_task');
  const reopened = new Store(f.store.filename);
  reopened.close();
  const original = f.store.db.prepare.bind(f.store.db);
  const statements = [];
  f.store.db.prepare = sql => {
    if (sql.includes("collection='attempts'") && sql.startsWith('SELECT')) statements.push(sql);
    return original(sql);
  };
  await view(f, { goalId: f.goal.id });
  await view(f, { taskId: task.id });
  await summary(f, { goalId: f.goal.id });
  await summary(f, { taskId: task.id });
  const cases = [
    ['goal', [f.goal.id, Number.MAX_SAFE_INTEGER, 31]], ['task', [task.id, Number.MAX_SAFE_INTEGER, 31]],
    ['goal', [f.goal.id]], ['task', [task.id]],
  ];
  assert.equal(statements.length, cases.length);
  for (const [index, [scope, args]] of cases.entries()) {
    const plan = original(`EXPLAIN QUERY PLAN ${statements[index]}`).all(...args).map(row => row.detail).join('\n');
    assert.match(plan, new RegExp(`SEARCH .* USING INDEX attempts_usage_by_${scope}`));
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  }
});

test('the scope summary reflects task purge without carrying removed usage into another task', async t => {
  const f = await fixture(t), first = f.task({ title: 'Remove me' }), second = f.task({ title: 'Retain me' });
  f.store.transaction(() => {
    for (const [task, amount] of [[first, 13], [second, 7]]) f.store.put('attempts', { id: 'attempt_' + task.id,
      taskId: task.id, goalId: task.goalId, status: 'completed', provider: 'paired:fixture', model: 'fixture',
      meteredUsage: { source: 'codex-app-server', counts: { totalTokens: amount } },
    });
  });
  const initial = await summary(f, { goalId: f.goal.id, attemptBefore: Number.MAX_SAFE_INTEGER });
  assert.equal(initial.summary.totalTokens.subtotal, '20');
  assert.equal(initial.attemptPage.summary.totalTokens.subtotal, '20');
  const deleted = f.command('task.delete', { id: first.id });
  f.command('task.purge', { id: first.id, confirmTitle: first.title, expectedRevision: deleted.revision });
  const refreshed = await summary(f, { goalId: f.goal.id, groupBy: 'date', attemptBefore: Number.MAX_SAFE_INTEGER });
  assert.equal(refreshed.summary.totalTokens.subtotal, '7');
  assert.equal(refreshed.attemptPage.summary.totalTokens.subtotal, '7');
  assert.deepEqual(refreshed.attemptPage.attempts.map(row => row.taskId), [second.id]);
  assert.equal((await summary(f, { taskId: first.id }, 404)).error.code, 'NOT_FOUND');
  assert.equal((await summary(f, { taskId: second.id })).summary.totalTokens.subtotal, '7');
});

test('complete usage and its group page share one SQLite read snapshot', async t => {
  const f = await fixture(t), task = f.task();
  const attempt = (id, totalTokens) => ({ id, taskId: task.id, goalId: task.goalId, status: 'completed',
    provider: 'paired:fixture', model: 'fixture', meteredUsage: { counts: { totalTokens } } });
  const attempts = [attempt('attempt_first', 1), attempt('attempt_second', 2)];
  f.store.transaction(() => { for (const row of attempts) f.store.put('attempts', row); });
  const writer = new Store(f.store.filename);
  const scopedRows = f.store.attemptUsageRows.bind(f.store);
  let updated = false;
  f.store.attemptUsageRows = function* (...args) {
    for (const row of scopedRows(...args)) {
      yield row;
      if (!updated) {
        const unseen = attempts.find(item => item.id !== row.attempt.id);
        writer.put('attempts', attempt(unseen.id, unseen.meteredUsage.counts.totalTokens + 10));
        updated = true;
      }
    }
  };
  try {
    const params = { goalId: task.goalId, attemptBefore: Number.MAX_SAFE_INTEGER };
    const before = await summary(f, params);
    assert.equal(before.summary.totalTokens.subtotal, '3');
    assert.deepEqual(before.groups[0].summary, before.summary);
    assert.deepEqual(before.attemptPage.summary, before.summary);
    const after = await summary(f, params);
    assert.equal(after.summary.totalTokens.subtotal, '13');
    assert.deepEqual(after.attemptPage.summary, after.summary);
    assert.deepEqual(after.groups[0].summary, after.summary);
  } finally { writer.close(); }
});

test('owner usage pages distinguish an observed zero, unknown historical data and executions with no terminal', async t => {
  const f = await fixture(t), task = f.task(), other = f.task();
  const now = new Date().toISOString();
  const ref = executionIdentity({ id: 'paired:fixture', model: 'fixture-model', runtime: 'codex-app-server' }, {
    mode: 'task', attemptId: 'attempt_reported', contextKey: 'verified-context', generation: task.generation, kind: task.kind,
  });
  const root = { goalId: task.goalId, taskId: task.id, kind: task.kind, status: 'completed', startedAt: now };
  const metered = { source: 'codex-app-server', threadId: 'verified-thread', turnId: 'verified-turn', counts: { totalTokens: 0, inputTokens: 0 } };
  const accepted = { ...root, id: ref.attemptId, execution: ref, provider: ref.provider, model: ref.model, reasoningEffort: 'high',
    contextKey: ref.contextKey, taskGeneration: ref.generation };
  const receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish({ executed: true, output: { outcome: 'completed', meteredUsage: { counts: { totalTokens: 99 } } }, meteredUsage: metered });
  const fact = readExecution(f.dataDir, accepted);
  assert.equal(fact.meteredUsage.counts.totalTokens, 0);
  assert.equal(fact.result.meteredUsage.counts.totalTokens, 99);
  assert.equal(withAttemptUsage(accepted, { ...fact, cleanupConfirmed: false }), accepted);
  assert.equal(withAttemptUsage(accepted, { ...fact, meteredUsage: { ...fact.meteredUsage, runKey: 'not-this-run' } }), accepted);
  const accounted = withAttemptUsage(accepted, fact);
  assert.equal(withAttemptUsage(accounted, fact), accounted);
  f.store.transaction(() => {
    f.store.put('attempts', { ...root, id: 'attempt_history', progress: { tokenUsage: { totalTokens: 999 } } });
    f.store.put('attempts', { ...root, id: 'attempt_check', preflightOnly: true });
    f.store.put('attempts', { ...root, id: 'attempt_pending', status: 'reconciling', cleanupPending: true });
    f.store.put('attempts', accounted);
    f.store.put('attempts', { ...root, id: 'attempt_other', taskId: other.id });
  });
  const latest = await view(f, { taskId: task.id, limit: 2 });
  assert.deepEqual(latest.attempts.map(row => row.state), ['reported', 'pending']);
  assert.equal(latest.attempts[0].usage.counts.totalTokens, 0);
  assert.equal(latest.attempts[0].reasoningEffort, 'high');
  assert.deepEqual(latest.summary.totalTokens, { reported: 1, subtotal: '0' });
  assert.deepEqual(latest.summary.cachedInputTokens, { reported: 0, subtotal: null });
  const earlier = await view(f, { taskId: task.id, limit: 2, before: latest.nextBefore });
  assert.deepEqual(earlier.attempts.map(row => row.state), ['not-executed', 'unknown']);
  assert.deepEqual(earlier.summary.totalTokens, { reported: 0, subtotal: null });
  assert.equal(earlier.nextBefore, null);
  assert.equal((await view(f, { goalId: f.goal.id })).attempts.length, 5);
  assert.equal((await view(f, { taskId: task.id, limit: 101 }, 400)).error.code, 'INVALID_INPUT');
  assert.equal((await view(f, { taskId: task.id, goalId: f.goal.id }, 400)).error.code, 'INVALID_INPUT');
  assert.equal(f.company.snapshot().attempts.find(row => row.id === accepted.id).meteredUsage, undefined);
});

test('a model-authored output cannot report usage through the business result', async t => {
  const f = await fixture(t, async input => ({ ...await defaultSimulation(input), meteredUsage: { source: 'codex-app-server', counts: { totalTokens: 1000 } } }));
  const task = f.task();
  await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, task.id));
  const report = await view(f, { taskId: task.id });
  assert.deepEqual(report.attempts.map(row => row.state), ['unknown']);
  assert.deepEqual(report.summary.totalTokens, { reported: 0, subtotal: null });
});

test('a failed paired Codex turn and its successful retry record independent real fixture increments', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const calls = path.join(f.root, 'metered-calls.jsonl');
  const model = { id: 'paired:metering-fixture', model: 'protocol-fixture', runtime: 'codex-app-server', reasoningEffort: 'high',
    persistent: false, command: process.execPath, args: [runner, 'codex-app-server', calls, 'usage-first-failure'], name: 'Protocol fixture' };
  f.store.transaction(() => f.store.put('externalModels', model));
  const paired = new PairedRuntimes(f.company, f.dataDir);
  const adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  const failures = [];
  f.engine.adapter = { reconcile: attempt => adapter.reconcile(attempt), start: async input => {
    const activation = await adapter.start(input);
    activation.result = activation.result.catch(error => {
      failures.push([error.message, error.cause?.message, error.cause?.cause?.message]);
      throw error;
    });
    return activation;
  } };
  const task = f.task();
  await f.start();
  const diagnostics = () => ({ ...taskWaitDiagnostics(f, task.id)(),
    evidence: f.store.list('attempts').filter(attempt => attempt.taskId === task.id).map(({ status, summary, meteredUsage }) => ({ status, summary, meteredUsage })),
    engineError: f.engine.lastError, failures });
  await until(async () => {
    const report = await view(f, { taskId: task.id });
    const current = f.store.require('tasks', task.id);
    assert(!['blocked', 'failed', 'cancelled', 'reconciling'].includes(current.status), JSON.stringify(diagnostics()));
    return current.status === 'succeeded' && report.attempts.length === 2 && report.coverage.reported === 2;
  }, 45000, diagnostics);
  const report = await view(f, { taskId: task.id });
  assert.deepEqual(report.attempts.map(row => row.status), ['completed', 'failed']);
  assert.deepEqual(report.attempts.map(row => row.usage.counts.totalTokens), [25, 25]);
  assert.deepEqual(report.attempts.map(row => row.reasoningEffort), ['high', 'high']);
  assert.deepEqual(report.summary.totalTokens, { reported: 2, subtotal: '50' });
  assert.equal(report.attempts[0].usage.counts.cachedInputTokens, 10);
  assert.equal(report.attempts[0].usage.counts.reasoningOutputTokens, 5);
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
});
