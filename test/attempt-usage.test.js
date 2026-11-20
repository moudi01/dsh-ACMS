import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshAdapter } from '../src/adapters/dsh.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { createRoutes } from '../src/host/http.js';
import { executionIdentity, ExecutionReceipt, readExecution } from '../src/runtime/execution-receipt.js';
import { withAttemptUsage } from '../src/runtime/attempt-usage.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const runner = fileURLToPath(new URL('./fixtures/recovery-runtime.mjs', import.meta.url));
async function view(f, params, status = 200) {
  const route = createRoutes(f).find(route => route.path === '/api/acms/usage');
  const response = await route.fetch(new Request(`http://127.0.0.1/api/acms/usage?${new URLSearchParams(params)}`));
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

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
