import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AcmsError, assert, digest } from '../core/util.js';
import { bundlePath, checkoutGitBundle, fileDigest, gitWorktreeFingerprint, removeTemporary, storeGitBundle, verifiedGitBundle, verifiedStoredGitBundle } from './git-delivery.js';

const format = 'acms-git-composition/1';
const objectId = value => typeof value === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
const gitDate = '2000-01-01T00:00:00Z';
const treeOutputLimit = 8 * 1024 * 1024;

function gitOptions(signal) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return { signal, maxOutput: treeOutputLimit, env: { ...inherited, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_AUTHOR_DATE: gitDate, GIT_COMMITTER_DATE: gitDate } };
}

async function gitText(invoke, args, cwd, options) {
  const result = await invoke('git', args, cwd, options);
  assert(result.code === 0 && !result.timedOut, 'COMPOSITE_GIT', (result.stderr || result.stdout || '无法核对 Git 候选版本。').trim().slice(0, 6000));
  return result.stdout.trim();
}

const compositionInput = ({ taskId, generation, artifactHash, bundle, baseline, mergeBase }) => ({
  taskId, generation, artifactHash, bundleSha256: bundle.sha256, baseline: baseline?.version ?? null,
  ...(mergeBase ? { mergeBase: mergeBase.version } : {}),
});

function candidateTree(listing) {
  assert(listing.length < treeOutputLimit && (!listing || listing.endsWith('\0')),
    'COMPOSITE_CONTENT', '组合候选的 Git 文件清单不完整。');
  const files = new Map();
  for (const row of listing.split('\0').filter(Boolean)) {
    const match = row.match(/^(100644|100755) blob ([a-f0-9]+)\t(.*)$/s);
    assert(match && objectId(match[2]), 'COMPOSITE_CONTENT', '组合候选含不支持的 Git 文件类型，请核对链接或子模块。');
    const [, mode, oid, filename] = match;
    const parts = filename.split('/');
    assert(!/[\\\x00-\x1f:]/.test(filename) && parts.every(part => part && !['.', '..', '.git', 'node_modules'].includes(part.toLowerCase())) &&
      parts[0].toLowerCase() !== '.acms', 'COMPOSITE_CONTENT', `组合候选含不支持的项目路径 ${filename}。`);
    assert(!files.has(filename), 'COMPOSITE_CONTENT', `组合候选的路径 ${filename} 重复。`);
    files.set(filename, { mode, oid });
  }
  assertPathAliases(files.keys());
  return files;
}

function assertPathAliases(filenames) {
  if (process.platform !== 'win32') return;
  const folded = new Map();
  for (const filename of filenames) {
    const parts = filename.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('/');
      const key = name.toLowerCase();
      const previous = folded.get(key);
      assert(!previous || previous.name === name, 'COMPOSITE_PATH_ALIAS',
        `组合候选的路径 ${previous?.filename} 与 ${filename} 在此文件系统可能相互覆盖。`,
        { paths: [previous?.filename, filename] });
      folded.set(key, { name, filename });
    }
  }
}

async function worktreeEntry(root, relative) {
  const parts = relative.split('/');
  let filename = root;
  for (const [index, part] of parts.entries()) {
    filename = path.join(filename, part);
    const info = await fs.lstat(filename).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return null;
    const file = index === parts.length - 1;
    assert(file ? info.isFile() : info.isDirectory(), 'COMPOSITE_DRAFT_CONFLICT',
      `依赖更新与父任务已有路径 ${relative} 冲突，工作副本保留。`);
    if (file) return info;
  }
}

async function matchesTreeEntry(filename, info, expected) {
  if (!info || !expected) return !info && !expected;
  const algorithm = expected.oid.length === 64 ? 'sha256' : 'sha1';
  return (process.platform === 'win32' || !!(info.mode & 0o111) === (expected.mode === '100755')) &&
    await fileDigest(filename, { algorithm, prefix: 'blob ' + info.size + '\0' }) === expected.oid;
}

