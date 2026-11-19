import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { assert, digest } from '../core/util.js';
import { isCollaborationPath } from './collaboration.js';

const FORMAT = 'acms-git-bundle/1';
const branch = 'refs/heads/delivery';
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
const attributes = '* -text -eol -ident -filter -working-tree-encoding\n';

function bundlePath(dataDir, sha256) {
  return path.join(dataDir, 'deliveries', sha256 + '.bundle');
}

function deliveryPath(filename) {
  const standard = filename.replaceAll('\\', '/');
  assert(standard && !/[\x00-\x1f:]/.test(standard) && !isCollaborationPath(standard) &&
    standard.split('/').every(part => part && !['.', '..', '.git', 'node_modules'].includes(part.toLowerCase())),
  'GIT_DELIVERY_PATH', 'Git delivery paths must be ordinary project files');
  return standard;
}

async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

async function removeTemporary(directory, parent) {
  if (await fs.realpath(directory).catch(() => null) === directory && path.dirname(directory) === parent) {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

export async function gitWorktreeFingerprint(root) {
  const files = [];
  async function walk(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = entry.name.toLowerCase();
      if (name === 'node_modules' || (!prefix && ['.git', '.acms'].includes(name))) continue;
      const relative = prefix + entry.name;
      const filename = path.join(directory, entry.name);
      if (name === '.git' || entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!await walk(filename, relative + '/')) return false;
      } else if (entry.isFile()) {
        const mode = (await fs.stat(filename)).mode & 0o111;
        files.push([relative, mode, await fileDigest(filename)]);
      } else return false;
    }
    return true;
  }
  if (!await walk(root, '')) return null;
  return digest(files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export async function verifiedGitBundle(task, dataDir) {
  const delivery = task.integration?.delivery;
  if (!delivery || delivery.format !== FORMAT || !oid(delivery.commit) || !oid(delivery.baseCommit) ||
    !oid(delivery.workspaceHead) || delivery.generation !== task.generation || delivery.artifactHash !== task.artifactHash ||
    delivery.baseCommit !== task.workspace?.baseCommit || typeof delivery.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(delivery.sha256) || !Number.isSafeInteger(delivery.bytes) || delivery.bytes < 1) return null;
  const expected = bundlePath(dataDir, delivery.sha256);
  if (delivery.path !== expected) return null;
  try {
    const root = await fs.realpath(dataDir);
    const file = await fs.lstat(expected);
    if (!file.isFile() || file.size !== delivery.bytes ||
      await fs.realpath(expected) !== bundlePath(root, delivery.sha256) || await fileDigest(expected) !== delivery.sha256) return null;
    return delivery;
  } catch {
    return null;
  }
}

export async function publishGitDelivery({ dataDir, task, artifacts, source, executionId, git, safeFile }) {
  const { workspace } = task;
  assert(oid(workspace.baseCommit) && Array.isArray(task.changeSet), 'GIT_DELIVERY_EVIDENCE',
    '交付缺少可验证的 Git 基准或变更清单，请重新交付。');
  const files = new Map(task.changeSet.map(file => [deliveryPath(file.path), file]));
  for (const artifact of artifacts) {
    const name = deliveryPath(artifact.path);
    const existing = files.get(name);
    assert(!existing || existing.hash === artifact.hash, 'ARTIFACT_CHANGED', '声明产物与已验收的 Git 变更不一致。');
    if (!existing) files.set(name, artifact);
  }
  const objectDirectory = async cwd => fs.realpath(await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], cwd));
  const objects = await objectDirectory(source);
  assert(await objectDirectory(workspace.path) === objects, 'GIT_DELIVERY_REPOSITORY', '工作副本不再属于批准的源 Git 仓库。');
  assert(!/[\r\n]/.test(objects), 'GIT_DELIVERY_REPOSITORY', 'Git 对象目录路径不能包含换行。');
  const objectFormat = await git(['rev-parse', '--show-object-format'], workspace.path);
  const workspaceHead = await git(['rev-parse', '--verify', 'HEAD'], workspace.path);
  const workspaceRoot = await fs.realpath(workspace.path);
  const integrationRoot = path.join(dataDir, 'integration');
  await fs.mkdir(integrationRoot, { recursive: true });
  const parent = await fs.realpath(integrationRoot);
  const temporary = await fs.mkdtemp(path.join(parent, executionId + '-delivery-'));
  let cleanupPending = false;
  try {
    const repository = path.join(temporary, 'repository');
    const indexWorktree = path.join(temporary, 'files');
    await fs.mkdir(indexWorktree);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const gitOptions = { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temporary, 'no-global-config'),
      GIT_AUTHOR_DATE: task.createdAt, GIT_COMMITTER_DATE: task.createdAt } };
    await git(['init', '--bare', '--template=', '--object-format=' + objectFormat, repository], temporary, gitOptions);
    await fs.mkdir(path.join(repository, 'info'), { recursive: true });
    await fs.writeFile(path.join(repository, 'objects', 'info', 'alternates'), objects.replaceAll('\\', '/') + '\n');
    await fs.writeFile(path.join(repository, 'info', 'attributes'), attributes);
    const build = args => git(['--git-dir=' + repository, '--work-tree=' + indexWorktree, '--literal-pathspecs',
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'user.name=ACMS', '-c', 'user.email=acms@localhost',
      ...args], indexWorktree, gitOptions);
    await build(['read-tree', workspace.baseCommit]);
    for (const [name, entry] of files) {
      if (entry.deleted) continue;
      const file = await safeFile(name);
      assert(path.relative(workspaceRoot, file) === path.normalize(name), 'GIT_DELIVERY_PATH', 'Git 交付不接受指向其他路径的文件。');
      const bytes = await fs.readFile(file);
      assert(digest(bytes.toString('base64')) === entry.hash, 'ARTIFACT_CHANGED', '生成 Git 交付版本时文件内容已改变。');
      const destination = path.join(indexWorktree, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { mode: (await fs.stat(file)).mode & 0o777 });
    }
    if (files.size) {
      const pathspec = path.join(temporary, 'pathspec');
      await fs.writeFile(pathspec, [...files.keys()].join('\0') + '\0');
      await build(['add', '--all', '--force', '--pathspec-from-file=' + pathspec, '--pathspec-file-nul']);
    }
    const tree = await build(['write-tree']);
    // A root commit bundles the complete file tree without relying on the
    // source object database or retaining its history in every backup.
    const commit = await build(['commit-tree', tree, '-m', `ACMS delivery ${task.id} g${task.generation} ${task.artifactHash}`]);
    await build(['update-ref', branch, commit]);
    const bundle = path.join(temporary, 'delivery.bundle');
    await build(['-c', 'pack.threads=1', 'bundle', 'create', bundle, branch]);
    const sha256 = await fileDigest(bundle);
    const { size: bytes } = await fs.stat(bundle);
    const maxOutput = 4 * 1024 * 1024;
    const ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.',
      ':(exclude,icase).acms', ':(exclude,glob,icase)**/node_modules/**'], workspace.path, { maxOutput });
    // Any ignored file outside the version (including local credentials or
    // local data) makes the workspace ineligible for automatic cleanup.
    const coversWorkspace = ignored.length < maxOutput && ignored.split('\0').every(name => !name || files.has(name));
    const worktreeHash = coversWorkspace ? await gitWorktreeFingerprint(workspace.path) : null;
    const filename = bundlePath(dataDir, sha256);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    // A retry only publishes identically hashed bytes at this path.
    await fs.rename(bundle, filename);
    return { format: FORMAT, path: filename, sha256, bytes, commit, workspaceHead, worktreeHash, baseCommit: workspace.baseCommit,
      generation: task.generation, artifactHash: task.artifactHash };
  } catch (error) {
    cleanupPending = !!error.cleanupUncertain;
    throw error;
  } finally {
    if (!cleanupPending) await removeTemporary(temporary, parent);
  }
}

