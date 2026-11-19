import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployLive } from '../scripts/deploy-live.mjs';
import { WORKTREE_RESTORE_HOLD } from '../src/core/restore-safety.js';
import { fixture } from './helpers.js';

const deployScript = fileURLToPath(new URL('../scripts/deploy-live.mjs', import.meta.url));
const exec = promisify(execFile);
const yaml = filename => filename.replaceAll('\\', '/').replaceAll("'", "''");

async function profile(t) {
  const company = await fixture(t);
  const home = path.join(company.root, 'dsh');
  const profile = 'isolated';
  const profileDir = path.join(home, 'profiles', profile);
  await mkdir(profileDir, { recursive: true });
  const oldHost = path.join(company.root, 'host-old.mjs');
  await writeFile(oldHost, 'export const oldHost = true;\n');
  const patch = path.join(profileDir, 'cordis.patch.yml');
  const original = Buffer.from([
    '# 保留原样', '- id: other-plugin', '  config: { enabled: true }', '# BEGIN ACMS MANAGED CONFIG',
    '- id: acms', `  name: '${yaml(oldHost)}'`, '  config:', `    dataDir: '${yaml(company.dataDir)}'`,
    '# END ACMS MANAGED CONFIG', '# after ACMS', '',
  ].join('\r\n'));
  await writeFile(patch, original);
  return { ...company, home, profile, profileDir, patch, original, oldHost,
    backups: path.join(company.dataDir, 'install-backups') };
}

const fakeBuild = f => async () => ({ filename: path.join(f.root, 'host-new.mjs'), revision: 'new' });

test('deploy rejects Git integration phases and unconfirmed cleanup before building', async t => {
  const f = await profile(t);
  f.store.put('attempts', { id: 'settled-attempt', status: 'completed' });
  for (const phase of ['preparing', 'checking', 'applying', 'reconciling']) {
    f.store.put('integrations', { id: 'integration-1', phase, commandId: 'command-1' });
    const reason = phase === 'reconciling' ? /integration-1 is reconciling.*Verify.*process cleanup/ : new RegExp(`integration-1 is ${phase}`);
    await assert.rejects(deployLive({ ...f, build: () => assert.fail('must refuse before building') }), reason);
    assert.deepEqual(await readFile(f.patch), f.original);
  }
  f.store.put('integrations', { id: 'integration-1', phase: 'stopped', cleanupUncertain: true });
  await assert.rejects(deployLive({ ...f, build: () => assert.fail('must refuse before building') }), /integration-1 is stopped.*Verify.*process cleanup/);
  await assert.rejects(readdir(f.backups), { code: 'ENOENT' });
});

test('execution, conversation, and worktree-recovery holds still prevent deployment', async t => {
  const f = await profile(t);
  const deploy = () => deployLive({ ...f, build: () => assert.fail('must refuse before building') });
  f.store.put('attempts', { id: 'attempt-1', status: 'cancelled', cleanupPending: true });
  await assert.rejects(deploy(), /active executions/);
  f.store.put('attempts', { id: 'attempt-1', status: 'cancelled', cleanupPending: false });
  f.store.put('conversationMessages', { id: 'chat-1', status: 'streaming' });
  await assert.rejects(deploy(), /active conversations/);
  f.store.put('conversationMessages', { id: 'chat-1', status: 'stopped' });
  await mkdir(path.join(f.dataDir, WORKTREE_RESTORE_HOLD));
  await assert.rejects(deploy(), { code: 'RESTORE_WORKTREES_PENDING' });
  assert.deepEqual(await readFile(f.patch), f.original);
});

test('integration or restore hold acquired during build is checked again before switching', async t => {
  for (const block of ['integration', 'restore']) {
    const f = await profile(t);
    const expected = block === 'integration' ? /late-integration is applying/ : { code: 'RESTORE_WORKTREES_PENDING' };
    await assert.rejects(deployLive({ ...f, build: async () => {
      if (block === 'integration') f.store.put('integrations', { id: 'late-integration', phase: 'applying' });
      else await mkdir(path.join(f.dataDir, WORKTREE_RESTORE_HOLD));
      return fakeBuild(f)();
    } }), expected);
    assert.deepEqual(await readFile(f.patch), f.original);
    assert.deepEqual(await readdir(f.profileDir), ['cordis.patch.yml']);
    assert.deepEqual(await readdir(f.backups), []);
  }
});

