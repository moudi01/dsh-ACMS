import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { exportLegacy, legacyExportState, migrateLegacy } from '../src/core/legacy.js';

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('legacy export writes a verifiable backup without touching live state', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Legacy task' });
  const result = exportLegacy(f.store, { dataDir: f.dataDir });

  assert.equal(result.skipped, false);
  assert.equal(result.apply, false);
  assert.ok(result.files.every(file => file.bytes > 0 && file.sha256.length === 64));
  const manifestPath = path.join(result.dir, 'manifest.json');
  assert.ok(existsSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.applied, false);
  assert.equal(manifest.files.length, 2);
  for (const file of manifest.files) assert.equal(sha256(path.join(result.dir, file.name)), file.sha256);
  const entities = JSON.parse(readFileSync(path.join(result.dir, 'entities.json'), 'utf8'));
  assert.ok(entities.collections.tasks.some(row => row.id === task.id));

  // Backup only: the live rows keep running under the old model.
  assert.equal(f.store.require('tasks', task.id).status, 'ready');
  assert.equal(legacyExportState(f.store), null);
  assert.equal(f.store.require('goals', f.goal.id).status, 'active');
});

test('legacy export isolation is idempotent and archives legacy work', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Legacy task' });
  const result = exportLegacy(f.store, { dataDir: f.dataDir, apply: true });

  assert.equal(result.skipped, false);
  assert.equal(result.appliedCounts.tasks, 1);
  assert.equal(result.appliedCounts.goals, 1);
  const archived = f.store.require('tasks', task.id);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.legacyPreviousStatus, 'ready');
  assert.equal(archived.legacyBatch, result.batchId);
  assert.equal(f.store.require('goals', f.goal.id).status, 'archived');
  assert.equal(legacyExportState(f.store).batchId, result.batchId);

  const again = exportLegacy(f.store, { dataDir: f.dataDir, apply: true });
  assert.equal(again.skipped, true);
  assert.equal(again.reason, 'already-exported');
  assert.equal(again.batchId, result.batchId);
});

test('startup migration archives stage-model rows before scheduling', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Stage-model row' });
  f.store.transaction(() => f.store.put('tasks', {
    ...f.store.require('tasks', task.id),
    workflowSnapshot: { id: 'default', name: '旧流程', version: 1, steps: [{ id: 'work', type: 'work' }] },
    stageIndex: 0, status: 'ready',
  }));
  const result = migrateLegacy(f.store, { dataDir: f.dataDir });
  assert.equal(result.skipped, false);
  const archived = f.store.require('tasks', task.id);
  assert.equal(archived.status, 'archived');
  assert.equal(archived.legacyBatch, result.batchId);
  const again = migrateLegacy(f.store, { dataDir: f.dataDir });
  assert.equal(again, null);
  await f.start();
  await new Promise(r => setTimeout(r, 120));
  assert.equal(f.adapter.calls.length, 0);
});

test('engine startup blocks until every legacy execution is confirmed stopped', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Legacy running work' });
  f.store.transaction(() => {
    f.store.put('tasks', { ...f.store.require('tasks', task.id), workflowSnapshot: { id: 'default', steps: [], version: 1 }, status: 'running', activeAttemptId: 'old-0' });
    f.store.put('attempts', { id: 'old-0', taskId: task.id, goalId: task.goalId, agentId: task.agentId, taskGeneration: 1, role: 'worker', status: 'running', startedAt: new Date().toISOString() });
  });
  f.adapter.reconcile = async () => ({ status: 'unknown', reason: 'Fixture cannot prove the old process stopped' });
  await assert.rejects(f.start(), error => error.code === 'LEGACY_EXECUTION_UNCONFIRMED');
  // Nothing was migrated or released; the old data is intact and startable later.
  assert.equal(f.store.require('tasks', task.id).status, 'running');
  assert.equal(f.store.require('attempts', 'old-0').status, 'running');
  assert.equal(legacyExportState(f.store), null);
  assert.equal(f.adapter.calls.length, 0);
});

test('engine startup archives legacy executions only after confirmed cleanup', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Legacy running work' });
  f.store.transaction(() => {
    f.store.put('tasks', { ...f.store.require('tasks', task.id), workflowSnapshot: { id: 'default', steps: [], version: 1 }, status: 'running', activeAttemptId: 'old-0' });
    for (let i = 0; i < 4; i++) f.store.put('attempts', { id: `old-${i}`, taskId: task.id, goalId: task.goalId, agentId: task.agentId, taskGeneration: 1, role: 'worker', status: 'running', startedAt: new Date().toISOString() });
  });
  let reconcileCalls = 0;
  f.adapter.reconcile = async () => { reconcileCalls++; return { status: 'stopped', cleanupConfirmed: true, reason: 'Fixture confirmed exit' }; };
  await f.start();
  const state = legacyExportState(f.store);
  for (let i = 0; i < 4; i++) {
    const attempt = f.store.require('attempts', `old-${i}`);
    assert.equal(attempt.legacyBatch, state.batchId);
    assert.equal(attempt.status, 'stopped');
    assert.equal(attempt.cleanupPending, false);
    assert.equal(attempt.cleanupUncertain, false);
  }
  assert.equal(f.store.require('tasks', task.id).status, 'archived');
  assert.equal(reconcileCalls, 4);
  // Slots are free: fresh work runs immediately.
  const goal = f.command('goal.create', { title: 'After migration', description: 'Deliver', acceptance: 'Delivered', projectId: f.project.id, templateId: f.template.id, plan: false });
  const fresh = f.task({ goalId: goal.id, title: 'Fresh work' });
  await until(() => f.store.require('tasks', fresh.id).status === 'succeeded', 15000);
  assert.equal(f.adapter.calls.length, 1);
});

test('engine startup does not migrate while another scheduler holds the lease', async t => {
  const f = await fixture(t);
  const task = f.task({ title: 'Legacy row under foreign lease' });
  f.store.transaction(() => f.store.put('tasks', { ...f.store.require('tasks', task.id), workflowSnapshot: { id: 'default', steps: [], version: 1 }, status: 'ready' }));
  f.store.acquireLease('other-host');
  await assert.rejects(f.start(), { code: 'ENGINE_BUSY' });
  assert.equal(f.store.require('tasks', task.id).status, 'ready');
  assert.equal(legacyExportState(f.store), null);
});

test('legacy export refuses to isolate while an attempt is active', async t => {
  const f = await fixture(t);
  f.task({ title: 'Legacy task' });
  f.store.put('attempts', {
    id: 'attempt_legacy_active', taskId: f.store.list('tasks')[0].id, goalId: f.goal.id,
    agentId: 'manager', role: 'worker', status: 'running', startedAt: new Date().toISOString(),
  });
  const result = exportLegacy(f.store, { dataDir: f.dataDir, apply: true });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'active-attempts');
  assert.equal(f.store.list('tasks')[0].status, 'ready');
});