export async function checkoutGitBundle(delivery, destination, cwd, git) {
  // Reuse a finished checkout if the previous host stopped just before
  // attaching it. A partial checkout is built in a separate directory.
  const existing = await fs.lstat(destination).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    assert(existing.isDirectory() && !existing.isSymbolicLink() &&
      await git(['rev-parse', '--verify', 'HEAD'], destination) === delivery.commit &&
      await git(['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain'], destination) === '',
    'GIT_DELIVERY_DESTINATION', '现有审查副本与 Git 交付版本不一致。');
    return;
  }
  const parent = await fs.realpath(path.dirname(destination));
  const temporary = await fs.mkdtemp(path.join(parent, path.basename(destination) + '-bundle-'));
  try {
    await git(['clone', '--no-checkout', '--template=', '--branch', 'delivery', '--', delivery.path, temporary], cwd);
    const info = path.join(temporary, '.git', 'info');
    await fs.mkdir(info, { recursive: true });
    await fs.writeFile(path.join(info, 'attributes'), attributes);
    await git(['-c', 'core.hooksPath=' + info, '-c', 'core.autocrlf=false', 'checkout', '--detach', delivery.commit], temporary);
    await fs.rename(temporary, destination);
  } finally {
    await removeTemporary(temporary, parent);
  }
}
