import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { OWNER, SYSTEM } from '../src/core/util.js';
import { createRoutes } from '../src/host/http.js';
import { ACTIVITY_EVENT_TYPES, activityContext, describeActivity, redactActivityText, sanitizeActivityData } from '../src/core/activity.js';

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

  const blocked = describeActivity({ seq: 2, at: '2026-01-01T00:00:01.000Z', type: 'task.blocked', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { kind: 'human', reason: '缺少品牌文件', executorId: 'worker_1', executorName: '执行员甲', executorRole: 'worker' } }, context);
  assert.equal(blocked.actor.label, '调度器');
  assert.equal(blocked.executor, '执行者 · 执行员甲');
  assert.equal(blocked.subject.id, 'task_1');
  assert.match(blocked.reason, /缺少品牌文件/);

  const reviewed = describeActivity({ seq: 3, at: '2026-01-01T00:00:02.000Z', type: 'review.decided', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'agent', id: 'reviewer_1' }, decision: 'approve', data: { taskId: 'task_1', scope: 'task', actorRole: 'reviewer', actorName: '审查员乙' } }, context);
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

  assert.equal(redactActivityText('token=INDEPENDENT_FAKE_SECRET'), 'token=[已隐藏]');
  assert.ok(!redactActivityText('{"token":"INDEPENDENT_FAKE_SECRET"}').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{\\"token\\":\\"INDEPENDENT_FAKE_SECRET\\"}').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{"password":"abc\\"INDEPENDENT_FAKE_SECRET"}').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{"password":"abc,INDEPENDENT_FAKE_SECRET"}').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{"password":"abc}INDEPENDENT_FAKE_SECRET"}').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{\\"password\\":\\"abc,INDEPENDENT_FAKE_SECRET\\"}').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{"password":"abcINDEPENDENT_FAKE_SECRET').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('{"password":"abc"INDEPENDENT_FAKE_SECRET').includes('INDEPENDENT_FAKE_SECRET'));
  const longJson = `${'说明'.repeat(240)}{"password":"abcINDEPENDENT_FAKE_SECRET"}`;
  assert.ok(!JSON.stringify(sanitizeActivityData({ reason: longJson })).includes('INDEPENDENT_FAKE_SECRET'));
  const longDescribed = describeActivity({ seq: 8, at: '2026-01-01T00:00:00.000Z', type: 'task.blocked', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { kind: 'human', reason: longJson } }, context);
  assert.ok(!longDescribed.reason.includes('INDEPENDENT_FAKE_SECRET'));
  const unclosedDescribed = describeActivity({ seq: 9, at: '2026-01-01T00:00:00.000Z', type: 'task.blocked', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { kind: 'human', reason: `${'说明'.repeat(240)}{"password":"abcINDEPENDENT_FAKE_SECRET` } }, context);
  assert.ok(!unclosedDescribed.reason.includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('access_token=INDEPENDENT_FAKE_SECRET').includes('INDEPENDENT_FAKE_SECRET'));
  assert.ok(!redactActivityText('Authorization: Basic RkFLRV9TRUNSRVQ=').includes('RkFLRV9TRUNSRVQ'));
  const bearer = redactActivityText('Authorization: Bearer INDEPENDENT_FAKE_SECRET');
  assert.ok(!bearer.includes('INDEPENDENT_FAKE_SECRET'));
  assert.match(bearer, /已隐藏/);
  const leaked = describeActivity({ seq: 5, at: '2026-01-01T00:00:00.000Z', type: 'attempt.failed', entityId: 'attempt_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { taskId: 'task_1', message: 'Authorization: Bearer INDEPENDENT_FAKE_SECRET' } }, context);
  assert.ok(!leaked.reason.includes('INDEPENDENT_FAKE_SECRET'));
  assert.match(leaked.reason, /已隐藏/);
  assert.ok(!JSON.stringify(leaked.details).includes('INDEPENDENT_FAKE_SECRET'));

  const legacyAgent = describeActivity({ seq: 6, at: '2026-01-01T00:00:00.000Z', type: 'agent.saved', entityId: 'worker_1', goalId: null, actor: { kind: 'owner', id: 'owner' }, data: {} }, context);
  assert.match(legacyAgent.action, /保存了角色/);

  const secretContext = demoContext();
  secretContext.agents.set('worker_1', { id: 'worker_1', name: 'Agent token=FAKE_LABEL', role: 'worker' });
  const labelled = describeActivity({ seq: 7, at: '2026-01-01T00:00:00.000Z', type: 'task.created', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'agent', id: 'worker_1' }, data: { actorRole: 'worker', actorName: 'Agent token=FAKE_LABEL', title: '演示任务' } }, secretContext);
  assert.ok(!labelled.actor.label.includes('FAKE_LABEL'));
  assert.ok(!labelled.details.actorName.includes('FAKE_LABEL'));
  assert.ok(!labelled.action.includes('FAKE_LABEL'));
});

