import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, until } from './helpers.js';
import { executionIdentity, ExecutionReceipt, readExecution } from '../src/runtime/execution-receipt.js';
import { fileStem, atomicJson } from '../packages/codex-runtime/lib/store.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { DshAdapter } from '../src/adapters/dsh.js';
import { spawnNode, bounded } from '../src/runtime/owned-process.js';

const runtime = fileURLToPath(new URL('./fixtures/recovery-runtime.mjs', import.meta.url));
const host = fileURLToPath(new URL('./fixtures/recovery-host.mjs', import.meta.url));
const windows = { skip: process.platform !== 'win32', timeout: 25000 };
const response = { executed: true, output: { outcome: 'completed', summary: 'Explicit state fixture', artifacts: [] } };
function identity(overrides = {}, modelOverrides = {}) {
  return executionIdentity({ id: 'paired:fixture', model: 'fixture-model', persistent: true, ...modelOverrides }, { mode: 'task', attemptId: 'attempt-fixture', generation: 1, kind: 'work', contextKey: 'fixture-context', ...overrides });
}
function attempt(ref) { return { id: ref.attemptId, provider: ref.provider, model: ref.model, taskGeneration: ref.generation, contextKey: ref.contextKey, kind: ref.kind, execution: ref }; }
async function hostProcess(t, plan, action) {
  const child = spawnNode({ argv: [process.execPath, host, plan, action], cwd: process.cwd() });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); child.stdin.end();
  t.after(async () => { child.terminate(); await child.done; });
  const outcome = await bounded(child.done, 12000, 'fixture host deadline');
  return { ...outcome, stdout, stderr };
}
test('session and run keys isolate attempt, generation, kind, context, provider, model and retention', () => {
  const ref = identity();
  const next = identity({ attemptId: 'next' });
  assert.equal(ref.threadKey, next.threadKey); assert.notEqual(ref.runKey, next.runKey);
  for (const other of [identity({ generation: 2 }), identity({ kind: 'review' }), identity({ contextKey: 'other' }), identity({}, { id: 'paired:other' }), identity({}, { model: 'other' }), identity({ freshContext: true }), identity({}, { persistent: false })]) {
    assert.notEqual(other.threadKey, ref.threadKey); assert.notEqual(other.runKey, ref.runKey);
  }
  const ephemeral = identity({}, { persistent: false }); assert.equal(ephemeral.threadKey, ephemeral.runKey);
});

for (const field of ['provider', 'model', 'id', 'contextKey', 'taskGeneration', 'kind']) test(`receipt rejects mismatched attempt ${field}`, async t => {
  const f = await fixture(t), ref = identity(), receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish(response);
  const a = attempt(ref); a[field] = field === 'taskGeneration' ? 2 : 'wrong';
  assert.equal(readExecution(f.dataDir, a).code, 'RECOVERY_IDENTITY');
});
for (const field of ['provider', 'model', 'attemptId', 'contextKey', 'generation', 'kind', 'persistent', 'runtime', 'runKey', 'threadKey']) test(`receipt rejects corrupted identity ${field}`, async t => {
  const f = await fixture(t), ref = identity(), receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish(response);
  const raw = JSON.parse(await readFile(receipt.paths.file, 'utf8'));
  raw.identity[field] = field === 'generation' ? 2 : field === 'persistent' ? false : 'wrong';
  await writeFile(receipt.paths.file, JSON.stringify(raw));
  assert.equal(readExecution(f.dataDir, attempt(ref)).status, 'unknown');
});

