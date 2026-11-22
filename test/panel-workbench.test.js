import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createRoutes } from '../src/host/http.js';
import { OWNER, digest } from '../src/core/util.js';
import { compareActivity } from '../src/client/display.js';
import { Store } from '../src/core/store.js';
import { dashboardSnapshot, workbenchPage } from '../src/core/panel-dashboard.js';
import { compositionCheckContract, goalDeliveryState } from '../src/core/composite-delivery.js';
import { goalDeliveryHash } from '../src/core/goal-contract.js';

test('dashboard and workbench only decode indexed projections on first read and open full goal context by ID', async t => {
  const f = await fixture(t);
  const otherProject = f.command('project.save', { name: '另一个项目', repoRoot: f.root, mode: 'copy' });
  const otherGoal = f.command('goal.create', { title: '跨项目详情', projectId: otherProject.id, description: 'isolated',
    acceptance: 'read by ID', plan: false });
  const other = f.task({ goalId: otherGoal.id, title: '其他范围的前置任务' });
  const createdAt = '2000-01-01T00:00:00.000Z';
  const ids = [];
  f.store.transaction(() => {
    for (let index = 0; index < 85; index++) {
      const id = 'task_page_' + String(index).padStart(3, '0');
      ids.push(id);
      const status = index === 84 ? 'deleted' : index === 83 ? 'succeeded' : 'ready';
      f.store.put('tasks', { id, projectId: f.project.id, goalId: f.goal.id, kind: 'work', status,
        title: '工作台任务 ' + index, description: '长说明 '.repeat(100) + (index === 82 ? 'ÉSÔTERIC' : 'ordinary'),
        dependencies: index === 0 ? [other.id] : [], createdAt,
        ...(status === 'deleted' ? { deletion: { batchId: id } } : {}) });
    }
    f.store.put('attempts', { id: 'attempt_legacy_missing_agent', taskId: ids[0], status: 'completed' });
    f.store.event('task.changed', ids[60], {}, OWNER);
  });
  const routes = new Map(createRoutes(f).map(route => [route.path, route.fetch]));
  const read = async target => {
    const url = new URL(target, 'http://dsh/api/acms/');
    const reply = await routes.get(url.pathname)(new Request(url));
    return { status: reply.status, body: await reply.json() };
  };
  const old = (await read('state?view=panel')).body;
  const list = f.store.list.bind(f.store);
  const queries = [];
  const compact = [];
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.list = collection => { queries.push(collection); return list(collection); };
  f.store.db.prepare = sql => { if (sql.includes('INDEXED BY dashboard_task_fields')) compact.push(sql); return prepare(sql); };
  const firstDashboard = (await read('state?view=dashboard')).body;
  assert(firstDashboard.dashboardView);
  assert.equal(firstDashboard.trashCount, 1);
  assert.equal(firstDashboard.projects.total, 2);
  assert.equal(firstDashboard.pendingQuestions, old.interactions.filter(row => row.status === 'pending').length);
  assert.equal(firstDashboard.activeGoals, old.goals.filter(goal => goal.taskSummary.total > 0 && ['active','planning'].includes(goal.status)).length);
  assert.equal(firstDashboard.tasks, undefined);
  assert.deepEqual(firstDashboard.runtime.capacity, old.runtime.capacity);
  assert.equal(firstDashboard.recent[0].agentName, null);
  const scope = 'workbench?projectId=' + f.project.id;
  const first = await read(scope);
  assert.equal(first.status, 200);
  assert.equal(first.body.tasks.length, 40);
  assert.equal(first.body.tasks[0].id, ids[60]);
  assert.equal(first.body.visibleTotal, 83);
  assert.equal(first.body.counts.total, 84);
  assert.equal(first.body.knownTasks[0].id, other.id);
  const second = await read(scope + '&after=' + first.body.next);
  const third = await read(scope + '&after=' + second.body.next);
  const combined = [first, second, third].flatMap(page => page.body.tasks.map(task => task.id));
  assert.deepEqual(combined, old.tasks.filter(task => task.projectId === f.project.id && task.status === 'ready').sort(compareActivity).map(task => task.id));
  assert.equal(third.body.next, null);
  assert.equal((await read('workbench?projectId=' + otherProject.id + '&after=' + first.body.next)).status, 400);
  assert.equal((await read(scope + '&goalId=' + otherGoal.id)).status, 404);
  const found = await read(scope + '&search=' + encodeURIComponent('ésôteric'));
  assert.deepEqual(found.body.tasks.map(task => task.id), [ids[82]]);
  assert(!found.body.tasks[0].description.includes('ÉSÔTERIC'));
  assert(queries.every(collection => !['tasks','attempts','artifacts','verifications'].includes(collection)), queries.join(', '));

  // A covering expression index can still defer a table seek; verify the
  // actual projection reads columns from the index, including returned keys.
  assert(compact.length > 0);
  const program = prepare('EXPLAIN ' + compact[0]).all();
  const table = prepare("SELECT rootpage FROM sqlite_schema WHERE name='entities'").get().rootpage;
  const tableCursors = new Set(program.filter(row => row.opcode === 'OpenRead' && row.p2 === table).map(row => row.p1));
  assert(!program.some(row => row.opcode === 'Column' && tableCursors.has(row.p1)), 'compact SELECT must not fetch entity bodies');

  const context = await read('panel-context?taskId=' + other.id);
  assert.equal(context.status, 200);
  assert.deepEqual(context.body.goals.map(goal => goal.id), [otherGoal.id]);
  assert(context.body.tasks.some(task => task.id === other.id));
  assert.deepEqual(context.body.tasks.filter(task => ids.includes(task.id)).map(task => task.id), [ids[0]]);
  assert.equal(context.body.tasks.find(task => task.id === ids[0]).description, undefined);
  assert.equal((await read('panel-context?taskId=' + ids[84])).status, 404);
});