test('historical actor roles and executors are not rewritten by later edits', () => {
  const context = demoContext();
  // The live agent record and the task assignment changed after the event.
  context.agents.set('worker_1', { id: 'worker_1', name: '执行员甲', role: 'manager' });
  context.tasks.set('task_1', { ...context.tasks.get('task_1'), agentId: 'worker_2' });
  context.agents.set('worker_2', { id: 'worker_2', name: '执行员乙', role: 'worker' });

  const blocked = describeActivity({ seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'task.blocked', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { kind: 'human', reason: '缺少材料', executorId: 'worker_1', executorName: '执行员甲', executorRole: 'worker' } }, context);
  assert.equal(blocked.executor, '执行者 · 执行员甲');

  const created = describeActivity({ seq: 2, at: '2026-01-01T00:00:00.000Z', type: 'task.created', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'agent', id: 'worker_1' }, data: { actorRole: 'worker', actorName: '执行员甲', title: '演示任务' } }, context);
  assert.equal(created.actor.label, '执行者 · 执行员甲');

  const legacy = describeActivity({ seq: 3, at: '2026-01-01T00:00:00.000Z', type: 'task.created', entityId: 'task_1', goalId: 'goal_1', actor: { kind: 'agent', id: 'worker_1' }, data: { title: '演示任务' } }, context);
  assert.match(legacy.actor.label, /历史角色未记录/);
  assert.equal(legacy.executor, null);
});

test('event bodies snapshot the acting agent role and name', async t => {
  const f = await fixture(t); const agent = f.command('agent.save', { name: 'Snapshot worker', role: 'worker' }); const task = f.task();
  f.store.transaction(() => f.store.event('task.changed', task.id, { fields: ['title'] }, { kind: 'agent', id: agent.id }));
  const body = JSON.parse(eventsOf(f.store, 'task.changed').at(-1).body);
  assert.equal(body.actorRole, 'worker');
  assert.equal(body.actorName, 'Snapshot worker');
});

test('goal completion records the delivered contract version and delivery hash', async t => {
  const f = await fixture(t); const delivered = f.task(); await f.start();
  await until(() => f.store.require('goals', f.goal.id).status === 'succeeded');
  const event = eventsOf(f.store, 'goal.succeeded').at(-1); const body = JSON.parse(event.body);
  assert.equal(typeof body.deliveryHash, 'string');
  assert.equal(body.contractVersion, f.store.require('goals', f.goal.id).completedContractVersion);
  const described = describeActivity(f.store.eventEntry(event), activityContext(f.company.snapshot()));
  assert.equal(described.evidence.deliveryHash, body.deliveryHash);
  assert.match(described.action, new RegExp(`交付版本 ${body.contractVersion}`));
  assert.equal(body.delivery.length, 1);
  assert.equal(body.delivery[0].id, delivered.id);
  assert.equal(body.delivery[0].artifactHash, f.store.require('tasks', delivered.id).artifactHash);
  assert.equal(described.delivery.length, 1);
  assert.equal(described.deliveryTotal, 1);
  assert.equal(described.delivery[0].id, delivered.id);
});

test('goal completion ignores stale or cancelled reviews', async t => {
  const f = await fixture(t); f.task();
  f.store.put('tasks', { id: 'task_stale_review', goalId: f.goal.id, projectId: f.project.id, title: '旧的整体审查', description: '', acceptance: '', kind: 'review', status: 'cancelled', reviewScope: 'goal', deliveryHash: 'old-delivery', passed: false, dependencies: [], createdAt: new Date().toISOString() });
  await f.start();
  await until(() => f.store.require('goals', f.goal.id).status === 'succeeded');
  const body = JSON.parse(eventsOf(f.store, 'goal.succeeded').at(-1).body);
  assert.equal(body.review, undefined, 'a cancelled/old review must not be attached to this completion');
});

test('goal completion review evidence must match the delivered hash and pass', () => {
  const context = demoContext();
  context.tasks.set('task_goal_review', { id: 'task_goal_review', title: '最终审查', status: 'succeeded', passed: true, reviewScope: 'goal' });
  const base = { seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'goal.succeeded', entityId: 'goal_1', goalId: 'goal_1', actor: { kind: 'system', id: 'scheduler' }, data: { contractVersion: 1, deliveryHash: 'HASH_A', delivery: [{ id: 'task_1', title: '演示任务', artifactHash: 'A', artifactIds: [], generation: 1, contractVersion: 1 }], review: { taskId: 'task_goal_review', passed: true, deliveryHash: 'HASH_A' } } };
  const valid = describeActivity(base, context);
  assert.equal(valid.deliveryReview.taskId, 'task_goal_review');
  assert.equal(valid.deliveryReviewStale, false);
  const stale = describeActivity({ ...base, data: { ...base.data, review: { ...base.data.review, deliveryHash: 'HASH_B' } } }, context);
  assert.equal(stale.deliveryReview, null);
  assert.equal(stale.deliveryReviewStale, true);
  const unpassed = describeActivity({ ...base, data: { ...base.data, review: { ...base.data.review, passed: false } } }, context);
  assert.equal(unpassed.deliveryReview, null);
  assert.equal(unpassed.deliveryReviewStale, true);
});

test('manager-routed blockers keep the executor snapshot', async t => {
  const f = await fixture(t); const task = f.task(); const record = f.store.require('tasks', task.id);
  f.engine.block(record, 'integration', '集成冲突', '请处理');
  const event = eventsOf(f.store, 'blocker.coordinated').at(-1);
  assert.ok(event, 'manager routing must leave a blocker.coordinated event');
  const body = JSON.parse(event.body);
  if (record.agentId) {
    assert.equal(body.executorId, record.agentId);
    const described = describeActivity(f.store.eventEntry(event), activityContext(f.company.snapshot()));
    assert.ok(described.executor?.startsWith('执行者'), 'the executor snapshot must survive manager routing');
  }
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
