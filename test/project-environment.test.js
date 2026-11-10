import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { runContained } from '../src/runtime/host-command.js';
import { prepareDependencies } from '../src/runtime/project-environment.js';
import { fixture, gitProject, until } from './helpers.js';
import { cleanupError } from '../src/runtime/owned-process.js';

const windows = { skip: process.platform !== 'win32', timeout: 30000 };
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const tree = fileURLToPath(new URL('./fixtures/owned-tree.mjs', import.meta.url));
const writeJson = (file, object) => writeFile(file, JSON.stringify(object));

async function offlinePackage(f) {
  const packageDir = path.join(f.root, 'package');
  const cache = path.join(f.root, 'seed-cache');
  await mkdir(packageDir);
  await writeJson(path.join(packageDir, 'package.json'), { name: 'acms-fixture-dependency', version: '1.0.0', main: 'index.js' });
  await writeFile(path.join(packageDir, 'index.js'), 'module.exports = 42;');
  const npm = async (...args) => {
    const result = await runContained(process.execPath, [npmCli, ...args, '--cache', cache, '--offline', '--ignore-scripts'], packageDir);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  const [packed] = JSON.parse(await npm('pack', '--json'));
  await npm('cache', 'add', path.join(packageDir, packed.filename));
  const dependencies = { 'acms-fixture-dependency': '1.0.0' };
  await writeJson(path.join(f.source, 'package.json'), { name: 'fixture-project', version: '1.0.0', dependencies });
  await writeJson(path.join(f.source, 'package-lock.json'), { name: 'fixture-project', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture-project', version: '1.0.0', dependencies },
      'node_modules/acms-fixture-dependency': { version: '1.0.0', resolved: 'https://registry.npmjs.org/acms-fixture-dependency/-/acms-fixture-dependency-1.0.0.tgz', integrity: packed.integrity } } });
  return { command: process.execPath, args: [npmCli], cacheSeed: cache, timeoutMs: 12000 };
}

test('offline lockfile preparation works in a Git worktree, in the check copy and in an independent reviewer copy', windows, async t => {
  const dispatched = [];
  const f = await fixture(t, async input => {
    const { task, prompt } = input;
    assert.match(await readFile(path.join(task.workspace.path, 'node_modules', 'acms-fixture-dependency', 'index.js'), 'utf8'), /42/);
    dispatched.push(input);
    if (task.kind === 'review') {
      const contract = JSON.parse(prompt.split('\nCONTRACT:\n')[1]);
      assert.equal(contract.review.checks.checks[0].id, 'node-check');
      assert.equal(contract.review.checks.checks[0].passed, true);
      assert(!Object.hasOwn(contract.review.checks.checks[0], 'stdout'));
      return { outcome: 'reviewed', decision: 'changes_requested', summary: 'Product defect observed despite an independent esbuild directory restriction',
        findings: ['The fixture has an independent product defect.'],
        rework: { category: 'product-defect', evidence: 'Independent product evidence', scope: 'Fix implementation', affectedEntrypoints: [] } };
    }
    return defaultSimulation(input);
  });
  const preparation = await offlinePackage(f);
  await gitProject(f);
  f.command('project.save', { id: f.project.id, autoMerge: false, preparation,
    checks: [{ id: 'node-check', command: 'node', args: ['-e', "process.exit(require('acms-fixture-dependency') === 42 ? 0 : 1)"],
      requiredPackages: ['acms-fixture-dependency'] }] });
  const task = f.task();
  await f.start();
  await until(() => {
    const current = f.store.require('tasks', task.id);
    assert(!current.environmentBlock, JSON.stringify(current.environmentBlock));
    return current.status === 'succeeded';
  }, 20000);
  const delivered = f.store.require('tasks', task.id);
  assert(!delivered.changeSet.some(file => file.path.includes('node_modules')));
  const review = f.command('review.request', { id: task.id });
  await until(() => f.store.require('tasks', review.id).status === 'succeeded', 15000);
  assert.equal(f.store.require('tasks', review.id).passed, false);
  assert.equal(f.store.require('tasks', review.id).environmentBlock, undefined);
  assert.notEqual(dispatched[0].task.workspace.path, dispatched[1].task.workspace.path);
  await assert.rejects(stat(path.join(f.source, 'node_modules')), { code: 'ENOENT' });
  const check = f.store.list('verifications').find(v => v.kind === 'checks' && v.taskId === task.id).checks[0];
  assert.equal(check.inputUnchanged, true);
  assert.equal(check.preparation.cleanupConfirmed, true);
  assert.notEqual(check.cwd, delivered.workspace.path);
  assert.match(check.log.hash, /^[a-f0-9]{64}$/);
});

