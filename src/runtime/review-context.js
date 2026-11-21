import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deliveryGeneration, matchesTaskReview, taskContractVersion } from '../core/goal-contract.js';
import { AcmsError, assert, digest } from '../core/util.js';
import { verifyCollaboration } from './collaboration.js';

const schema = 'acms-review-context/1';
export const REVIEW_INLINE_BYTES = 8 * 1024;
const maxTextBytes = 32 * 1024;
const textPath = /\.(md|markdown|txt|rst|html|css|js|jsx|mjs|cjs|ts|tsx|json|py|rs|go|java|yml|yaml)$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const component = /^[a-zA-Z0-9_-]{1,200}$/;

const unavailable = (message, details) => new AcmsError('REVIEW_EVIDENCE_UNAVAILABLE', message, details);

async function directory(parent, name, create = false) {
  const dir = path.join(parent, name);
  if (create) {
    try { await fs.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(dir, await fs.realpath(dir)) !== '') {
    throw unavailable('审查材料目录必须是隔离工作区内的普通目录。');
  }
  return dir;
}

async function reviewRoot(dataDir, task) {
  assert(task.workspace?.mode === 'review-copy' && component.test(task.id), 'REVIEW_EVIDENCE_UNAVAILABLE', '审查工作区归属无法核对。');
  const reviews = await directory(await fs.realpath(dataDir), 'reviews');
  const owned = await directory(reviews, task.id);
  assert(path.relative(owned, await fs.realpath(task.workspace.path)) === '',
    'REVIEW_EVIDENCE_UNAVAILABLE', '审查工作区归属无法核对。');
  return owned;
}

async function localFile(root, name) {
  if (typeof name !== 'string' || path.isAbsolute(name)) throw unavailable('审查材料路径必须相对于隔离工作区。');
  const relative = path.relative(root, path.resolve(root, name));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw unavailable('审查材料路径超出隔离工作区。');
  }
  const parts = relative.split(path.sep);
  let parent = root;
  for (const part of parts.slice(0, -1)) parent = await directory(parent, part);
  return { filename: path.join(parent, parts.at(-1)), path: parts.join('/') };
}

const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;
function unchanged(left, right) {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

// artifact.hash is SHA-256 over Base64 text. Carry the final one or
// two bytes across reads so this agrees with hashing one Base64 string.
async function readEvidence(filename, artifact, signal, { capture = false, output = null } = {}) {
  signal?.throwIfAborted();
  const listed = await fs.lstat(filename, { bigint: true });
  if (!listed.isFile() || listed.isSymbolicLink() || listed.size !== BigInt(artifact.bytes) ||
      path.relative(filename, await fs.realpath(filename)) !== '') throw unavailable('审查材料的文件类型或字节数与原交付不符。');
  const input = await fs.open(filename, 'r');
  try {
    if (!unchanged(listed, await input.stat({ bigint: true }))) throw unavailable('读取审查材料时文件已变化。');
    const raw = createHash('sha256'), base64 = createHash('sha256');
    const chunks = [], buffer = Buffer.allocUnsafe(64 * 1024);
    let carry = Buffer.alloc(0), total = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > artifact.bytes) throw unavailable('读取审查材料时字节数已变化。');
      const chunk = buffer.subarray(0, bytesRead);
      raw.update(chunk);
      const block = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const end = block.length - block.length % 3;
      base64.update(block.subarray(0, end).toString('base64'));
      carry = Buffer.from(block.subarray(end));
      if (capture) chunks.push(Buffer.from(chunk));
      if (output) await output.writeFile(chunk);
    }
    base64.update(carry.toString('base64'));
    if (total !== artifact.bytes || !unchanged(listed, await input.stat({ bigint: true })) ||
        !unchanged(listed, await fs.lstat(filename, { bigint: true })) || base64.digest('hex') !== artifact.hash) {
      throw unavailable('审查材料与原交付摘要不符。');
    }
    signal?.throwIfAborted();
    return { rawSha256: raw.digest('hex'), textBytes: capture ? Buffer.concat(chunks) : null };
  } finally {
    await input.close();
  }
}

