import test from 'node:test';
import assert from 'node:assert/strict';
import { activityAt, defaultProjectId, graphLayout, graphSections, hiddenDependencies, scopeCounts } from '../src/client/graph.js';

const project = (id, createdAt = '2026-11-01T00:00:00.000Z') => ({ id, name: `项目 ${id}`, createdAt });
const goal = (id, projectId, title = `目标 ${id}`) => ({ id, projectId, title });
const task = (id, projectId, goalId, extra = {}) => ({ id, projectId, goalId, title: `任务 ${id}`, status: 'ready', dependencies: [], createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...extra });

test('activityAt reads the stored activity time and degrades to zero', () => {
  assert.equal(activityAt({ updatedAt: '2026-11-07T10:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' }), Date.parse('2026-11-07T10:00:00.000Z'));
  assert.equal(activityAt({ createdAt: '2026-11-02T00:00:00.000Z' }), Date.parse('2026-11-02T00:00:00.000Z'));
  assert.equal(activityAt({ updatedAt: 'not a date' }), 0);
  assert.equal(activityAt(null), 0);
});

test('defaultProjectId focuses the single project without guessing', () => {
  assert.equal(defaultProjectId([], []), '');
  assert.equal(defaultProjectId([project('p1')], []), 'p1');
});

test('defaultProjectId prefers unfinished work and then newest activity', () => {
  const projects = [project('p1'), project('p2')];
  const tasks = [
    task('t1', 'p1', 'g1', { status: 'succeeded', updatedAt: '2026-11-07T12:00:00.000Z' }),
    task('t2', 'p2', 'g2', { status: 'blocked', updatedAt: '2026-11-07T09:00:00.000Z' }),
  ];
  assert.equal(defaultProjectId(projects, tasks), 'p2');
  tasks.push(task('t3', 'p1', 'g1', { status: 'running', updatedAt: '2026-11-07T13:00:00.000Z' }));
  assert.equal(defaultProjectId(projects, tasks), 'p1');
});

test('defaultProjectId falls back to newest activity when everything is done, with a stable tie-break', () => {
  const projects = [project('p1', '2026-10-01T00:00:00.000Z'), project('p2', '2026-10-02T00:00:00.000Z')];
  const tasks = [
    task('t1', 'p1', 'g1', { status: 'succeeded', updatedAt: '2026-11-07T12:00:00.000Z' }),
    task('t2', 'p2', 'g2', { status: 'cancelled', updatedAt: '2026-11-07T08:00:00.000Z' }),
  ];
  assert.equal(defaultProjectId(projects, tasks), 'p1');
  const tied = tasks.map(item => ({ ...item, updatedAt: '2026-11-07T12:00:00.000Z' }));
  assert.equal(defaultProjectId(projects, tied), 'p1');
});

test('scopeCounts separates unfinished, blocked and review work', () => {
  const counts = scopeCounts([
    task('t1', 'p1', 'g1', { status: 'running' }),
    task('t2', 'p1', 'g1', { status: 'blocked' }),
    task('t3', 'p1', 'g1', { status: 'reviewing' }),
    task('t4', 'p1', 'g1', { status: 'succeeded' }),
  ]);
  assert.deepEqual(counts, { total: 4, open: 3, active: 2, blocked: 1, reviewing: 1, done: 1 });
});

test('graphSections keeps a single goal in one canvas without section chrome', () => {
  const tasks = [task('t1', 'p1', 'g1'), task('t2', 'p1', 'g2')];
  const model = graphSections({ projects: [project('p1')], goals: [goal('g1', 'p1', '交付 A')], tasks, projectId: 'p1', goalId: 'g1' });
  assert.equal(model.mode, 'single');
  assert.equal(model.sections.length, 1);
  assert.deepEqual(model.sections[0].tasks.map(item => item.id), ['t1']);
  assert.match(model.scopeLabel, /项目：项目 p1/);
  assert.match(model.scopeLabel, /目标：交付 A/);
});

test('graphSections groups one project by goal, newest activity first, empty goals dropped', () => {
  const tasks = [
    task('t1', 'p1', 'g1', { updatedAt: '2026-11-07T08:00:00.000Z' }),
    task('t2', 'p1', 'g2', { updatedAt: '2026-11-07T09:00:00.000Z' }),
    task('orphan', 'p1', 'g-deleted', { updatedAt: '2026-11-07T07:00:00.000Z' }),
  ];
  const model = graphSections({ projects: [project('p1')], goals: [goal('g1', 'p1'), goal('g2', 'p1'), goal('g3', 'p1')], tasks, projectId: 'p1' });
  assert.equal(model.mode, 'goals');
  assert.deepEqual(model.sections.map(section => section.goalId), ['g2', 'g1', null]);
  assert.equal(model.sections[2].title, '未归属目标');
  assert.equal(model.sections[0].counts.total, 1);
});

