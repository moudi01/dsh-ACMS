import test from 'node:test';
import assert from 'node:assert/strict';
import { activeViewTasks, childrenIndex, completedTasks, goalVisibleInActiveView, hasOpenDescendant, isCompleted, orderByActivity, verificationsForTask, visibleCounts } from '../src/client/display.js';

const task = (id, status, parentId = null, extra = {}) => ({ id, status, parentId, createdAt: '2026-01-01T00:00:00.000Z', activityAt: '2026-01-01T00:00:00.000Z', ...extra });

test('activity order is newest first with a stable id tie-break', () => {
  const items = [
    task('b', 'ready', null, { activityAt: '2026-01-02T00:00:00.000Z' }),
    task('a', 'ready', null, { activityAt: '2026-01-02T00:00:00.000Z' }),
    task('c', 'ready', null, { activityAt: '2026-01-03T00:00:00.000Z' }),
  ];
  assert.deepEqual(orderByActivity(items).map(item => item.id), ['c', 'a', 'b']);
});

test('active view keeps unfinished work and only the completed ancestors needed to reach it', () => {
  const tasks = [
    task('done-parent', 'succeeded'),
    task('done-child', 'succeeded', 'done-parent'),
    task('open-child', 'blocked', 'done-parent'),
    task('unrelated-done', 'archived'),
  ];
  const view = activeViewTasks(tasks).map(item => item.id);
  assert.deepEqual(view.sort(), ['done-parent', 'open-child']);
  const index = childrenIndex(tasks);
  assert.equal(hasOpenDescendant(tasks[0], index), true);
  assert.equal(hasOpenDescendant(tasks[3], index), false);
});

test('review task evidence follows the review attempt even when the conclusion targets another entity', () => {
  const task = { id: 'review-task' };
  const attempts = [{ id: 'review-attempt', taskId: 'review-task' }, { id: 'other-attempt', taskId: 'other-task' }];
  const verifications = [
    { id: 'direct', taskId: 'review-task', attemptId: 'direct-attempt' },
    { id: 'goal-review', taskId: 'goal-id', attemptId: 'review-attempt' },
    { id: 'task-review', taskId: 'reviewed-task', attemptId: 'review-attempt' },
    { id: 'foreign', taskId: 'other-task', attemptId: 'other-attempt' },
  ];
  assert.deepEqual(verificationsForTask(task, attempts, verifications).map(item => item.id), ['direct', 'goal-review', 'task-review']);
});

test('completed taxonomy, goal visibility and counts are display-only', () => {
  assert.equal(isCompleted({ status: 'succeeded' }), true);
  assert.equal(isCompleted({ status: 'archived' }), true);
  assert.equal(isCompleted({ status: 'cancelled' }), true);
  assert.equal(isCompleted({ status: 'blocked' }), false);
  const tasks = [task('a', 'running'), task('b', 'succeeded'), task('c', 'archived')];
  assert.deepEqual(completedTasks(tasks).map(item => item.id).sort(), ['b', 'c']);
  assert.deepEqual(visibleCounts(tasks), { total: 3, completed: 2, visible: 1 });
  assert.equal(goalVisibleInActiveView({ id: 'g', status: 'succeeded' }, [task('x', 'blocked', null, { goalId: 'g' })]), true);
  assert.equal(goalVisibleInActiveView({ id: 'g', status: 'succeeded' }, [task('x', 'succeeded', null, { goalId: 'g' })]), false);
});
