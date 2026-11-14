import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDeliveryArchive } from '../src/runtime/archive-validation.js';
import { verifyDeliveryArchive } from '../src/runtime/delivery-archive.js';
import { ARCHIVE_PROMPT_BYTES, promptFor } from '../src/runtime/prompt.js';
import { buildHost } from '../scripts/host-bundle.mjs';
import { fixture } from './helpers.js';
import { deliveryZip, manifestFor } from './fixtures/delivery-zip.js';

test('sourcePath file/directory collisions fail regardless of ordering and role', () => {
  const entries = [{ name: 'packed/a', data: 'a' }, { name: 'packed/b', data: 'b' }];
  for (const role of ['release', 'evidence', 'deleted']) for (const reverse of [false, true]) {
    const manifest = manifestFor(entries);
    manifest.files[0].sourcePath = 'src'; manifest.files[1].sourcePath = 'src/file.js';
    if (role === 'deleted') manifest.files[0] = { path: 'removed', sourcePath: 'src', role };
    else manifest.files[0].role = role;
    if (reverse) manifest.files.reverse();
    const report = verifyDeliveryArchive(deliveryZip(entries, manifest));
    assert.equal(report.passed, false);
    assert.ok(report.errors.some(e => e.code === 'SOURCE_FILE_DIRECTORY_CONFLICT'), JSON.stringify(report.errors));
  }
});

test('9000-file manifests stay out of dependency and both review prompts with one shared summary budget', async t => {
  const f = await fixture(t), source = f.task(), dependent = f.task({ dependencies: [source.id] });
  const entries = Array.from({ length: 9000 }, (_, i) => ({ name: `file-${i}`, data: '' }));
  const bytes = deliveryZip(entries), report = await validateDeliveryArchive(bytes);
  assert.equal(report.passed, true);
  const blob = path.join(f.root, 'large.zip'); await writeFile(blob, bytes);
  const artifact = { id: 'large-archive', taskId: source.id, path: 'large.zip', blob, bytes: bytes.length, hash: 'fixture', archiveVerification: report };
  f.store.put('artifacts', artifact);
  f.store.put('tasks', { ...source, artifactIds: [artifact.id] });
  const attempt = { id: 'prompt-fixture', agentId: 'reviewer' };
  const kinds = [dependent, { ...dependent, kind: 'review', reviewOf: source.id },
    { ...dependent, kind: 'review', reviewScope: 'goal', reviewTargets: [{ id: source.id }] }];
  for (const task of kinds) {
    const prompt = promptFor(f.company, task, attempt), contract = JSON.parse(prompt.split('CONTRACT:\n')[1]);
    assert.ok(Buffer.byteLength(prompt) < 24000, `prompt has ${Buffer.byteLength(prompt)} bytes`);
    assert.ok(!prompt.includes('file-8999'));
    const artifactView = contract.review?.artifacts?.[0] ?? contract.review?.targets?.[0].artifacts[0] ?? contract.inputArtifacts[0];
    assert.equal(artifactView.archiveVerification.manifestReference.archivePath, blob);
    const reread = verifyDeliveryArchive(await readFile(artifactView.archiveVerification.manifestReference.archivePath));
    assert.equal(reread.manifest.files.length, 9000);
    assert.equal(reread.manifestSha256, artifactView.archiveVerification.manifestReference.sha256);
    t.diagnostic(`${task.reviewOf ? 'task review' : task.reviewScope ?? 'dependency'} prompt: ${Buffer.byteLength(prompt)} bytes`);
  }
  // Repeated references exercise aggregate budget exhaustion, including the
  // shared budget when dependency artifacts and review artifacts coexist.
  f.store.put('tasks', { ...source, artifactIds: Array(32).fill(artifact.id) });
  for (const task of kinds) {
    const prompt = promptFor(f.company, task, attempt), contract = JSON.parse(prompt.split('CONTRACT:\n')[1]);
    assert.ok(contract.archiveEvidenceBudget.omitted > 0);
    assert.ok(contract.archiveEvidenceBudget.usedBytes <= ARCHIVE_PROMPT_BYTES);
    assert.ok(Buffer.byteLength(prompt) < 60000, `aggregate prompt has ${Buffer.byteLength(prompt)} bytes`);
    assert.ok(!prompt.includes('file-8999'));
  }
});

test('deep paths validate without blocking host timers and cancellation rejects instead of returning evidence', async t => {
  const entries = Array.from({ length: 1000 }, (_, i) => ({ name: 'd/'.repeat(400) + 'f' + i, data: '' }));
  const bytes = deliveryZip(entries);
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  try {
    const start = performance.now();
    const report = await validateDeliveryArchive(bytes);
    assert.equal(report.passed, true); assert.ok(ticks > 0, 'host timers must run during validation');
    t.diagnostic(`1000 deep paths verified in ${Math.round(performance.now() - start)} ms; ${ticks} host timer ticks`);
    const controller = new AbortController(), reason = new Error('owner paused');
    const pending = validateDeliveryArchive(bytes, { signal: controller.signal });
    const cancel = setTimeout(() => controller.abort(reason), 10);
    try { await assert.rejects(pending, error => error === reason); } finally { clearTimeout(cancel); }
    await assert.rejects(validateDeliveryArchive(bytes, { signal: controller.signal }), error => error === reason);
    assert.equal((await validateDeliveryArchive(deliveryZip([]))).passed, true, 'next verification survives cancellation');
  } finally { clearInterval(timer); }
});

test('isolated host bundle publishes and runs its matching archive worker', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'acms-archive-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const built = await buildHost({ root, outDir: directory, entryPoint: 'src/runtime/archive-validation.js' });
  const code = await readFile(built.filename, 'utf8');
  assert.ok(code.includes('./' + path.basename(built.archiveWorker)));
  const bundled = await import(pathToFileURL(built.filename));
  assert.equal((await bundled.validateDeliveryArchive(deliveryZip([{ name: '中文', data: '字节' }]))).passed, true);
  assert.equal((await bundled.validateDeliveryText(Buffer.from('中文交接'))).status, 'no-warning');
  const controller = new AbortController(), pending = bundled.validateDeliveryArchive(deliveryZip([]), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
