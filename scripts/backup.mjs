#!/usr/bin/env node
// Consistent, manifest-backed backup for a local ACMS data directory.
// Only the current data directory is supported; source projects stay separate.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const FORMAT = 'acms-backup/1';
const EXCLUDED_DIRS = [
  { name: 'node_modules', reason: '可重建依赖缓存', rebuild: '在对应工作副本运行 npm ci（使用项目锁文件）' },
  { name: '.git', reason: '工作副本 Git 元数据可从源项目重建', rebuild: '由源项目当前提交重新创建隔离工作副本' },
  { name: '.cache', reason: '可重建缓存', rebuild: '按需重新生成' },
  { name: 'diagnostics', reason: '模型检测隔离目录，可重建', rebuild: '需要时重新执行模型连通性检测' },
];
const EXCLUDED_FILES = new Set(['company.db', 'company.db-wal', 'company.db-shm']);
const SENSITIVE = [
  { name: 'pairing', reason: '外部配对 runner 与邀请回执（含本机运行入口信息）', rebuild: '在目标环境重新配对外部 agent；配对令牌不进入备份' },
];
const PRIVATE_WARNINGS = [
  { name: 'conversations', message: 'conversations/ 包含角色回复与私有内容，备份文件按本机私有数据处理' },
  { name: 'artifacts', message: 'artifacts/ 可能包含项目源码或敏感数据，备份文件按本机私有数据处理' },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const isInside = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
async function exists(target) { try { await fs.lstat(target); return true; } catch { return false; } }

async function dirSize(target) {
  let total = 0;
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await dirSize(child);
    else if (entry.isFile()) total += (await fs.lstat(child)).size;
  }
  return total;
}

async function walk(root) {
  const files = [];
  const excluded = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { excluded.push({ path: relative, bytes: 0, reason: '符号链接不跟随，避免越界读取', rebuild: '由所有者确认链接目标后单独处理' }); continue; }
      if (entry.isDirectory()) {
        const rule = EXCLUDED_DIRS.find(item => item.name === entry.name);
        if (rule) { excluded.push({ path: relative, bytes: await dirSize(absolute), reason: rule.reason, rebuild: rule.rebuild }); continue; }
        await visit(absolute); continue;
      }
      if (entry.isFile()) {
        if (EXCLUDED_FILES.has(entry.name)) {
          excluded.push({ path: relative, bytes: (await fs.lstat(absolute)).size,
            reason: entry.name === 'company.db' ? '数据库由一致性快照替代' : 'WAL/SHM 由一致性数据库快照覆盖',
            rebuild: '从备份中的 company.db 恢复，不需要单独复制' }); continue;
        }
        const stat = await fs.lstat(absolute);
        files.push({ path: relative, bytes: stat.size, file: absolute });
      }
    }
  }
  await visit(root);
  return { files, excluded };
}

export async function planBackup({ dataDir, out, includePairing = false }) {
  const source = path.resolve(dataDir);
  if (!(await exists(path.join(source, 'company.db')))) throw new Error(`ACMS database not found under ${source}`);
  const target = path.resolve(out ?? `${source}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (isInside(source, target)) throw new Error('Backup target must be outside the ACMS data directory');
  const { files: walkedFiles, excluded } = await walk(source);
  const files = includePairing ? walkedFiles : walkedFiles.filter(file => !file.path.startsWith('pairing/'));
  for (const item of SENSITIVE) {
    if (includePairing && item.name === 'pairing') { continue; }
    const absolute = path.join(source, item.name);
    if (await exists(absolute)) {
      excluded.push({ path: item.name, bytes: await dirSize(absolute), reason: item.reason, rebuild: item.rebuild });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  excluded.sort((a, b) => a.path.localeCompare(b.path));
  const totals = { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), excludedBytes: excluded.reduce((sum, item) => sum + item.bytes, 0) };
  let freeBytes = null;
  try { const stat = await fs.statfs(source); freeBytes = stat.bsize * stat.bavail; } catch { /* optional capacity hint */ }
  const warnings = [];
  for (const item of PRIVATE_WARNINGS) if (await exists(path.join(source, item.name))) warnings.push(item.message);
  if (!includePairing && await exists(path.join(source, 'pairing'))) warnings.push('pairing 目录默认排除：外部模型需要在新环境重新配对');
  if (freeBytes !== null && freeBytes < totals.bytes * 1.1) warnings.push(`可用空间不足：需要约 ${totals.bytes} 字节，当前可用 ${freeBytes} 字节`);
  return { format: FORMAT, mode: 'plan', createdAt: new Date().toISOString(), source, target, includePairing, database: { file: 'company.db', bytes: (await fs.lstat(path.join(source, 'company.db'))).size }, files, excluded, warnings, totals, space: { freeBytes, requiredBytes: totals.bytes, sufficient: freeBytes === null || freeBytes >= totals.bytes * 1.1 } };
}

async function snapshotDatabase(source, destination) {
  const database = new DatabaseSync(source);
  try { database.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`); }
  finally { database.close(); }
  const copy = new DatabaseSync(destination);
  try {
    const row = copy.prepare('PRAGMA integrity_check').get();
    if (row?.integrity_check !== 'ok') throw new Error(`Backup database integrity check failed: ${row?.integrity_check}`);
  } finally { copy.close(); }
  const bytes = await fs.readFile(destination);
  return { file: path.basename(destination), bytes: bytes.length, sha256: sha256(bytes), integrity: 'ok' };
}

