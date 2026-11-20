import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { Company } from '../src/core/domain.js';
import { Store } from '../src/core/store.js';
import { createRoutes } from '../src/host/http.js';
import { createAgentApi } from '../src/host/agent-api.js';
import { byteSha256, verifyDeliveryArchive } from '../src/runtime/delivery-archive.js';
import { copyContentHash } from '../src/runtime/copy-composition.js';
import { gitWorktreeFingerprint } from '../src/runtime/git-delivery.js';
import { run, WorkspaceManager } from '../src/runtime/workspaces.js';
import { applyBackup, planBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { fixture, gitProject, until } from './helpers.js';

const root = 'http://127.0.0.1/api/acms/composition/';
const binary = Buffer.from([0, 8, 13, 10, 128, 255]);

function ownerRoutes(runtime) {
  const handlers = new Map(createRoutes(runtime).map(route => [route.path, route]));
  return {
    archive: selection => handlers.get('/api/acms/composition/archive').fetch(new Request(root + 'archive', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection),
    })),
    download: (selection, archiveSha256) => handlers.get('/api/acms/composition/download').fetch(
      new Request(root + 'download?' + new URLSearchParams({ ...selection, archiveSha256 }))),
  };
}

function zipEntries(zip) {
  const found = new Map();
  for (let offset = 0; zip.readUInt32LE(offset) === 0x04034b50;) {
    const length = zip.readUInt16LE(offset + 26), size = zip.readUInt32LE(offset + 18);
    const start = offset + 30 + length + zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const stored = zip.subarray(start, start + size);
    found.set(name, zip.readUInt16LE(offset + 8) === 8 ? inflateRawSync(stored) : stored);
    offset = start + size;
  }
  return found;
}

async function rebuild(root, entries) {
  await fs.mkdir(root);
  for (const [name, bytes] of entries) {
    if (!name.startsWith('source/') || name === 'source/') continue;
    const target = path.join(root, name.slice(7));
    if (name.endsWith('/')) await fs.mkdir(target, { recursive: true });
    else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
  }
  return root;
}

async function failed(response, status, code) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
}

async function archiveFixture(t, mode, { review = false, reviewGate } = {}) {
  let reviewed;
  const f = await fixture(t, async input => {
    const cwd = input.task.workspace.path;
    if (input.task.kind === 'review') {
      reviewed = await fs.readFile(path.join(cwd, 'raw.bin'));
      if (reviewGate) await reviewGate;
      return { outcome: 'reviewed', decision: 'approve', summary: 'Reviewed the selected candidate' };
    }
    await fs.unlink(path.join(cwd, 'obsolete.txt'));
    await fs.unlink(path.join(cwd, 'module'));
    await fs.mkdir(path.join(cwd, 'module'));
    if (mode === 'copy') await fs.mkdir(path.join(cwd, 'module', 'empty'));
    await fs.writeFile(path.join(cwd, 'module', '说明.txt'), '候选\r\n');
    await fs.writeFile(path.join(cwd, 'raw.bin'), binary);
    await fs.writeFile(path.join(cwd, 'zero.txt'), '');
    return { outcome: 'completed', artifacts: [{ path: 'raw.bin' }] };
  });
  await fs.writeFile(path.join(f.source, 'obsolete.txt'), 'obsolete baseline');
  await fs.writeFile(path.join(f.source, 'module'), 'previous file');
  const baseCommit = mode === 'git' ? (await gitProject(f)).trim() : undefined;
  f.command('project.save', { id: f.project.id, autoMerge: false,
    checks: [{ id: 'joint', command: process.execPath, args: ['-e', 'process.exitCode=0'] }] });
  const goal = f.command('goal.create', { projectId: f.project.id, templateId: review ? 'base' : f.template.id, plan: false, title: 'Verified full candidate',
    description: 'Archive fixed delivery', acceptance: 'Use the exact accepted candidate', deliveryMode: mode + '-composite' });
  const task = f.task({ goalId: goal.id });
  f.workspaces.runIntegrationCommand = f.workspaces.runDeliveryCheck = async (command, args, cwd, options) => {
    options.beforeStart?.(command);
    const result = await run(command, args, cwd, options);
    if (options.cleanupReceipt) await fs.writeFile(options.cleanupReceipt, JSON.stringify({ confirmed: true, exitCode: result.code ?? 1 }));
    return { ...result, cleanupConfirmed: true };
  };
  const current = () => f.store.require('goals', goal.id);
  const snapshot = () => f.company.snapshot().goals.find(row => row.id === goal.id);
  const selection = () => ({ goalId: goal.id, version: current().composition.version, deliveryHash: f.company.deliveryHash(goal.id) });
  const complete = () => until(() => {
    const failed = f.store.list('attempts').find(row => row.goalId === goal.id && row.status === 'failed');
    if (failed) assert.fail(failed.summary);
    if (current().compositionRecheck?.status === 'failed') assert.fail(current().compositionRecheck.reason);
    return snapshot().finalComposition;
  }, 45000, () => ({ status: current().status, recheck: current().compositionRecheck, review: snapshot().reviewSummary }));
  const routes = ownerRoutes(f);
  return { f, goal, current, snapshot, selection, routes, task, complete, baseCommit, reviewed: () => reviewed };
}

