import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, gitProject, until } from './helpers.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { canReconcileTask } from '../src/core/task-actions.js';
import { run } from '../src/runtime/workspaces.js';
import { cleanupError } from '../src/runtime/owned-process.js';

const windows = { skip: process.platform !== 'win32' };
const crashHost = fileURLToPath(new URL('./fixtures/integration-crash-host.mjs', import.meta.url));
const records = f => f.store.list('integrations');
const current = (f, task) => f.store.require('tasks', task.id);
const head = async f => (await run('git', ['rev-parse', 'HEAD'], f.source)).stdout.trim();
const sourceDelivery = f => path.join(f.source, 'deliverable.md');
const pending = async f => {
  const task = f.task();
  const workspace = await f.workspaces.prepare(task, {});
  const output = await defaultSimulation({ task: { ...task, workspace } });
  const { artifacts, hash, changeSet } = await f.workspaces.collect({ ...task, workspace }, { id: task.id }, output.artifacts);
  return f.store.transaction(() => {
    for (const artifact of artifacts) f.store.put('artifacts', artifact);
    return f.store.put('tasks', { ...task, workspace, artifactIds: artifacts.map(a => a.id), artifactHash: hash, changeSet, status: 'integrating', integrationPending: true });
  });
};

async function checkingFixture(t) {
  const f = await fixture(t);
  const started = path.join(f.root, 'check-started.json');
  const release = path.join(f.root, 'release-check');
  const check = `
    const fs = require('node:fs'), path = require('node:path');
    if (!process.cwd().split(path.sep).includes('integration') || fs.existsSync(process.argv[2])) process.exit(0);
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
    setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0); }, 25);
  `;
  const before = (await gitProject(f, [{ id: 'hold', command: 'node', args: ['-e', check, started, release], timeoutMs: 30000 }])).trim();
  const task = await pending(f);
  await f.start();
  const pids = await until(async () => {
    try { return JSON.parse(await readFile(started, 'utf8')); } catch { return null; }
  }, 15000);
  return { f, task, before, pids, release };
}

function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

test('queued integration can be paused and cancelled before any command starts', windows, async t => {
  const f = await fixture(t);
  const before = (await gitProject(f)).trim();
  f.command('company.pause', { afterCurrent: true });
  const task = await pending(f);
  await f.start();
  f.command('task.pause', { id: task.id });
  assert.equal(current(f, task).status, 'paused');
  f.command('task.cancel', { id: task.id });
  f.command('company.resume');
  await f.engine.tick();
  assert.equal(current(f, task).status, 'cancelled');
  assert.equal(records(f).length, 0);
  assert.equal(await head(f), before);
  assert.equal(f.adapter.calls.length, 0);
});

test('Git inspection retains its own cleanup hold across refresh and restart', async t => {
  const f = await fixture(t);
  const task = f.task();
  const record = {
    id: 'integration-fixture', taskId: task.id, generation: task.generation,
    artifactHash: 'delivery', phase: 'applying', applyStartedAt: new Date().toISOString(),
    commandId: 'apply-command', targetRoot: f.source, targetRef: 'refs/heads/main', integratedCommit: 'candidate',
  };
  const dir = path.join(f.dataDir, 'integration-receipts');
  await mkdir(dir, { recursive: true });
  const proof = JSON.stringify({ confirmed: true, exitCode: 0 });
  await writeFile(path.join(dir, record.commandId + '.json'), proof);
  f.store.transaction(() => {
    f.store.put('tasks', { ...task, status: 'integrating', activeIntegrationId: record.id, artifactHash: record.artifactHash });
    f.store.put('integrations', record);
  });
  let calls = 0, receipt;
  f.workspaces.runIntegrationCommand = async (_command, args, _cwd, options) => {
    options.beforeStart();
    assert.equal(path.dirname(options.cleanupReceipt), dir);
    if (++calls === 1) {
      receipt = options.cleanupReceipt;
      assert.equal(records(f)[0].inspectionCommandId + '.json', path.basename(receipt));
      throw cleanupError('injected Git inspection cleanup failure');
    }
    await writeFile(options.cleanupReceipt, proof);
    return { code: 0, stdout: args[0] === 'rev-parse' ? 'candidate\n' : '' };
  };

  await f.start();
  const held = records(f)[0];
  assert.equal(held.phase, 'reconciling');
  assert.equal(held.commandId, record.commandId);
  assert.notEqual(held.inspectionCommandId, held.commandId);
  f.command('task.reconcile', { id: task.id });
  await until(() => !current(f, task).recoveryRequested && !f.engine.ticking);
  assert.equal(records(f)[0].inspectionCommandId, held.inspectionCommandId);
  await f.engine.stop();
  await f.engine.start();
  assert.equal(current(f, task).status, 'reconciling');
  assert.equal(records(f)[0].inspectionCommandId, held.inspectionCommandId);
  assert.equal(calls, 1);

  await writeFile(receipt, proof, { flag: 'wx' });
  await until(() => current(f, task).status === 'succeeded');
  assert.equal(current(f, task).integration.integratedCommit, 'candidate');
  assert.equal(records(f)[0].inspectionCommandId, null);
  assert.equal(records(f)[0].phase, 'completed');
  assert.equal(calls, 3);
  assert.equal(f.adapter.calls.length, 0);
});