test('an empty offline cache blocks before model dispatch without consuming a retry', windows, async t => {
  const f = await fixture(t);
  const { cacheSeed, ...preparation } = await offlinePackage(f);
  f.command('project.save', { id: f.project.id, preparation });
  const task = f.task();
  await f.start();
  const blocked = await until(() => f.store.require('tasks', task.id).environmentBlock, 12000);
  assert.equal(blocked.failures[0].code, 'preparation');
  assert.equal(blocked.report.host.preparationFailure.code, 1);
  assert.equal(f.store.require('tasks', task.id).attempts, 0);
  assert.equal(f.adapter.calls.length, 0);
  assert(!Object.hasOwn(blocked.report.host.preparationFailure, 'stderr'));
  f.command('project.save', { id: f.project.id, preparation: { ...preparation, cacheSeed } });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded', 20000);
  assert.equal(f.adapter.calls.filter(call => call.task.id === task.id).length, 1);
});

test('workspace-local preparation caches are isolated and invalidate on lock or runtime input changes', windows, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'lock.json'), 'one');
  await writeFile(path.join(f.source, 'runtime.json'), 'v1');
  const spec = { command: process.execPath, network: 'allow', inputs: ['lock.json', 'runtime.json'], timeoutMs: 3000,
    args: ['-e', "require('node:fs').mkdirSync('node_modules'); if (process.env.ACMS_FIXTURE_SECRET) process.exit(7)"] };
  const previousSecret = process.env.ACMS_FIXTURE_SECRET;
  process.env.ACMS_FIXTURE_SECRET = 'fixture-only';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.ACMS_FIXTURE_SECRET;
    else process.env.ACMS_FIXTURE_SECRET = previousSecret;
  });
  const [a, b] = await Promise.all([f.workspaces.prepare(f.task(), {}), f.workspaces.prepare(f.task(), {})]);
  const run = cwd => prepareDependencies(f.dataDir, cwd, spec, runContained);
  const [first, second] = await Promise.all([run(a.path), run(b.path)]);
  assert.equal(first.key, second.key);
  assert.notEqual(first.cwd, second.cwd);
  assert.equal((await run(a.path)).reused, true);
  const unexpected = path.join(a.path, 'node_modules', 'unexpected.js');
  await writeFile(unexpected, 'unexpected dependency content');
  assert.equal((await run(a.path)).reused, undefined);
  await assert.rejects(stat(unexpected), { code: 'ENOENT' });
  await writeFile(path.join(a.path, 'lock.json'), 'two');
  const lockChange = await run(a.path);
  assert.notEqual(lockChange.key, first.key);
  assert.equal((await run(b.path)).reused, true);
  await writeFile(path.join(a.path, 'runtime.json'), 'v2');
  assert.notEqual((await run(a.path)).key, lockChange.key);
});