test('the owner archives exactly the approved directory tree and repeat downloads survive backup', async t => {
  const review = Promise.withResolvers();
  const { f, goal, task, current, snapshot, selection, routes, complete, reviewed } =
    await archiveFixture(t, 'copy', { review: true, reviewGate: review.promise });
  await f.start();
  try {
    await until(reviewed, 45000, () => ({ status: current().status, recheck: current().compositionRecheck, summary: snapshot().reviewSummary }));
    assert.equal(snapshot().compositionVerified, true);
    assert.equal(snapshot().finalComposition, null);
    await failed(await routes.archive(selection()), 409, 'COMPOSITE_NOT_VERIFIED');
  } finally { review.resolve(); }
  const completed = await complete();
  assert(completed.reviewId);
  await f.engine.stop();
  const chosen = selection();
  await fs.writeFile(path.join(f.store.require('tasks', task.id).workspace.path, 'raw.bin'), 'changed author workspace');
  await fs.rename(f.source, path.join(f.root, 'moved-source'));
  await failed(await routes.download(chosen, '0'.repeat(64)), 410, 'ARTIFACT_MISSING');
  const attempts = await Promise.all([routes.archive(chosen), routes.archive(chosen)]);
  assert(attempts.every(response => response.status === 200));
  const [archive, second] = await Promise.all(attempts.map(response => response.json()));
  assert.deepEqual(second, archive);
  const response = await routes.download(chosen, archive.archiveSha256);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('x-acms-candidate-version'), chosen.version);
  const bytes = Buffer.from(await response.arrayBuffer());
  const verification = verifyDeliveryArchive(bytes);
  assert(verification.passed);
  assert.equal(verification.archiveSha256, archive.archiveSha256);
  assert.equal(verification.manifestSha256, archive.manifestSha256);
  const entries = zipEntries(bytes);
  const manifest = JSON.parse(entries.get('acms-delivery.json'));
  assert.equal(manifest.candidate.reviewId, completed.reviewId);
  assert.equal(manifest.candidate.version, chosen.version);
  assert.equal(manifest.candidate.deliveryHash, chosen.deliveryHash);
  assert.equal(manifest.candidate.contentHash, current().composition.contentHash);
  assert.equal(manifest.candidate.baseHash, current().compositionBase.snapshot.sha256);
  assert.equal(manifest.candidate.checks[0].inputHash, current().composition.contentHash);
  assert.equal(manifest.candidate.checks[0].logSha256, current().composition.checks[0].log.hash);
  assert.equal(manifest.candidate.materialization, 'clean-directory');
  assert.deepEqual(entries.get('source/raw.bin'), reviewed());
  assert.equal(entries.get('source/module/说明.txt').toString(), '候选\r\n');
  assert.equal(entries.get('source/module/empty/').length, 0);
  assert.equal(entries.get('source/zero.txt').length, 0);
  assert(!entries.has('source/module') && !entries.has('source/obsolete.txt'));
  assert(!manifest.files.some(entry => entry.role === 'deleted'));
  assert.equal(await copyContentHash(await rebuild(path.join(f.root, 'extract'), entries)), current().composition.contentHash);
  const blob = path.join(f.dataDir, 'deliveries', 'archives', archive.archiveSha256 + '.zip');
  await fs.unlink(blob);
  assert.deepEqual(await (await routes.archive(chosen)).json(), archive);
  assert.deepEqual(await fs.readFile(blob), bytes);
  const backup = path.join(f.root, 'backup');
  const dataDir = path.join(f.root, 'restored');
  await applyBackup(await planBackup({ dataDir: f.dataDir, out: backup }));
  await restoreBackup({ backup, target: dataDir });
  const store = new Store(path.join(dataDir, 'company.db'));
  try {
    const company = new Company(store);
    const restored = ownerRoutes({ company, workspaces: new WorkspaceManager(dataDir, company) });
    const response = await restored.download(chosen, archive.archiveSha256);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally { store.close(); }
  assert.equal(f.store.require('goals', goal.id).status, 'succeeded');
  const record = path.join(f.dataDir, 'deliveries', 'archives', archive.key + '.json');
  await fs.writeFile(record, JSON.stringify({ ...archive, manifestSha256: '5'.repeat(64) }));
  await failed(await routes.download(chosen, archive.archiveSha256), 409, 'ARTIFACT_CORRUPT');
  await failed(await routes.archive(chosen), 409, 'ARTIFACT_CORRUPT');
  await fs.writeFile(record, JSON.stringify(archive));
  await fs.writeFile(blob, Buffer.alloc(bytes.length, 37));
  await failed(await routes.download(chosen, archive.archiveSha256), 409, 'ARTIFACT_CORRUPT');
  await failed(await routes.archive(chosen), 409, 'ARTIFACT_CORRUPT');
});