for (const stop of ['task.pause', 'task.cancel', 'company.pause']) test(`${stop} stops a real candidate check and verifies its process tree`, windows, async t => {
  const { f, task, before, pids, release } = await checkingFixture(t);
  const cancelled = stop === 'task.cancel';
  f.command(stop, stop === 'company.pause' ? {} : { id: task.id });
  const stopping = current(f, task);
  assert.equal(stopping.status, 'stopping');
  assert.equal(canReconcileTask(stopping, []), true);
  await until(() => current(f, task).status === (cancelled ? 'cancelled' : 'paused'));
  assert(pids.every(gone));
  assert.equal(await head(f), before);
  await assert.rejects(readFile(sourceDelivery(f)), { code: 'ENOENT' });
  assert.equal(records(f)[0].phase, 'stopped');
  assert.equal(records(f)[0].stopRequested, cancelled ? 'cancelled' : 'paused');
  if (stop === 'company.pause') {
    await writeFile(release, '');
    f.command('company.resume');
    f.command('task.resume', { id: task.id });
    await until(() => current(f, task).status === 'succeeded', 15000);
    assert.equal(current(f, task).artifactHash, task.artifactHash);
    assert.equal(records(f)[1].phase, 'completed');
  }
  assert.equal(f.adapter.calls.length, 0);
});

test('graceful company pause lets the current candidate finish and holds the next delivery', windows, async t => {
  const { f, task, release } = await checkingFixture(t);
  f.command('company.pause', { afterCurrent: true });
  const queued = await pending(f);
  await writeFile(release, '');
  await until(() => current(f, task).status === 'succeeded', 15000);
  assert.equal(current(f, queued).status, 'integrating');
  assert.deepEqual(records(f).map(row => row.taskId), [task.id]);
  assert.equal(f.adapter.calls.length, 0);
});

test('host shutdown stops the candidate within a bounded wait and preserves the integration checkpoint', windows, async t => {
  const { f, task, before, pids } = await checkingFixture(t);
  const time = Date.now();
  await f.engine.stop();
  assert(Date.now() - time < 8000);
  assert(pids.every(gone));
  assert.equal(await head(f), before);
  assert.equal(current(f, task).status, 'integrating');
  assert.equal(current(f, task).integrationPending, true);
  assert.equal(records(f)[0].phase, 'stopped');
});

test('candidate checks cannot apply to a target HEAD that moved while checking', windows, async t => {
  const { f, task, before, release } = await checkingFixture(t);
  const external = await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'Concurrent owner commit'], f.source);
  assert.equal(external.code, 0, external.stderr);
  const changed = await head(f);
  assert.notEqual(changed, before);
  f.command('company.pause', { afterCurrent: true });
  await writeFile(release, '');
  await until(() => current(f, task).status === 'blocked', 15000);
  assert.equal(await head(f), changed);
  await assert.rejects(readFile(sourceDelivery(f)), { code: 'ENOENT' });
  assert.equal(records(f)[0].phase, 'failed');
  assert.equal(f.adapter.calls.length, 0);
});

test('revoking auto-merge during candidate checks prevents application', windows, async t => {
  const { f, task, before, release } = await checkingFixture(t);
  f.command('project.save', { id: f.project.id, autoMerge: false });
  f.command('company.pause', { afterCurrent: true });
  await writeFile(release, '');
  await until(() => current(f, task).status === 'blocked', 15000);
  assert.equal(await head(f), before);
  assert.equal(records(f)[0].phase, 'failed');
  assert.match(records(f)[0].reason, /authorization or checks changed/);
  assert.equal(f.adapter.calls.length, 0);
});

