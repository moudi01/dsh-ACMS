/**
 * Presentation-only projections for the task dependency graph.
 *
 * Everything here is a pure function over the snapshot the client already received.
 * It decides which project/goal scope the graph shows (issue #24), how each scope is
 * grouped and laid out, and which predecessor tasks are hidden by the current filter or
 * live in another scope. It never reads or writes task, dependency or scheduler state.
 */

export const terminalStatus = new Set(['succeeded', 'cancelled', 'archived']);
const activeStatus = new Set(['running', 'preparing', 'reviewing', 'integrating', 'reconciling']);
const blockedStatus = new Set(['blocked', 'failed', 'paused', 'stopping']);

/** Latest stored business activity of one record (fallback 0 when unknown). */
export function activityAt(item) {
  const time = Date.parse(item?.updatedAt ?? item?.createdAt ?? '');
  return Number.isFinite(time) ? time : 0;
}

/**
 * Default project focus for the task workspace.
 *
 * Rule: projects with unfinished tasks win; among them the one with the newest task
 * activity, then the oldest created project, then id. Without unfinished tasks the same
 * ordering applies to every project. A single project is always focused. No project
 * means "全部项目".
 */
export function defaultProjectId(projects = [], tasks = []) {
  const available = projects.filter(project => project?.id);
  if (!available.length) return '';
  if (available.length === 1) return available[0].id;
  const measured = available.map(project => {
    const own = tasks.filter(task => task.projectId === project.id);
    return {
      project,
      open: own.filter(task => !terminalStatus.has(task.status)).length,
      activity: own.reduce((latest, task) => Math.max(latest, activityAt(task)), 0),
    };
  });
  const hasOpen = measured.some(entry => entry.open > 0);
  const pool = hasOpen ? measured.filter(entry => entry.open > 0) : measured;
  return [...pool].sort((a, b) =>
    b.activity - a.activity
    || String(a.project.createdAt ?? '').localeCompare(String(b.project.createdAt ?? ''))
    || String(a.project.id).localeCompare(String(b.project.id)))[0].project.id;
}

/** Visible task counts for a scope summary. */
export function scopeCounts(tasks = []) {
  const counts = { total: tasks.length, open: 0, active: 0, blocked: 0, reviewing: 0, done: 0 };
  for (const task of tasks) {
    if (terminalStatus.has(task.status)) { counts.done += 1; continue; }
    counts.open += 1;
    if (activeStatus.has(task.status)) counts.active += 1;
    if (blockedStatus.has(task.status)) counts.blocked += 1;
    if (task.status === 'reviewing' || task.status === 'integrating') counts.reviewing += 1;
  }
  return counts;
}

/** Stable order: newest activity first, then task id. Input array order never matters. */
function orderByActivity(tasks = []) {
  return [...tasks].sort((a, b) => activityAt(b) - activityAt(a) || String(a.id).localeCompare(String(b.id)));
}

const sectionActivity = section => section.tasks.reduce((latest, task) => Math.max(latest, activityAt(task)), 0);

/**
 * Group already-filtered `tasks` into graph scopes.
 *
 * mode 'single'   → one goal is selected (or a deep link resolved to one): a single canvas.
 * mode 'goals'    → one project is selected: one collapsible section per goal.
 * mode 'projects' → "全部项目": one collapsible section per project, goals nested inside.
 *
 * Dependencies never cross canvases by design; when data contains one it is reported in
 * `crossScope` instead of being drawn, so a display bug cannot look like a real edge.
 */
