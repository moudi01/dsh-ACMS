import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, verifyDeliveryArchive } from '../src/runtime/delivery-archive.js';
import { deliveryZip, manifestFor, zip, sha } from './fixtures/delivery-zip.js';
import { fixture, until } from './helpers.js';
import { digest } from '../src/core/util.js';
import { promptFor } from '../src/runtime/prompt.js';
import { Store } from '../src/core/store.js';
import { createAgentApi } from '../src/host/agent-api.js';

const sample = [
  { name: '源码/', data: '' },
  { name: '源码/交接🙂.md', data: '# 中文 / Unicode é\n', descriptor: true },
  { name: 'windows.txt', data: 'line one\r\nline two\r\n', method: 0 },
  { name: 'empty', data: '', method: 0 },
  { name: 'binary.bin', data: Buffer.from([0, 255, 128, 13, 10, 0]) },
];
const codes = result => result.errors.map(e => e.code);
const fails = (bytes, code, limits) => { const result = verifyDeliveryArchive(bytes, limits); assert.equal(result.passed, false); assert.ok(codes(result).includes(code), JSON.stringify(result.errors)); return result; };

test('verifies exact LF/CRLF, Unicode, binary and empty bytes with stored/deflated entries and descriptors', () => {
  const manifest = manifestFor(sample); manifest.files[1].role = 'evidence';
  manifest.files.push({ path: 'removed.js', sourcePath: 'original/removed.js', role: 'deleted' });
  const bytes = deliveryZip(sample, manifest), report = verifyDeliveryArchive(bytes);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.deepEqual(report.manifest, manifest); assert.equal(report.archiveSha256, sha(bytes));
  assert.equal(report.manifestSha256, sha(JSON.stringify(manifest)));
  assert.notEqual(report.archiveSha256, digest(bytes.toString('base64')));
});

test('line-ending changes are actionable content errors, never silently normalized', () => {
  const entries = [{ name: 'handoff.md', data: '你好\n交接\n' }], manifest = manifestFor(entries);
  const changed = [{ name: 'handoff.md', data: '你好\r\n交接\r\n' }];
  const result = fails(deliveryZip(changed, manifest), 'CONTENT_MISMATCH');
  assert.deepEqual(result.errors[0], { code: 'CONTENT_MISMATCH', path: 'handoff.md',
    expectedSha256: sha(entries[0].data), actualSha256: sha(changed[0].data), expectedBytes: Buffer.byteLength(entries[0].data), actualBytes: Buffer.byteLength(changed[0].data) });
});

test('detects missing, unexpected, deleted and duplicate manifest items', () => {
  const entries = [{ name: 'a', data: 'a' }], manifest = manifestFor(entries);
  fails(deliveryZip([], manifest), 'MISSING_FILE');
  fails(deliveryZip(entries, manifestFor([])), 'UNEXPECTED_FILE');
  fails(deliveryZip(entries, { ...manifest, files: [...manifest.files, ...manifest.files] }), 'DUPLICATE_MANIFEST_PATH');
  fails(deliveryZip(entries, { ...manifest, files: [{ path: 'a', sourcePath: 'a', role: 'deleted' }] }), 'DELETED_PATH_PRESENT');
  fails(deliveryZip([{ name: 'a/b', data: 'a' }], { ...manifest, files: [{ path: 'a', sourcePath: 'a', role: 'deleted' }] }), 'DELETED_PATH_PRESENT');
  fails(deliveryZip(entries, { ...manifest, files: [{ ...manifest.files[0], sourcePath: '../outside' }] }), 'INVALID_PATH');
  fails(deliveryZip(entries, { ...manifest, files: [{ ...manifest.files[0], sha256: digest(Buffer.from('a').toString('base64')) }] }), 'CONTENT_MISMATCH');
});

test('requires a versioned manifest and excludes only the manifest from its own list', () => {
  fails(zip([{ name: 'a', data: 'a' }]), 'MISSING_MANIFEST');
  fails(zip([{ name: 'acms-delivery.json', data: '{broken' }]), 'INVALID_MANIFEST_JSON');
  fails(deliveryZip([], { format: 'future', files: [] }), 'INVALID_MANIFEST_CONTRACT');
  const manifest = manifestFor([{ name: 'acms-delivery.json', data: 'x' }]);
  fails(deliveryZip([], manifest), 'SELF_LISTED_MANIFEST');
  const a = verifyDeliveryArchive(deliveryZip(sample)), b = verifyDeliveryArchive(deliveryZip(sample, { ...manifestFor(sample), note: 'new metadata' }));
  assert.equal(a.passed, true); assert.equal(b.passed, true);
  assert.notEqual(a.manifestSha256, b.manifestSha256); assert.notEqual(a.archiveSha256, b.archiveSha256);
});

