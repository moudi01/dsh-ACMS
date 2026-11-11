import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { OWNER } from '../src/core/util.js';
import { createRoutes } from '../src/host/http.js';
import { ACTIVITY_EVENT_TYPES, activityContext, describeActivity, sanitizeActivityData } from '../src/core/activity.js';

const insertEvent = (store, { at = new Date().toISOString(), type, entityId, goalId, actor = 'scheduler', principalKind = 'system', onBehalfOf = null, body = {} }) =>
  store.db.prepare('INSERT INTO events(at,type,entity_id,goal_id,actor,principal_kind,on_behalf_of,body) VALUES (?,?,?,?,?,?,?,?)')
    .run(at, type, entityId ?? null, goalId ?? null, actor, principalKind, onBehalfOf ? JSON.stringify(onBehalfOf) : null, JSON.stringify(body));
const eventsOf = (store, type) => store.db.prepare('SELECT * FROM events WHERE type=? ORDER BY seq').all(type);
const allowedCount = store => {
  const marks = ACTIVITY_EVENT_TYPES.map(() => '?').join(',');
  return Number(store.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE type IN (${marks})`).get(...ACTIVITY_EVENT_TYPES).n);
};

test('project and agent creation remain distinguishable from later edits', async t => {
  const f = await fixture(t);
  assert.equal(JSON.parse(eventsOf(f.store, 'project.saved')[0].body).created, true);
  f.command('project.save', { id: f.project.id, name: 'Fixture renamed' });
  assert.equal(JSON.parse(eventsOf(f.store, 'project.saved').at(-1).body).created, false);

  const agent = f.command('agent.save', { name: 'Activity worker', role: 'worker' });
  assert.equal(JSON.parse(eventsOf(f.store, 'agent.saved').at(-1).body).created, true);
  f.command('agent.save', { id: agent.id, name: 'Activity worker 2' });
  assert.equal(JSON.parse(eventsOf(f.store, 'agent.saved').at(-1).body).created, false);
});

test('activity pages newest first with durable cursors, repeatable reads and no duplicates', async t => {
  const f = await fixture(t); const task = f.task();
  for (let index = 0; index < 6; index += 1) {
    insertEvent(f.store, { at: new Date(Date.now() + index * 1000).toISOString(), type: 'task.changed', entityId: task.id, goalId: f.goal.id, body: { fields: ['title'] } });
  }
  const total = allowedCount(f.store);
  const seen = []; let page = f.store.activityPage({ limit: 3 }); let guard = 20;
  while (guard-- > 0) {
    assert.ok(page.entries.length <= 3);
    for (const entry of page.entries) seen.push(entry.seq);
    if (!page.hasMore) break;
    page = f.store.activityPage({ before: page.nextBefore, limit: 3 });
  }
  assert.equal(new Set(seen).size, seen.length, 'pagination must never repeat an event');
  assert.equal(seen.length, total, 'pagination must expose every allowed event exactly once');
  for (let index = 1; index < seen.length; index += 1) assert.ok(seen[index - 1] > seen[index], 'events stay newest first');

  const repeat = f.store.activityPage({ limit: 3 });
  const again = f.store.activityPage({ limit: 3 });
  assert.deepEqual(repeat, again, 'the same cursor request is deterministic');
  assert.equal(repeat.nextBefore, repeat.entries.at(-1).seq);

  const newest = f.store.cursor();
  insertEvent(f.store, { type: 'task.changed', entityId: task.id, goalId: f.goal.id, body: { fields: ['description'] } });
  const newer = f.store.activityPage({ after: newest, limit: 10 });
  assert.deepEqual(newer.entries.map(entry => entry.seq), [newest + 1]);
  assert.equal(newer.direction, 'newer');
  assert.equal(f.store.activityPage({ after: f.store.cursor(), limit: 10 }).entries.length, 0);
});

test('activity excludes progress, readiness and command audit noise', async t => {
  const f = await fixture(t); const task = f.task();
  insertEvent(f.store, { type: 'attempt.progress', entityId: 'attempt_noise', goalId: f.goal.id, body: { taskId: task.id, percent: 40 } });
  insertEvent(f.store, { type: 'task.readiness', entityId: task.id, goalId: f.goal.id, body: { status: 'ready' } });
  insertEvent(f.store, { type: 'command.accepted', entityId: task.id, goalId: f.goal.id, body: { command: 'task.create', requestId: 'request_noise' } });
  insertEvent(f.store, { type: 'notifications.delivered', entityId: 'attempt_noise', goalId: f.goal.id, body: { taskId: task.id, notificationIds: ['n1'] } });
  const types = new Set(f.store.activityPage({ limit: 200 }).entries.map(entry => entry.type));
  for (const noise of ['attempt.progress', 'task.readiness', 'command.accepted', 'notifications.delivered']) assert.ok(!types.has(noise), `${noise} must stay out of the activity feed`);
});

test('activity filters by project, goal and task and attributes review events to the reviewed task', async t => {
  const f = await fixture(t);
  const project = f.command('project.save', { name: 'Second project', repoRoot: f.source, mode: 'copy' });
  const goal = f.command('goal.create', { projectId: project.id, title: 'Second goal', description: 'Second', acceptance: 'Second', plan: false });
  const task = f.command('task.create', { goalId: goal.id, title: 'Second task' });
  const review = f.store.put('tasks', { id: 'task_review_link', goalId: goal.id, projectId: project.id, title: 'Review second task', description: '', acceptance: '', kind: 'review', status: 'succeeded', reviewOf: task.id, dependencies: [], createdAt: new Date().toISOString() });
  insertEvent(f.store, { type: 'review.decided', entityId: review.id, goalId: goal.id, actor: 'reviewer_agent', principalKind: 'agent', body: { taskId: task.id, scope: 'task', decision: 'approve', artifactHash: 'abc123' } });
  insertEvent(f.store, { type: 'task.changed', entityId: f.task().id, goalId: f.goal.id, body: { fields: ['title'] } });

  const byProject = f.store.activityPage({ projectId: project.id, limit: 100 }).entries;
  assert.ok(byProject.length > 0);
  assert.ok(byProject.every(entry => entry.goalId === goal.id || entry.entityId === project.id));
  const byGoal = f.store.activityPage({ goalId: goal.id, limit: 100 }).entries;
  assert.ok(byGoal.some(entry => entry.type === 'review.decided'));
  const byTask = f.store.activityPage({ taskId: task.id, limit: 100 }).entries;
  assert.ok(byTask.some(entry => entry.type === 'review.decided'), 'review decisions remain discoverable from the reviewed task');
  assert.ok(byTask.every(entry => entry.goalId === goal.id));
});

test('activity pagination survives a database restart', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'acms-activity-restart-')); const source = path.join(root, 'source');
  await mkdir(source);
  const filename = path.join(root, 'data', 'company.db'); let store = new Store(filename); let company = new Company(store);
  t.after(async () => { try { store.close(); } catch {} await rm(path.resolve(root), { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  const project = company.command(OWNER, randomUUID(), 'project.save', { name: 'Restart project', repoRoot: source, mode: 'copy' });
  company.command(OWNER, randomUUID(), 'goal.create', { projectId: project.id, title: 'Restart goal', description: 'Restart', acceptance: 'Restart', plan: false });
  const before = store.activityPage({ limit: 50 });
  assert.ok(before.entries.some(entry => entry.type === 'goal.created'));
  store.close();
  store = new Store(filename); company = new Company(store);
  const after = store.activityPage({ limit: 50 });
  assert.deepEqual(after.entries.map(entry => entry.seq), before.entries.map(entry => entry.seq), 'restart keeps the durable event cursor');
});

function demoContext() {
  return activityContext({
    projects: [{ id: 'project_1', name: '演示项目' }],
    goals: [{ id: 'goal_1', title: '演示目标', projectId: 'project_1' }],
    tasks: [{ id: 'task_1', title: '演示任务', goalId: 'goal_1', projectId: 'project_1', agentId: 'worker_1' }],
    agents: [{ id: 'worker_1', name: '执行员甲', role: 'worker' }, { id: 'reviewer_1', name: '审查员乙', role: 'reviewer' }],
    interactions: [{ id: 'interaction_1', taskId: 'task_1', question: '请提供品牌素材' }],
  });
}

test('activity describes the real actor and never guesses an unknown agent', () => {
  const context = demoContext();
  const owner = describeActivity({ seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'goal.created', entityId: 'goal_1', goalId: 'goal_1', actor: { kind: 'owner', id: 'owner' }, data: {} }, context);
  assert.equal(owner.actor.label, '所有者');
  assert.equal(owner.subject.title, '演示目标');

  const blocked = describeActivity({ seq: 2, at: '2026-01-01T00:00:01.000Z', type: 'task.blocked', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { kind: 'human', reason: '缺少品牌文件' } }, context);
  assert.equal(blocked.actor.label, '调度器');
  assert.equal(blocked.executor, '执行者 · 执行员甲');
  assert.equal(blocked.subject.id, 'task_1');
  assert.match(blocked.reason, /缺少品牌文件/);

  const reviewed = describeActivity({ seq: 3, at: '2026-01-01T00:00:02.000Z', type: 'review.decided', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'agent', id: 'reviewer_1' }, decision: 'approve', data: { taskId: 'task_1', scope: 'task' } }, context);
  assert.equal(reviewed.actor.label, '审查者 · 审查员乙');
  assert.match(reviewed.action, /审查通过/);

  const external = describeActivity({ seq: 4, at: '2026-01-01T00:00:03.000Z', type: 'goal.submitted', entityId: 'goal_1', goalId: 'goal_1', actor: { kind: 'user-agent', id: 'credential_1' }, onBehalfOf: { kind: 'owner', id: 'owner' }, data: {} }, context);
  assert.equal(external.actor.label, '外部智能体（代表所有者）');

  const unknown = describeActivity({ seq: 5, at: '2026-01-01T00:00:04.000Z', type: 'task.changed', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'agent', id: 'agent_missing' }, data: { fields: ['title'] } }, context);
  assert.equal(unknown.actor.label, '未知智能体');
  assert.equal(describeActivity({ seq: 6, at: '2026-01-01T00:00:05.000Z', type: 'attempt.progress', entityId: 'attempt_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: {} }, context), null);
});

test('activity degrades honestly for legacy project/agent events and redacts sensitive details', () => {
  const context = demoContext();
  const created = describeActivity({ seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'project.saved', entityId: 'project_1', actor: { kind: 'owner', id: 'owner' }, data: { created: true } }, context);
  assert.match(created.action, /创建了项目/);
  const edited = describeActivity({ seq: 2, at: '2026-01-01T00:00:00.000Z', type: 'project.saved', entityId: 'project_1', actor: { kind: 'owner', id: 'owner' }, data: { created: false } }, context);
  assert.match(edited.action, /更新了项目/);
  const legacy = describeActivity({ seq: 3, at: '2026-01-01T00:00:00.000Z', type: 'project.saved', entityId: 'project_1', actor: { kind: 'owner', id: 'owner' }, data: {} }, context);
  assert.match(legacy.action, /保存了项目/);

  const sensitive = sanitizeActivityData({ token: 'acms_ag_secret', prompt: 'private chain of thought', nested: { password: 'p', visible: 'ok' }, reasoningEffort: 'high', long: 'x'.repeat(900), many: Array.from({ length: 30 }, (_, index) => index) });
  assert.equal(sensitive.token, '[已隐藏]');
  assert.equal(sensitive.prompt, '[已隐藏]');
  assert.equal(sensitive.nested.password, '[已隐藏]');
  assert.equal(sensitive.nested.visible, 'ok');
  assert.equal(sensitive.reasoningEffort, 'high');
  assert.ok(sensitive.long.length <= 501);
  assert.equal(sensitive.many.length, 20);

  const described = describeActivity({ seq: 4, at: '2026-01-01T00:00:00.000Z', type: 'task.changed', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'owner', id: 'owner' }, data: { fields: ['title'], token: 'leak-me' } }, context);
  assert.equal(described.details.token, '[已隐藏]');
});

test('activity wording covers cancellation, recovery, rejection and completion', () => {
  const context = demoContext();
  const described = (seq, type, entityId = 'task_1', data = {}, decision) => describeActivity({ seq, at: '2026-01-01T00:00:00.000Z', type, entityId, goalId: 'goal_1', actor: { kind: 'owner', id: 'owner' }, data, ...(decision ? { decision } : {}) }, context);
  assert.match(described(1, 'task.paused.requested').action, /请求暂停任务/);
  assert.match(described(2, 'task.cancelled.requested').action, /请求取消任务/);
  assert.match(described(3, 'task.resumed').action, /恢复了任务/);
  assert.match(described(4, 'task.succeeded').action, /完成交付/);
  assert.match(described(5, 'goal.succeeded', 'goal_1').action, /目标「演示目标」完成/);
  assert.match(described(6, 'goal.paused', 'goal_1', { mode: 'after-current' }).action, /当前执行结束后暂停/);
  assert.match(described(7, 'goal.resumed', 'goal_1').action, /恢复了目标/);
  const cancelled = described(8, 'goal.cancelled', 'goal_1', { reason: '所有者取消' });
  assert.match(cancelled.action, /取消了目标/);
  assert.match(cancelled.reason, /所有者取消/);
  assert.match(described(9, 'review.decided', 'task_1', { taskId: 'task_1', scope: 'task' }, 'changes_requested').action, /审查退回：任务「演示任务」/);
  assert.match(described(10, 'review.decided', 'task_1', { taskId: 'task_1', scope: 'task' }, 'approve').action, /审查通过：任务「演示任务」/);
  assert.match(described(11, 'attempt.failed', 'attempt_1', { taskId: 'task_1', code: 'PROVIDER_FAILED', message: '模型服务不可用' }).reason, /模型服务不可用/);
});

test('the activity route validates cursors and scopes without touching business state', async t => {
  const f = await fixture(t); const task = f.task();
  const route = createRoutes(f).find(item => item.path === '/api/acms/activity');
  const get = async query => { const response = await route.fetch(new Request(`http://dsh/api/acms/activity${query}`)); return { status: response.status, body: await response.json() }; };
  const page = await get('?limit=4');
  assert.equal(page.status, 200);
  assert.ok(page.body.entries.length <= 4);
  assert.equal(typeof page.body.nextBefore, 'number');
  assert.equal(page.body.direction, 'older');
  assert.equal((await get('?limit=0')).status, 400);
  assert.equal((await get('?limit=201')).status, 400);
  assert.equal((await get('?before=5&after=3')).status, 400);
  assert.equal((await get('?before=oops')).status, 400);
  assert.equal((await get('?projectId=')).status, 400);
  const scoped = await get(`?taskId=${encodeURIComponent(task.id)}&limit=100`);
  assert.equal(scoped.status, 200);
  assert.ok(scoped.body.entries.every(entry => entry.goalId === f.goal.id));
  const before = await get('?limit=100');
  assert.ok(before.body.entries.length > 0);
  insertEvent(f.store, { type: 'task.changed', entityId: task.id, goalId: f.goal.id, body: { fields: ['description'] } });
  const after = await get(`?after=${before.body.latestSeq}&limit=10`);
  assert.equal(after.status, 200);
  assert.equal(after.body.entries.length, 1);
  assert.equal(after.body.direction, 'newer');
});