export function graphSections({ projects = [], goals = [], tasks = [], projectId = '', goalId = '', knownTasks = tasks } = {}) {
  const project = projects.find(item => item.id === projectId) ?? null;
  const goal = goals.find(item => item.id === goalId) ?? null;
  let mode;
  let sections;
  if (goalId) {
    mode = 'single';
    sections = [{ key: `goal:${goalId}`, kind: 'goal', id: goalId, title: goal?.title ?? '未知目标', projectId: goal?.projectId ?? projectId, goalId, tasks: orderByActivity(tasks.filter(task => task.goalId === goalId)) }];
  } else if (projectId) {
    mode = 'goals';
    const goalIds = new Set(goals.filter(item => item.projectId === projectId).map(item => item.id));
    sections = goals.filter(item => item.projectId === projectId).map(item => ({ key: `goal:${item.id}`, kind: 'goal', id: item.id, title: item.title, projectId, goalId: item.id, tasks: orderByActivity(tasks.filter(task => task.goalId === item.id)) }));
    const orphans = tasks.filter(task => task.projectId === projectId && !goalIds.has(task.goalId));
    if (orphans.length) sections.push({ key: 'goal:unknown', kind: 'goal', id: 'unknown', title: '未归属目标', projectId, goalId: null, tasks: orderByActivity(orphans) });
  } else {
    mode = 'projects';
    sections = projects.map(item => ({ key: `project:${item.id}`, kind: 'project', id: item.id, title: item.name, projectId: item.id, goalId: null, tasks: orderByActivity(tasks.filter(task => task.projectId === item.id)) }));
  }
  sections = sections.filter(section => section.tasks.length);
  sections.sort((a, b) => sectionActivity(b) - sectionActivity(a) || a.key.localeCompare(b.key));
  const canvasKeys = new Map();
  for (const section of sections) {
    section.counts = scopeCounts(section.tasks);
    if (mode === 'projects') {
      const byGoal = new Map();
      for (const task of section.tasks) byGoal.set(task.goalId, [...(byGoal.get(task.goalId) ?? []), task]);
      section.groups = [...byGoal.entries()].map(([goalId, list]) => ({ key: `goal:${goalId}`, goalId, title: goals.find(item => item.id === goalId)?.title ?? '未知目标', tasks: list, counts: scopeCounts(list) }));
      section.groups.sort((a, b) => sectionActivity({ tasks: b.tasks }) - sectionActivity({ tasks: a.tasks }) || a.key.localeCompare(b.key));
      for (const group of section.groups) for (const task of group.tasks) canvasKeys.set(task.id, group.key);
    } else {
      for (const task of section.tasks) canvasKeys.set(task.id, section.key);
    }
  }
  const knownById = new Map(knownTasks.map(task => [task.id, task]));
  const crossScope = [];
  for (const section of sections) for (const task of section.tasks) for (const dependencyId of task.dependencies ?? []) {
    const owner = canvasKeys.get(dependencyId);
    if (owner === canvasKeys.get(task.id)) continue;
    if (!owner) continue;
    crossScope.push({ taskId: task.id, taskTitle: task.title, dependencyId, dependencyTitle: knownById.get(dependencyId)?.title ?? null, section: canvasKeys.get(task.id), dependencySection: owner });
  }
  const scopeLabel = goalId
    ? `项目：${project?.name ?? '未知项目'} · 目标：${goal?.title ?? '未知目标'}`
    : projectId
      ? `项目：${project?.name ?? '未知项目'} · 全部目标（${sections.length} 个有任务的目标）`
      : `全部项目（${sections.length} 个有任务的项目）`;
  return { mode, scopeLabel, sections, crossScope, visible: tasks.length };
}

/**
 * Predecessors that are missing from the current canvas: filtered out by search, review
 * toggle or scope, or no longer in the snapshot. They are surfaced as expandable
 * placeholders; no edge is invented and no data is rewritten.
 */
export function hiddenDependencies(tasks = [], knownTasks = []) {
  const ids = new Set(tasks.map(task => task.id));
  const knownById = new Map(knownTasks.map(task => [task.id, task]));
  const seen = new Set();
  const list = [];
  for (const task of tasks) for (const dependencyId of task.dependencies ?? []) {
    const key = `${task.id}:${dependencyId}`;
    if (ids.has(dependencyId) || seen.has(key)) continue;
    seen.add(key);
    const dependency = knownById.get(dependencyId);
    list.push({ taskId: task.id, taskTitle: task.title, dependencyId, dependencyTitle: dependency?.title ?? null, dependencyStatus: dependency?.status ?? null });
  }
  return list;
}

/**
 * Deterministic layered layout. Rows are assigned by newest activity then id, so the same
 * tasks always produce the same coordinates regardless of the input array order, and one
 * project can never drift into another project's canvas.
 */
export function graphLayout(tasks = []) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const levels = new Map();
  const visit = (task, seen = new Set()) => {
    if (levels.has(task.id)) return levels.get(task.id);
    if (seen.has(task.id)) return 0;
    seen.add(task.id);
    const parents = (task.dependencies ?? []).map(id => byId.get(id)).filter(Boolean);
    const level = parents.length ? Math.max(...parents.map(parent => visit(parent, new Set(seen)))) + 1 : 0;
    levels.set(task.id, level);
    return level;
  };
  tasks.forEach(task => visit(task));
  const rows = new Map();
  const positions = new Map();
  for (const task of orderByActivity(tasks)) {
    const level = levels.get(task.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    positions.set(task.id, { x: 30 + level * 300, y: 30 + row * 130 });
  }
  const columns = levels.size ? Math.max(...levels.values()) + 1 : 1;
  const rowCount = rows.size ? Math.max(...rows.values()) : 1;
  return { levels, positions, columns, width: Math.max(700, columns * 300), height: Math.max(220, rowCount * 130 + 60) };
}