for (const name of ['../escape', '/absolute', 'C:/drive', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a:stream', 'a\u0000b', 'a.', 'a ', 'CON.txt', 'dir/NUL']) {
  test(`rejects unsafe ZIP path ${JSON.stringify(name)}`, () => fails(zip([{ name, data: 'x' }]), 'INVALID_PATH'));
}

test('rejects duplicate, case/Unicode aliases and file/directory collisions', () => {
  for (const names of [['a', 'a'], ['a', 'A'], ['é', 'e\u0301'], ['ς', 'σ'], ['dir/', 'DIR/']]) {
    fails(zip(names.map(name => ({ name, data: '' }))), 'DUPLICATE_ZIP_PATH');
  }
  fails(zip([{ name: 'dir', data: '' }, { name: 'dir/file', data: '' }]), 'FILE_DIRECTORY_CONFLICT');
  fails(zip([{ name: 'Dir/a', data: '' }, { name: 'dir/b', data: '' }]), 'PATH_ALIAS_CONFLICT');
  fails(zip([{ name: 'link', data: 'target', attributes: (0xa000 << 16) >>> 0 }]), 'UNSUPPORTED_LINK');
  fails(zip([{ name: 'link', data: 'target', attributes: 0x400 }]), 'UNSUPPORTED_LINK');
});

test('rejects encryption, unsupported compression, alternate names and ZIP64 extras', () => {
  fails(zip([{ name: 'a', data: '', flags: 1 }]), 'UNSUPPORTED_ZIP_ENCODING');
  fails(zip([{ name: 'a', data: '', method: 99 }]), 'UNSUPPORTED_ZIP_ENCODING');
  fails(zip([{ name: '中文', data: '', flags: 0 }]), 'ZIP_NAME_REQUIRES_UTF8');
  for (const type of [1, 0x7075]) { const extra = Buffer.alloc(4); extra.writeUInt16LE(type); fails(zip([{ name: 'a', data: '', extra }]), 'UNSUPPORTED_ZIP_EXTRA'); }
});

test('rejects truncated/modified archives, inconsistent headers, hidden entries and invalid CRC', () => {
  const bytes = deliveryZip(sample);
  fails(bytes.subarray(0, bytes.length - 1), 'INVALID_ZIP_END');
  const mismatched = Buffer.from(bytes); mismatched[30] ^= 1; fails(mismatched, 'ZIP_HEADER_MISMATCH');
  const crc = zip([{ name: 'a', data: 'a', method: 0 }]); crc[31] ^= 1; fails(crc, 'ZIP_CRC_MISMATCH');
  const multidisk = Buffer.from(bytes); multidisk.writeUInt16LE(1, multidisk.length - 18); fails(multidisk, 'UNSUPPORTED_MULTIDISK_ZIP');
  const hidden = zip([{ name: 'a', data: '' }, { name: 'b', data: '' }]);
  const start = hidden.readUInt32LE(hidden.length - 6), central = hidden.subarray(start, hidden.length - 22);
  const second = central.subarray(47), end = Buffer.from(hidden.subarray(-22));
  end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(second.length, 12);
  fails(Buffer.concat([hidden.subarray(0, start), second, end]), 'INVALID_LOCAL_ENTRY');
});

test('enforces compressed, expanded, per-file, manifest and entry limits before inflation', () => {
  const bytes = deliveryZip([{ name: 'large', data: 'a'.repeat(10000) }]);
  for (const [limit, value, code] of [['archiveBytes', 10, 'ARCHIVE_SIZE_LIMIT'], ['entries', 1, 'ENTRY_LIMIT'],
    ['fileBytes', 100, 'EXPANDED_SIZE_LIMIT'], ['totalBytes', 100, 'EXPANDED_SIZE_LIMIT'], ['manifestBytes', 5, 'EXPANDED_SIZE_LIMIT']]) {
    fails(bytes, code, { ...ARCHIVE_LIMITS, [limit]: value });
  }
  // Both headers lie about expanded size; the inflater itself remains bounded.
  const bomb = zip([{ name: 'bomb', data: 'a'.repeat(100000) }]), start = bomb.readUInt32LE(bomb.length - 6);
  bomb.writeUInt32LE(1, 22); bomb.writeUInt32LE(1, start + 24); fails(bomb, 'INVALID_DEFLATE');
});

test('failed archive persists original bytes and diagnostics and cannot complete a task', async t => {
  const manifest = manifestFor([{ name: 'handoff.md', data: 'valid\n' }]);
  const bytes = deliveryZip([{ name: 'handoff.md', data: 'invalid\r\n' }], manifest);
  const f = await fixture(t, async input => {
    await writeFile(path.join(input.task.workspace.path, 'delivery.zip'), bytes);
    return { outcome: 'completed', artifacts: [{ path: 'delivery.zip', archiveFormat: ARCHIVE_FORMAT }] };
  });
  const task = f.task(); await f.start();
  await until(() => f.store.list('verifications').some(v => v.taskId === task.id && !v.passed));
  await f.engine.stop();
  const artifact = f.store.list('artifacts').find(a => a.taskId === task.id), report = artifact.archiveVerification;
  assert.equal(report.passed, false); assert.equal(report.taskId, task.id); assert.equal(report.taskGeneration, 1);
  assert.deepEqual(await readFile(artifact.blob), bytes); assert.equal(report.archiveSha256, sha(bytes));
  assert.notEqual(f.store.require('tasks', task.id).status, 'succeeded');
  assert.equal(f.store.list('integrations').length, 0);
  const verification = f.store.list('verifications').find(v => v.taskId === task.id);
  assert.equal(verification.checks[0].errors[0].code, 'CONTENT_MISMATCH');
  const reopened = new Store(path.join(f.dataDir, 'company.db'));
  try { assert.deepEqual(reopened.require('artifacts', artifact.id).archiveVerification, report); } finally { reopened.close(); }
});

test('verified archive and provenance reach dependency/review contracts and scoped external reads', async t => {
  const bytes = deliveryZip(sample);
  const f = await fixture(t, async input => {
    await writeFile(path.join(input.task.workspace.path, 'delivery.zip'), bytes);
    return { outcome: 'completed', artifacts: [{ path: 'delivery.zip', archiveFormat: ARCHIVE_FORMAT }] };
  });
  const task = f.task(), downstream = f.task({ dependencies: [task.id] });
  f.store.put('tasks', { ...downstream, status: 'paused' });
  await f.start(); await until(() => f.store.require('tasks', task.id).status === 'succeeded'); await f.engine.stop();
  const artifact = f.store.list('artifacts').find(a => a.taskId === task.id);
  assert.equal(artifact.archiveVerification.passed, true);
  const attempt = { id: 'test-prompt', agentId: 'manager' };
  const contract = JSON.parse(promptFor(f.company, downstream, attempt).split('CONTRACT:\n')[1]);
  const summary = contract.inputArtifacts[0].archiveVerification;
  assert.equal(summary.manifest, undefined);
  assert.equal(summary.archiveSha256, artifact.archiveVerification.archiveSha256);
  assert.equal(summary.taskId, task.id);
  assert.deepEqual(summary.manifestReference, { archivePath: artifact.blob, entry: 'acms-delivery.json', sha256: artifact.archiveVerification.manifestSha256 });
  const source = f.store.require('tasks', task.id);
  const review = { ...downstream, kind: 'review', reviewScope: 'goal', reviewTargets: [{ id: task.id }], deliveryHash: 'test' };
  const reviewContract = JSON.parse(promptFor(f.company, review, attempt).split('CONTRACT:\n')[1]);
  assert.deepEqual(reviewContract.review.targets[0].artifacts[0].archiveVerification, summary);
  assert.equal(await f.workspaces.unchanged(source, source.artifactIds), true);
  await writeFile(path.join(source.workspace.path, 'delivery.zip'), deliveryZip(sample, { ...manifestFor(sample), note: 'rebuilt' }));
  assert.equal(await f.workspaces.unchanged(source, source.artifactIds), false);
  const api = createAgentApi({ ...f, adapter: f.adapter }); await api.start(); t.after(() => api.close());
  const credential = f.command('agentCredential.create', { name: 'Archive reader', projectIds: [f.project.id], goalIds: [f.goal.id] });
  const response = await fetch(api.baseUrl + '/artifacts/' + artifact.id, { headers: { authorization: `Bearer ${credential.token}` } });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.value.artifact.archiveVerification, artifact.archiveVerification);
  assert.deepEqual(Buffer.from(payload.value.content, 'base64'), bytes);
  const denied = f.command('agentCredential.create', { name: 'Unscoped reader', projectIds: [f.project.id], goalIds: [] });
  assert.equal((await fetch(api.baseUrl + '/artifacts/' + artifact.id, { headers: { authorization: `Bearer ${denied.token}` } })).status, 403);
});

test('standalone verifier reports invalid bytes with a nonzero exit code', async t => {
  const f = await fixture(t), filename = path.join(f.root, 'delivery.zip');
  await writeFile(filename, deliveryZip(sample));
  let result = spawnSync(process.execPath, ['scripts/verify-delivery-archive.mjs', filename], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).passed, true);
  await writeFile(filename, deliveryZip(sample, manifestFor([])));
  result = spawnSync(process.execPath, ['scripts/verify-delivery-archive.mjs', filename], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).passed, false);
});
