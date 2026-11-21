import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultSimulation, SimulatedAdapter } from '../src/adapters/simulated.js';
import { Company } from '../src/core/domain.js';
import { Store } from '../src/core/store.js';
import { digest } from '../src/core/util.js';
import { Conversations } from '../src/runtime/conversations.js';
import { Engine } from '../src/runtime/engine.js';
import { verifyCollaboration } from '../src/runtime/collaboration.js';
import { WorkspaceManager } from '../src/runtime/workspaces.js';
import { applyBackup, planBackup } from '../scripts/backup.mjs';
import { restoreBackup } from '../scripts/restore-backup.mjs';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const contractOf = prompt => JSON.parse(prompt.split('\nCONTRACT:\n')[1]);
const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));
const current = (f, task) => f.store.require('tasks', task.id);

async function workDone(f, task, status = 'succeeded') {
  await until(() => {
    const row = current(f, task);
    if (row.status === status) return !f.engine.live.size;
    if (['failed', 'cancelled', 'blocked'].includes(row.status) && f.engine.live.size === 0) {
      const last = f.store.attemptUsagePage('task', task.id, Number.MAX_SAFE_INTEGER, 1)[0]?.attempt;
      assert.fail(last?.summary ?? row.blocker?.reason ?? row.status);
    }
    return false;
  }, undefined, taskWaitDiagnostics(f, task.id));
}

async function readHandoff(workspace) {
  const entry = await readFile(path.join(workspace.path, workspace.collaboration.index));
  const context = JSON.parse(entry);
  const history = await readFile(path.join(workspace.path, context.handoff.history.path));
  assert.equal(context.handoff.history.sha256, createHash('sha256').update(history).digest('hex'));
  assert.equal(context.handoff.history.bytes, history.length);
  assert.equal(workspace.collaboration.handoff.bytes, entry.length);
  return { entry, context, history, scoped: JSON.parse(history) };
}

