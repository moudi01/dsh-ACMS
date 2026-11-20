// Build artifacts only. No profile, live host or company database access.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

async function matchesPublishedVersion(filename, bytes) {
  const existing = await fs.readFile(filename).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!existing) return false;
  if (!existing.equals(bytes)) throw new Error(`Existing host artifact differs from its versioned build: ${filename}`);
  return true;
}

async function publishVersion(filename, bytes) {
  if (await matchesPublishedVersion(filename, bytes)) return;
  const temporary = filename + '.tmp-' + randomUUID();
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', flush: true });
    try { await fs.link(temporary, filename); }
    catch (error) {
      if (error.code !== 'EEXIST' || !await matchesPublishedVersion(filename, bytes)) throw error;
    }
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function buildResource(root, prefix, entryPoint) {
  const result = await build({ absWorkingDir: root, entryPoints: [entryPoint], platform: 'node',
    format: 'esm', bundle: true, packages: 'external', write: false, target: 'node24' });
  const bytes = result.outputFiles[0].contents;
  return { name: `${prefix}-${createHash('sha256').update(bytes).digest('hex')}.mjs`, bytes };
}

export async function buildHost({ root, outDir = path.join(root, 'dist'), entryPoint = 'src/host/index.js' }) {
  const source = await fs.readFile(path.join(root, 'src/runtime/owned-job.cs'));
  const resource = `owned-job-${createHash('sha256').update(source).digest('hex')}.cs`;
  const [archiveWorker, bareTransactionHook] = await Promise.all([
    buildResource(root, 'archive-worker', 'src/runtime/delivery-archive-worker.js'),
    buildResource(root, 'bare-transaction-hook', 'src/runtime/bare-transaction-hook.js'),
  ]);
  const bundle = await build({ absWorkingDir: root, entryPoints: [path.resolve(root, entryPoint)], platform: 'node', format: 'esm', bundle: true,
    packages: 'external', write: false, target: 'node24', define: { __ACMS_OWNED_JOB_RESOURCE__: JSON.stringify(`./${resource}`),
      __ACMS_ARCHIVE_WORKER_RESOURCE__: JSON.stringify(`./${archiveWorker.name}`),
      __ACMS_BARE_TRANSACTION_HOOK_RESOURCE__: JSON.stringify(`./${bareTransactionHook.name}`) } });
  const bytes = bundle.outputFiles[0].contents;
  const revision = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const filename = path.join(outDir, `host-${revision}.mjs`);
  await fs.mkdir(outDir, { recursive: true });
  // Publish side resources before the host that references them. Keep older
  // versions so a previous profile can still load its matching resources.
  await publishVersion(path.join(outDir, resource), source);
  await publishVersion(path.join(outDir, archiveWorker.name), archiveWorker.bytes);
  await publishVersion(path.join(outDir, bareTransactionHook.name), bareTransactionHook.bytes);
  await publishVersion(filename, bytes);
  return { filename, revision, resource: path.join(outDir, resource), archiveWorker: path.join(outDir, archiveWorker.name),
    bareTransactionHook: path.join(outDir, bareTransactionHook.name) };
}
