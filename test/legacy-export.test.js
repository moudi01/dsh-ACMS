import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
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
