import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { AcmsError, assert, digest } from '../core/util.js';
import { fileDigest, removeTemporary } from './git-delivery.js';
import { includedProjectInput } from './project-inputs.js';

const treeFormat = 'acms-copy-tree/1';
const candidateFormat = 'acms-copy-composition/1';
const manifestLimit = 16 * 1024 * 1024;
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const parentOf = name => path.posix.dirname(name);
const byName = ([left], [right]) => left < right ? -1 : left > right ? 1 : 0;
const same = (left, right) => left?.mode === right?.mode && left?.oid === right?.oid && left?.bytes === right?.bytes;
const fileMode = stat => process.platform !== 'win32' && stat.mode & 0o111 ? '100755' : '100644';
const missing = error => {
  if (error.code !== 'ENOENT') throw error;
  return null;
};

function validateTree(entries) {
  const folded = new Map();
  for (const [name, entry] of entries) {
    const parts = name.split('/');
    assert(parts.every(part => part && part !== '.' && part !== '..' && includedProjectInput(part) &&
      !/[\\\x00-\x1f:<>|"*?]/.test(part) && !/[ .]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)),
    'COMPOSITE_PATH', `组合候选使用了无法安全重建的路径 ${name}。`);
    const alias = name.normalize('NFC').toLowerCase();
    assert(!folded.has(alias), 'COMPOSITE_PATH_ALIAS', `组合候选的路径 ${folded.get(alias)} 与 ${name} 可能相互覆盖。`,
      { paths: [folded.get(alias), name] });
    folded.set(alias, name);
    const parent = parentOf(name);
    assert(parent === '.' || entries.get(parent)?.mode === 'directory', 'COMPOSITE_CONFLICT',
      `组合候选的路径 ${parent} 与 ${name} 冲突，请核对文件或目录变化。`, { paths: [parent, name] });
    assert(entry.mode === 'directory' || (['100644', '100755'].includes(entry.mode) && isHash(entry.oid) &&
      Number.isSafeInteger(entry.bytes) && entry.bytes >= 0), 'COMPOSITE_CONTENT', `无法核对目录候选文件 ${name}。`);
  }
}

async function approvedDirectory(root, name, create) {
  const destination = path.join(root, name);
  if (create) await fs.mkdir(destination).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await fs.lstat(destination).catch(missing);
  assert(info?.isDirectory() && await fs.realpath(destination) === destination, 'COMPOSITE_CONTENT',
    `无法核对目录候选存储位置 ${name}，请检查数据目录。`);
  return destination;
}

async function storage(dataDir, name, create = false) {
  const deliveries = await approvedDirectory(await fs.realpath(dataDir), 'deliveries', create);
  const copy = await approvedDirectory(deliveries, 'copy', create);
  return approvedDirectory(copy, name, create);
}

async function safeFile(filename, expected) {
  const info = await fs.lstat(filename).catch(missing);
  assert(info?.isFile() && await fs.realpath(filename) === filename &&
    (expected === undefined || info.size === expected), 'COMPOSITE_CONTENT',
  `无法核对目录候选文件 ${path.basename(filename)}，请核对缺失文件、链接或内容变化。`);
  return info;
}

function encodeTree(entries) {
  const body = Buffer.from(JSON.stringify({ format: treeFormat, entries: [...entries].sort(byName)
    .map(([name, item]) => item.mode === 'directory' ? [name, item.mode] : [name, item.mode, item.oid, item.bytes]) }));
  assert(body.length <= manifestLimit, 'COMPOSITE_CONTENT', '目录候选文件清单超过可核对范围。');
  return { body, reference: { format: treeFormat, sha256: sha256(body) } };
}

async function scan(root, signal) {
  const entries = new Map();
  async function walk(directory, prefix) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (!includedProjectInput(item.name)) continue;
      const relative = prefix + item.name;
      const filename = path.join(directory, item.name);
      if (item.isDirectory()) {
        assert((await fs.lstat(filename)).isDirectory() && await fs.realpath(filename) === filename, 'COMPOSITE_PATH',
          `目录候选的路径 ${relative} 经过链接。`);
        entries.set(relative, { mode: 'directory' });
        await walk(filename, relative + '/');
      } else {
        assert(item.isFile(), 'COMPOSITE_PATH', `目录候选的路径 ${relative} 含链接或特殊文件。`);
        const info = await safeFile(filename);
        entries.set(relative, { mode: fileMode(info), oid: await fileDigest(filename, { signal }), bytes: info.size });
      }
    }
  }
  await walk(root, '');
  validateTree(entries);
  return entries;
}

