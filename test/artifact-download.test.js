import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fixture } from './helpers.js';
import { createRoutes } from '../src/host/http.js';
import { digest } from '../src/core/util.js';

function routesFor(f) {
  const routes = createRoutes(f);
  const download = routes.find(route => route.path.endsWith('/artifact/download'));
  const preview = routes.find(route => route.path.endsWith('/artifact') && !route.path.endsWith('/download'));
  return { download, preview };
}

async function putArtifact(f, { id, bytes, relative = '交付/中文 名称.bin', recordedBytes = bytes.length, blobPath, hash }) {
  const task = f.task({ title: `任务 ${id}` });
  const blob = blobPath ?? path.join(f.dataDir, 'artifacts', id);
  if (!blobPath) { await mkdir(path.dirname(blob), { recursive: true }); await writeFile(blob, bytes); }
  return f.store.put('artifacts', { id, taskId: task.id, attemptId: `attempt_${id}`, path: relative, title: relative,
    hash: hash === undefined ? digest(bytes.toString('base64')) : hash, bytes: recordedBytes, blob });
}

const url = id => `http://dsh/api/acms/artifact/download?id=${encodeURIComponent(id)}`;

test('下载返回与 blob 完全一致的原始字节：二进制、PNG、ZIP、大文件、空文件和 Unicode 文件名', async t => {
  const f = await fixture(t); const { download, preview } = routesFor(f);
  const binary = Buffer.from([0, 255, 1, 2, 128, 65, 66, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 8, 7, 6]);
  const large = Buffer.alloc(300000, 7);
  await putArtifact(f, { id: 'artifact_binary', bytes: binary, relative: '交付/二进制 文件.bin' });
  await putArtifact(f, { id: 'artifact_png', bytes: png, relative: '交付/图片.png' });
  await putArtifact(f, { id: 'artifact_zip', bytes: zip, relative: '交付/归档.zip' });
  await putArtifact(f, { id: 'artifact_large', bytes: large, relative: '交付/large.md' });
  await putArtifact(f, { id: 'artifact_empty', bytes: Buffer.alloc(0), relative: '交付/空文件.txt' });

  const binaryResponse = await download.fetch(new Request(url('artifact_binary')));
  assert.equal(binaryResponse.status, 200);
  assert.equal(binaryResponse.headers.get('content-type'), 'application/octet-stream');
  assert.match(binaryResponse.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.match(decodeURIComponent(binaryResponse.headers.get('content-disposition')), /二进制 文件\.bin/);
  const rawSha = createHash('sha256').update(binary).digest('hex');
  assert.equal(binaryResponse.headers.get('x-acms-artifact-sha256'), rawSha);
  assert.equal(binaryResponse.headers.get('x-acms-artifact-hash'), digest(binary.toString('base64')));
  assert.notEqual(binaryResponse.headers.get('x-acms-artifact-hash'), rawSha);
  assert.equal(binaryResponse.headers.get('x-acms-artifact-bytes'), String(binary.length));
  assert.deepEqual(Buffer.from(await binaryResponse.arrayBuffer()), binary);

  const pngResponse = await download.fetch(new Request(url('artifact_png')));
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await pngResponse.arrayBuffer()), png);

  const zipResponse = await download.fetch(new Request(url('artifact_zip')));
  assert.equal(zipResponse.status, 200);
  assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Buffer.from(await zipResponse.arrayBuffer()), zip);

  const largeResponse = await download.fetch(new Request(url('artifact_large')));
  assert.equal(largeResponse.status, 200);
  assert.equal(largeResponse.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const largeBody = Buffer.from(await largeResponse.arrayBuffer());
  assert.equal(largeBody.length, large.length);
  assert.deepEqual(largeBody, large);

  const emptyResponse = await download.fetch(new Request(url('artifact_empty')));
  assert.equal(emptyResponse.status, 200);
  assert.equal(emptyResponse.headers.get('content-length'), '0');
  assert.equal((await emptyResponse.arrayBuffer()).byteLength, 0);

  // The bounded text preview stays truncated; that must not affect the download.
  const previewResponse = await preview.fetch(new Request(`http://dsh/api/acms/artifact?id=artifact_large`));
  const previewBody = await previewResponse.json();
  assert.equal(previewBody.truncated, true);
  assert.equal(previewBody.content.length, 262144);
});

test('缺失参数、未知产物、损坏与缺失 blob 返回结构化错误', async t => {
  const f = await fixture(t); const { download } = routesFor(f);
  await putArtifact(f, { id: 'artifact_ok', bytes: Buffer.from([1, 2, 3]) });
  await putArtifact(f, { id: 'artifact_corrupt', bytes: Buffer.from([1, 2, 3]), recordedBytes: 99 });
  await putArtifact(f, { id: 'artifact_tampered', bytes: Buffer.from([1, 2, 3]), hash: digest(Buffer.from([9, 8, 7]).toString('base64')) });

  const missingId = await download.fetch(new Request('http://dsh/api/acms/artifact/download'));
  assert.equal(missingId.status, 400);
  assert.equal((await missingId.json()).error.code, 'INVALID_INPUT');

  const unknown = await download.fetch(new Request(url('artifact_unknown')));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'NOT_FOUND');

  const corrupt = await download.fetch(new Request(url('artifact_corrupt')));
  assert.equal(corrupt.status, 409);
  assert.equal((await corrupt.json()).error.code, 'ARTIFACT_CORRUPT');

  // Same byte count but different content is still detected through the ACMS digest.
  const tampered = await download.fetch(new Request(url('artifact_tampered')));
  assert.equal(tampered.status, 409);
  assert.equal((await tampered.json()).error.code, 'ARTIFACT_CORRUPT');

  const missingBlob = await putArtifact(f, { id: 'artifact_missing', bytes: Buffer.from([1]), blobPath: path.join(f.dataDir, 'artifacts', 'absent') });
  const missing = await download.fetch(new Request(url(missingBlob.id)));
  assert.equal(missing.status, 410);
  assert.equal((await missing.json()).error.code, 'ARTIFACT_MISSING');
});

test('超过公司产物上限时拒绝下载而不是静默截断', async t => {
  const f = await fixture(t); const { download } = routesFor(f);
  f.command('policy.update', { patch: { maxArtifactBytes: 1024 } });
  await putArtifact(f, { id: 'artifact_too_large', bytes: Buffer.alloc(2048, 1) });
  const response = await download.fetch(new Request(url('artifact_too_large')));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'ARTIFACT_TOO_LARGE');
});