for (const unknown of [false, true]) test(`preparation failure reports ${unknown ? 'unknown cleanup' : 'access denied'} without launching the model`, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, 'lock.json'), 'locked');
  f.command('project.save', { id: f.project.id, preparation: { command: process.execPath, args: [], inputs: ['lock.json'], network: 'allow' } });
  const task = f.task();
  let receipt;
  f.workspaces.runDeliveryCheck = async (_command, _args, _cwd, options) => {
    receipt = options.cleanupReceipt;
    if (unknown) throw cleanupError('fixture could not confirm process-tree cleanup');
    throw Object.assign(new Error('access denied'), { code: 'EACCES' });
  };
  await f.start();
  if (unknown) {
    await until(() => f.store.require('tasks', task.id).status === 'reconciling' && !f.engine.live.size);
    const attempt = f.store.require('attempts', f.store.require('tasks', task.id).activeAttemptId);
    assert.equal(attempt.hostCheck.checkId, 'dependency-preparation');
    assert.equal(attempt.cleanupPending, true);
    f.command('task.cancel', { id: task.id });
    await writeJson(receipt, { confirmed: true, exitCode: 1 });
    f.command('task.reconcile', { id: task.id });
    await until(() => f.store.require('tasks', task.id).status === 'cancelled');
    assert.equal(f.store.require('attempts', attempt.id).cleanupPending, false);
    assert.equal(f.store.require('tasks', task.id).attempts, 0);
  } else {
    const block = await until(() => f.store.require('tasks', task.id).environmentBlock);
    assert.equal(block.report.host.preparationFailure.errorCode, 'EACCES');
    assert.equal(f.store.require('tasks', task.id).attempts, 0);
  }
  assert.equal(f.adapter.calls.length, 0);
});

for (const mode of ['timeout', 'cancel']) test(`dependency preparation uses bounded owned cleanup on ${mode}`, windows, async t => {
  const f = await fixture(t);
  const pidsFile = path.join(f.root, 'pids.jsonl');
  await writeFile(path.join(f.source, 'lock.json'), 'locked');
  f.command('project.save', { id: f.project.id, preparation: { command: process.execPath, args: [tree, pidsFile],
    inputs: ['lock.json'], network: 'allow', timeoutMs: mode === 'timeout' ? 2000 : 10000 } });
  const task = f.task();
  await f.start();
  const pids = await until(async () => {
    const rows = await readFile(pidsFile, 'utf8').catch(() => '');
    const lines = rows.trim().split('\n');
    return lines.length === 3 && lines.map(line => JSON.parse(line).pid);
  });
  if (mode === 'cancel') {
    f.command('task.cancel', { id: task.id });
    await until(() => f.store.require('tasks', task.id).status === 'cancelled');
  } else {
    const block = await until(() => f.store.require('tasks', task.id).environmentBlock);
    assert.equal(block.report.host.preparationFailure.timedOut, true);
    assert.equal(f.store.require('tasks', task.id).attempts, 0);
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(f.adapter.calls.length, 0);
});

test('host evidence is reused only for the same inputs and check, and builds cannot replace the original delivery', windows, async t => {
  const f = await fixture(t);
  const check = { id: 'test', command: 'node', args: ['-e', "require('node:fs').readFileSync('deliverable.md')"] };
  f.command('project.save', { id: f.project.id, checks: [check] });
  const task = f.task();
  const workspace = await f.workspaces.prepare(task, {});
  await writeFile(path.join(workspace.path, 'deliverable.md'), 'original');
  let invocations = 0;
  const invoke = (...args) => { invocations++; return runContained(...args); };
  const collect = (spec = check) => f.workspaces.collect({ ...task, workspace, checksSnapshot: [spec] }, { id: 'fixture' },
    [{ path: 'deliverable.md' }], invoke);
  const first = await collect();
  f.store.put('verifications', { id: 'cached', taskId: task.id, kind: 'checks', checks: first.checks });
  assert.equal((await collect()).checks[0].reused, true);
  assert.equal(invocations, 1);
  await writeFile(path.join(workspace.path, 'config.json'), 'changed');
  const changed = await collect();
  assert.notEqual(changed.checks[0].inputHash, first.checks[0].inputHash);
  f.store.put('verifications', { id: 'config-version', taskId: task.id, kind: 'checks', checks: changed.checks });
  const originalPathExt = process.env.PATHEXT;
  process.env.PATHEXT = `${originalPathExt ?? '.EXE'};.ACMSFIXTURE`;
  try {
    assert.notEqual((await collect()).checks[0].environment, changed.checks[0].environment);
  } finally {
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;
  }
  const build = await collect({ ...check, args: ['-e', "require('node:fs').writeFileSync('deliverable.md','rewritten')"] });
  assert.equal(build.checks[0].code, 0);
  assert.equal(build.checks[0].passed, false);
  assert.equal(build.checks[0].inputUnchanged, false);
  assert.equal(await readFile(path.join(workspace.path, 'deliverable.md'), 'utf8'), 'original');
  assert.equal(invocations, 4);
});