export async function copyContentHash(root, signal) {
  return encodeTree(await scan(await fs.realpath(root), signal)).reference.sha256;
}

export async function copyCheckInputs(root, signal) {
  const entries = await scan(await fs.realpath(root), signal);
  return {
    hash: encodeTree(entries).reference.sha256,
    entries: [...entries].map(([name, { mode, oid }]) => [name, oid ? `${mode}:${oid}` : mode]),
  };
}

async function publishFile(source, filename, verify) {
  try { await fs.link(source, filename); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return verify();
  }
}

async function checkBlob(filename, entry, signal) {
  await safeFile(filename, entry.bytes);
  assert(await fileDigest(filename, { signal }) === entry.oid, 'COMPOSITE_CONTENT', '持久目录交付的文件内容无法核对。', { sha256: entry.oid });
}

async function saveTree(entries, manifestDirectory, temporary) {
  const { body, reference } = encodeTree(entries);
  const source = path.join(temporary, 'manifest.json');
  await fs.writeFile(source, body, { flag: 'wx', flush: true });
  const file = path.join(manifestDirectory, reference.sha256 + '.json');
  await publishFile(source, file, async () => {
    await safeFile(file, body.length);
    assert(await fileDigest(file) === reference.sha256, 'COMPOSITE_CONTENT', '已有目录交付清单无法核对。');
  });
  return reference;
}

export async function captureCopySnapshot(root, dataDir, signal) {
  const source = await fs.realpath(root);
  const entries = await scan(source, signal);
  const blobDirectory = await storage(dataDir, 'files', true);
  const manifests = await storage(dataDir, 'trees', true);
  const parent = await approvedDirectory(await fs.realpath(dataDir), 'integration', true);
  const temporary = await fs.mkdtemp(path.join(parent, 'copy-capture-'));
  try {
    for (const [name, item] of entries) {
      signal?.throwIfAborted();
      if (item.mode === 'directory') continue;
      const file = path.join(blobDirectory, item.oid);
      if (await fs.lstat(file).catch(missing)) {
        await checkBlob(file, item, signal);
        continue;
      }
      const input = path.join(source, name);
      await safeFile(input, item.bytes);
      const staged = path.join(temporary, item.oid);
      await fs.copyFile(input, staged, constants.COPYFILE_EXCL);
      await checkBlob(staged, item, signal);
      await publishFile(staged, file, () => checkBlob(file, item, signal));
    }
    const current = await copyContentHash(root, signal);
    assert(current === encodeTree(entries).reference.sha256, 'COMPOSITE_CONTENT', '冻结期间目录内容已变化，请停止修改后重试。');
    return await saveTree(entries, manifests, temporary);
  } finally { await removeTemporary(temporary, parent); }
}

async function readTree(reference, dataDir) {
  assert(reference?.format === treeFormat && isHash(reference.sha256), 'COMPOSITE_CONTENT', '目录交付缺少可核对的版本引用。');
  const filename = path.join(await storage(dataDir, 'trees'), reference.sha256 + '.json');
  const info = await safeFile(filename);
  assert(info.size <= manifestLimit, 'COMPOSITE_CONTENT', '目录交付清单超过可核对范围。');
  const bytes = await fs.readFile(filename);
  assert(sha256(bytes) === reference.sha256, 'COMPOSITE_CONTENT', '持久目录交付清单已变化。');
  const rows = JSON.parse(bytes).entries;
  assert(Array.isArray(rows) && rows.every(row => Array.isArray(row) && typeof row[0] === 'string'),
    'COMPOSITE_CONTENT', '无法核对目录交付清单结构。');
  const entries = new Map(rows.map(([name, mode, oid, size]) => [name, { mode, oid, bytes: size }]));
  assert(rows.length === entries.size && encodeTree(entries).reference.sha256 === reference.sha256,
    'COMPOSITE_CONTENT', '无法核对目录交付清单结构。');
  validateTree(entries);
  return entries;
}

