import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCodexRun } from '../lib/index.js';
import { ThreadStore } from '../lib/store.js';
import { startOwnedProcess } from '../../../src/runtime/owned-process.js';

const fakeBin = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-runtime-life-'));
  const stateFile = join(root, 'codex-threads.json');
  const children = [];
  const ctx = {
    subprocess: { spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: 'pipe', env: { ...process.env, ...spec.env }, windowsHide: true });
      children.push(child);
      const done = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done,
        terminate() { if (child.exitCode === null) child.kill(); },
        async waitForExit(signal) { if (signal?.aborted) return false; await done; return true; } };
    } }
  };
  t.after(() => {
    for (const child of children) assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'owned child must be reaped');
    rmSync(root, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
  });
  return {
    root, stateFile, children,
    runtime(mode = 'success', options = {}) {
      return { async start(request) {
        const store = new ThreadStore(stateFile, 'test:one');
        try {
          store.update({ status: 'starting', terminalResult: null });
          return await startCodexRun(request, { codexBin: fakeBin, cwd: root, store,
            model: 'fixture-model', permissionMode: 'acms-workspace',
            startupTimeoutMs: 2000, turnTimeoutMs: 2000, disposeGraceMs: 100,
            env: { FAKE_DB: join(root, 'fake-db.json'), FAKE_MODE: mode },
            spawn: spec => ctx.subprocess.spawn(spec), onError: () => {}, ...options });
        } catch (error) {
          await store.close(error.timedOut ? 'timeout' : 'failed');
          throw error;
        }
      } };
    },
    request(signal = new AbortController().signal) { return { prompt: [{ type: 'text', text: 'Test' }], label: 'test:one', cwd: root, parent: { id: 'parent' }, signal }; },
    summary() { return JSON.parse(readFileSync(stateFile, 'utf8'))['test:one']; }
  };
}

test('separate app-server processes resume the same ID and return IDs; locks survive until cleanup', async t => {
  const f = fixture(t);
  const provider = f.runtime();
  const first = await provider.start(f.request());
  await assert.rejects(provider.start(f.request()), { code: 'CODEX_THREAD_BUSY' });
  const a = await first.result;
  await first.dispose();
  const second = await provider.start(f.request());
  const b = await second.result;
  await second.dispose();
  assert.equal(a.stopReason, 'completed');
  assert.equal(b.stopReason, 'completed');
  assert.equal(a.threadId, b.threadId);
  assert.notEqual(a.turnId, b.turnId);
  assert.notEqual(f.children[0].pid, f.children[1].pid);
  assert.equal(f.summary().turns, 2);
  assert.equal(f.summary().status, 'idle');
  assert.equal(f.summary().totalToolCalls, 2);
  const events = readFileSync(join(f.root, f.summary().eventFile), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.method === 'provider/threadReady' && e.params.resumed).length, 1);
  assert.equal(events.filter(e => e.method === 'turn/started').length, 2);
});

test('transport product failure is returned as error with original HTTP classification', async t => {
  const f = fixture(t);
  const run = await f.runtime('failure').start(f.request());
  const result = await run.result;
  await run.dispose();
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /category: transport; HTTP status: 503/);
  assert.equal(f.summary().failure.category, 'transport');
});

test('app-server exit keeps the thread ID and a new dispatch resumes it', async t => {
  const f = fixture(t);
  const run = await f.runtime('process-exit').start(f.request());
  const failed = await run.result;
  await run.dispose();
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.diagnostic, /category: process/);
  const retry = await f.runtime().start(f.request());
  const result = await retry.result;
  await retry.dispose();
  assert.equal(result.threadId, failed.threadId);
  assert.equal(result.stopReason, 'completed');
});

test('turn timeout and explicit interruption both settle and release locks', async t => {
  const f = fixture(t);
  const timeoutRun = await f.runtime('turn-timeout', { turnTimeoutMs: 80 }).start(f.request());
  const timed = await timeoutRun.result;
  await timeoutRun.dispose();
  assert.equal(timed.stopReason, 'error');
  assert.match(timed.diagnostic, /timeout exceeded/);
  assert.equal(f.summary().lastStatus, 'timeout');
  const cancel = await f.runtime('cancel').start(f.request());
  await cancel.dispose();
  const cancelled = await cancel.result;
  assert.equal(cancelled.stopReason, 'aborted');
  assert.equal(f.summary().lastStatus, 'aborted');
  assert.equal(f.summary().status, 'idle');
});

