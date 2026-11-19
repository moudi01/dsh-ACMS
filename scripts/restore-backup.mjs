#!/usr/bin/env node
// Restore a verified ACMS backup into a new directory. The source backup is
// never modified; the target must be empty so a restore cannot merge silently.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyBackup, sha256, realTarget, isInside } from './backup.mjs';
import { hasWorktreeStartupHold, pendingWorktreeRefs, recoverWorktrees, setWorktreeStartupHold } from './restore-worktrees.mjs';

function parseArgs(argv) {
  const args = { backup: null, target: null, json: false, resumeWorktrees: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--backup') args.backup = argv[++index];
    else if (value === '--target') args.target = argv[++index];
    else if (value === '--resume-worktrees') args.resumeWorktrees = true;
    else if (value === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.target || (!args.backup && !args.resumeWorktrees)) throw new Error('Specify --target and either --backup or --resume-worktrees');
  if (args.backup && args.resumeWorktrees) throw new Error('--resume-worktrees uses the existing --target without --backup');
  return args;
}
// The target may not contain the backup directory, checked with real paths.


export async function restoreBackup({ backup, target, resumeWorktrees = false }) {
  if (resumeWorktrees) {
    const destination = path.resolve(target);
    const verification = await verifyBackup(destination);
    if (!verification.ok) throw new Error(`Restored data verification failed: ${verification.errors.join('; ')}`);
    const { manifest } = verification;
    if (manifest.restoredTo !== destination || !manifest.worktreeRecovery) throw new Error('--resume-worktrees requires an existing recorded restore target');
    if (!manifest.worktreeRecovery.ready) {
      if (!hasWorktreeStartupHold(path.join(destination, manifest.database.file))) throw new Error('Restored database has no recorded Git worktree startup hold');
      await completeWorktreeRestore(destination, manifest);
    }
    return report(destination, manifest);
  }
  const source = path.resolve(backup); const destination = path.resolve(target);
  if (isInside(await realTarget(source), await realTarget(destination))) throw new Error('Restore target must be outside the backup directory');
  const verification = await verifyBackup(source);
  if (!verification.ok) throw new Error(`Backup verification failed: ${verification.errors.join('; ')}`);
  let targetEntries = [];
  try { targetEntries = await fs.readdir(destination); } catch { /* new directory */ }
  if (targetEntries.length) throw new Error(`Restore target is not empty: ${destination}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, destination, { recursive: true, errorOnExist: false });
  const manifest = verification.manifest;
  if (!path.isAbsolute(manifest.source)) throw new Error('Backup source must be an absolute data directory');
  const rewritten = rewritePaths(path.join(destination, manifest.database.file), manifest.source, destination);
  manifest.restoredFrom = manifest.source;
  manifest.restoredAt = new Date().toISOString();
  manifest.restoredTo = destination;
  manifest.rewrittenPaths = rewritten;
  delete manifest.worktreeRecovery;
  await completeWorktreeRestore(destination, manifest);
  return report(destination, manifest);
}

async function completeWorktreeRestore(destination, manifest) {
  const database = path.join(destination, manifest.database.file);
  const refs = await pendingWorktreeRefs(database, destination, manifest.files);
  if (refs.length && !manifest.worktreeRecovery) {
    // Store the startup hold and a verified resumable manifest before any
    // external Git registry write. A process crash leaves the hold in place.
    setWorktreeStartupHold(database, true);
    manifest.worktreeRecovery = { ready: false, verified: [],
      issues: refs.map(ref => ({ path: ref.relative, reason: '等待核验 Git 工作副本' })) };
    await writeRestoreState(destination, manifest);
  }
  manifest.worktreeRecovery = await recoverWorktrees(refs, manifest.gitWorktrees, destination, manifest.source);
  if (manifest.worktreeRecovery.ready) setWorktreeStartupHold(database, false);
  await writeRestoreState(destination, manifest);
}

async function writeRestoreState(destination, manifest) {
  const database = path.join(destination, manifest.database.file);
  const check = new DatabaseSync(database);
  try {
    const row = check.prepare('PRAGMA integrity_check').get();
    if (row?.integrity_check !== 'ok') throw new Error(`Restored database integrity check failed: ${row?.integrity_check}`);
  } finally { check.close(); }
  const databaseBytes = await fs.readFile(database);
  manifest.database = { ...manifest.database, bytes: databaseBytes.length, sha256: sha256(databaseBytes) };
  const fileBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  manifest.totals = { ...manifest.totals, files: manifest.files.length, bytes: fileBytes, databaseBytes: databaseBytes.length, requiredBytes: fileBytes + databaseBytes.length };
  const lines = [
    '# ACMS restore notes', '',
    `Restored ${new Date().toISOString()} from ${manifest.source}.`, '',
    '## Excluded material and how to rebuild it', '',
  ];
  if (!manifest.excluded.length) lines.push('Nothing was excluded.');
  for (const item of manifest.excluded) lines.push(`- \`${item.path}\` — ${item.reason}. Rebuild: ${item.rebuild}`);
  lines.push('', '## After restore', '',
    manifest.worktreeRecovery.ready
      ? '1. Start the host with this directory as the ACMS data directory; do not copy individual files over a live database.'
      : '1. Git 工作副本仍待核验，此数据目录不能启动宿主。处理下列路径后，运行 `node scripts/restore-backup.mjs --target <此数据目录> --resume-worktrees`。',
    '2. In-flight attempts restored without confirmed cleanup enter `reconciling`; use "重新读取回执" instead of re-running or deleting locks.',
    manifest.includePairing
      ? '3. External model pairing files were included in this backup; review them in this environment before use.'
      : '3. External model pairings were excluded; re-pair them in this environment if needed.',
    '4. Source project Git repositories are not part of this backup; keep them separately.',
    `5. ${manifest.rewrittenPaths} stored path(s) inside the old data directory were rewritten to this restored directory, including task workspaces and artifact blob paths. Paths outside the data directory were left unchanged.`, '');
  if (manifest.worktreeRecovery.verified.length || manifest.worktreeRecovery.issues.length) {
    lines.push('## Git worktrees', '');
    for (const verified of manifest.worktreeRecovery.verified) lines.push(`- 已核验 \`${verified}\``);
    for (const item of manifest.worktreeRecovery.issues) lines.push(`- \`${item.path}\` · ${item.reason}`);
  }
  await fs.writeFile(path.join(destination, 'REBUILD.md'), lines.join('\n'), { mode: 0o600 });
  await fs.writeFile(path.join(destination, 'backup-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
}

function report(destination, manifest) {
  return { ok: true, startable: manifest.worktreeRecovery.ready, target: destination, files: manifest.files.length, excluded: manifest.excluded.length,
    rewrittenPaths: manifest.rewrittenPaths, database: manifest.database, worktrees: manifest.worktreeRecovery };
}

function rewritePaths(databasePath, oldRoot, newRoot) {
  const database = new DatabaseSync(databasePath);
  let rewritten = 0;
  const resolve = value => {
    if (typeof value !== 'string' || !value) return value;
    // Only absolute paths can point into the old data directory. Relative
    // fields such as branch names, commits or artifact paths must stay intact
    // even when the restore process happens to run from the old directory.
    if (!path.isAbsolute(value)) return value;
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
    else {
      console.log(`Restored ACMS backup to ${result.target}`);
      console.log(`- files: ${result.files}, excluded entries: ${result.excluded}`);
      console.log(`- company.db ${result.database.bytes} bytes sha256=${result.database.sha256}`);
      console.log(result.startable ? 'See REBUILD.md for post-restore steps.' : 'Git 工作副本待核验。请查看 REBUILD.md 后续接恢复。');
    }
    if (!result.startable) process.exitCode = 2;
  } catch (error) { console.error(`Restore failed: ${error.message}`); process.exit(1); }
}