async function verifyFiles(entries, dataDir, signal, verified = new Set()) {
  const directory = await storage(dataDir, 'files');
  for (const item of entries.values()) {
    signal?.throwIfAborted();
    if (item.mode === 'directory' || verified.has(item.oid)) continue;
    await checkBlob(path.join(directory, item.oid), item, signal);
    verified.add(item.oid);
  }
  return directory;
}

export async function verifyCopySnapshot(reference, dataDir, signal) {
  await verifyFiles(await readTree(reference, dataDir), dataDir, signal);
}

export function copyDeliveryFor(task) {
  const delivery = task?.integration?.delivery;
  if (!task?.copyDeliveryInputHash || task.workspace?.mode !== 'copy' || delivery?.format !== treeFormat ||
    delivery.sha256 !== task.copyDeliveryInputHash || delivery.generation !== task.generation ||
    delivery.artifactHash !== task.artifactHash || delivery.baseHash !== task.workspace.compositionBase) return null;
  return delivery;
}

export async function verifiedCopyDelivery(task, dataDir) {
  const delivery = copyDeliveryFor(task);
  if (!delivery) return null;
  return verifyCopySnapshot(delivery, dataDir).then(() => delivery, () => null);
}

export async function checkoutCopyComposition(reference, destination, dataDir, signal) {
  const entries = await readTree(reference, dataDir);
  const blobs = await verifyFiles(entries, dataDir, signal);
  const parent = await fs.realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const existing = await fs.lstat(target).catch(missing);
  if (existing) {
    assert(existing.isDirectory() && await fs.realpath(target) === target &&
      await copyContentHash(target, signal) === reference.sha256, 'COMPOSITE_WORKSPACE_INCOMPLETE',
    '现有副本与冻结内容不一致，原文件已保留。');
    return entries;
  }
  const root = await fs.mkdtemp(path.join(parent, 'copy-checkout-'));
  try {
    for (const [name, item] of entries) {
      signal?.throwIfAborted();
      const filename = path.join(root, name);
      if (item.mode === 'directory') await fs.mkdir(filename);
      else {
        await fs.copyFile(path.join(blobs, item.oid), filename, constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') await fs.chmod(filename, item.mode === '100755' ? 0o755 : 0o644);
      }
    }
    assert(await copyContentHash(root, signal) === reference.sha256, 'COMPOSITE_CONTENT', '重建目录的内容与持久交付不一致。');
    signal?.throwIfAborted();
    await fs.rename(root, target);
  } finally { await removeTemporary(root, parent); }
  return entries;
}

const inputIdentity = ({ taskId, generation, artifactHash, snapshot, baseline, mergeBase }) => ({
  taskId, generation, artifactHash, snapshotSha256: snapshot.sha256, baseline: baseline?.version ?? null,
  ...(mergeBase ? { mergeBase: mergeBase.version } : {}),
});

export function selectedCopyVersions(tasks, baseHash) {
  const selected = new Map(), versions = [];
  for (const task of tasks) {
    const snapshot = copyDeliveryFor(task);
    assert(snapshot && snapshot.baseHash === baseHash,
    'COMPOSITE_INPUT_MISSING', `任务 ${task.id} 缺少当前固定基线的持久目录交付。`, { taskId: task.id });
    const baseline = task.workspace.compositionInput;
    assert(baseline?.baseHash === baseHash && Array.isArray(baseline.inputs) &&
      baseline.inputs.every(row => digest(selected.get(row.taskId) ?? null) === digest(row)),
      'COMPOSITE_INPUT_STALE', `任务 ${task.id} 使用的依赖版本已变化，请按当前依赖协调返工。`, { taskId: task.id });
    const version = { taskId: task.id, generation: task.generation, artifactHash: task.artifactHash, snapshot, baseline };
    selected.set(task.id, inputIdentity(version));
    versions.push(version);
  }
  return versions;
}

function merge(entries, before, after, taskId) {
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(name), change = after.get(name);
    if (same(previous, change) || same(entries.get(name), change)) continue;
    assert(same(entries.get(name), previous), 'COMPOSITE_CONFLICT',
      `任务 ${taskId} 的目录交付在 ${name} 与已组合版本冲突，请协调修正。`, { taskId, path: name });
    if (change) entries.set(name, change);
    else entries.delete(name);
  }
  validateTree(entries);
}

