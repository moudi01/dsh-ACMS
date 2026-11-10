#!/usr/bin/env node
// Restore a verified ACMS backup into a new directory. The source backup is
// never modified; the target must be empty so a restore cannot merge silently.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBackup } from './backup.mjs';

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
    '3. External model pairings were excluded; re-pair them in this environment if needed.',
    '4. Source project Git repositories are not part of this backup; keep them separately.', '');
  await fs.writeFile(path.join(destination, 'REBUILD.md'), lines.join('\n'), { mode: 0o600 });
  return { ok: true, target: destination, files: manifest.files.length, excluded: manifest.excluded.length, database: manifest.database };
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
