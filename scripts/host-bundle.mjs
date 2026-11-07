// Build artifacts only. No profile, live host or company database access.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export async function buildHost({ root, outDir = path.join(root, 'dist'), entryPoint = 'src/host/index.js' }) {
  const source = await readFile(path.join(root, 'src/runtime/owned-job.cs'));
  const resource = `owned-job-${createHash('sha256').update(source).digest('hex')}.cs`;
  const bundle = await build({ absWorkingDir: root, entryPoints: [path.resolve(root, entryPoint)], platform: 'node', format: 'esm', bundle: true,
    packages: 'external', write: false, target: 'node24', define: { __ACMS_OWNED_JOB_RESOURCE__: JSON.stringify(`./${resource}`) } });
  const bytes = bundle.outputFiles[0].contents;
  const revision = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const filename = path.join(outDir, `host-${revision}.mjs`);
  await mkdir(outDir, { recursive: true });
  // The resource is published before its referencing bundle. Old bundles retain
  // their matching resource for rollback, even when the C# implementation changes.
  await writeFile(path.join(outDir, resource), source);
  await writeFile(filename, bytes);
  return { filename, revision, resource: path.join(outDir, resource) };
}
