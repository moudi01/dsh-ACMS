// Build artifacts only. No profile, live host or company database access.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

async function matchesPublishedVersion(filename, bytes) {
  const existing = await readFile(filename).catch(error => {
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
    await writeFile(temporary, bytes, { flag: 'wx', flush: true });
    if (!await matchesPublishedVersion(filename, bytes)) await rename(temporary, filename);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function buildHost({ root, outDir = path.join(root, 'dist'), entryPoint = 'src/host/index.js' }) {
  const source = await readFile(path.join(root, 'src/runtime/owned-job.cs'));
  const resource = `owned-job-${createHash('sha256').update(source).digest('hex')}.cs`;
  const worker = await build({ absWorkingDir: root, entryPoints: ['src/runtime/delivery-archive-worker.js'], platform: 'node',
    format: 'esm', bundle: true, packages: 'external', write: false, target: 'node24' });
  const workerBytes = worker.outputFiles[0].contents;
  const archiveWorker = `archive-worker-${createHash('sha256').update(workerBytes).digest('hex')}.mjs`;
  const bundle = await build({ absWorkingDir: root, entryPoints: [path.resolve(root, entryPoint)], platform: 'node', format: 'esm', bundle: true,
    packages: 'external', write: false, target: 'node24', define: { __ACMS_OWNED_JOB_RESOURCE__: JSON.stringify(`./${resource}`),
      __ACMS_ARCHIVE_WORKER_RESOURCE__: JSON.stringify(`./${archiveWorker}`) } });
  const bytes = bundle.outputFiles[0].contents;
  const revision = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const filename = path.join(outDir, `host-${revision}.mjs`);
  await mkdir(outDir, { recursive: true });
  // The resource is published before its referencing bundle. Old bundles retain
  // their matching resource for rollback, even when the C# implementation changes.
  await publishVersion(path.join(outDir, resource), source);
  await publishVersion(path.join(outDir, archiveWorker), workerBytes);
  await publishVersion(filename, bytes);
  return { filename, revision, resource: path.join(outDir, resource), archiveWorker: path.join(outDir, archiveWorker) };
}