test('the Git download contains the fixed candidate and checks both version and current size policy', async t => {
  const { f, current, selection, routes, task, complete, baseCommit } = await archiveFixture(t, 'git');
  await f.start();
  await complete();
  await f.engine.stop();
  const chosen = selection();
  await fs.writeFile(path.join(f.store.require('tasks', task.id).workspace.path, 'raw.bin'), 'changed author workspace');
  const result = await routes.archive(chosen);
  assert.equal(result.status, 200);
  const archive = await result.json();
  const response = await routes.download(chosen, archive.archiveSha256);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(byteSha256(bytes), archive.archiveSha256);
  assert(verifyDeliveryArchive(bytes).passed);
  const entries = zipEntries(bytes);
  const manifest = JSON.parse(entries.get('acms-delivery.json'));
  assert.equal(manifest.candidate.baseCommit, baseCommit);
  assert.equal(manifest.candidate.contentHash, current().composition.contentHash);
  assert.deepEqual(entries.get('source/raw.bin'), binary);
  assert(!entries.has('source/.git') && !entries.has('source/obsolete.txt'));
  assert.equal(await gitWorktreeFingerprint(await rebuild(path.join(f.root, 'extract'), entries)), current().composition.contentHash);
  assert.equal(await fs.readFile(path.join(f.source, 'module'), 'utf8'), 'previous file');
  await failed(await routes.download({ ...chosen, version: '1'.repeat(64) }, archive.archiveSha256), 409, 'STALE_COMPOSITION');
  await failed(await routes.download(chosen, '2'.repeat(64)), 409, 'STALE_COMPOSITION');
  f.command('policy.update', { patch: { maxArtifactBytes: archive.bytes - 1 } });
  await failed(await routes.archive(chosen), 413, 'ARTIFACT_TOO_LARGE');
  await failed(await routes.download(chosen, archive.archiveSha256), 413, 'ARTIFACT_TOO_LARGE');
});

test('archive preparation detects a revoked project root before publishing or responding', async t => {
  const { f, selection, routes, complete } = await archiveFixture(t, 'copy');
  await f.start();
  await complete();
  await f.engine.stop();
  const chosen = selection();
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  const writeFile = fs.writeFile;
  let revoked = false;
  const fault = t.mock.method(fs, 'writeFile', async (filename, ...args) => {
    if (!revoked && path.basename(filename) === 'candidate.zip') {
      revoked = true;
      f.command('policy.update', { patch: { allowedProjectRoots: [outside] } });
    }
    return writeFile(filename, ...args);
  });
  try {
    await failed(await routes.archive(chosen), 403, 'PROJECT_PATH_DENIED');
    assert(revoked);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'deliveries', 'archives')), []);
  } finally { fault.mock.restore(); }
  f.command('policy.update', { patch: { allowedProjectRoots: [f.source] } });
  const response = await routes.archive(chosen);
  assert.equal(response.status, 200);
  const archive = await response.json();
  f.command('project.save', { id: f.project.id, checks: [{ id: 'changed', command: process.execPath, args: ['-e', 'process.exit(0)'] }] });
  await failed(await routes.download(chosen, archive.archiveSha256), 409, 'COMPOSITE_NOT_VERIFIED');
});

test('a valid scoped agent credential cannot access the owner candidate routes', async t => {
  const { f, goal, selection, complete } = await archiveFixture(t, 'copy');
  await f.start();
  await complete();
  await f.engine.stop();
  const credential = f.command('agentCredential.create', { name: 'Read scoped', projectIds: [f.project.id],
    goalIds: [goal.id], commands: ['status.read'] });
  const agent = createAgentApi(f);
  await agent.start();
  try {
    const authorization = 'Bearer ' + credential.token;
    const allowed = await fetch(agent.baseUrl + '/goals/' + goal.id, { headers: { authorization } });
    assert.equal(allowed.status, 200);
    const archive = await fetch(new URL('/api/acms/composition/archive', agent.baseUrl), { method: 'POST',
      headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(selection()) });
    assert.notEqual(archive.status, 200);
    const download = await fetch(agent.baseUrl + '/composition/download?' + new URLSearchParams(selection()), { headers: { authorization } });
    assert.equal(download.status, 404);
  } finally { await agent.close(); }
});
