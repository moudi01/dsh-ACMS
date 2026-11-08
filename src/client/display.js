import { activityAt } from './graph.js';

/**
 * Presentation-only helpers for issue #17 (display defaults).
 *
 * They never mutate task/goal status, review conclusions, dependencies or
 * scheduler order; they only decide what a view shows and in which order.
 */

export const COMPLETED_STATUSES = new Set(['succeeded', 'cancelled', 'archived']);
export const isCompleted = item => COMPLETED_STATUSES.has(item?.status);

/** Newest effective activity first; stable tie-break by id, then creation time. */
export function compareActivity(a, b) {
  return activityAt(b) - activityAt(a)
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
    || String(a?.createdAt ?? '').localeCompare(String(b?.createdAt ?? ''));
}
export function orderByActivity(items = []) { return [...items].sort(compareActivity); }

export const taskParentId = task => task?.reviewOf || task?.parentId || null;

/** Children grouped under their parent task (review tasks count as children of the reviewed task). */
export function childrenIndex(tasks = []) {
  const map = new Map();
  for (const task of tasks) {
    const parent = taskParentId(task);
    if (!parent) continue;
    map.set(parent, [...(map.get(parent) ?? []), task]);
  }
  for (const list of map.values()) list.sort(compareActivity);
  return map;
}

/** Does a completed node still contain unfinished/blocked/pending work? */
export function hasOpenDescendant(node, index) {
  const stack = [...(index.get(node?.id) ?? [])]; const seen = new Set();
  while (stack.length) {
    const task = stack.pop();
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    if (!isCompleted(task)) return true;
    stack.push(...(index.get(task.id) ?? []));
  }
  return false;
}

/**
 * Current-view tasks: every unfinished task plus the completed ancestors needed
 * to discover it. A completed branch with open descendants therefore stays
 * visible instead of becoming an unreachable orphan.
 */
export function activeViewTasks(tasks = []) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const keep = new Set(tasks.filter(task => !isCompleted(task)).map(task => task.id));
  for (const task of tasks) {
    if (isCompleted(task)) continue;
    let parent = taskParentId(task); const seen = new Set();
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent); keep.add(parent); parent = taskParentId(byId.get(parent));
    }
  }
  return tasks.filter(task => keep.has(task.id));
}

export function completedTasks(tasks = []) { return orderByActivity(tasks.filter(isCompleted)); }

/** A goal stays in the current view when it is open or still has open descendants. */
export function goalVisibleInActiveView(goal, tasks = []) {
  return !isCompleted(goal) || tasks.some(task => task.goalId === goal.id && !isCompleted(task));
}

export function visibleCounts(items = [], completed = false) {
  const done = items.filter(isCompleted).length;
  return { total: items.length, completed: done, visible: completed ? done : items.length - done };
}