test('startup timeout rejects before publication, reaps the process, and clears the lease', async t => {
  const f = fixture(t);
  await assert.rejects(f.runtime('startup-timeout', { startupTimeoutMs: 80 }).start(f.request()), /stage: initialize/);
  assert.equal(f.summary().lastStatus, 'timeout');
  const retry = await f.runtime().start(f.request());
  assert.equal((await retry.result).stopReason, 'completed');
  await retry.dispose();
});

for (const failure of ['denied', 'timeout', 'false']) test(`cleanup ${failure} retains a durable lease after a completed turn`, async t => {
  const f = fixture(t);
  let store;
  const run = await startCodexRun(f.request(), {
    codexBin: fakeBin, cwd: f.root, store: store = new ThreadStore(f.stateFile, 'fault'),
    model: 'fixture-model', permissionMode: 'acms-workspace', startupTimeoutMs: 2000, turnTimeoutMs: 2000, disposeGraceMs: 50,
    env: { FAKE_DB: join(f.root, 'fault-db.json'), FAKE_MODE: 'success' }, onError: () => {},
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: 'pipe', env: { ...process.env, ...spec.env }, windowsHide: true });
      f.children.push(child);
      const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => resolve({ exitCode })); });
      return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done,
        terminate: () => child.kill(),
        waitForExit: () => failure === 'denied' ? Promise.reject(new Error('injected access denied')) : failure === 'timeout' ? new Promise(() => {}) : Promise.resolve(false),
      };
    },
  });
  assert.equal((await run.result).stopReason, 'completed');
  const before = Date.now();
  await assert.rejects(run.dispose(), { cleanupUncertain: true });
  assert(Date.now() - before < 1000);
  assert.equal(store.summary.status, 'reconciling'); assert.equal(store.summary.cleanupPending, true);
  assert.equal(existsSync(store.lockPath), true);
  assert.throws(() => new ThreadStore(f.stateFile, 'fault'), { code: 'CODEX_THREAD_BUSY' });
  await new Promise(resolve => setTimeout(resolve, 30));
});

test('startup failure plus uncertain cleanup preserves error identity and lease before a handle exists', async t => {
  const f = fixture(t); const store = new ThreadStore(f.stateFile, 'startup-fault');
  const { PassThrough } = await import('node:stream');
  await assert.rejects(startCodexRun(f.request(), {
    store, cwd: f.root, model: 'fixture-model', permissionMode: 'acms-workspace', startupTimeoutMs: 30, disposeGraceMs: 50,
    spawn: () => ({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), done: new Promise(() => {}), terminate() {}, waitForExit: () => new Promise(() => {}) }),
  }), error => error.cleanupUncertain && error instanceof AggregateError && /initialize/.test(error.message));
  assert.equal(store.summary.cleanupPending, true); assert.equal(existsSync(store.lockPath), true);
  await assert.rejects(store.close('failed'), { cleanupUncertain: true });
});

test('an uncertain asynchronous spawn failure quarantines before returning to the caller', async t => {
  const f = fixture(t); const store = new ThreadStore(f.stateFile, 'spawn-fault');
  await assert.rejects(startCodexRun(f.request(), {
    store, cwd: f.root, spawn: async () => { throw Object.assign(new Error('injected launch service lost its receipt'), { cleanupUncertain: true }); },
  }), { cleanupUncertain: true, code: 'PAIRED_CLEANUP_UNCONFIRMED' });
  assert.equal(store.summary.cleanupPending, true); assert.equal(existsSync(store.lockPath), true);
  await assert.rejects(store.close('failed'), { cleanupUncertain: true });
});

test('app-server uses verified native containment on normal completion and startup timeout', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  for (const mode of ['success', 'startup-timeout']) {
    const store = new ThreadStore(f.stateFile, `native-${mode}`);
    const pending = startCodexRun(f.request(), {
      store, codexBin: fakeBin, cwd: f.root, model: 'fixture-model', permissionMode: 'acms-workspace', startupTimeoutMs: mode === 'success' ? 2000 : 100, turnTimeoutMs: 2000, disposeGraceMs: 1000,
      spawn: spec => startOwnedProcess(spec, { cleanupMs: 900 }),
      env: { FAKE_DB: join(f.root, 'native-db.json'), FAKE_MODE: mode }, onError: () => {},
    });
    if (mode === 'success') {
      const run = await pending; assert.equal((await run.result).stopReason, 'completed'); await run.dispose();
      assert.equal(store.summary.status, 'idle'); assert.equal(existsSync(store.lockPath), false);
    } else {
      await assert.rejects(pending, error => !error.cleanupUncertain && /initialize/.test(error.message));
      await store.close('failed'); assert.equal(existsSync(store.lockPath), false);
    }
  }
});
