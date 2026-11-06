import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { inspectPaperclip, importPaperclip } from '../src/migration/paperclip.js';
async function snapshot(f) {
  const root = path.join(f.root, 'old-bridge'); await mkdir(path.join(root, 'board', 'issues'), { recursive: true }); await mkdir(path.join(root, 'state'));
  const files = { 'board/index.json': [{ identifier: 'OLD-1' }, { identifier: 'OLD-2' }], 'board/agents.json': [{ id: 'old-agent', name: 'Historical worker', role: 'engineer' }],
    'board/issues/OLD-1.json': { id: 'old-1', identifier: 'OLD-1', title: 'Historical completed', status: 'done', documents: [{ title: 'Evidence', body: 'Historic document' }], comments: [{ author: 'Old reviewer', body: 'Previous review' }] },
    'board/issues/OLD-2.json': { id: 'old-2', identifier: 'OLD-2', title: 'Continue work', assigneeAgentId: 'old-agent', status: 'in_progress', blockedBy: [{ identifier: 'OLD-1' }] },
    'state/live.json': { agentStatus: [{ name: 'old-agent', status: 'paused' }], issues: {} }, 'state/state.json': { comments: {}, updates: {}, dispatches: [{ childId: 'old-run' }] } };
  for (const [name, data] of Object.entries(files)) await writeFile(path.join(root, name), JSON.stringify(data));
  return root;
}
test('migration requires stopped-source evidence and preserves historical documents without dispatching', async t => {
  const f = await fixture(t); const root = await snapshot(f); const inspected = await inspectPaperclip(root);
  assert.equal(inspected.preview.tasks, 2); assert.equal(inspected.preview.unresolvedDispatches, 1);
  assert.throws(() => importPaperclip(f.company, inspected, { projectId: f.project.id }), /Pause all old/);
  assert.equal(f.company.snapshot().ui.migrationVisible, true);
  const options = { projectId: f.project.id, fingerprint: inspected.fingerprint, confirmedStopped: true, stopEvidence: 'Old scheduler disabled; old-run exited; files inspected.' };
  const migration = importPaperclip(f.company, inspected, options); assert.equal(importPaperclip(f.company, inspected, options).goalId, migration.goalId);
  assert.equal(f.company.snapshot().ui.migrationVisible, false); assert.equal(f.company.snapshot().migrations.length, 1);
  assert.throws(() => importPaperclip(f.company, { ...inspected, root: path.join(f.root, 'another-source') }, options), { code: 'MIGRATION_COMPLETED' });
  const tasks = f.store.list('tasks'); assert.deepEqual(tasks.map(t => t.status).sort(), ['archived', 'paused']);
  assert.equal(tasks.find(t => t.legacy.identifier === 'OLD-1').legacy.documents[0].body, 'Historic document');
  await f.start(); await new Promise(r => setTimeout(r, 50)); assert.equal(f.adapter.calls.length, 0);
  const pending = tasks.find(t => t.status === 'paused'); f.command('task.resume', { id: pending.id });
  await until(() => f.store.require('tasks', pending.id).status === 'succeeded');
});
test('migration refuses active old executors and a stale preview fingerprint', async t => {
  const f = await fixture(t); const root = await snapshot(f); const inspected = await inspectPaperclip(root);
  const options = { projectId: f.project.id, fingerprint: inspected.fingerprint, confirmedStopped: true, stopEvidence: 'Owner says executor was stopped and inspected.' };
  await writeFile(path.join(root, 'state', 'live.json'), JSON.stringify({ agentStatus: [{ name: 'old-agent', status: 'running' }], issues: {} }));
  assert.throws(() => importPaperclip(f.company, { ...inspected, fingerprint: 'changed' }, options), /changed after preview/);
  const active = await inspectPaperclip(root);
  assert.throws(() => importPaperclip(f.company, active, options), /still reports active/);
  assert.equal(f.store.list('migrations').length, 0);
});