test('dashboard reuses the committed SQL projection but refreshes runtime and invalidates on external updates and rollback', async t => {
  const f = await fixture(t);
  const task = f.task();
  const query = new URLSearchParams({ projectId: f.project.id });
  const workbench = () => workbenchPage(f.company, query);
  const dashboard = () => dashboardSnapshot(f.company, f.adapter, f.engine.live);
  const title = () => workbench().tasks.find(row => row.id === task.id)?.title;
  const writer = new Store(f.store.filename);
  let reads = 0;
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (sql.includes('INDEXED BY dashboard_task_fields')) reads++; return prepare(sql); };

  try {
    const before = dashboard();
    assert.equal(title(), task.title);
    f.adapter.activeProbes = 1;
    const probed = dashboard();
    assert.equal(probed.cursor, before.cursor);
    assert.equal(probed.capacity.counts.probe, 1);
    assert.equal(reads, 1);

    writer.put('tasks', { ...writer.require('tasks', task.id), title: '外部提交无事件' });
    assert.equal(f.store.cursor(), before.cursor);
    assert.equal(title(), '外部提交无事件');
    assert.equal(reads, 2);
    f.store.db.prepare("UPDATE entities SET body=json_set(body,'$.title',?) WHERE collection='tasks' AND id=?").run('同连接无事件', task.id);
    assert.equal(title(), '同连接无事件');
    assert.equal(reads, 3);

    assert.throws(() => f.store.transaction(() => {
      f.store.put('tasks', { ...f.store.require('tasks', task.id), title: '未提交的临时版本' });
      assert.equal(title(), '未提交的临时版本');
      throw new Error('roll back fixture');
    }), /roll back fixture/);
    assert.equal(title(), '同连接无事件');
    assert.equal(reads, 5);

    const afterRollback = f.store.cursor();
    f.store.transaction(() => f.store.event('task.changed', task.id, {}, OWNER));
    assert(dashboard().cursor > afterRollback);
    f.store.db.prepare('DELETE FROM events WHERE seq=?').run(f.store.cursor());
    assert.equal(dashboard().cursor, afterRollback);
    assert.equal(reads, 7);

    writer.put('tasks', { ...writer.require('tasks', task.id), title: '并发写入前的证据' });
    let concurrent = false;
    f.store.db.prepare = sql => {
      if (!concurrent && sql.includes('INDEXED BY dashboard_task_fields')) {
        concurrent = true;
        writer.put('tasks', { ...writer.require('tasks', task.id), title: '并发提交后的证据' });
      }
      return prepare(sql);
    };
    assert.equal(title(), '并发写入前的证据');
    assert.equal(title(), '并发提交后的证据');
  } finally { writer.close(); }
});

