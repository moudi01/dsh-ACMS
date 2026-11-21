import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startCodexRun } from '../packages/codex-runtime/lib/index.js';
import { ThreadStore } from '../packages/codex-runtime/lib/store.js';

const windows = { skip: process.platform !== 'win32', timeout: 30000 };
const phaseChannel = channel('acms.owned-process.native-phase');

async function fixture(t) {
  const temp = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temp, 'acms-native-start-'));
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = root;
  process.env.TMP = root;
  const phases = [];
  const observed = value => phases.push(value);
  phaseChannel.subscribe(observed);
  t.after(async () => {
    phaseChannel.unsubscribe(observed);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const relative = path.relative(temp, root);
    assert.match(relative, /^acms-native-start-[a-zA-Z0-9]+$/);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const module = new URL('../src/runtime/owned-process.js', import.meta.url);
  module.search = randomUUID();
  return { root, phases, ...await import(module.href) };
}

function interceptCompiler(t, intercept) {
  const spawn = childProcess.spawn;
  const mock = t.mock.method(childProcess, 'spawn', (file, args, options) =>
    path.basename(file).toLowerCase() === 'csc.exe' ? intercept(() => spawn(file, args, options), args, options) : spawn(file, args, options));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

async function verifiedExit(child) {
  child.stdin.end();
  child.stdout.resume();
  child.stderr.resume();
  const result = await child.done;
  assert.equal(result.cleanup.confirmed, true);
  assert.equal(result.exitCode, 0);
}

test('a cold Windows compiler is shared, cancellation prevents dispatch, and warm jobs reuse the helper', windows, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('Cancel only this waiting caller');
  let compiles = 0;
  interceptCompiler(t, (launch, _args, options) => {
    compiles++;
    assert.equal(options.stdio, 'ignore');
    const child = launch();
    child.once('spawn', () => controller.abort(reason));
    return child;
  });
  const spec = { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: f.root,
    env: { FIXTURE_PRIVATE_VALUE: 'must-not-enter-phase-logs' } };
  const first = f.startOwnedProcess(spec);
  const cancelled = f.startOwnedProcess(spec, { signal: controller.signal, spawn: () => assert.fail('cancelled request dispatched') });
  const other = f.startOwnedProcess(spec);
  await Promise.all([first.then(verifiedExit), other.then(verifiedExit), assert.rejects(cancelled, error => error === reason)]);
  await verifiedExit(await f.startOwnedProcess(spec));
  assert.equal(compiles, 1);
  const compilation = f.phases.filter(record => record.phase === 'helper-compile');
  assert.deepEqual(compilation.map(({ outcome, exitCode, deadlineMs }) => [outcome, exitCode, deadlineMs]), [['compiled', 0, 10000]]);
  assert.ok(f.phases.some(phase => phase.phase === 'helper-lookup' && phase.outcome === 'found'));
  assert.deepEqual(f.phases.filter(phase => phase.phase === 'helper-acquire').map(phase => phase.use).sort(), ['cold', 'shared', 'shared', 'warm']);
  assert.equal(f.phases.filter(phase => phase.phase === 'supervisor-handshake' && phase.outcome === 'started').length, 3);
  assert.equal(f.phases.filter(phase => phase.phase === 'supervisor-cleanup' && phase.jobConfirmed && phase.supervisorExited && phase.confirmed).length, 3);
  assert.ok(f.phases.every(phase => Number.isSafeInteger(phase.elapsedMs) && phase.elapsedMs >= 0));
  const recorded = JSON.stringify(f.phases);
  assert.equal(recorded.includes(f.root) || recorded.includes('argv') || recorded.includes('must-not-enter'), false);
  t.diagnostic('Native helper phases ' + recorded);
});

function compilerFaults(t) {
  const spawned = Promise.withResolvers();
  const termination = Promise.withResolvers();
  let first, target, count = 0, killRequests = 0;
  interceptCompiler(t, (launch, args) => {
    if (++count > 1) return launch();
    const child = new EventEmitter();
    child.pid = 12345; // An instrumented child handle, never a real PID operation.
    child.kill = () => { killRequests++; termination.resolve(); return true; };
    first = child;
    target = path.dirname(args.find(argument => argument.startsWith('/out:')).slice(5));
    spawned.resolve();
    return child;
  });
  return { spawned: spawned.promise, termination: termination.promise, first: () => first, target: () => target,
    count: () => count, killRequests: () => killRequests };
}

function startFixture(f, store) {
  return startCodexRun({ prompt: [{ type: 'text', text: 'fixture' }], signal: new AbortController().signal }, {
    cwd: f.root, store, model: 'fixture', argv: ['fixture-only'], startupTimeoutMs: 100, disposeGraceMs: 100,
    spawn: spec => f.startOwnedProcess(spec, { spawn: () => assert.fail('failed bootstrap dispatched a supervisor') }),
  });
}

test('missing compiler lookup is reported without launching or leaking the temporary source path', windows, async t => {
  const f = await fixture(t);
  const systemRoot = process.env.SystemRoot;
  const privatePath = path.join(f.root, 'missing-system-directory');
  try {
    process.env.SystemRoot = privatePath;
    await assert.rejects(f.startOwnedProcess({ argv: ['unused'], cwd: f.root }, { spawn: () => assert.fail('missing helper dispatched') }),
      error => error.noProcessStarted && !error.cleanupUncertain && error.ownedProcessPhases[0].phase === 'helper-lookup' &&
        /unavailable/.test(error.message) && !error.message.includes(privatePath));
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
  assert.deepEqual(f.phases.map(phase => phase.phase), ['helper-lookup', 'helper-acquire']);
});

test('a supervisor handshake deadline does not treat exit without a job receipt as cleanup', windows, async t => {
  const f = await fixture(t);
  let supervisor;
  const run = await f.startOwnedProcess({ argv: ['unused'], cwd: f.root }, {
    helperPath: 'injected', startupMs: 40, cleanupMs: 100,
    spawn() { return supervisor = f.spawnNode({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 3000)'] }); },
  });
  run.stdout.resume();
  run.stderr.resume();
  await assert.rejects(run.done, error => error.cleanupUncertain &&
    error.ownedProcessPhases[0].outcome === 'deadline' &&
    error.ownedProcessPhases[1].jobConfirmed === false && error.ownedProcessPhases[1].confirmed === false);
  await supervisor.done;
  assert.ok(f.phases.some(phase => phase.phase === 'supervisor-handshake' && phase.deadlineMs === 40));
});

test('a nonzero compiler exit records the time and code without compiler output and permits retry', windows, async t => {
  const f = await fixture(t);
  const faults = compilerFaults(t);
  const store = new ThreadStore(path.join(f.root, 'codex-threads.json'), 'compiler-failure');
  const failed = assert.rejects(startFixture(f, store), error =>
    error.noProcessStarted && !error.cleanupUncertain && /helper-compile: failed/.test(error.message) &&
    /exitCode=17/.test(error.message) && error.facts.containment.at(-1).confirmed);
  await faults.spawned;
  faults.first().emit('exit', 17, null);
  await failed;
  assert.equal(faults.killRequests(), 0);
  assert.equal(store.summary.cleanupPending, undefined);
  await store.close('failed');
  await assert.rejects(access(store.lockPath), { code: 'ENOENT' });
  await assert.rejects(access(faults.target()), { code: 'ENOENT' });
  await verifiedExit(await f.startOwnedProcess({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd: f.root }));
  assert.equal(faults.count(), 2);
});

for (const mode of ['timeout-exit', 'timeout-unconfirmed', 'process-error-unconfirmed']) test('compiler cleanup requires actual exit evidence (' + mode + ')', windows, async t => {
  const f = await fixture(t);
  const faults = compilerFaults(t);
  const observedExit = mode === 'timeout-exit';
  const timeout = mode !== 'process-error-unconfirmed';
  const state = path.join(f.root, 'codex-threads.json');
  const store = new ThreadStore(state, 'compiler-timeout');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = assert.rejects(startFixture(f, store), error => {
    assert.ok(error.message.includes('helper-compile: ' + (timeout ? 'deadline' : 'process-error')));
    assert.equal(error.message.includes('private compiler output'), false);
    assert.equal(JSON.stringify(error.facts).includes(f.root), false);
    assert.equal(error.facts.containment.at(-1).confirmed, observedExit);
    assert.equal(!!error.cleanupUncertain, !observedExit);
    assert.equal(!!error.noProcessStarted, observedExit);
    return true;
  });
  await faults.spawned;
  if (timeout) t.mock.timers.tick(10000);
  else faults.first().emit('error', new Error('private compiler output at ' + f.root));
  await faults.termination;
  // Neither the kill request nor losing the compiler's channel proves exit.
  faults.first().emit('close', 0, null);
  if (observedExit) faults.first().emit('exit', null, 'SIGTERM');
  else t.mock.timers.tick(1000);
  await failed;
  assert.equal(faults.killRequests(), 1);
  if (observedExit) {
    assert.equal(store.summary.cleanupPending, undefined);
    await store.close('failed');
    await assert.rejects(access(store.lockPath), { code: 'ENOENT' });
    await assert.rejects(access(faults.target()), { code: 'ENOENT' });
  } else {
    assert.equal(store.summary.cleanupPending, true);
    await access(store.lockPath);
    await access(faults.target());
    await assert.rejects(f.startOwnedProcess({ argv: ['unused'], cwd: f.root }), { cleanupUncertain: true });
    assert.equal(faults.count(), 1);
    const recovered = Promise.withResolvers();
    const recordExit = phase => { if (phase.outcome === 'late-exit') recovered.resolve(phase); };
    phaseChannel.subscribe(recordExit);
    try {
      faults.first().emit('exit', 11, null);
      assert.equal((await recovered.promise).exitCode, 11);
      await new Promise(resolve => setImmediate(resolve));
    } finally { phaseChannel.unsubscribe(recordExit); }
    await assert.rejects(access(faults.target()), { code: 'ENOENT' });
    assert.equal(store.summary.cleanupPending, true, 'late compiler exit does not rewrite a quarantined task receipt');
  }
  t.mock.timers.reset();
  await verifiedExit(await f.startOwnedProcess({ argv: [process.execPath, '-e', 'process.exit(0)'], cwd: f.root }));
  assert.equal(faults.count(), 2);
});