async function inspectCandidateCheckout(root, files) {
  const remaining = new Map(files);
  async function walk(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(absolute, relative + '/');
      else {
        const expected = remaining.get(relative);
        assert(expected && entry.isFile(), 'COMPOSITE_CONTENT', `组合候选实际检出含意外路径 ${relative}。`);
        const info = await fs.lstat(absolute);
        assert(info.isFile() && await matchesTreeEntry(absolute, info, expected),
        'COMPOSITE_CONTENT', `组合候选的路径 ${relative} 与 Git 树字节或模式不一致。`);
        remaining.delete(relative);
      }
    }
  }
  await walk(root, '');
  assert(!remaining.size, 'COMPOSITE_CONTENT', `组合候选实际检出缺少路径 ${remaining.keys().next().value}。`);
}

export async function selectedGitVersions(tasks, baseCommit, dataDir) {
  const selected = [];
  const previous = new Map();
  for (const task of tasks) {
    const bundle = await verifiedGitBundle(task, dataDir);
    assert(bundle && task.workspace?.compositionBase === baseCommit && bundle.baseCommit === baseCommit,
      'COMPOSITE_INPUT_MISSING', `任务 ${task.id} 缺少可核对的固定基线或持久 Git 交付，请核对后重新交付。`);
    assert(/^[a-f0-9]{64}$/.test(bundle.worktreeHash ?? ''), 'COMPOSITE_INPUT_INCOMPLETE',
      `任务 ${task.id} 的 Git 交付未证明覆盖完整工作副本。请保留原副本，补齐所需运行材料后重新交付。`);
    const baseline = task.workspace.compositionInput ?? null;
    if (baseline) {
      assert(baseline.baseCommit === baseCommit && Array.isArray(baseline.inputs) &&
        baseline.inputs.every(input => digest(previous.get(input.taskId) ?? null) === digest(input)),
      'COMPOSITE_INPUT_STALE', `任务 ${task.id} 使用的依赖版本已变化，请按当前依赖协调返工。`);
    }
    const item = { taskId: task.id, generation: task.generation, artifactHash: task.artifactHash, bundle, baseline };
    selected.push(item);
    previous.set(task.id, compositionInput(item));
  }
  return selected;
}

async function readCachedComposition(filename, dataDir, version, baseCommit, inputs) {
  const record = await fs.lstat(filename).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!record?.isFile() || record.size > 1024 * 1024) return null;
  const value = await fs.readFile(filename, 'utf8').then(JSON.parse).catch(() => null);
  if (value?.format !== format || value.version !== version || value.baseCommit !== baseCommit ||
    digest(value.inputs ?? null) !== digest(inputs) || !objectId(value.tree) || !/^[a-f0-9]{64}$/.test(value.contentHash ?? '') ||
    !/^[a-f0-9]{64}$/.test(value.bundle?.sha256 ?? '')) return null;
  const bundle = await verifiedStoredGitBundle({ ...value.bundle, path: bundlePath(dataDir, value.bundle.sha256) }, dataDir);
  return bundle ? { ...value, bundle } : null;
}

