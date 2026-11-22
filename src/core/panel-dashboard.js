import { assert, digest } from './util.js';
import { ENVIRONMENT_RECOVERED_REASON, taskSettledForGoal } from './hierarchy.js';
import { checkpointDeliverySources } from './goal-checkpoint-rows.js';
import { finalGoalComposition, goalDeliveryState } from './composite-delivery.js';
import { attemptForPanel } from './panel-attempts.js';
import { executionCapacity } from './execution-capacity.js';
import { activeViewTasks, compareActivity, isCompleted, isQueuedReview, taskBoardColumn, visibleCounts } from '../client/display.js';
import { defaultProjectId } from '../client/graph.js';
import { PENDING_INTEGRATION_PHASES } from './task-actions.js';

const field = key => `json_extract(body,'$.${key}')`;
const taskFields = ['goalId', 'projectId', 'kind', 'status', 'parentId', 'reviewOf', 'createdAt', 'agentId', 'title',
  'generation', 'reviewScope', 'deliveryHash', 'blocker.planId', 'costBudgetDeferral.decisionId', 'origin.kind', 'origin.blockerKind',
  'environmentResolution.sourceTaskId', 'coordinationOf', 'cancelledBy', 'stopRequested'];
const recovered = `(${field('cancelReason')}='${ENVIRONMENT_RECOVERED_REASON}')`;
const resolved = "json_type(body,'$.environmentResolution') IN ('object','array','text','integer','true')";
const taskKeys = [...taskFields.map(field), recovered, resolved];
export const DASHBOARD_INDEXES = `
  CREATE INDEX IF NOT EXISTS dashboard_task_fields ON entities(id,${taskKeys.join(',')}) WHERE collection='tasks';
  CREATE INDEX IF NOT EXISTS dashboard_pending_plans ON entities(collection) WHERE collection='plans' AND ${field('approvalStatus')}='pending';
  CREATE INDEX IF NOT EXISTS dashboard_pending_delivery ON entities(collection) WHERE collection='goals'
    AND ${field('deliveryApproval')} IS NOT NULL AND ${field('composition.passed')}=1 AND ${field('status')}='succeeded';
`;

function compactTasks(store) {
  const fields = taskFields.map(key => `${field(key)} AS "${key}"`).join(',');
  return store.db.prepare(`SELECT id,rowid AS historyPosition,${fields},${recovered} AS recovered,${resolved} AS resolved FROM entities INDEXED BY dashboard_task_fields
    WHERE collection='tasks'`).all().map(({ recovered, resolved, ...row }) => ({
      ...row,
      blocker: { planId: row['blocker.planId'] },
      costBudgetDeferral: { decisionId: row['costBudgetDeferral.decisionId'] },
      origin: { kind: row['origin.kind'], blockerKind: row['origin.blockerKind'] },
      environmentResolution: resolved ? { sourceTaskId: row['environmentResolution.sourceTaskId'] } : null,
      cancelReason: recovered ? ENVIRONMENT_RECOVERED_REASON : null,
    }));
}

