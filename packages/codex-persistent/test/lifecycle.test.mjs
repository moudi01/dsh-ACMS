import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';

const fakeBin = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-persistent-life-'));
  const stateFile = join(root, 'codex-threads.json');
  const children = [];
  const providers = [];
  const ctx = {
    logger: { warn() {} },
    subagents: { registerProvider(provider) { providers.push(provider); } },
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
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, stateFile, children,
    provider(mode = 'success', options = {}) {
      apply(ctx, { codexBin: fakeBin, stateFile, startupTimeoutMs: 2000, turnTimeoutMs: 2000, disposeGraceMs: 100,
        env: { FAKE_DB: join(root, 'fake-db.json'), FAKE_MODE: mode }, ...options });
      return providers.at(-1);
    },
    request(signal = new AbortController().signal) { return { prompt: [{ type: 'text', text: 'Test' }], label: 'test:one', cwd: root, parent: { id: 'parent' }, signal }; },
    summary() { return JSON.parse(readFileSync(stateFile, 'utf8'))['test:one']; }
  };
}

test('separate app-server processes resume the same ID and return IDs; locks survive until cleanup', async t => {
  const f = fixture(t);
  const provider = f.provider();
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
  const run = await f.provider('failure').start(f.request());
  const result = await run.result;
  await run.dispose();
  assert.equal(result.stopReason, 'error');
  assert.match(result.diagnostic, /category: transport; HTTP status: 503/);
  assert.equal(f.summary().failure.category, 'transport');
});

test('app-server exit keeps the thread ID and a new dispatch resumes it', async t => {
  const f = fixture(t);
  const run = await f.provider('process-exit').start(f.request());
  const failed = await run.result;
  await run.dispose();
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.diagnostic, /category: process/);
  const retry = await f.provider().start(f.request());
  const result = await retry.result;
  await retry.dispose();
  assert.equal(result.threadId, failed.threadId);
  assert.equal(result.stopReason, 'completed');
});

test('turn timeout and explicit interruption both settle and release locks', async t => {
  const f = fixture(t);
  const timeoutRun = await f.provider('turn-timeout', { turnTimeoutMs: 80 }).start(f.request());
  const timed = await timeoutRun.result;
  await timeoutRun.dispose();
  assert.equal(timed.stopReason, 'error');
  assert.match(timed.diagnostic, /timeout exceeded/);
  assert.equal(f.summary().lastStatus, 'timeout');
  const cancel = await f.provider('cancel').start(f.request());
  await cancel.dispose();
  const cancelled = await cancel.result;
  assert.equal(cancelled.stopReason, 'aborted');
  assert.equal(f.summary().lastStatus, 'aborted');
  assert.equal(f.summary().status, 'idle');
});

test('startup timeout rejects before publication, reaps the process, and clears the lease', async t => {
  const f = fixture(t);
  await assert.rejects(f.provider('startup-timeout', { startupTimeoutMs: 80 }).start(f.request()), /stage: initialize/);
  assert.equal(f.summary().lastStatus, 'timeout');
  const retry = await f.provider().start(f.request());
  assert.equal((await retry.result).stopReason, 'completed');
  await retry.dispose();
});