async function materializeEvidence(meta, dataDir, artifact, attemptId, signal, capture) {
  const filename = path.join(meta, artifact.hash);
  try { return await readEvidence(filename, artifact, signal, { capture }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const originals = await directory(await fs.realpath(dataDir), 'artifacts');
  const pending = path.join(meta, '.pending-' + attemptId + '-' + randomUUID());
  const output = await fs.open(pending, 'wx');
  let identity;
  try {
    identity = await output.stat({ bigint: true });
    const checked = await readEvidence(path.join(originals, artifact.hash), artifact, signal, { capture, output });
    await output.sync();
    signal?.throwIfAborted();
    // Both names remain on the reviewer volume. A valid existing reference
    // wins and is rechecked, including after a restart; a corrupt file is held.
    try { await fs.link(pending, filename); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await readEvidence(filename, artifact, signal, { capture });
    }
    return checked;
  } finally {
    await output.close();
    const current = await fs.lstat(pending, { bigint: true }).catch(() => null);
    if (identity && current?.isFile() && sameFile(identity, current) &&
        path.relative(meta, await fs.realpath(meta).catch(() => path.dirname(meta))) === '') await fs.unlink(pending);
  }
}

function sourceVersion(store, review) {
  const source = store.require('tasks', review.reviewOf);
  assert(source.status === 'succeeded' && matchesTaskReview(review, source), 'STALE_REVIEW', '审查指向的交付版本已变化。');
  const artifacts = (source.artifactIds ?? []).map(id => store.get('artifacts', id));
  if (artifacts.some(artifact => !artifact || artifact.taskId !== source.id || !hashPattern.test(artifact.hash) ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof artifact.path !== 'string' || !artifact.path)) {
    throw unavailable('原交付的产物索引缺失或无法核对。', { sourceTaskId: source.id });
  }
  const version = { taskId: source.id, generation: deliveryGeneration(source), contractVersion: taskContractVersion(source), artifactHash: source.artifactHash };
  return { version, artifacts, collaboration: collaborationPin(source.workspace),
    fingerprint: digest([version, artifacts.map(a => [a.id, a.path, a.hash, a.bytes])]) };
}

function collaborationPin(workspace) {
  const record = workspace?.collaboration;
  return record?.revision ? { revision: record.revision, files: record.files } : null;
}

async function verifyPinnedCollaboration(root, pin) {
  if (!pin) return;
  assert(hashPattern.test(pin.revision) && pin.files?.['context.json'] && pin.files?.['shared.md'],
    'COLLABORATION_PATH', '固定作者协作版本缺少文件摘要');
  await verifyCollaboration({ path: root, collaboration: pin });
}

export function assertTaskReviewContextCurrent(store, task, context) {
  assert(sourceVersion(store, task).fingerprint === context.sourceFingerprint,
    'STALE_REVIEW', '审查材料索引或交付版本已变化。');
  if (Object.hasOwn(context, 'collaboration')) assert(digest(collaborationPin(task.workspace)) === digest(context.collaboration),
    'STALE_REVIEW', '审查使用的固定作者协作版本已变化。');
}

export async function prepareTaskReviewContext(store, dataDir, task, attempt, signal) {
  const source = sourceVersion(store, task);
  assert(component.test(attempt.id), 'REVIEW_EVIDENCE_UNAVAILABLE', '审查执行标识无法核对。');
  const collaboration = collaborationPin(task.workspace);
  const entries = [];
  let root, reviewMeta, inlineBytes = 0;
  try {
    root = await reviewRoot(dataDir, task);
    try {
      assert(!collaboration || digest(collaboration) === digest(source.collaboration), 'COLLABORATION_CHANGED', '固定作者协作版本不匹配');
      await verifyPinnedCollaboration(root, collaboration);
    } catch {
      throw unavailable('审查副本缺少固定作者协作版本或摘要不符。请恢复该版本，或重新发起独立审查。');
    }
    for (const artifact of source.artifacts) {
      signal?.throwIfAborted();
      const text = textPath.test(artifact.path), capture = text && artifact.bytes <= maxTextBytes;
      let checked, local;
      try {
        local = await localFile(root, artifact.path);
        checked = await readEvidence(local.filename, artifact, signal, { capture });
      } catch {
        signal?.throwIfAborted();
        // A reused reviewer copy can have a stale or missing file. Only the
        // content-addressed original is a fallback. Never copy the live author.
        try {
          if (!reviewMeta) {
            const workspaceMeta = await directory(root, '.acms', true);
            reviewMeta = await directory(workspaceMeta, 'review-evidence', true);
          }
          const filename = path.join(reviewMeta, artifact.hash);
          checked = await materializeEvidence(reviewMeta, dataDir, artifact, attempt.id, signal, capture);
          local = { path: path.relative(root, filename).split(path.sep).join('/') };
        } catch {
          signal?.throwIfAborted();
          throw unavailable('找不到与原交付摘要一致的审查材料。请恢复原始产物后再审查。', { artifactId: artifact.id, sourceTaskId: source.version.taskId });
        }
      }
      const entry = { artifactId: artifact.id, path: artifact.path, workspacePath: local.path, hash: artifact.hash,
        rawSha256: checked.rawSha256, bytes: artifact.bytes };
      let omitted = text ? 'large-text' : 'non-text';
      if (capture) {
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(checked.textBytes); }
        catch { omitted = 'invalid-utf8'; }
        if (content !== undefined) {
          // This is the exact additional property in the pretty-printed
          // CONTRACT.review.sourceEvidence array, including UTF-8 and escapes.
          const encoded = Buffer.byteLength(',\n        "content": ' + JSON.stringify(content), 'utf8');
          if (inlineBytes + encoded <= REVIEW_INLINE_BYTES) {
            inlineBytes += encoded;
            entry.content = content;
            omitted = null;
          } else omitted = 'inline-budget';
        }
      }
      entries.push({ ...entry, omitted });
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error.code === 'REVIEW_EVIDENCE_UNAVAILABLE') throw error;
    throw unavailable('无法安全读取审查工作区或原交付材料。请核对隔离目录后重试。', { sourceTaskId: source.version.taskId });
  }
  const evidence = entries.map(({ content, ...reference }) => reference);
  return { entries, receipt: { schema, source: source.version, sourceFingerprint: source.fingerprint, collaboration,
    inlineLimitBytes: REVIEW_INLINE_BYTES, inlineBytes, evidence } };
}

export async function verifyTaskReviewContext(dataDir, task, attempt, signal) {
  const receipt = attempt.reviewContext;
  const pin = receipt && Object.hasOwn(receipt, 'collaboration')
    ? receipt.collaboration : collaborationPin(attempt.workspace ?? task.workspace);
  if (!receipt && !pin) return;
  let root;
  try {
    root = await reviewRoot(dataDir, task);
    assert(digest(collaborationPin(task.workspace)) === digest(pin), 'COLLABORATION_CHANGED', '固定作者协作版本已变化');
    await verifyPinnedCollaboration(root, pin);
    signal?.throwIfAborted();
    for (const reference of receipt?.evidence ?? []) {
      const input = await localFile(root, reference.workspacePath);
      const checked = await readEvidence(input.filename, reference, signal);
      if (checked.rawSha256 !== reference.rawSha256) throw unavailable('审查材料字节已经变化。');
    }
  } catch {
    signal?.throwIfAborted();
    throw new AcmsError('REVIEW_EVIDENCE_CHANGED', '审查所用材料在执行期间已变化，未记录通过。请从原交付重新发起审查。');
  }
}
