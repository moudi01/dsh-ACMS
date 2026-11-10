#!/usr/bin/env node
// Retention dry-run for local ACMS runtime copies. It never deletes anything:
// the owner reviews the list and uses the existing authorised cleanup flow.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const CANDIDATE_DIRS = ['workspaces', 'reviews', 'integration', 'diagnostics'];
const TERMINAL = new Set(['succeeded', 'cancelled', 'archived', 'deleted']);
const LIVE_ATTEMPT = new Set(['preparing', 'running', 'cancelling', 'reconciling']);
const PENDING_INTEGRATION = new Set(['preparing', 'checking', 'applying', 'reconciling']);

function parseArgs(argv) {
  const args = { dataDir: null, days: 30, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--data-dir') args.dataDir = argv[++index];
    else if (value === '--days') args.days = Number(argv[++index]);
    else if (value === '--json') args.json = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isSafeInteger(args.days) || args.days < 1) throw new Error('--days must be a positive integer');
  return args;
}

async function size(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) total += await size(path.join(target, entry.name));
  return total;
}
async function newestMtime(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    // Rebuildable dependency and Git metadata do not extend retention by
    // themselves; their copy time should not keep a whole workspace alive.
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    newest = Math.max(newest, await newestMtime(path.join(target, entry.name)));
  }
  return newest;
}

export async function prunePlan({ dataDir, days = 30 }) {
  const root = path.resolve(dataDir);
  const databasePath = path.join(root, 'company.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const protectedIds = new Map();
  try {
    const rows = database.prepare("SELECT collection, id, body FROM entities WHERE collection IN ('tasks','attempts','integrations')").all();
    for (const row of rows) {
      const body = JSON.parse(row.body);
      const id = body.id ?? row.id;
      if (row.collection === 'tasks' && !TERMINAL.has(body.status)) protectedIds.set(id, `未完成任务（${body.status}）`);
      if (row.collection === 'attempts' && (LIVE_ATTEMPT.has(body.status) || body.cleanupPending === true)) {
        protectedIds.set(id, `运行中/待清理执行（${body.status}）`);
        if (body.taskId) protectedIds.set(body.taskId, `运行中/待清理执行（${body.status}）`);
      }
      if (row.collection === 'integrations' && PENDING_INTEGRATION.has(body.phase)) {
        protectedIds.set(id, `在途集成（${body.phase}）`);
        if (body.taskId) protectedIds.set(body.taskId, `在途集成（${body.phase}）`);
      }
    }
  } finally { database.close(); }
  const cutoff = Date.now() - days * 86400000;
  const candidates = [];
  const protectedEntries = [];
  for (const directory of CANDIDATE_DIRS) {
    const base = path.join(root, directory);
    let entries;
    try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const absolute = path.join(base, entry.name);
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) { protectedEntries.push({ path: relative, reason: '符号链接，需所有者核对目标后手动处理' }); continue; }
      const newest = await newestMtime(absolute);
      const ageDays = (Date.now() - newest) / 86400000;
      if (ageDays < days) continue;
      const owner = [...protectedIds.keys()].find(id => entry.name.includes(id));
      if (owner) { protectedEntries.push({ path: relative, reason: `仍被${protectedIds.get(owner)}引用（${owner}），不能清理`, ageDays: Number(ageDays.toFixed(1)) }); continue; }
      candidates.push({ path: relative, bytes: await size(absolute), ageDays: Number(ageDays.toFixed(1)) });
    }
  }
  candidates.sort((a, b) => b.bytes - a.bytes);
  protectedEntries.sort((a, b) => a.path.localeCompare(b.path));
  return { format: 'acms-prune-plan/1', createdAt: new Date().toISOString(), dataDir: root, cutoff: new Date(cutoff).toISOString(), days,
    candidates, protected: protectedEntries, totals: { candidates: candidates.length, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0) },
    note: 'Dry-run only. Review candidates and use the authorised cleanup flow; active tasks, attempts and cleanup holds are never listed for deletion.' };
}

function print(plan) {
  console.log(`ACMS retention dry-run (${plan.days} days, data dir ${plan.dataDir})`);
  console.log(`- candidates: ${plan.totals.candidates}, bytes: ${plan.totals.bytes}`);
  for (const item of plan.candidates) console.log(`- ${item.path}: ${item.bytes} bytes, ${item.ageDays} days`);
  for (const item of plan.protected) console.log(`- protected ${item.path}: ${item.reason}`);
  console.log('No files were deleted.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dataDir = args.dataDir ?? process.env.ACMS_DATA_DIR ?? path.join(os.homedir(), '.dsh', 'acms');
    const plan = await prunePlan({ dataDir, days: args.days });
    if (args.json) console.log(JSON.stringify(plan, null, 2)); else print(plan);
  } catch (error) { console.error(`Prune plan failed: ${error.message}`); process.exit(1); }
}
