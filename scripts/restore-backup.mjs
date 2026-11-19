#!/usr/bin/env node
// Restore a verified ACMS backup into a new directory. The source backup is
// never modified; the target must be empty so a restore cannot merge silently.
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyBackup, sha256, realTarget, isInside } from './backup.mjs';
import { pendingWorktreeRefs, recoverWorktrees, relocatedGitPointer } from './restore-worktrees.mjs';
import { WORKTREE_RESTORE_HOLD, assertWorktreeRestoreReady, worktreeRestorePending } from '../src/core/restore-safety.js';

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
    const registeredRoot = manifest.restoredRoot ?? manifest.restoredTo;
    if (typeof registeredRoot !== 'string' || path.relative(registeredRoot, await fs.realpath(destination)) !== '' || !manifest.worktreeRecovery) {
      throw new Error('--resume-worktrees requires an existing recorded restore target');
    }
    if (worktreeRestorePending(destination)) {
      await completeWorktreeRestore(destination, manifest);
    } else if (!manifest.worktreeRecovery.ready) {
      throw new Error('Restored directory has no recorded Git worktree startup hold');
    }
    return report(destination, manifest);
  }
  const source = path.resolve(backup); const destination = path.resolve(target);
  assertWorktreeRestoreReady(source);
  if (isInside(await realTarget(source), await realTarget(destination))) throw new Error('Restore target must be outside the backup directory');
  const verification = await verifyBackup(source);
  if (!verification.ok) throw new Error(`Backup verification failed: ${verification.errors.join('; ')}`);
  const { manifest } = verification;
  const originalRoot = manifest.sourceRoot ?? manifest.source;
  if (!path.isAbsolute(manifest.source) || !path.isAbsolute(originalRoot)) throw new Error('Backup source must be an absolute data directory');
  let targetEntries = [];
  try { targetEntries = await fs.readdir(destination); } catch { /* new directory */ }
  if (targetEntries.length) throw new Error(`Restore target is not empty: ${destination}`);
  await fs.mkdir(destination, { recursive: true });
  await fs.mkdir(path.join(destination, WORKTREE_RESTORE_HOLD), { mode: 0o700 });
  await fs.cp(source, destination, { recursive: true, errorOnExist: false });
  const oldRoots = new Set([manifest.source, originalRoot, ...(manifest.gitWorktrees ?? []).filter(proof => !proof.reason && proof.rootAlias).map(proof => proof.rootAlias)]);
  const rewritten = rewritePaths(path.join(destination, manifest.database.file), oldRoots, destination);
  manifest.restoredFrom = manifest.source;
  manifest.restoredAt = new Date().toISOString();
  manifest.restoredTo = destination;
  manifest.restoredRoot = await fs.realpath(destination);
  manifest.rewrittenPaths = rewritten;
  delete manifest.worktreeRecovery;
  await completeWorktreeRestore(destination, manifest);
  return report(destination, manifest);
}

async function completeWorktreeRestore(destination, manifest) {
  const database = path.join(destination, manifest.database.file);
  const staging = path.join(destination, WORKTREE_RESTORE_HOLD);
  if (!(await fs.lstat(staging)).isDirectory()) throw new Error('Git worktree staging directory must be a regular directory');
  const refs = await pendingWorktreeRefs(database, destination, manifest.files);
  if (!manifest.worktreeRecovery) {
    // Publish the resumable manifest before changing any external registration.
    manifest.worktreeRecovery = { ready: false, verified: [],
      issues: refs.map(ref => ({ path: ref.relative, reason: '等待核验 Git 工作副本' })) };
    await writeRestoreState(destination, manifest, staging);
  }
  const restoredRoot = manifest.restoredRoot ?? destination;
  manifest.worktreeRecovery = await recoverWorktrees(refs, manifest.gitWorktrees, restoredRoot, manifest.sourceRoot ?? manifest.source, staging);
  if (manifest.worktreeRecovery.ready) {
    const proofs = new Map((manifest.gitWorktrees ?? []).map(proof => [proof.relative + '/.git', proof]));
    manifest.files = manifest.files.map(file => {
      const pointer = relocatedGitPointer(proofs.get(file.path), restoredRoot);
      return pointer ? { ...file, bytes: pointer.length, sha256: sha256(pointer) } : file;
    });
  }
  await writeRestoreState(destination, manifest, staging);
  if (manifest.worktreeRecovery.ready) {
    for (const entry of await fs.readdir(staging, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(backup-manifest\.json|REBUILD\.md|pointer)\.acms-[a-f0-9-]{36}$/.test(entry.name)) {
        throw new Error('Unexpected staged restore entry: ' + entry.name);
      }
      await fs.unlink(path.join(staging, entry.name));
    }
    await fs.rmdir(staging);
  }
}

async function writeRestoreState(destination, manifest, staging) {
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
  await publishRestoreFile('backup-manifest.json', JSON.stringify(manifest, null, 2) + '\n', destination, staging);
  await publishRestoreFile('REBUILD.md', lines.join('\n'), destination, staging);
}

async function publishRestoreFile(filename, contents, destination, staging) {
  const temporary = path.join(staging, filename + '.acms-' + randomUUID());
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx', flush: true, mode: 0o600 });
    await fs.rename(temporary, path.join(destination, filename));
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function report(destination, manifest) {
  return { ok: true, startable: manifest.worktreeRecovery.ready, target: destination, files: manifest.files.length, excluded: manifest.excluded.length,
    rewrittenPaths: manifest.rewrittenPaths, database: manifest.database, worktrees: manifest.worktreeRecovery };
}

function rewritePaths(databasePath, oldRoots, newRoot) {
  const database = new DatabaseSync(databasePath);
  let rewritten = 0;
  const resolve = value => {
    if (typeof value !== 'string' || !value) return value;
    // Only absolute paths can point into the old data directory. Relative
    // fields such as branch names, commits or artifact paths must stay intact
    // even when the restore process happens to run from the old directory.
    if (!path.isAbsolute(value)) return value;
    for (const root of oldRoots) {
      const relative = path.relative(root, value);
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      rewritten += 1;
      return path.join(newRoot, relative);
    }
    return value;
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