test('ordinary dispatch reads a compact focused handoff while retaining scoped evidence on demand', async t => {
  const oldBody = '仅历史记录，包含文本 "、反斜线 \\ 和 Unicode 🚀。\n'.repeat(130);
  const privacy = '作者单独指令：只核对原始格式。';
  const checkpoint = '已核对依赖的第一轮，继续现有进度。';
  let worker, dependency, delivered;
  const f = await fixture(t, async input => {
    if (input.task.id === dependency.id) return defaultSimulation(input);
    if (input.task.reviewOf === worker.id) {
      assert.equal(input.task.workspace.collaboration.revision, delivered.task.workspace.collaboration.revision);
      const data = await readHandoff(input.task.workspace);
      assert.deepEqual(data.entry, delivered.data.entry);
      assert.equal(input.prompt.includes(privacy) || data.history.includes(Buffer.from(privacy)), false);
      assert.match(contractOf(input.prompt).collaboration.instructions, /historical author context/);
      return defaultSimulation(input);
    }
    assert.equal(input.task.id, worker.id);
    const data = await readHandoff(input.task.workspace);
    delivered = { ...input, data };
    return defaultSimulation(input);
  });
  const agent = f.command('agent.save', { name: 'Fixture worker', role: 'worker' });
  const parent = f.task({ title: 'Parent with old records', agentId: agent.id });
  f.command('task.pause', { id: parent.id });
  dependency = f.task({ title: 'Actual prerequisite' });
  worker = f.task({ parentId: parent.id, dependencies: [dependency.id], title: 'Continue with latest scope' });
  const otherGoal = f.command('goal.create', { title: 'Unrelated goal', description: 'Other scope', acceptance: 'Other result',
    projectId: f.project.id, templateId: f.template.id, plan: false });
  const foreign = f.task({ goalId: otherGoal.id, title: 'NEVER_APPEARS_IN_WORKSPACE', agentId: agent.id });
  f.command('task.pause', { id: foreign.id });
  const unrelated = Array.from({ length: 6 }, (_, i) => f.task({ title: 'Unrelated ' + i, agentId: agent.id }));
  for (const item of unrelated) f.command('task.pause', { id: item.id });
  const interaction = { id: 'parent-question', taskId: parent.id, goalId: f.goal.id, taskGeneration: parent.generation,
    status: 'pending', kind: 'human', reason: 'Need source details', question: 'Which parent input is still missing?' };
  f.store.transaction(() => {
    // Simulate a stale imported ancestry pointer. The accessible parent remains
    // useful; neither the cross-goal record nor its attempts may enter handoff.
    f.store.put('tasks', { ...current(f, parent), parentId: foreign.id });
    f.store.put('tasks', { ...current(f, worker), dependencies: [dependency.id, foreign.id] });
    f.store.put('tasks', { ...current(f, foreign), status: 'succeeded', artifactIds: ['foreign-artifact'] });
    f.store.put('artifacts', { id: 'foreign-artifact', taskId: foreign.id, title: foreign.title,
      hash: digest('foreign'), path: 'not-shared.txt', blob: path.join(f.dataDir, 'not-shared.txt') });
    f.store.put('interactions', interaction);
    f.store.put('attempts', { id: 'parent-checkpoint', taskId: parent.id, status: 'completed', summary: checkpoint,
      handoff: '继续现有文件。', taskGeneration: parent.generation });
    f.store.put('attempts', { id: 'old-worker-checkpoint', taskId: worker.id, status: 'completed', summary: 'A replaced contract used an old note.',
      taskGeneration: worker.generation, goalContractVersion: worker.goalContractVersion });
    for (const item of [...unrelated, foreign, parent]) {
      for (let i = 0; i < 5; i++) f.store.put('attempts', { id: item.id + '-history-' + i, taskId: item.id,
        status: 'failed', resultAccepted: false, summary: oldBody + i });
    }
  });
  await f.workspaces.publishProject(f.project);
  await writeFile(path.join(f.source, '.acms/shared.md'), '项目所有者约定：保持 UTF-8。');
  f.command('goal.edit', { id: f.goal.id, patch: { title: '所有者最新任务目标' } });
  worker = f.command('task.edit', { id: worker.id, patch: { acceptance: 'Keep the current output and original Unicode' } });
  const chats = new Conversations(f.company, f.engine, f.adapter, f.dataDir);
  const chat = chats.open({ agentId: worker.agentId, taskId: worker.id });
  const sent = chats.send({ conversationId: chat.id, requestId: randomUUID(), text: privacy });
  assert.equal(sent.status, 'queued');

  f.engine.intervalMs = 100;
  await f.start();
  await workDone(f, worker);
  const { task, prompt, attempt, data } = delivered;
  const { context, entry, history, scoped } = data;
  const contract = contractOf(prompt);
  assert.equal(contract.goal.title, '所有者最新任务目标');
  assert.equal(contract.task.acceptance, current(f, worker).acceptance);
  assert.equal(contract.ownerConversation.at(-1).text, privacy);
  assert.deepEqual(contract.role.grants, []);
  assert.ok(contract.changeNotifications.some(n => n.changes.some(change => change.after === contract.goal.title)));
  assert.match(await readFile(path.join(task.workspace.path, contract.collaboration.notes), 'utf8'), /保持 UTF-8/);
  assert.deepEqual(context.tasks.map(record => record.id), [worker.id, parent.id, dependency.id]);
  assert.deepEqual(context.handoff.unavailableInputs, [foreign.id]);
  assert.deepEqual(context.tasks[0].attempts, []);
  assert.equal(context.tasks[0].historicalCheckpointId, 'old-worker-checkpoint');
  assert.ok(scoped.tasks.find(row => row.id === worker.id).attempts.some(a => a.id === 'old-worker-checkpoint'));
  assert.equal(context.tasks[1].attempts[0].summary, checkpoint);
  assert.equal(context.interactions[0].id, interaction.id);
  assert.equal(context.interactions[0].question, interaction.question);
  const original = context.tasks[2].artifacts[0];
  assert.equal(contract.inputArtifacts.length, 1);
  assert.equal(original.id, contract.inputArtifacts[0].id);
  assert.equal(original.hash, digest((await readFile(contract.inputArtifacts[0].path)).toString('base64')));
  assert.equal(original.selectedForDelivery, true);
  assert.equal(context.handoff.omitted.tasks, unrelated.length);
  assert.equal(entry.includes(Buffer.from('仅历史记录')), false);
  assert.equal(history.includes(Buffer.from('NEVER_APPEARS_IN_WORKSPACE')), false);
  assert.equal(history.includes(Buffer.from(privacy)), false);
  assert.equal(scoped.tasks.find(row => row.id === unrelated[3].id).attempts[0].summary, oldBody + '0');
  assert.ok(entry.length < 16384 && history.length / entry.length > 30);
  t.diagnostic('Read first: ' + entry.length + ' UTF-8 bytes. Scoped history on demand: ' + history.length + ' bytes.');
  assert.equal(f.adapter.calls.filter(call => call.task.id === worker.id).length, 1);
  const saved = f.store.require('attempts', attempt.id);
  assert.equal(saved.workHandoff.promptUtf8Bytes, Buffer.byteLength(prompt, 'utf8'));
  assert.equal(saved.workHandoff.revision, task.workspace.collaboration.revision);
  assert.equal(saved.workspace.collaboration.files['task-history.json'], context.handoff.history.sha256);
  const pointer = await readJson(path.join(f.source, '.acms/CURRENT.json'));
  const projectSnapshot = await readJson(path.join(f.source, '.acms', pointer.path));
  assert.ok(projectSnapshot.tasks.some(row => row.id === foreign.id));
  assert.equal(projectSnapshot.handoff, undefined);

  const review = f.command('review.request', { id: worker.id });
  await workDone(f, review);
  assert.notEqual(current(f, review).workspace.path, task.workspace.path);
});