test('lease loss aborts the candidate and a successor resumes from verified cleanup', windows, async t => {
  const { f, task, before, pids, release } = await checkingFixture(t);
  f.store.releaseLease(f.engine.owner);
  await f.engine.integration;
  assert(pids.every(gone));
  assert.equal(await head(f), before);
  assert.equal(records(f)[0].phase, 'checking');
  await f.engine.stop();
  await writeFile(release, '');
  await f.engine.start();
  await until(() => current(f, task).status === 'succeeded', 15000);
  assert.deepEqual(records(f).map(row => row.phase), ['stopped', 'completed']);
  assert.equal(f.adapter.calls.length, 0);
});

test('cancel after the real fast-forward records the applied commit and the stop request', windows, async t => {
  const f = await fixture(t);
  await gitProject(f);
  const task = await pending(f);
  const integrate = f.workspaces.integrate.bind(f.workspaces);
  f.workspaces.integrate = async (...args) => {
    const result = await integrate(...args);
    f.command('task.cancel', { id: task.id });
    return result;
  };
  await f.start();
  await until(() => current(f, task).status === 'succeeded', 15000);
  assert.equal(current(f, task).integration.integratedCommit, await head(f));
  assert.equal(current(f, task).integration.stopRequested, 'cancelled');
  assert(f.store.page(0, 1000).entries.some(e => e.type === 'integration.completed' && e.stopRequested === 'cancelled'));
  assert.equal(f.adapter.calls.length, 0);
});

test('cancel at final admission prevents the Git command from starting', windows, async t => {
  const f = await fixture(t);
  const before = (await gitProject(f)).trim();
  const task = await pending(f);
  const cancel = event => {
    if (event.type !== 'integration.applying') return;
    f.store.events.off('event', cancel);
    f.command('task.cancel', { id: task.id });
  };
  f.store.events.on('event', cancel);
  await f.start();
  await until(() => current(f, task).status === 'cancelled', 15000);
  assert.equal(await head(f), before);
  assert.equal(records(f)[0].phase, 'stopped');
  await assert.rejects(readFile(sourceDelivery(f)), { code: 'ENOENT' });
  assert.equal(f.adapter.calls.length, 0);
});

for (const missingCleanup of [false, true]) test(`restart after Git applied the candidate ${missingCleanup ? 'with delayed cleanup proof' : 'before result acceptance'}`, windows, async t => {
  const f = await fixture(t);
  const before = (await gitProject(f)).trim();
  const task = await pending(f);
  const crash = await run(process.execPath, [crashHost, f.dataDir], f.root, { timeout: 25000 });
  assert.equal(crash.code, 87, crash.stderr);
  const after = await head(f);
  assert.notEqual(after, before);
  const [inFlight] = records(f);
  assert.equal(inFlight.phase, 'applying');
  assert.equal(inFlight.integratedCommit, after);
  assert.equal(current(f, task).status, 'integrating');
  const receipt = path.join(f.dataDir, 'integration-receipts', inFlight.commandId + '.json');
  const proof = await readFile(receipt);
  if (missingCleanup) await unlink(receipt);
  await f.start();
  if (missingCleanup) {
    assert.equal(current(f, task).status, 'reconciling');
    assert.equal(current(f, task).integrationRecovery.observed, null);
    assert.equal(records(f)[0].inspectionCommandId, undefined);
    assert.equal(records(f)[0].phase, 'reconciling');
    assert.equal(canReconcileTask(current(f, task), []), true);
    f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
    const waiting = f.task({ title: 'Do not dispatch into the unconfirmed slot' });
    await f.engine.tick();
    assert.equal(current(f, waiting).status, 'ready');
    f.command('task.cancel', { id: waiting.id });
    await writeFile(receipt, proof, { flag: 'wx' });
  }
  await until(() => current(f, task).status === 'succeeded', 15000);
  assert.equal(await head(f), after);
  assert.equal(current(f, task).integration.proof, 'target-history');
  assert.deepEqual(records(f).map(row => row.phase), ['completed']);
  assert.equal(f.store.page(0, 1000).entries.filter(e => e.type === 'integration.applying').length, 1);
  assert.equal(f.adapter.calls.length, 0);
});