export async function applyBackup(plan) {
  const { source, target } = plan;
  if (isInside(source, target)) throw new Error('Backup target must be outside the ACMS data directory');
  if (await exists(target)) { const entries = await fs.readdir(target).catch(() => []); if (entries.length) throw new Error(`Backup target is not empty: ${target}`); }
  await fs.mkdir(target, { recursive: true });
  const database = await snapshotDatabase(path.join(source, 'company.db'), path.join(target, 'company.db'));
  const files = [];
  for (const file of plan.files) {
    const destination = path.join(target, ...file.path.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const bytes = await fs.readFile(file.file);
    const hash = sha256(bytes);
    await fs.writeFile(destination, bytes, { mode: 0o600 });
    files.push({ path: file.path, bytes: bytes.length, sha256: hash });
  }
  const manifest = {
    format: FORMAT, createdAt: plan.createdAt, source, includePairing: plan.includePairing === true,
    database, files, excluded: plan.excluded, warnings: plan.warnings,
    totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), excludedBytes: plan.totals.excludedBytes },
    note: 'Raw-byte SHA-256 is used for backup integrity. ACMS artifact.hash uses sha256(base64 text) and is not interchangeable.',
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(target, 'backup-manifest.json'), manifestBytes, { mode: 0o600 });
  return { ...plan, mode: 'apply', database, files, manifestSha256: sha256(manifestBytes) };
}

export async function verifyBackup(backupDir) {
  const root = path.resolve(backupDir);
  const manifestPath = path.join(root, 'backup-manifest.json');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
  catch (error) { throw new Error(`Cannot read backup manifest: ${error.message}`); }
  if (manifest.format !== FORMAT) throw new Error(`Unsupported backup format: ${manifest.format}`);
  const errors = [];
  const check = async (relative, expected) => {
    const absolute = path.join(root, ...relative.split('/'));
    let bytes;
    try { bytes = await fs.readFile(absolute); }
    catch { errors.push(`${relative}: missing`); return; }
    if (bytes.length !== expected.bytes) errors.push(`${relative}: size ${bytes.length} != ${expected.bytes}`);
    if (sha256(bytes) !== expected.sha256) errors.push(`${relative}: sha256 mismatch`);
  };
  await check(manifest.database.file, manifest.database);
  for (const file of manifest.files) await check(file.path, file);
  const known = new Set(['backup-manifest.json', 'REBUILD.md', manifest.database.file, ...manifest.files.map(file => file.path)]);
  const { files: existing } = await walk(root);
  for (const file of existing) if (!known.has(file.path)) errors.push(`${file.path}: unexpected file`);
  if (errors.length) return { ok: false, errors };
  const database = new DatabaseSync(path.join(root, manifest.database.file));
  try { const row = database.prepare('PRAGMA integrity_check').get(); if (row?.integrity_check !== 'ok') errors.push(`database integrity: ${row?.integrity_check}`); }
  finally { database.close(); }
  return { ok: errors.length === 0, errors, manifest };
}

function parseArgs(argv) {
  const args = { apply: false, json: false, includePairing: false, verify: null, dataDir: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') args.apply = true;
    else if (value === '--json') args.json = true;
    else if (value === '--include-pairing') args.includePairing = true;
    else if (value === '--verify') args.verify = argv[++index];
    else if (value === '--data-dir') args.dataDir = argv[++index];
    else if (value === '--out') args.out = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}
function print(value, asJson) {
  if (asJson) { console.log(JSON.stringify(value, null, 2)); return; }
  if ('ok' in value) {
    if (!value.ok) { console.error('Backup verification failed:'); for (const error of value.errors) console.error(`- ${error}`); return; }
    console.log(`Backup verification passed: ${value.manifest.files.length} files, company.db ${value.manifest.database.bytes} bytes`);
    return;
  }
  console.log(`ACMS backup ${value.mode} ${value.target ?? ''}`);
  console.log(`- files: ${value.totals.files}, bytes: ${value.totals.bytes}, excluded bytes: ${value.totals.excludedBytes}`);
  for (const item of value.excluded) console.log(`- excluded ${item.path}: ${item.reason}`);
  for (const warning of value.warnings) console.log(`! ${warning}`);
  if (value.database) console.log(`- company.db ${value.database.bytes} bytes sha256=${value.database.sha256}`);
  if (value.mode === 'plan') console.log('Plan only. Re-run with --apply to write the backup.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.verify) {
      const result = await verifyBackup(args.verify);
      print(result, args.json);
      if (!result.ok) process.exit(1);
    } else {
      const dataDir = args.dataDir ?? process.env.ACMS_DATA_DIR ?? path.join(os.homedir(), '.dsh', 'acms');
      const plan = await planBackup({ dataDir, out: args.out, includePairing: args.includePairing });
      if (!args.apply) { print(plan, args.json); }
      else {
        const result = await applyBackup(plan);
        const verification = await verifyBackup(result.target);
        if (!verification.ok) { print(verification, args.json); process.exit(1); }
        print({ ...result, mode: 'apply', verified: verification.ok }, args.json);
      }
    }
  } catch (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exit(1);
  }
}

export { sha256, isInside, walk };