test('dashboard badges use current plan generation and the latest matching review creation order', async t => {
  const f = await fixture(t);
  const planner = f.task();
  const hash = f.company.deliveryHash(f.goal.id);
  f.store.transaction(() => {
    f.store.put('tasks', { ...planner, generation: 2, blocker: { kind: 'plan-approval', planId: 'plan_current' } });
    const plan = { taskId: planner.id, goalId: f.goal.id, approvalStatus: 'pending', proposalTasks: [{ title: 'the plan' }] };
    f.store.put('plans', { ...plan, id: 'plan_current', generation: 2 });
    f.store.put('plans', { ...plan, id: 'plan_old_generation', generation: 1 });
    f.store.put('plans', { ...plan, id: 'plan_other_blocker', generation: 2 });
    const review = { goalId: f.goal.id, projectId: f.project.id, kind: 'review', reviewScope: 'goal',
      deliveryHash: hash, createdAt: '2000-01-01T00:00:00.000Z' };
    f.store.put('tasks', { ...review, id: 'task_review_z_first', status: 'failed' });
    f.store.put('tasks', { ...review, id: 'task_review_a_latest', status: 'cancelled' });
    f.store.put('tasks', { ...review, id: 'task_review_other_hash', deliveryHash: 'superseded', status: 'succeeded' });
  });
  const dashboard = dashboardSnapshot(f.company, f.adapter, f.engine.live);
  assert.deepEqual(dashboard.pending.items.map(row => row.id), ['plan_current']);
  const workbench = workbenchPage(f.company, new URLSearchParams({ projectId: f.project.id }));
  assert.equal(workbench.goals.find(goal => goal.id === f.goal.id).reviewSummary?.status, 'cancelled');
});

test('a completed workbench page reads artifact counts only for its forty task IDs', async t => {
  const f = await fixture(t);
  f.store.transaction(() => {
    for (let i = 0; i < 4000; i++) {
      const id = 'task_artifact_count_' + String(i).padStart(4, '0');
      f.store.put('tasks', { id, projectId: f.project.id, goalId: f.goal.id, title: 'Completed ' + i,
        kind: 'work', status: 'succeeded', artifactIds: ['artifact_y_' + i], createdAt: '2000-01-01T00:00:00.000Z' });
      if (i !== 0) {
        f.store.put('artifacts', { id: 'artifact_x_' + i, taskId: id });
        f.store.put('artifacts', { id: 'artifact_y_' + i, taskId: id });
      }
    }
  });
  const requestIds = [];
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.includes('wanted.value AS id') || !sql.includes('INDEXED BY artifacts_by_task')) return statement;
    return { all(ids) { requestIds.push(JSON.parse(ids)); return statement.all(ids); } };
  };
  const params = new URLSearchParams({ projectId: f.project.id, completed: '1' });
  const first = workbenchPage(f.company, params);
  params.set('after', first.next);
  const second = workbenchPage(f.company, params);
  assert.equal(first.visibleTotal, 4000);
  assert.equal(first.tasks.length, 40);
  assert.equal(second.tasks.length, 40);
  assert.deepEqual(requestIds, [first.tasks.map(row => row.id), second.tasks.map(row => row.id)]);
  assert.deepEqual(Object.keys(first.artifactCounts), requestIds[0]);
  assert.deepEqual(Object.keys(second.artifactCounts), requestIds[1]);
  assert.equal(first.artifactCounts[first.tasks[0].id], 0);
  assert.equal(first.artifactCounts[first.tasks[1].id], 2);
  assert(Object.values(second.artifactCounts).every(count => count === 2));
  t.diagnostic('Completed rows counted from 4,000-task scope: ' + requestIds.map(ids => ids.length).join(' + '));
});