for (const mode of ['missing', 'corrupt', 'locked', 'lock-access-error', 'running', 'cleanup-uncertain', 'incomplete', 'conflicting', 'timestamp']) test(`state ${mode} keeps reconciliation and never launches a model`, async t => {
  const f = await fixture(t), ref = identity(), a = attempt(ref), receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish(response);
  if (mode === 'missing') await unlink(receipt.paths.file);
  else if (mode === 'corrupt') await writeFile(receipt.paths.file, '{broken');
  else if (mode === 'locked') await writeFile(receipt.paths.lock, '{partial');
  else if (mode === 'lock-access-error') await mkdir(receipt.paths.lock);
  else {
    const raw = JSON.parse(await readFile(receipt.paths.file, 'utf8'));
    if (mode === 'running') raw.status = 'running';
    if (mode === 'cleanup-uncertain') raw.cleanupConfirmed = false;
    if (mode === 'incomplete') raw.response = null;
    if (mode === 'conflicting') raw.status = 'stopped';
    if (mode === 'timestamp') raw.finishedAt = null;
    await writeFile(receipt.paths.file, JSON.stringify(raw));
  }
  const paired = new PairedRuntimes(f.company, f.dataDir, { ownedProcess: () => { assert.fail('must not invoke model'); } });
  const adapter = new DshAdapter({ subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  assert.equal((await adapter.reconcile(a)).status, 'unknown');
  assert((await adapter.progress(a)).reason);
});

test('Codex progress uses the recorded true key, ignores DSH registry, and validates summary identity', async t => {
  const f = await fixture(t), ref = identity({}, { runtime: 'codex-app-server', persistent: false });
  new ExecutionReceipt(f.dataDir, ref);
  const file = path.join(f.dataDir, 'codex-threads', fileStem(ref.threadKey) + '.summary.json');
  atomicJson(file, { key: ref.threadKey, executionIdentity: ref, lastSnippet: 'State fixture progress', threadId: 'fixture-thread' });
  const paired = new PairedRuntimes(f.company, f.dataDir);
  const adapter = new DshAdapter({ subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  assert.equal((await adapter.progress(attempt(ref))).lastSnippet, 'State fixture progress');
  atomicJson(file, { key: ref.threadKey, executionIdentity: { ...ref, attemptId: 'review-attempt' }, lastSnippet: 'must not leak' });
  const progress = await adapter.progress(attempt(ref)); assert.equal(progress.code, 'RECOVERY_IDENTITY'); assert.equal(progress.lastSnippet, undefined);
});

test('only confirmed stopped receipt without complete output permits retry', async t => {
  const f = await fixture(t), ref = identity(), receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish(null, new Error('Explicit fixture: failed before output, cleanup verified'));
  const fact = readExecution(f.dataDir, attempt(ref)); assert.equal(fact.status, 'stopped'); assert.equal(fact.cleanupConfirmed, true);
  assert.deepEqual(fact.actions, ['retry']);
});

test('missing/corrupt receipt keeps engine occupancy and an operator refresh cannot force retry', async t => {
  const f = await fixture(t), task = f.task(), ref = identity();
  const a = { ...attempt(ref), taskId: task.id, goalId: task.goalId, agentId: task.agentId, status: 'running', startedAt: new Date().toISOString() };
  const receipt = new ExecutionReceipt(f.dataDir, ref); receipt.finish(response); await writeFile(receipt.paths.file, '{corrupt');
  f.store.transaction(() => { f.store.put('attempts', a); f.store.put('tasks', { ...task, status: 'running', activeAttemptId: a.id }); });
  let starts = 0;
  f.engine.adapter = { reconcile: old => readExecution(f.dataDir, old), start: () => { starts++; throw new Error('Unexpected model call'); } };
  await f.start();
  assert.equal(f.store.require('tasks', task.id).status, 'reconciling');
  assert.equal(f.store.require('attempts', a.id).cleanupPending, true);
  f.command('task.reconcile', { id: task.id, confirmedStopped: true, evidence: 'An unchecked claim must not release the slot' });
  await until(() => !f.store.require('tasks', task.id).recoveryRequested);
  for (let n = 0; n < 3; n++) await f.engine.tick();
  assert.equal(starts, 0); assert.equal(f.store.list('tasks').length, 1); assert.equal(f.store.require('attempts', a.id).cleanupPending, true);
  assert.equal(f.store.require('attempts', a.id).recovery.code, 'RECOVERY_CORRUPT');
});

test('an already accepted result restores its saved task phase without accepting twice after a lock is resolved', async t => {
  const f = await fixture(t), task = f.task(), ref = identity(), receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish(response); await writeFile(receipt.paths.lock, 'Explicit ambiguous lock fixture');
  const a = { ...attempt(ref), taskId: task.id, goalId: task.goalId, agentId: task.agentId, status: 'completed', resultAccepted: true, cleanupPending: true, startedAt: new Date().toISOString() };
  f.store.transaction(() => { f.store.put('attempts', a); f.store.put('tasks', { ...task, status: 'succeeded', activeAttemptId: a.id }); });
  f.adapter.reconcile = old => readExecution(f.dataDir, old);
  await f.start(); assert.equal(f.store.require('tasks', task.id).status, 'reconciling');
  await unlink(receipt.paths.lock); // test-only resolution; no product operation removes unknown locks
  f.command('task.reconcile', { id: task.id });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(f.adapter.calls.length, 0); assert.equal(f.store.require('attempts', a.id).cleanupPending, false);
});

test('settling a recovered attempt charges only previously unaccounted runtime', async t => {
  const f = await fixture(t), task = f.task();
  const a = { id: 'budget-fixture', taskId: task.id, goalId: task.goalId, status: 'reconciling', startedAt: '2026-01-01T00:00:00.000Z', recoveredFinishedAt: '2026-01-01T00:00:01.000Z', elapsedMs: 1000 };
  f.store.transaction(() => { f.store.put('attempts', a); f.store.put('goals', { ...f.goal, runtimeMs: 1000 }); });
  f.engine.finishAttempt(a, 'completed', 'State fixture');
  assert.equal(f.store.require('goals', f.goal.id).runtimeMs, 1000);
});

test('refresh requested during final cleanup remains pending until the live activation settles', async t => {
  const f = await fixture(t), task = f.task(), ref = identity({ generation: task.generation });
  f.store.transaction(() => f.store.put('tasks', { ...task, status: 'paused' }));
  await f.start();
  const a = { ...attempt(ref), taskId: task.id, goalId: task.goalId, agentId: task.agentId, status: 'reconciling', cleanupPending: true, startedAt: new Date().toISOString() };
  new ExecutionReceipt(f.dataDir, ref).finish({ executed: true, output: { outcome: 'blocked', kind: 'human', reason: 'Explicit lifecycle fixture', question: 'Fixture input' } });
  f.adapter.reconcile = old => readExecution(f.dataDir, old);
  // Explicit lifecycle fixture: the result is durable while the activation is
  // still finishing host-side teardown, so recovery must wait for live removal.
  f.engine.live.set(a.id, { taskId: task.id, controller: new AbortController(), promise: Promise.resolve() });
  f.store.transaction(() => { f.store.put('attempts', a); f.store.put('tasks', { ...task, status: 'reconciling', activeAttemptId: a.id }); });
  f.command('task.reconcile', { id: task.id });
  await f.engine.tick();
  assert.equal(f.store.require('tasks', task.id).recoveryRequested, true);
  assert.equal(f.store.require('attempts', a.id).cleanupPending, true);
  f.engine.live.delete(a.id); f.engine.kick();
  await until(() => f.store.require('tasks', task.id).status === 'blocked');
  assert.equal(f.store.require('attempts', a.id).recovery.status, 'completed');
  assert.equal(f.adapter.calls.length, 0);
});

for (const failurePoint of ['acceptance', 'adapter-bookkeeping']) test(`live completion followed by ${failurePoint} failure recovers without repeating the fixture invocation`, windows, async t => {
  const f = await fixture(t), calls = path.join(f.root, 'fixture-calls.jsonl');
  const model = { id: 'paired:acceptance-fixture', model: 'protocol-fixture', persistent: false, command: process.execPath, args: [runtime, 'runner', calls, 'complete'], name: 'Protocol fixture' };
  f.store.transaction(() => f.store.put('externalModels', model));
  const paired = new PairedRuntimes(f.company, f.dataDir), adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  let rejected = false;
  f.engine.adapter = { reconcile: a => adapter.reconcile(a), start: async input => {
    if (input.task.kind === 'review') return f.adapter.start(input);
    const activation = await adapter.start(input);
    if (failurePoint === 'adapter-bookkeeping') activation.result = activation.result.then(() => {
      rejected = true; throw new Error('Injected acceptance interruption in adapter bookkeeping after receipt commit');
    });
    return activation;
  } };
  const collect = f.workspaces.collect.bind(f.workspaces);
  f.workspaces.collect = async (...args) => { if (failurePoint === 'acceptance' && !rejected) { rejected = true; throw new Error('Injected acceptance interruption after completion'); } return collect(...args); };
  const task = f.task(); await f.start();
  await until(() => f.store.list('attempts').some(a => a.status === 'reconciling'));
  const first = f.store.list('attempts')[0]; assert.equal(first.cleanupPending, true); assert.match(first.recovery.reason, /Injected acceptance/);
  assert.equal(f.store.list('tasks').length, 1);
  const count = await readFile(calls, 'utf8'); assert.equal(count.trim().split('\n').length, 1);
  f.command('task.reconcile', { id: task.id });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(await readFile(calls, 'utf8'), count);
  assert.equal(f.store.require('attempts', first.id).recovery.status, 'completed');
});

for (const terminal of ['completed', 'stopped']) for (const changed of ['generation', 'activeAttemptId']) test(`${terminal} receipt cannot mutate a task with a different ${changed}`, async t => {
  const f = await fixture(t), task = f.task(), ref = identity({ generation: task.generation });
  const receipt = new ExecutionReceipt(f.dataDir, ref);
  receipt.finish(terminal === 'completed' ? response : null);
  const a = { ...attempt(ref), taskId: task.id, goalId: task.goalId, agentId: task.agentId, status: 'running', startedAt: new Date().toISOString() };
  f.store.transaction(() => {
    f.store.put('attempts', a);
    f.store.put('tasks', { ...task, status: 'paused', activeAttemptId: a.id, [changed]: changed === 'generation' ? task.generation + 1 : 'new-attempt' });
  });
  f.adapter.reconcile = old => readExecution(f.dataDir, old);
  await f.start();
  assert.equal(f.store.require('tasks', task.id).status, 'paused');
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(f.store.list('tasks').length, 1);
  assert.equal(f.store.require('attempts', a.id).status, terminal === 'completed' ? 'reconciling' : 'interrupted');
});

test('completed receipt cannot be reused to launch the same attempt; orphan locks block new runs', async t => {
  const f = await fixture(t), ref = identity();
  const model = { id: ref.provider, model: ref.model, persistent: true };
  f.store.transaction(() => f.store.put('externalModels', model));
  const receipt = new ExecutionReceipt(f.dataDir, ref); receipt.finish(response);
  const paired = new PairedRuntimes(f.company, f.dataDir, { ownedProcess: () => assert.fail('duplicate model invocation') });
  await assert.rejects(paired.run(model.id, { mode: 'task', attemptId: ref.attemptId, contextKey: ref.contextKey, generation: ref.generation, kind: ref.kind }), { cleanupUncertain: true });
  assert.equal(readExecution(f.dataDir, attempt(ref)).status, 'completed');
  await writeFile(path.join(f.dataDir, 'paired-runs', 'orphan.json.lock'), '');
  await assert.rejects(new PairedRuntimes(f.company, f.dataDir).run(model.id, { mode: 'task' }), { cleanupUncertain: true });
});

for (const protocol of ['runner', 'codex-app-server']) for (const persistent of [false, true]) test(`${protocol} persistent=${persistent}: separate host recovers completion not yet stored, with no extra invocation`, windows, async t => {
  const f = await fixture(t); let task = f.task(); const workspace = await f.workspaces.prepare(task, {});
  const calls = path.join(f.root, 'fixture-calls.jsonl');
  const model = { id: 'paired:restart', model: 'protocol-fixture', persistent, command: process.execPath, args: [runtime, protocol, calls, 'complete'], ...(protocol === 'runner' ? {} : { runtime: protocol }) };
  const input = { mode: 'task', cwd: workspace.path, prompt: 'Protocol fixture only', attemptId: 'restart-attempt', contextKey: 'isolated-context', generation: task.generation, kind: task.kind };
  const ref = executionIdentity(model, input), a = { ...attempt(ref), taskId: task.id, goalId: task.goalId, agentId: task.agentId, role: 'worker', grants: [], status: 'running', startedAt: new Date().toISOString(), workspace };
  const plan = path.join(f.root, 'host-plan.json'); await writeFile(plan, JSON.stringify({ model, dataDir: f.dataDir, input, attempt: a }));
  const executed = await hostProcess(t, plan, 'run'); assert.equal(executed.exitCode, 0, executed.stderr);
  let count = await readFile(calls, 'utf8'); assert.equal(count.trim().split('\n').length, 1);
  if (persistent) {
    const nextInput = { ...input, attemptId: 'later-attempt' }, nextRef = executionIdentity(model, nextInput);
    assert.equal(nextRef.threadKey, ref.threadKey);
    const nextPlan = path.join(f.root, 'later-plan.json'); await writeFile(nextPlan, JSON.stringify({ model, dataDir: f.dataDir, input: nextInput, attempt: attempt(nextRef) }));
    const next = await hostProcess(t, nextPlan, 'run'); assert.equal(next.exitCode, 0, next.stderr);
    count = await readFile(calls, 'utf8'); assert.equal(count.trim().split('\n').length, 2);
  }
  const recovered = await hostProcess(t, plan, 'read'); assert.equal(recovered.exitCode, 0, recovered.stderr); assert.equal(JSON.parse(recovered.stdout).status, 'completed');
  assert.equal(await readFile(calls, 'utf8'), count);
  f.store.transaction(() => { task = f.store.put('tasks', { ...task, status: 'running', activeAttemptId: a.id, workspace }); f.store.put('attempts', a); });
  const adapter = new DshAdapter({ subagents: { providers: new Map() } }, f.company, f.dataDir);
  f.adapter.reconcile = old => adapter.reconcile(old);
  await f.start(); await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.deepEqual(f.adapter.calls.map(c => c.task.kind), []);
  assert.equal(await readFile(calls, 'utf8'), count);
  assert.equal(f.store.require('attempts', a.id).recovery.status, 'completed');
});

for (const protocol of ['runner', 'codex-app-server']) test(`${protocol}: host crash remains uncertain across restart even when the process has exited`, windows, async t => {
  const f = await fixture(t), calls = path.join(f.root, 'fixture-calls.jsonl');
  const model = { id: 'paired:crash', model: 'protocol-fixture', persistent: false, command: process.execPath, args: [runtime, protocol, calls, 'hold'], ...(protocol === 'runner' ? {} : { runtime: protocol }) };
  const input = { mode: 'task', cwd: f.source, prompt: 'Crash fixture', attemptId: 'crash-attempt', contextKey: 'crash-context', generation: 1, kind: 'work' };
  const ref = executionIdentity(model, input), a = attempt(ref), plan = path.join(f.root, 'crash-plan.json');
  await writeFile(plan, JSON.stringify({ model, input, attempt: a, dataDir: f.dataDir, crash: true }));
  const executed = await hostProcess(t, plan, 'run'); assert.equal(executed.exitCode, 86, executed.stderr);
  const count = await readFile(calls, 'utf8'), pids = count.trim().split('\n').map(s => JSON.parse(s).pid);
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; } }), 10000);
  const result = await hostProcess(t, plan, 'read'); assert.equal(result.exitCode, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'unknown');
  f.store.transaction(() => f.store.put('externalModels', model));
  await assert.rejects(new PairedRuntimes(f.company, f.dataDir).run(model.id, { ...input, attemptId: 'must-not-retry' }), { cleanupUncertain: true });
  assert.equal(await readFile(calls, 'utf8'), count);
});