test('unchanged handoff reuses the history file and detects a changed version before reuse', async t => {
  const f = await fixture(t);
  const task = f.task();
  const workspace = await f.workspaces.prepare(task, {});
  const initial = await readHandoff(workspace);
  const historyPath = path.join(workspace.path, initial.context.handoff.history.path);
  const mark = new Date('2020-02-03T00:00:00Z');
  await utimes(historyPath, mark, mark);
  const lastWrite = (await stat(historyPath)).mtimeMs;
  const refreshed = await f.workspaces.prepare({ ...task, workspace }, {});
  assert.equal(refreshed.collaboration.revision, workspace.collaboration.revision);
  assert.equal((await stat(historyPath)).mtimeMs, lastWrite);
  await writeFile(historyPath, initial.history.map(byte => byte ^ 1));
  await assert.rejects(verifyCollaboration(refreshed), { code: 'COLLABORATION_CHANGED' });
  const rebuilt = await f.workspaces.prepare({ ...task, workspace: refreshed }, {});
  await verifyCollaboration(rebuilt);
  assert.deepEqual((await readHandoff(rebuilt)).history, initial.history);
});

test('a legacy workspace handoff upgrades on dispatch and survives backup into a separate runtime', async t => {
  const f = await fixture(t, async ({ task }) => {
    await writeFile(path.join(task.workspace.path, 'draft.txt'), 'Prior draft survives.');
    return { outcome: 'blocked', kind: 'human', reason: 'Missing the approved decision', question: 'Continue the draft?',
      reversibleDefault: 'Read draft.txt and continue at checkpoint three.' };
  });
  const task = f.task({ title: 'Recover durable checkpoint', longLived: true });
  const workspace = await f.workspaces.prepare({ ...task, kind: 'plan' }, {});
  assert.equal(workspace.collaboration.handoff, undefined);
  f.store.put('tasks', { ...task, workspace });
  await verifyCollaboration(workspace);
  await f.start();
  await workDone(f, task, 'blocked');
  await f.engine.stop();
  const sourceWorkspace = current(f, task).workspace;
  const before = await readHandoff(sourceWorkspace);
  const pending = f.store.list('interactions').find(i => i.taskId === task.id && i.status === 'pending');
  const backup = path.join(f.root, 'handoff-backup');
  const restored = path.join(f.root, 'handoff-restored');
  await applyBackup(await planBackup({ dataDir: f.dataDir, out: backup }));
  await restoreBackup({ backup, target: restored });

  const store = new Store(path.join(restored, 'company.db'));
  const company = new Company(store);
  const workspaces = new WorkspaceManager(restored, company);
  let observed;
  const executor = new SimulatedAdapter(async input => {
    observed = { ...input, data: await readHandoff(input.task.workspace) };
    assert.equal(await readFile(path.join(input.task.workspace.path, 'draft.txt'), 'utf8'), 'Prior draft survives.');
    return defaultSimulation(input);
  });
  const engine = new Engine(company, executor, workspaces, { intervalMs: 20 });
  try {
    const restoredWorkspace = store.require('tasks', task.id).workspace;
    assert.equal(path.relative(restored, restoredWorkspace.path), path.join('workspaces', task.id));
    assert.deepEqual((await readHandoff(restoredWorkspace)).entry, before.entry);
    await verifyCollaboration(restoredWorkspace);
    assert.notEqual(restoredWorkspace.path, sourceWorkspace.path);
    await writeFile(path.join(f.source, '.acms/shared.md'), 'New owner notes after backup.');
    company.command({ kind: 'owner', id: 'owner' }, randomUUID(), 'interaction.answer', { id: pending.id, answer: 'Use the restored draft.' });
    await engine.start();
    await workDone({ store, engine }, task);
    assert.equal(executor.calls.length, 1);
    assert.equal(observed.data.context.tasks[0].attempts[0].handoff, 'Read draft.txt and continue at checkpoint three.');
    assert.equal(observed.data.context.interactions.some(i => i.id === pending.id), false);
    assert.equal(contractOf(observed.prompt).userAnswer, 'Use the restored draft.');
    assert.equal(await readFile(path.join(observed.task.workspace.path, '.acms/shared.md'), 'utf8'), 'New owner notes after backup.');
    assert.deepEqual((await readHandoff(sourceWorkspace)).entry, before.entry);
    assert.equal(current(f, task).status, 'blocked');
  } finally {
    await engine.stop();
    store.close();
  }
});