test('graphSections separates "全部项目" into project sections with per-goal groups', () => {
  const tasks = [
    task('a1', 'p1', 'a-main', { updatedAt: '2026-11-07T08:00:00.000Z' }),
    task('a2', 'p1', 'a-second', { updatedAt: '2026-11-07T09:00:00.000Z' }),
    task('b1', 'p2', 'b-main', { updatedAt: '2026-11-07T10:00:00.000Z' }),
  ];
  const model = graphSections({
    projects: [project('p1'), project('p2')],
    goals: [goal('a-main', 'p1', '目标一'), goal('a-second', 'p1', '目标二'), goal('b-main', 'p2', '目标三')],
    tasks,
  });
  assert.equal(model.mode, 'projects');
  assert.deepEqual(model.sections.map(section => section.id), ['p2', 'p1']);
  assert.deepEqual(model.sections[1].groups.map(group => group.goalId), ['a-second', 'a-main']);
  assert.deepEqual(model.sections[1].groups.flatMap(group => group.tasks.map(item => item.id)), ['a2', 'a1']);
  assert.equal(model.crossScope.length, 0);
});

test('graphSections reports cross-scope dependencies instead of drawing them', () => {
  const tasks = [
    task('a1', 'p1', 'g1'),
    task('b1', 'p2', 'g2', { dependencies: ['a1'] }),
  ];
  const model = graphSections({ projects: [project('p1'), project('p2')], goals: [goal('g1', 'p1'), goal('g2', 'p2')], tasks });
  assert.equal(model.crossScope.length, 1);
  assert.deepEqual(
    { task: model.crossScope[0].taskId, dependency: model.crossScope[0].dependencyId },
    { task: 'b1', dependency: 'a1' },
  );
});

test('cross-scope detection survives filters that hide the other side', () => {
  const all = [task('a1', 'p1', 'g1'), task('b1', 'p2', 'g2', { dependencies: ['a1'] })];
  const projects = [project('p1'), project('p2')];
  const goals = [goal('g1', 'p1'), goal('g2', 'p2')];
  const full = graphSections({ projects, goals, tasks: all, knownTasks: all });
  assert.equal(full.crossScope.length, 1);
  for (const filters of [{ projectId: 'p2' }, { goalId: 'g2' }]) {
    const filtered = graphSections({ projects, goals, tasks: [all[1]], knownTasks: all, ...filters });
    assert.equal(filtered.crossScope.length, 1, JSON.stringify(filters));
    assert.equal(filtered.crossScope[0].dependencyId, 'a1');
  }
  const sameGoal = [task('t1', 'p1', 'g1'), task('t2', 'p1', 'g1', { dependencies: ['t1'] })];
  const hiddenOnly = graphSections({ projects, goals, tasks: [sameGoal[1]], knownTasks: sameGoal, projectId: 'p1' });
  assert.equal(hiddenOnly.crossScope.length, 0);
});

test('hiddenDependencies surfaces filtered predecessors once, with titles when known', () => {
  const known = [task('t1', 'p1', 'g1', { title: '基础任务' }), task('t2', 'p1', 'g1', { dependencies: ['t1', 't1'], title: '依赖任务' })];
  const hidden = hiddenDependencies([known[1]], known);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].dependencyTitle, '基础任务');
  assert.equal(hidden[0].taskTitle, '依赖任务');
  assert.deepEqual(hiddenDependencies(known, known), []);
  const unknown = hiddenDependencies([task('t3', 'p1', 'g1', { dependencies: ['gone'] })], known);
  assert.equal(unknown[0].dependencyTitle, null);
});

test('graphLayout is deterministic regardless of input order and respects dependency depth', () => {
  const tasks = [
    task('t1', 'p1', 'g1', { status: 'ready' }),
    task('t2', 'p1', 'g1', { status: 'blocked', dependencies: ['t1'] }),
    task('t3', 'p1', 'g1', { status: 'ready' }),
  ];
  const forward = graphLayout(tasks);
  const reversed = graphLayout([...tasks].reverse());
  assert.deepEqual([...forward.positions.entries()], [...reversed.positions.entries()]);
  assert.equal(forward.levels.get('t1'), 0);
  assert.equal(forward.levels.get('t2'), 1);
  assert.equal(forward.positions.get('t2').x, forward.positions.get('t1').x + 300);
  assert.equal(forward.width, 700);
  assert.ok(forward.height >= 220);
});

test('graphLayout tolerates empty input and dependency cycles', () => {
  const empty = graphLayout([]);
  assert.equal(empty.positions.size, 0);
  assert.equal(empty.width, 700);
  assert.equal(empty.height, 220);
  const cyclic = [task('a', 'p1', 'g1', { dependencies: ['b'] }), task('b', 'p1', 'g1', { dependencies: ['a'] })];
  assert.doesNotThrow(() => graphLayout(cyclic));
});