test('a profile edit during build is preserved', async t => {
  const f = await profile(t);
  const changed = Buffer.concat([f.original, Buffer.from('# edited during build\r\n')]);
  await assert.rejects(deployLive({ ...f, build: async () => {
    await writeFile(f.patch, changed);
    return fakeBuild(f)();
  } }), /Profile changed/);
  assert.deepEqual(await readFile(f.patch), changed);
  assert.deepEqual(await readdir(f.backups), []);
});

test('the final publish serializes scheduler admission and a write failure leaves a usable backup', async t => {
  const f = await profile(t);
  const saved = f.store.put('integrations', { id: 'integration-1', phase: 'stopped' });
  const database = path.join(f.dataDir, 'company.db');
  const before = await readFile(database);
  f.store.db.exec('PRAGMA busy_timeout=0');
  const originalRename = fs.renameSync;
  const fail = t.mock.method(fs, 'renameSync', (temporary, target) => {
    if (target !== f.patch) return originalRename(temporary, target);
    assert.equal(path.dirname(temporary), f.profileDir);
    assert.throws(() => f.store.db.exec('BEGIN IMMEDIATE'), /database is locked/);
    throw new Error('simulated profile publication error');
  });
  try {
    await assert.rejects(deployLive({ ...f, build: fakeBuild(f) }), error => {
      assert.match(error.message, /Could not switch the ACMS host entry/);
      assert.match(error.cause?.message ?? '', /simulated profile publication error/);
      assert.match(error.message, /Previous configuration:/);
      return true;
    });
  } finally { fail.mock.restore(); }
  assert.deepEqual(await readFile(f.patch), f.original);
  assert.deepEqual(await readdir(f.profileDir), ['cordis.patch.yml']);
  const [backup] = await readdir(f.backups);
  assert.deepEqual(await readFile(path.join(f.backups, backup)), f.original);
  assert.deepEqual(await readFile(database), before);
  assert.deepEqual(f.store.require('integrations', saved.id), saved);
  f.store.db.exec('BEGIN IMMEDIATE; ROLLBACK');
});

test('an isolated CLI deployment after terminal integration can be rolled back using its reported profile backup', async t => {
  const f = await profile(t);
  const settled = f.store.put('integrations', { id: 'integration-1', phase: 'completed', commandId: 'finished-command' });
  const args = [deployScript, f.profile];
  const options = { cwd: f.root, env: { ...process.env, DSH_HOME: f.home }, timeout: 30000, windowsHide: true };
  const { stdout } = await exec(process.execPath, args, options);
  const revision = stdout.match(/ACMS host ([a-f0-9]+) published to isolated/)?.[1];
  assert(revision, stdout);
  const backup = stdout.match(/Previous configuration: ([^\r\n]+)/)?.[1];
  assert(backup?.startsWith(f.backups + path.sep), stdout);
  assert.deepEqual(await readFile(backup), f.original);
  const edited = await readFile(f.patch, 'utf8');
  assert(edited.includes(`host-${revision}.mjs`));
  assert.equal(edited.replace(/  name: '[^\r\n]*'/, `  name: '${yaml(f.oldHost)}'`), f.original.toString('utf8'));
  const bundle = edited.match(/  name: '([^\r\n]+)'/)?.[1].replaceAll("''", "'");
  const bundleSource = await readFile(bundle, 'utf8');
  const resources = new Set(bundleSource.match(/(?:owned-job-[a-f0-9]{64}\.cs|archive-worker-[a-f0-9]{64}\.mjs)/g));
  assert.equal(resources.size, 2);
  const files = [bundle, ...[...resources].map(name => path.join(path.dirname(bundle), name))];
  const times = await Promise.all(files.map(async filename => (await stat(filename)).mtimeMs));
  const repeated = await exec(process.execPath, args, options);
  assert.doesNotMatch(repeated.stdout, /Previous configuration/);
  assert.deepEqual(await readdir(f.backups), [path.basename(backup)]);
  assert.deepEqual(await Promise.all(files.map(async filename => (await stat(filename)).mtimeMs)), times);

  const rollback = path.join(f.profileDir, 'rollback.tmp');
  await writeFile(rollback, await readFile(backup));
  await rename(rollback, f.patch);
  assert.deepEqual(await readFile(f.patch), f.original);
  assert.match(await readFile(f.oldHost, 'utf8'), /oldHost = true/);
  assert.deepEqual(f.store.require('integrations', settled.id), settled);
});