test('dashboard only loads deliverable source records for unresolved candidate versions', async t => {
  const f = await fixture(t);
  const baseHash = digest('baseline'), contentHash = digest('accepted bytes');
  const checkContract = compositionCheckContract(f.project);
  const selectionFor = (version, deliveryHash) => ({ version, deliveryHash });
  f.store.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const goalId = 'goal_decided_' + i;
      const version = 'candidate-' + i;
      const artifactHash = digest('artifact-' + i);
      const snapshotSha256 = digest('delivery-' + i);
      const task = f.store.put('tasks', { id: 'task_decided_' + i, goalId, projectId: f.project.id, kind: 'work', status: 'succeeded',
        generation: 1, deliveryGeneration: 1, artifactHash, dependencies: [], workspace: { compositionInput: { version: 'source-1' } },
        integration: { delivery: { sha256: snapshotSha256 } } });
      const goal = { id: goalId, title: 'Delivery ' + i, projectId: f.project.id, status: 'succeeded', templateId: f.template.id,
        description: 'fixture-long-delivery '.repeat(396), contractVersion: 1, completedContractVersion: 1,
        deliveryMode: 'copy-composite', compositionBase: { snapshot: { sha256: baseHash } },
        deliveryApproval: { returnedVersions: i >= 200 && i < 399 ? [version] : [] } };
      const composition = { version, passed: true, checkContract, ledgerHash: goalDeliveryHash(goal, [task]),
        snapshot: { sha256: contentHash }, baseHash, contentHash,
        inputs: [{ taskId: task.id, generation: 1, artifactHash, snapshotSha256, baseline: 'source-1' }],
        checks: [{ id: 'acceptance', checkVersion: 1, inputHash: contentHash, passed: true, cleanupConfirmed: true }] };
      const { hash, candidate } = goalDeliveryState(f.store, { ...goal, composition }, { project: f.project, roots: [task] });
      assert.equal(candidate, composition);
      f.store.put('goals', { ...goal, composition, completedDeliveryHash: hash,
        ...(i < 200 ? { candidateMerge: { status: i % 2 ? 'rejected' : 'applied', selection: selectionFor(version, hash) } } : {}) });
    }
  });
  let sourceReads = 0;
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = sql => { if (sql.includes('INDEXED BY delivered_work_by_goal')) sourceReads++; return prepare(sql); };
  const fullGoals = [];
  const parse = JSON.parse;
  JSON.parse = (json, ...args) => {
    if (typeof json === 'string' && json.startsWith('{"id":"goal_decided_') && json.includes('fixture-long-delivery')) fullGoals.push(Buffer.byteLength(json));
    return parse(json, ...args);
  };
  const dashboard = () => dashboardSnapshot(f.company, f.adapter, f.engine.live);
  try {
    assert.deepEqual(dashboard().pending.items.map(item => item.id), ['goal_decided_399']);
    assert.equal(sourceReads, 1);
    assert.equal(fullGoals.length, 1);
    assert.equal(dashboard().pending.total, 1);
    assert.equal(sourceReads, 1);
    assert.equal(fullGoals.length, 1);
    t.diagnostic(`400 candidate goals: first read decoded 1 full goal (${fullGoals[0]} B) and read 1 delivery source. Warm read reused both.`);

    const reopened = f.store.require('goals', 'goal_decided_0');
    f.store.put('goals', { ...reopened, candidateMerge: { ...reopened.candidateMerge, status: 'previewed' } });
    for (const [index, change] of [[1, 'hash'], [200, 'version']]) {
      const current = f.store.require('goals', 'goal_decided_' + index);
      const composition = change === 'version' ? { ...current.composition, version: 'subsequent-candidate' } :
        { ...current.composition, checks: [{ ...current.composition.checks[0], inputHash: digest('new accepted input') }] };
      const { hash } = goalDeliveryState(f.store, { ...current, composition });
      f.store.put('goals', { ...current, composition, completedDeliveryHash: hash });
    }
    fullGoals.length = 0;
    sourceReads = 0;
    assert.deepEqual(dashboard().pending.items.map(item => item.id),
      ['goal_decided_0', 'goal_decided_1', 'goal_decided_200', 'goal_decided_399']);
    assert.equal(fullGoals.length, 4);
    assert.equal(sourceReads, 4);
  } finally {
    JSON.parse = parse;
  }
});
