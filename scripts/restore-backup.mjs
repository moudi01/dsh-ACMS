#!/usr/bin/env node
// Restore a verified ACMS backup into a new directory. The source backup is
// never modified; the target must be empty so a restore cannot merge silently.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyBackup, sha256 } from './backup.mjs';

function parseArgs(argv) {
  const args = { backup: null, target: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--backup') args.backup = argv[++index];
    else if (value === '--target') args.target = argv[++index];
    else if (value === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.backup || !args.target) throw new Error('Both --backup and --target are required');
  return args;
}
const inside = (root, target) => { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

export async function restoreBackup({ backup, target }) {
  const source = path.resolve(backup); const destination = path.resolve(target);
  if (inside(source, destination)) throw new Error('Restore target must be outside the backup directory');
  const verification = await verifyBackup(source);
  if (!verification.ok) throw new Error(`Backup verification failed: ${verification.errors.join('; ')}`);
  let targetEntries = [];
  try { targetEntries = await fs.readdir(destination); } catch { /* new directory */ }
  if (targetEntries.length) throw new Error(`Restore target is not empty: ${destination}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, errorOnExist: false });
  const manifest = verification.manifest;
  const rewritten = rewritePaths(path.join(destination, manifest.database.file), manifest.source, destination);
  const databaseBytes = await fs.readFile(path.join(destination, manifest.database.file));
  manifest.database = { ...manifest.database, bytes: databaseBytes.length, sha256: sha256(databaseBytes) };
  manifest.restoredFrom = manifest.source;
  manifest.restoredAt = new Date().toISOString();
  manifest.restoredTo = destination;
  manifest.rewrittenPaths = rewritten;
  await fs.writeFile(path.join(destination, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const lines = [
    '# ACMS restore notes', '',
    `Restored ${new Date().toISOString()} from ${manifest.source}.`, '',
    '## Excluded material and how to rebuild it', '',
  ];
  if (!manifest.excluded.length) lines.push('Nothing was excluded.');
  for (const item of manifest.excluded) lines.push(`- \`${item.path}\` — ${item.reason}. Rebuild: ${item.rebuild}`);
  lines.push('', '## After restore', '',
    '1. Start the host with this directory as the ACMS data directory; do not copy individual files over a live database.',
    '2. In-flight attempts restored without confirmed cleanup enter `reconciling`; use "重新读取回执" instead of re-running or deleting locks.',
    manifest.includePairing
      ? '3. External model pairing files were included in this backup; review them in this environment before use.'
      : '3. External model pairings were excluded; re-pair them in this environment if needed.',
    '4. Source project Git repositories are not part of this backup; keep them separately.',
    `5. ${rewritten} stored path(s) inside the old data directory were rewritten to this restored directory, including task workspaces and artifact blob paths. Paths outside the data directory were left unchanged.`, '');
  await fs.writeFile(path.join(destination, 'REBUILD.md'), lines.join('\n'), { mode: 0o600 });
  return { ok: true, target: destination, files: manifest.files.length, excluded: manifest.excluded.length, rewrittenPaths: rewritten, database: manifest.database };
}

function rewritePaths(databasePath, oldRoot, newRoot) {
  const database = new DatabaseSync(databasePath);
  let rewritten = 0;
  const resolve = value => {
    if (typeof value !== 'string' || !value) return value;
    const relative = path.relative(path.resolve(oldRoot), path.resolve(value));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return value;
    rewritten += 1;
    return path.join(newRoot, relative);
  };
  const walk = value => {
    if (typeof value === 'string') return resolve(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  try {
    database.exec('BEGIN IMMEDIATE');
    const rows = database.prepare('SELECT collection, id, revision, body FROM entities').all();
    const update = database.prepare('UPDATE entities SET body=?, revision=? WHERE collection=? AND id=?');
    for (const row of rows) {
      const body = JSON.parse(row.body);
      const next = walk(body);
      const serialized = JSON.stringify(next);
      if (serialized !== row.body) update.run(serialized, row.revision + 1, row.collection, row.id);
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  } finally { database.close(); }
  return rewritten;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await restoreBackup(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else { console.log(`Restored ACMS backup to ${result.target}`); console.log(`- files: ${result.files}, excluded entries: ${result.excluded}`); console.log(`- company.db ${result.database.bytes} bytes sha256=${result.database.sha256}`); console.log('See REBUILD.md for excluded material and post-restore steps.'); }
  } catch (error) { console.error(`Restore failed: ${error.message}`); process.exit(1); }
}