async function writeComposition(filename, candidate) {
  const temporary = filename + '.tmp-' + randomUUID();
  try {
    const { format, commit, sha256, bytes } = candidate.bundle;
    await fs.writeFile(temporary, JSON.stringify({ ...candidate, bundle: { format, commit, sha256, bytes } }), { flag: 'wx', flush: true });
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function composeGitVersions({ dataDir, source, baseCommit, inputs, invoke, signal }) {
  assert(objectId(baseCommit), 'COMPOSITE_BASE', '组合候选缺少固定基线。');
  const rows = inputs.map(compositionInput);
  const version = digest({ format, baseCommit, inputs: rows });
  const cache = path.join(dataDir, 'deliveries', 'compositions');
  await fs.mkdir(cache, { recursive: true });
  const filename = path.join(cache, version + '.json');
  const existing = await readCachedComposition(filename, dataDir, version, baseCommit, rows);
  if (existing) return existing;

  const scratch = path.join(dataDir, 'integration');
  await fs.mkdir(scratch, { recursive: true });
  const parent = await fs.realpath(scratch);
  const directory = await fs.mkdtemp(path.join(parent, 'composition-'));
  let retain = false;
  try {
    const repository = path.join(directory, 'repository');
    const options = gitOptions(signal);
    const git = (args, cwd = directory) => gitText(invoke, args, cwd, options);
    const inRepo = ['--git-dir=' + repository, '-c', 'core.ignorecase=false', '-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost'];
    const build = args => git([...inRepo, ...args]);
    await git(['init', '--bare', '--template=', '--object-format=' + (baseCommit.length === 64 ? 'sha256' : 'sha1'), repository]);
    await build(['fetch', '--no-tags', '--', source, baseCommit]);
    const treeOf = commit => build(['rev-parse', '--verify', commit + '^{tree}']);
    const trees = new Map();
    const readTree = tree => {
      if (!trees.has(tree)) trees.set(tree, build(['ls-tree', '-r', '--full-tree', '-z', tree]).then(candidateTree));
      return trees.get(tree);
    };
    const addBundle = async bundle => {
      assert(await verifiedStoredGitBundle(bundle, dataDir), 'COMPOSITE_INPUT_MISSING', '组合候选的持久 Git 版本缺失或已损坏。');
      await build(['bundle', 'unbundle', bundle.path]);
      return treeOf(bundle.commit);
    };
    let tree = await treeOf(baseCommit);
    for (const item of inputs) {
      const incoming = await addBundle(item.bundle);
      const baseline = item.mergeBase ?? item.baseline;
      const ancestor = baseline?.bundle?.commit ?? baseCommit;
      if (baseline) await addBundle(baseline.bundle);
      if (process.platform === 'win32') {
        const basePaths = await readTree(await treeOf(ancestor));
        const left = await readTree(tree), right = await readTree(incoming);
        // Independent additions cannot rely on a case-insensitive merge or
        // checkout deciding which spelling to preserve.
        assertPathAliases([...left.keys(), ...right.keys()].filter(filename => !basePaths.has(filename)));
      }
      const ours = await build(['commit-tree', tree, '-p', ancestor, '-m', 'ACMS composition current tree']);
      const theirs = await build(['commit-tree', incoming, '-p', ancestor, '-m', 'ACMS composition task tree']);
      const merged = await invoke('git', [...inRepo, 'merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, theirs], directory, options);
      const [mergedTree, ...paths] = merged.stdout.split('\0');
      if (merged.code === 1 && !merged.timedOut) {
        const conflicts = paths.filter(Boolean).slice(0, 20);
        throw new AcmsError('COMPOSITE_CONFLICT', `任务 ${item.taskId} 的交付与已组合版本冲突，请协调修正${conflicts.length ? '（' + conflicts.join('、') + '）' : ''}。`,
          { taskId: item.taskId, conflicts });
      }
      assert(merged.code === 0 && !merged.timedOut && objectId(mergedTree.trim()), 'COMPOSITE_GIT',
        (merged.stderr || 'Git 无法组合已选版本。').trim().slice(0, 6000));
      tree = mergedTree.trim();
    }
    const entries = await readTree(tree);
    const commit = await build(['commit-tree', tree, '-m', 'ACMS candidate ' + version]);
    await build(['update-ref', 'refs/heads/delivery', commit]);
    const bundleFile = path.join(directory, 'candidate.bundle');
    await build(['-c', 'pack.threads=1', 'bundle', 'create', bundleFile, 'refs/heads/delivery']);
    const checkout = path.join(directory, 'checkout');
    await checkoutGitBundle({ path: bundleFile, commit }, checkout, directory, git);
    await inspectCandidateCheckout(checkout, entries);
    const contentHash = await gitWorktreeFingerprint(checkout);
    assert(contentHash, 'COMPOSITE_CONTENT', '组合候选无法重建为可核对的项目文件。');
    const candidate = { format, version, baseCommit, inputs: rows, tree, contentHash,
      bundle: await storeGitBundle(bundleFile, commit, dataDir) };
    await writeComposition(filename, candidate);
    return candidate;
  } catch (error) {
    retain = !!error.cleanupUncertain;
    throw error;
  } finally { if (!retain) await removeTemporary(directory, parent); }
}

export async function checkoutComposition(candidate, destination, cwd, dataDir, invoke, signal) {
  const bundle = await verifiedStoredGitBundle(candidate?.bundle, dataDir);
  assert(bundle, 'COMPOSITE_INPUT_MISSING', '持久的组合候选版本缺失或已损坏。');
  const options = gitOptions(signal);
  const git = (args, directory) => gitText(invoke, args, directory, options);
  await checkoutGitBundle(bundle, destination, cwd, git);
  assert(await git(['rev-parse', '--verify', bundle.commit + '^{tree}'], destination) === candidate.tree,
    'COMPOSITE_CONTENT', '组合候选副本的 Git 树与已选版本不一致。');
  const entries = candidateTree(await git(['ls-tree', '-r', '--full-tree', '-z', bundle.commit], destination));
  await inspectCandidateCheckout(destination, entries);
  assert(await gitWorktreeFingerprint(destination) === candidate.contentHash, 'COMPOSITE_CONTENT', '组合候选副本与已选版本不一致。');
  return entries;
}

export async function updateCompositionWorkspace(previous, incoming, workspacePath, dataDir, invoke, signal) {
  const parent = await fs.realpath(path.join(dataDir, 'integration'));
  const temporary = await fs.mkdtemp(path.join(parent, 'composition-update-'));
  try {
    const oldPath = path.join(temporary, 'old-input');
    const newPath = path.join(temporary, 'new-input');
    const before = await checkoutComposition(previous, oldPath, temporary, dataDir, invoke, signal);
    const after = await checkoutComposition(incoming, newPath, temporary, dataDir, invoke, signal);
    const root = await fs.realpath(workspacePath);
    const stagedNames = await gitText(invoke, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD', '--', '.'], root, gitOptions(signal));
    assert(stagedNames.length < treeOutputLimit, 'COMPOSITE_DRAFT_CONFLICT', '父任务暂存清单过大，无法安全更新依赖。');
    const canonical = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
    const staged = new Set(stagedNames.split('\0').filter(Boolean).map(canonical));
    const changes = [];
    for (const relative of new Set([...before.keys(), ...after.keys()])) {
      signal?.throwIfAborted();
      const expected = before.get(relative), replacement = after.get(relative);
      if (expected?.oid === replacement?.oid && expected?.mode === replacement?.mode) continue;
      const filename = path.join(root, relative);
      const info = await worktreeEntry(root, relative);
      if (await matchesTreeEntry(filename, info, replacement)) continue;
      assert(!staged.has(canonical(relative)) && await matchesTreeEntry(filename, info, expected), 'COMPOSITE_DRAFT_CONFLICT',
        `依赖更新与父任务草稿 ${relative} 冲突，工作副本及暂存内容保留。`, { path: relative });
      changes.push({ relative, filename, expected, replacement });
    }
    // Only update the old baseline's unchanged paths. Finished changes already
    // match the new input so an interrupted overlay can be resumed safely.
    const stagedFile = path.join(temporary, 'update');
    for (const { relative, filename, expected, replacement } of changes) {
      signal?.throwIfAborted();
      assert(await matchesTreeEntry(filename, await worktreeEntry(root, relative), expected),
        'COMPOSITE_DRAFT_CONFLICT', `父任务草稿 ${relative} 在依赖更新期间发生变化，已保留该文件。`);
      if (replacement) {
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.copyFile(path.join(newPath, relative), stagedFile);
        await fs.rename(stagedFile, filename);
      } else await fs.unlink(filename);
    }
  } finally { await removeTemporary(temporary, parent); }
}