export async function composeCopyVersions({ dataDir, base, inputs, signal }) {
  const rows = inputs.map(inputIdentity);
  const version = digest({ format: candidateFormat, baseHash: base.sha256, inputs: rows });
  const cache = await storage(dataDir, 'compositions', true);
  const filename = path.join(cache, version + '.json');
  const read = async () => {
    if (!await fs.lstat(filename).catch(missing)) return null;
    const info = await safeFile(filename);
    assert(info.size <= manifestLimit, 'COMPOSITE_CONTENT', '目录候选记录超过可核对范围。');
    let candidate;
    try { candidate = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { throw new AcmsError('COMPOSITE_CONTENT', '无法读取持久目录候选记录。', { cause: error.code ?? null }); }
    assert(candidate?.format === candidateFormat && candidate.version === version && candidate.baseHash === base.sha256 &&
      candidate.contentHash === candidate.snapshot?.sha256 && digest(candidate.inputs) === digest(rows),
    'COMPOSITE_CONTENT', '持久目录候选记录与当前已选输入不一致。');
    return candidate;
  };
  const stored = await read();
  const verified = new Set();
  const originals = new Map();
  const load = async reference => {
    if (!originals.has(reference?.sha256)) {
      const entries = await readTree(reference, dataDir);
      await verifyFiles(entries, dataDir, signal, verified);
      originals.set(reference.sha256, entries);
    }
    return originals.get(reference.sha256);
  };
  const initial = await load(base);
  const entries = new Map(initial);
  for (const item of inputs) {
    signal?.throwIfAborted();
    const baseline = item.mergeBase ?? item.baseline;
    try {
      const previous = baseline ? await load(baseline.snapshot) : initial;
      merge(entries, previous, await load(item.snapshot), item.taskId);
    } catch (error) {
      if (!error.code?.startsWith('COMPOSITE_') || error.code === 'COMPOSITE_CONFLICT' && error.details?.taskId) throw error;
      throw new AcmsError(error.code, `任务 ${item.taskId} 的目录交付无法组合：${error.message}`,
        { ...error.details, taskId: item.taskId });
    }
  }
  const expected = encodeTree(entries).reference.sha256;
  if (stored) {
    assert(stored.contentHash === expected, 'COMPOSITE_CONTENT', '已存目录候选与当前输入的组合内容不一致。');
    await load(stored.snapshot);
    return stored;
  }
  const manifests = await storage(dataDir, 'trees');
  const parent = await approvedDirectory(await fs.realpath(dataDir), 'integration', true);
  const temporary = await fs.mkdtemp(path.join(parent, 'copy-compose-'));
  try {
    const snapshot = await saveTree(entries, manifests, temporary);
    const candidate = { format: candidateFormat, version, baseHash: base.sha256, inputs: rows, contentHash: snapshot.sha256, snapshot };
    const record = path.join(temporary, 'candidate.json');
    await fs.writeFile(record, JSON.stringify(candidate), { flag: 'wx', flush: true });
    return await publishFile(record, filename, async () => {
      const published = await read();
      assert(published?.contentHash === expected, 'COMPOSITE_CONTENT', '并发发布的目录候选与当前组合内容不一致。');
      return published;
    }) ?? candidate;
  } finally { await removeTemporary(temporary, parent); }
}
