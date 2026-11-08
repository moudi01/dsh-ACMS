import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * One-time export of the stage-based task model (issue #25, P0).
 *
 * The old model drives a task through `workflowSnapshot.steps` with
 * `stageIndex` and a mandatory review stage. The new model has atomic tasks
 * and review sub-tasks, so existing rows are exported to `<dataDir>/legacy/`
 * and then isolated (archived) instead of being rewritten in place.
 *
 * The export is deliberately split: `apply: false` only writes the backup and
 * never mutates ACMS state, so operators can verify the evidence first.
 */

export const LEGACY_META_KEY = 'legacy-export';

export const LEGACY_COLLECTIONS = [
  'projects', 'goals', 'tasks', 'agents', 'workflows', 'workflowHistory',
  'attempts', 'artifacts', 'verifications', 'interactions', 'proposals',
  'changes', 'notifications', 'plans', 'actionBatches', 'agentCredentials',
  'conversations', 'conversationMessages', 'modelPreferences',
];

const ACTIVE_ATTEMPT = new Set(['preparing', 'running', 'cancelling', 'reconciling']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function migrateLegacy(store, { dataDir } = {}) {
  const legacyTaskIds = new Set(store.list('tasks').filter(t => t.workflowSnapshot && !t.legacyBatch).map(t => t.id));
  if (!legacyTaskIds.size) return null;
  if (legacyExportState(store)) return { skipped: true, reason: 'already-exported', tasks: legacyTaskIds.size };
  // The host calls this before the scheduler starts, so attempts left
  // "running" by a stopped host are stale rather than live executions.
  return exportLegacy(store, { dataDir, apply: true, force: true });
}

export function legacyExportState(store) {
  const row = store.db.prepare('SELECT value FROM meta WHERE key=?').get(LEGACY_META_KEY);
  return row ? JSON.parse(row.value) : null;
}

function sqlPath(filename) {
  // SQLite string literals use single quotes; Windows paths are accepted with
  // forward slashes and do not need escaping themselves.
  return filename.replaceAll('\\', '/').replaceAll("'", "''");
}

function activeAttempts(store) {
  return store.list('attempts').filter(a => ACTIVE_ATTEMPT.has(a.status) || a.cleanupPending === true);
}

export function exportLegacy(store, options = {}) {
  const { dataDir, apply = false, force = false, now = () => new Date().toISOString() } = options;
  if (!dataDir) throw new Error('exportLegacy requires dataDir');
  const previous = legacyExportState(store);
  if (previous && !force) return { skipped: true, reason: 'already-exported', ...previous };
  const active = activeAttempts(store);
  if (apply && active.length && !force) {
    return { skipped: true, reason: 'active-attempts', active: active.map(a => a.id) };
  }

  const exportedAt = now();
  const batchId = `legacy-${exportedAt.replace(/[:.]/g, '-')}`;
  const dir = path.join(dataDir, 'legacy', batchId);
  mkdirSync(dir, { recursive: true });

  const snapshot = {};
  for (const collection of LEGACY_COLLECTIONS) snapshot[collection] = store.list(collection);
  const payload = JSON.stringify({ batchId, exportedAt, collections: snapshot }, null, 2);
  const entitiesPath = path.join(dir, 'entities.json');
  writeFileSync(entitiesPath, payload);

  // A logical JSON dump is readable, but the SQLite file is the authoritative
  // backup: VACUUM INTO produces one consistent standalone database.
  const databasePath = path.join(dir, 'company.db');
  store.db.exec(`VACUUM INTO '${sqlPath(databasePath)}'`);

  const counts = Object.fromEntries(Object.entries(snapshot).map(([key, rows]) => [key, rows.length]));
  const manifest = {
    batchId, exportedAt, applied: false, counts,
    files: [
      { name: 'entities.json', bytes: Buffer.byteLength(payload), sha256: sha256(payload) },
      { name: 'company.db', bytes: 0, sha256: '' },
    ],
  };

  let appliedCounts = null;
  if (apply) {
    store.transaction(() => {
      const tasks = store.list('tasks').filter(t => t.status !== 'deleted' && !t.legacyBatch);
      const goals = store.list('goals').filter(g => g.status !== 'deleted' && !g.legacyBatch);
      for (const task of tasks) {
        store.put('tasks', {
          ...task, legacyBatch: batchId, legacyPreviousStatus: task.status,
          status: 'archived', stopRequested: null,
        });
      }
      for (const goal of goals) {
        store.put('goals', { ...goal, legacyBatch: batchId, legacyPreviousStatus: goal.status, status: 'archived' });
      }
      // Stage-model attempts keep their evidence but stop owning scheduler
      // slots. They are marked unknown rather than "stopped": migration never
      // ran the old process and cannot prove its tree exited.
      const legacyAttempts = store.list('attempts').filter(a => !a.legacyBatch && (ACTIVE_ATTEMPT.has(a.status) || a.cleanupPending));
      for (const attempt of legacyAttempts) {
        store.put('attempts', {
          ...attempt, legacyBatch: batchId, legacyStatus: attempt.status, legacyCleanupUncertain: true,
          status: 'unknown', cleanupPending: false, cleanupUncertain: true,
          recovery: { status: 'legacy-archived', reason: '旧阶段制执行随任务归档；迁移未重新核对进程树是否停止' },
        });
      }
      const retiredAgents = [];
      for (const agentId of new Set(legacyAttempts.map(a => a.agentId).filter(Boolean))) {
        const agent = store.get('agents', agentId);
        if (!agent?.temporary || agent.status !== 'available') continue;
        const held = store.list('tasks').some(t => t.agentId === agentId && !['succeeded', 'cancelled', 'archived', 'deleted'].includes(t.status));
        if (held) continue;
        store.put('agents', { ...agent, status: 'retired' });
        retiredAgents.push(agentId);
      }
      store.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(LEGACY_META_KEY, JSON.stringify({ batchId, dir, exportedAt }));
      store.event('legacy.exported', batchId, { batchId, dir, tasks: tasks.length, goals: goals.length, attempts: legacyAttempts.length, retiredAgents: retiredAgents.length }, { kind: 'system', id: 'scheduler' });
      appliedCounts = { tasks: tasks.length, goals: goals.length, attempts: legacyAttempts.length, retiredAgents: retiredAgents.length };
    });
  }

  // Re-read the database backup after the migration so the manifest covers the
  // bytes actually written, whether or not isolation was applied.
  const dbBytes = readFileSync(databasePath);
  manifest.applied = apply;
  manifest.files[1] = { name: 'company.db', bytes: dbBytes.length, sha256: sha256(dbBytes) };
  manifest.appliedCounts = appliedCounts;
  const manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    skipped: false, batchId, dir, exportedAt, apply, counts, appliedCounts,
    files: manifest.files,
  };
}