const group = (rows, key) => {
  const grouped = new Map();
  for (const row of rows) {
    const id = key(row);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
};
const latest = (a, b) => !a || (b && b > a) ? b : a;
const mergeActivity = (rows, initial) => rows.reduce((time, row) => latest(time, row.activityAt), initial);
const rowWithBody = row => ({ ...JSON.parse(row.body), revision: row.revision });

const cachedRows = new WeakMap();

function dashboardRows(store) {
  // Both owner views can consume the same committed SQLite projection. Include
  // writes from this connection and other connections, even without an event.
  // The cursor read pins the read snapshot before reading data_version.
  if (store.inTransaction) return readDashboardRows(store);
  const cursor = store.cursor();
  const version = store.db.prepare('PRAGMA data_version').get().data_version;
  const writes = store.db.prepare('SELECT total_changes() AS writes').get().writes;
  const cached = cachedRows.get(store);
  if (cached && cached.cursor === cursor && cached.version === version && cached.writes === writes) return cached.rows;
  const rows = readDashboardRows(store);
  cachedRows.set(store, { cursor, version, writes, rows });
  return rows;
}

function readDashboardRows(store) {
  const activity = store.activity();
  const own = row => latest(activity.get(row.id), row.createdAt);
  const tasks = compactTasks(store);
  const visible = tasks.filter(task => task.status !== 'deleted');
  const children = group(visible, row => row.reviewOf || row.parentId);
  const remembered = new Map();
  const cascade = (task, visiting) => {
    if (remembered.has(task.id)) return remembered.get(task.id);
    if (visiting.has(task.id)) return own(task);
    const path = new Set(visiting).add(task.id);
    const at = (children.get(task.id) ?? []).reduce((time, child) => latest(time, cascade(child, path)), own(task));
    remembered.set(task.id, at);
    return at;
  };
  for (const task of visible) task.activityAt = cascade(task, new Set());
  const visibleByGoal = group(visible, item => item.goalId);
  const activeTasks = activeViewTasks(visible);
  const activeByProject = group(activeTasks, item => item.projectId);
  const activeByGoal = group(activeTasks, item => item.goalId);
  const read = (collection, projection) => store.db.prepare(`SELECT id,${projection} FROM entities
    WHERE collection=? AND ${field('status')} IS NOT 'deleted' ORDER BY rowid`).all(collection);
  const columns = keys => keys.map(key => `${field(key)} AS ${key}`).join(',');
  const goalFields = columns(['projectId', 'title', 'status', 'createdAt', 'contractVersion']);
  const goals = read('goals', `${goalFields},${field('timeBox.coordinationTaskId')} AS coordination,
    ${field('costBudgetDeferrals')} AS deferrals,${field('contractChange.status')} AS contractStatus`).map(({ coordination, deferrals, contractStatus, ...goal }) => {
    const owned = visibleByGoal.get(goal.id) ?? [];
    const counted = owned.filter(task => task.kind !== 'review');
    const ledger = { timeBox: { coordinationTaskId: coordination }, costBudgetDeferrals: deferrals ? JSON.parse(deferrals) : [] };
    const active = activeByGoal.get(goal.id) ?? [];
    return { ...goal, contractChange: contractStatus ? { status: contractStatus } : null,
      hasCancelledReview: owned.some(task => task.kind === 'review' && task.reviewScope === 'goal' && task.status === 'cancelled'),
      activityAt: mergeActivity(owned, own(goal)), activeTasks: active.length, openTasks: active.filter(task => !isCompleted(task)).length,
      taskSummary: { total: counted.length, done: counted.filter(task => taskSettledForGoal(task, ledger)).length,
        status: counted.length ? goal.status : 'empty' } };
  });
  const goalsByProject = group(goals, goal => goal.projectId);
  const projects = read('projects', columns(['name', 'repoRoot', 'status', 'createdAt'])).map(project => {
    const owned = goalsByProject.get(project.id) ?? [];
    return { ...project, activityAt: mergeActivity(owned, own(project)), activeTasks: activeByProject.get(project.id)?.length ?? 0,
      activeGoals: owned.filter(goal => !isCompleted(goal) || goal.openTasks > 0).length };
  });
  return { tasks, visible, visibleByGoal, goals, projects };
}

function goalBadge(store, { hasCancelledReview, ...row }, tasks) {
  if (!hasCancelledReview) return row;
  const goal = store.get('goals', row.id);
  const { hash } = goalDeliveryState(store, goal, checkpointDeliverySources(store, goal));
  const review = tasks?.filter(task => task.kind === 'review' && task.reviewScope === 'goal' && task.deliveryHash === hash)
    .reduce((current, task) => !current || task.historyPosition > current.historyPosition ? task : current, null);
  return { ...row, reviewSummary: review?.status === 'cancelled' ? { status: 'cancelled' } : null };
}

function dashboardPending(company, rows) {
  const { store } = company;
  const goals = new Map(rows.goals.map(goal => [goal.id, goal]));
  const tasks = new Map(rows.visible.map(task => [task.id, task]));
  const taskIds = new Set(rows.tasks.map(task => task.id));
  const plans = store.db.prepare(`SELECT id,${field('goalId')} AS goalId,${field('taskId')} AS taskId,
    ${field('generation')} AS generation,json_array_length(body,'$.proposalTasks') AS count
    FROM entities INDEXED BY dashboard_pending_plans WHERE collection='plans' AND ${field('approvalStatus')}='pending' ORDER BY rowid`).all()
    .filter(row => goals.has(row.goalId) && !['succeeded', 'cancelled', 'archived'].includes(goals.get(row.goalId).status) &&
      tasks.get(row.taskId)?.generation === row.generation && tasks.get(row.taskId)?.blocker?.planId === row.id)
    .map(row => ({ ...row, kind: 'plan', title: goals.get(row.goalId).title }));

  const deliveries = [];
  for (const row of store.db.prepare(`SELECT body,revision FROM entities INDEXED BY dashboard_pending_delivery WHERE collection='goals'
    AND ${field('deliveryApproval')} IS NOT NULL AND ${field('composition.passed')}=1 AND ${field('status')}='succeeded' ORDER BY rowid`).iterate()) {
    const goal = rowWithBody(row);
    const project = store.get('projects', goal.projectId);
    const { hash, candidate } = goalDeliveryState(store, goal, { ...checkpointDeliverySources(store, goal), project });
    const template = store.get('templates', goal.templateId ?? 'base');
    const review = store.latestGoalReviewForContract(goal.id, goal.contractVersion ?? 1, { evidenceOnly: true });
    const asset = finalGoalComposition(company, goal, candidate, hash, { project, template, review });
    const prior = goal.candidateMerge;
    if (asset && !goal.deliveryApproval.returnedVersions?.includes(asset.version) &&
      (!prior || prior.selection.deliveryHash !== asset.deliveryHash || prior.selection.version !== asset.version || prior.status === 'previewed')) {
      deliveries.push({ id: goal.id, goalId: goal.id, kind: 'delivery', title: goal.title });
    }
  }
  const questions = store.db.prepare(`SELECT id,${field('taskId')} AS taskId,${field('kind')} AS interactionKind
    FROM entities WHERE collection='interactions' AND ${field('status')}='pending' ORDER BY rowid`).all()
    .filter(row => tasks.has(row.taskId) || !taskIds.has(row.taskId))
    .map(row => ({ ...row, kind: 'question', title: tasks.get(row.taskId)?.title }));
  return { questions: questions.length, entries: [...plans, ...deliveries, ...questions] };
}

function take(rows, limit, after) {
  const start = after === null ? 0 : rows.findIndex(row => row.id === after) + 1;
  const items = rows.slice(start, start + limit);
  return { items, total: rows.length, next: start + items.length < rows.length ? items.at(-1).id : null,
    ...(after !== null && start === 0 ? { reset: true } : {}) };
}

function pendingPage(store, rows, after) {
  const page = take(rows, 8, after);
  return { ...page, items: page.items.map(item => item.kind === 'question' ?
    { ...item, question: store.get('interactions', item.id)?.question } : item) };
}

export function dashboardSnapshot(company, adapter, live) {
  const { store } = company;
  return store.readSnapshot(() => {
    const rows = dashboardRows(store);
    const pending = dashboardPending(company, rows);
    const policy = company.policy();
    const attempts = store.panelAttempts([...(live?.keys() ?? [])]);
    const tasks = new Map(rows.tasks.map(task => [task.id, task]));
    const phases = PENDING_INTEGRATION_PHASES.map(phase => "'" + phase + "'").join(',');
    const integrations = store.db.prepare(`SELECT body,revision FROM entities INDEXED BY occupied_integrations_by_goal_task
      WHERE collection='integrations' AND ${field('phase')} IN (${phases}) ORDER BY rowid`).all().map(rowWithBody);
    const capacity = executionCapacity(store, adapter, live, policy, { attempts, tasks, integrations });
    const recent = attempts.filter(attempt => tasks.get(attempt.taskId)?.status !== 'deleted').slice(-8).map(attemptForPanel);
    return {
      dashboardView: true, policy, capacity, cursor: store.cursor(),
      projects: take(rows.projects.toSorted(compareActivity), 12, null),
      pending: pendingPage(store, pending.entries, null),
      pendingQuestions: pending.questions,
      trashCount: store.db.prepare(`SELECT count(*) AS count FROM entities WHERE collection='tasks'
        AND ${field('status')}='deleted' AND ${field('deletion.batchId')}=id`).get().count,
      activeGoals: rows.goals.filter(goal => goal.taskSummary.total && ['active', 'planning'].includes(goal.status)).length,
      reviewQueue: rows.visible.filter(isQueuedReview).length,
      defaultProjectId: defaultProjectId(rows.projects, rows.visible),
      recent: recent.map(attempt => ({ ...attempt, taskTitle: tasks.get(attempt.taskId)?.title ?? null,
        agentName: attempt.agentId ? store.get('agents', attempt.agentId)?.name ?? null : null })),
      attempts: [],
    };
  });
}

const taskPageSize = 40;
function rankedPage(rows, queryKey, after) {
  let boundary = null;
  if (after) {
    try {
      const [key, id, activityAt, createdAt] = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
      if (key === queryKey && typeof id === 'string' && (activityAt === null || typeof activityAt === 'string')) {
        boundary = { id, activityAt, createdAt };
      }
    } catch { /* invalid or obsolete bookmark */ }
    assert(boundary, 'INVALID_INPUT', '无效的任务游标。');
  }
  const remaining = rows.sort(compareActivity).filter(task => !boundary || task.id !== boundary.id && compareActivity(task, boundary) > 0);
  const picked = remaining.slice(0, taskPageSize);
  const last = picked.at(-1);
  const next = remaining.length > taskPageSize ?
    Buffer.from(JSON.stringify([queryKey, last.id, last.activityAt ?? null, last.createdAt ?? null])).toString('base64url') : null;
  return { picked, next };
}

export function workbenchPage(company, params) {
  const { store } = company;
  const projectId = params.get('projectId') ?? '';
  const goalId = params.get('goalId') ?? '';
  const search = params.get('search') ?? '';
  const status = params.get('status') ?? '';
  const after = params.get('after') ?? '';
  const completed = params.get('completed') === '1';
  const reviewQueue = params.get('reviewQueue') === '1';
  const showReviews = params.get('showReviews') !== '0';
  const filters = { projectId, goalId, search, status, completed, reviewQueue, showReviews };
  assert(projectId.length <= 200 && goalId.length <= 200 && search.length <= 300 && status.length <= 32 && after.length <= 600,
    'INVALID_INPUT', '无效的工作台筛选范围。');
  return store.readSnapshot(() => {
    const rows = dashboardRows(store);
    const currentProject = rows.projects.find(project => project.id === projectId);
    const currentGoal = rows.goals.find(goal => goal.id === goalId);
    assert((!projectId || currentProject) && (!goalId || currentGoal && (!projectId || currentGoal.projectId === projectId)),
      'NOT_FOUND', '所选项目或目标已不可用。');
    let scoped = rows.visible.filter(task => (!projectId || task.projectId === projectId) && (!goalId || task.goalId === goalId) &&
      (!reviewQueue || isQueuedReview(task)) && (showReviews || task.kind !== 'review'));
    if (search) {
      const needle = search.toLowerCase();
      const descriptions = store.db.prepare(`SELECT t.id,${field('description')} AS description FROM json_each(?) wanted
        JOIN entities AS t ON t.collection='tasks' AND t.id=wanted.value`).all(JSON.stringify(scoped.map(task => task.id)));
      const byId = new Map(descriptions.map(row => [row.id, row.description]));
      scoped = scoped.filter(task => `${task.title} ${byId.get(task.id) ?? ''}`.toLowerCase().includes(needle));
    }
    const counts = visibleCounts(scoped);
    const active = activeViewTasks(scoped);
    const visible = (completed ? scoped.filter(isCompleted) : active).filter(task => !status || task.status === status);
    const boardCounts = Object.fromEntries([...group(visible, task => taskBoardColumn(task.status))].map(([key, tasks]) => [key, tasks.length]));
    const { picked, next } = rankedPage(visible, digest(filters).slice(0, 16), after);
    const taskDetails = store.db.prepare(`SELECT t.id, substr(${field('description')},1,360) AS description, ${field('dependencies')} AS dependencies,
      ${field('longLived')} AS longLived
      FROM json_each(?) wanted JOIN entities AS t ON t.collection='tasks' AND t.id=wanted.value`).all(JSON.stringify(picked.map(task => task.id)));
    const details = new Map(taskDetails.map(row => [row.id, row]));
    const tasks = picked.map(({ id, goalId, projectId, agentId, title, kind, status, parentId, reviewOf, activityAt }) => {
      const detail = details.get(id);
      return { id, goalId, projectId, agentId, title, kind, status, parentId, reviewOf, activityAt,
        description: detail?.description ?? '', longLived: detail?.longLived === 1,
        dependencies: detail?.dependencies ? JSON.parse(detail.dependencies) : [] };
    });
    const taskById = new Map(rows.visible.map(task => [task.id, task]));
    const knownIds = new Set(tasks.flatMap(task => [...task.dependencies, task.parentId, task.reviewOf].filter(Boolean)));
    const knownTasks = [];
    for (const id of knownIds) {
      const known = taskById.get(id);
      if (!known) continue;
      const { goalId, projectId, title, kind, status, parentId, reviewOf } = known;
      if (parentId) knownIds.add(parentId);
      knownTasks.push({ id, goalId, projectId, title, kind, status, parentId, reviewOf });
    }
    const projectIds = new Set(tasks.map(task => task.projectId));
    const goalIds = new Set(tasks.map(task => task.goalId));
    const include = (records, selected, ids) => {
      const first = records.toSorted(compareActivity).slice(0, taskPageSize);
      const inPage = new Set(first.map(row => row.id));
      return [...first, ...records.filter(row => !inPage.has(row.id) && (row.id === selected || ids.has(row.id)))];
    };
    const scopedGoals = rows.goals.filter(goal => !projectId || goal.projectId === projectId);
    const projects = include(rows.projects, projectId, projectIds);
    const goals = include(scopedGoals, goalId, goalIds).map(goal => goalBadge(store, goal, rows.visibleByGoal.get(goal.id)));
    const roles = [...new Set(tasks.map(task => task.agentId))].flatMap(id => {
      const agent = id && store.get('agents', id);
      return agent ? [{ id, name: agent.name }] : [];
    });
    return { filters, counts, boardCounts, activeTotal: active.length, visibleTotal: visible.length,
      hasOpenGoals: scopedGoals.some(goal => !['succeeded', 'cancelled', 'archived'].includes(goal.status)),
      tasks, knownTasks, projects, goals, agents: roles, next,
      projectOptions: take(rows.projects.toSorted(compareActivity), taskPageSize, null),
      goalOptions: take(scopedGoals.toSorted(compareActivity), taskPageSize, null),
      cursor: store.cursor() };
  });
}

export function dashboardPage(company, params) {
  const { store } = company;
  const section = params.get('section');
  const parent = params.get('parent');
  const after = params.get('after');
  const requiredParent = section === 'goals' || section === 'tasks' || section === 'goal-description';
  assert(['projects', 'goals', 'pending', 'tasks', 'goal-description', 'project-options', 'goal-options'].includes(section) &&
    (requiredParent ? parent && parent.length <= 200 : section === 'goal-options' ? parent === null || parent.length <= 200 : parent === null) &&
    (after === null || (after.length > 0 && after.length <= 200)), 'INVALID_INPUT', '无效的总览范围。');
  return store.readSnapshot(() => {
    if (section === 'goal-description') {
      assert(after === null, 'INVALID_INPUT', '无效的说明范围。');
      const goal = store.get('goals', parent);
      assert(goal && goal.status !== 'deleted' && store.get('projects', goal.projectId)?.status !== 'deleted',
        'NOT_FOUND', '目标已不可用。');
      return { section, parent, items: [], total: 0, next: null, about: goal.description, cursor: store.cursor() };
    }
    const rows = dashboardRows(store);
    let result;
    if (section === 'projects') result = take(rows.projects.toSorted(compareActivity), 12, after);
    if (section === 'project-options') result = take(rows.projects.toSorted(compareActivity), taskPageSize, after);
    if (section === 'goal-options') result = take(rows.goals.filter(goal => parent === null || goal.projectId === parent).sort(compareActivity),
      taskPageSize, after);
    if (section === 'pending') result = pendingPage(store, dashboardPending(company, rows).entries, after);
    if (section === 'goals') {
      assert(rows.projects.some(project => project.id === parent), 'NOT_FOUND', '项目已不可用。');
      const goals = rows.goals.filter(goal => goal.projectId === parent && (!isCompleted(goal) || goal.openTasks > 0));
      const page = take(goals.sort(compareActivity), 6, after);
      result = { ...page, items: page.items.map(goal => goalBadge(store, goal, rows.visibleByGoal.get(goal.id))) };
    }
    if (section === 'tasks') {
      const goal = store.get('goals', parent);
      assert(goal && goal.status !== 'deleted' && store.get('projects', goal.projectId)?.status !== 'deleted', 'NOT_FOUND', '目标已不可用。');
      const owned = rows.visible.filter(task => task.goalId === parent);
      const tasks = activeViewTasks(owned).sort(compareActivity).map(({ id, goalId, projectId, title, kind, status, parentId, reviewOf, activityAt }) =>
        ({ id, goalId, projectId, title, kind, status, parentId, reviewOf, activityAt }));
      result = { ...take(tasks, 40, after), about: goal.description };
    }
    return { ...result, section, parent, cursor: store.cursor() };
  });
}
