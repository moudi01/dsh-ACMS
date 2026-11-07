import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, until } from './helpers.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { DshAdapter } from '../src/adapters/dsh.js';
import { cleanupError } from '../src/runtime/owned-process.js';

const tree = fileURLToPath(new URL('./fixtures/owned-tree.mjs', import.meta.url));
function register(f, args = []) {
  const model = { id: 'paired:cleanup-fixture', command: process.execPath, args, model: 'process-fixture', persistent: false, name: 'Process fixture' };
  f.store.transaction(() => f.store.put('externalModels', model)); return model;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }

for (const mode of ['cancel', 'timeout', 'overflow']) test(`paired ${mode} cleans real child/grandchild before releasing its slot`, { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const f = await fixture(t), file = path.join(f.root, 'tree-pids.jsonl');
  const model = register(f, [tree, file, mode === 'overflow' ? mode : 'hold']);
  const paired = new PairedRuntimes({ store: f.store, policy: () => ({ turnTimeoutMs: 1000 }) }, f.dataDir);
  const controller = new AbortController(); let pids = [];
  const result = paired.run(model.id, { mode: 'task', cwd: f.source }, controller.signal);
  const rejected = assert.rejects(result, error => {
    assert(!error.cleanupUncertain, error.message);
    assert.match(error.message, mode === 'cancel' ? /fixture cancellation/ : mode === 'timeout' ? /超时/ : /2 MiB/); return true;
  });
  t.after(async () => { controller.abort(); await result.catch(() => {}); await until(() => pids.every(pid => !alive(pid)), 10000); });
  await until(async () => { try { pids = (await readFile(file, 'utf8')).trim().split('\n').map(x => JSON.parse(x).pid); return pids.length === 3; } catch { return false; } });
  if (mode === 'cancel') controller.abort(new Error('fixture cancellation'));
  await rejected;
  assert(pids.every(pid => !alive(pid))); assert.equal(paired.running.size, 0);
});

for (const mode of ['cancel', 'timeout', 'overflow', 'startup']) test(`paired ${mode} keeps a quarantine when cleanup cannot be proved`, async t => {
  const f = await fixture(t); const model = register(f);
  const controller = new AbortController(); let launches = 0;
  const paired = new PairedRuntimes({ store: f.store, policy: () => ({ turnTimeoutMs: 30 }) }, f.dataDir, {
    cleanupMs: 60,
    ownedProcess: async () => {
      launches++;
      if (mode === 'startup') throw cleanupError('injected startup cleanup uncertainty');
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      setImmediate(() => {
        if (mode === 'cancel') controller.abort(new Error('cancel'));
        if (mode === 'overflow') stdout.end('x'.repeat(2097153));
      });
      return { stdin, stdout, stderr, done: new Promise(() => {}), cleanup: () => new Promise(() => {}) };
    },
  });
  const before = Date.now();
  await assert.rejects(paired.run(model.id, { mode: 'task', cwd: f.source }, controller.signal), { cleanupUncertain: true });
  assert(Date.now() - before < 1000); assert.equal(paired.running.size, 1);
  assert.equal([...paired.running.values()][0].cleanupUncertain, true);
  await assert.rejects(paired.run(model.id, { mode: 'task', cwd: f.source }), { cleanupUncertain: true });
  assert.equal(launches, 1); assert.throws(() => paired.forget(model.id), { code: 'MODEL_IN_USE' });
});

test('uncertain startup without an activation retains attempt and agent across restart; no repair or redispatch', async t => {
  const f = await fixture(t); let starts = 0;
  f.engine.adapter = {
    async start() { starts++; throw cleanupError('injected startup tree still unknown'); },
    async reconcile() { return { status: 'stopped', reason: 'only root stopped' }; },
  };
  const task = f.task(); await f.start();
  await until(() => f.store.list('attempts').some(a => a.cleanupUncertain));
  let attempt = f.store.list('attempts')[0];
  assert.equal(attempt.status, 'reconciling'); assert.equal(attempt.cleanupPending, true);
  assert.match(attempt.cleanupError, /startup tree/);
  assert.equal(f.store.require('tasks', task.id).status, 'reconciling');
  assert.equal(f.store.require('agents', task.agentId).status, 'available');
  await f.engine.stop(); await f.engine.start();
  attempt = f.store.require('attempts', attempt.id);
  assert.equal(attempt.cleanupPending, true); assert.equal(attempt.status, 'reconciling');
  assert.equal(f.store.list('tasks').length, 1);
  // Even an independently changed assignment/ready task cannot bypass its hold.
  f.store.transaction(() => f.store.put('tasks', { ...f.store.require('tasks', task.id), status: 'ready', agentId: 'manager' }));
  for (let i = 0; i < 5; i++) await f.engine.tick();
  assert.equal(starts, 1); assert.equal(f.store.list('attempts').length, 1);
});

test('uncertain manual probe retains diagnostic capacity', async t => {
  const f = await fixture(t); const model = register(f);
  const paired = new PairedRuntimes(f.company, f.dataDir, { ownedProcess: async () => { throw cleanupError('injected probe containment failure'); } });
  const adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  const result = await adapter.probeModel({ provider: model.id, model: model.model });
  assert.equal(result.status, 'unavailable'); assert.match(result.reason, /containment failure/);
  assert.equal(adapter.activeProbes, 1);
  await assert.rejects(adapter.probeModel({ provider: model.id, model: model.model }), { code: 'MODEL_CHECK_BUSY' });
});
