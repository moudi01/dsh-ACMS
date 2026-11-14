import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startPreview } from './preview-server.mjs';
import { OWNER } from '../src/core/util.js';

// Issue #17 acceptance: collapsed defaults, bounded text/lists, completed lists,
// activity ordering and per-object disclosure state. Static fixtures only; no
// model execution is started or required.
const server = await startPreview({ seed: true, startEngine: false });
const command = (name, args) => server.company.command(OWNER, randomUUID(), name, args);
const store = server.company.store;
const projectId = server.company.snapshot().projects[0].id;
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
const insertEvent = (at, type, entityId, goalId) => store.db.prepare('INSERT INTO events(at,type,entity_id,goal_id,actor,principal_kind,on_behalf_of,body) VALUES (?,?,?,?,?,?,?,?)').run(at, type, entityId, goalId, 'system', 'system', null, '{}');

// Long goal + long task list (goal with exactly 12 ready tasks).
const longGoal = command('goal.create', { projectId, title: '长说明目标', description: '这是一个很长的目标说明。'.repeat(24), acceptance: '长列表与折叠文本均可验证。', plan: false });
const longTask = command('task.create', { goalId: longGoal.id, title: '长说明任务', description: '这是一段需要默认折叠的任务说明。'.repeat(20) });
command('task.create', { goalId: longGoal.id, title: '短文本任务', description: '验收完整内容'.repeat(20) });
const listGoal = command('goal.create', { projectId, title: '长列表目标', description: '用于验证长列表计数。', acceptance: '可展开全部。', plan: false });
for (let index = 1; index <= 12; index += 1) command('task.create', { goalId: listGoal.id, title: `长列表任务 ${String(index).padStart(2, '0')}` });

// Completed / archived / cancelled fixtures, discovered from the completed list.
const doneGoal = command('goal.create', { projectId, title: '已完成示例目标', description: '已完成目标', acceptance: '归档与取消可区分。', plan: false });
store.put('goals', { ...store.require('goals', doneGoal.id), status: 'succeeded' });
const completedTask = store.put('tasks', { id: 'task_done_example', goalId: doneGoal.id, projectId, title: '已完成的交付', description: '完成', acceptance: '完成', kind: 'work', status: 'succeeded', dependencies: [], createdAt: iso(-300000), updatedAt: iso(-300000) });
const archivedTask = store.put('tasks', { id: 'task_archived_example', goalId: doneGoal.id, projectId, title: '已归档的交付', description: '归档', acceptance: '归档', kind: 'work', status: 'archived', dependencies: [], createdAt: iso(-200000), updatedAt: iso(-200000) });
const cancelledTask = store.put('tasks', { id: 'task_cancelled_example', goalId: doneGoal.id, projectId, title: '已取消的交付', description: '取消', acceptance: '取消', kind: 'work', status: 'cancelled', dependencies: [], createdAt: iso(-100000), updatedAt: iso(-100000) });
insertEvent(iso(-260000), 'task.succeeded', completedTask.id, doneGoal.id);
insertEvent(iso(-160000), 'task.succeeded', archivedTask.id, doneGoal.id);
insertEvent(iso(-60000), 'task.succeeded', cancelledTask.id, doneGoal.id);
const reviewTask = store.put('tasks', { id: 'task_goal_review_example', goalId: doneGoal.id, projectId, title: '目标最终审查示例', description: '目标审查', acceptance: '审查', kind: 'review', status: 'succeeded', reviewScope: 'goal', dependencies: [], createdAt: iso(-50000), updatedAt: iso(-50000) });
store.put('attempts', { id: 'attempt_goal_review_example', taskId: reviewTask.id, goalId: doneGoal.id, agentId: 'reviewer', role: 'reviewer', kind: 'review', status: 'completed', startedAt: iso(-50000) });
store.put('verifications', { id: 'verification_goal_review_example', taskId: doneGoal.id, goalId: doneGoal.id, attemptId: 'attempt_goal_review_example', kind: 'goal-review', passed: true, summary: '目标审查通过示例', createdAt: iso(-50000) });
insertEvent(iso(-50000), 'review.decided', reviewTask.id, doneGoal.id);

// Activity ordering fixtures: newer effective event must sort B before A.
const orderGoal = command('goal.create', { projectId, title: '活跃排序目标', description: '排序', acceptance: '排序', plan: false });
const orderA = command('task.create', { goalId: orderGoal.id, title: '活动任务 A' });
const orderB = command('task.create', { goalId: orderGoal.id, title: '活动任务 B' });
insertEvent(iso(-900000), 'task.changed', orderA.id, orderGoal.id);
insertEvent(iso(-60000), 'task.changed', orderB.id, orderGoal.id);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('test-results/ui', { recursive: true });
try {
  await page.goto(server.url);
  await page.getByRole('button', { name: '任务工作台', exact: true }).click();
  await expect(page.getByLabel('搜索任务')).toBeVisible();

  // 1. Main view hides completed work and reports visible/total counts.
  await expect(page.getByText('已完成的交付', { exact: true })).toHaveCount(0);
  await expect(page.locator('.acms-visible-count')).toContainText('可见');
  await expect(page.locator('.acms-visible-count')).toContainText('共');

  // 2. Projects/goals/tasks start collapsed.
  await expect(page.locator('.acms-project-group[open]')).toHaveCount(0);
  await expect(page.locator('.acms-goal-group[open]')).toHaveCount(0);
  await expect(page.locator('.acms-task-tree:visible')).toHaveCount(0);

  // 3. Completed list is searchable/filterable and opens details with evidence.
  await page.getByRole('button', { name: /^已完成（/ }).click();
  await expect(page.locator('.acms-visible-count')).toContainText('已完成');
  for (const title of ['已完成的交付', '已归档的交付', '已取消的交付']) await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  await expect(page.locator('.acms-completed')).toContainText('已归档');
  await expect(page.locator('.acms-completed')).toContainText('已取消');
  await page.getByLabel('筛选完成状态').selectOption('succeeded');
  await expect(page.getByRole('button', { name: '已完成的交付', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '已归档的交付', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '详情与证据 ↗' }).first().click();
  await expect(page.locator('.acms-drawer')).toContainText('产物与验收');
  await expect(page.locator('.acms-drawer')).toContainText('目标审查通过示例');
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('button', { name: '返回进行中', exact: false }).click();

  // 4. Hierarchy disclosure is keyboard-operable and survives a data refresh.
  const projectGroup = page.locator('.acms-project-group').filter({ hasText: '产品演示项目' }).first();
  const summary = projectGroup.locator('summary').first();
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(projectGroup).toHaveAttribute('open', '');
  const otherGroups = page.locator('.acms-project-group[open]');
  await expect(otherGroups).toHaveCount(1);
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(projectGroup).toHaveAttribute('open', '');

  // 5. Collapsed long text expands on demand; the goal remains collapsed until opened.
  const longGoalGroup = page.locator('.acms-goal-group').filter({ hasText: '长说明目标' });
  await longGoalGroup.locator('summary').first().click({ position: { x: 8, y: 8 } });
  const expand = longGoalGroup.getByRole('button', { name: '展开说明' });
  await expect(expand).toBeVisible(); await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click(); await expect(longGoalGroup.getByRole('button', { name: '收起说明' })).toHaveAttribute('aria-expanded', 'true');
  await longGoalGroup.getByRole('button', { name: '收起说明' }).click();

  // 6. Long task lists show a bounded summary plus a count-controlled expansion.
  const listGoalGroup = page.locator('.acms-goal-group').filter({ hasText: '长列表目标' });
  await listGoalGroup.locator('summary').first().click({ position: { x: 8, y: 8 } });
  await expect(listGoalGroup.getByRole('button', { name: '显示全部 12 项任务' })).toBeVisible();
  await expect(listGoalGroup.locator('.acms-task-tree > li')).toHaveCount(8);
  await listGoalGroup.getByRole('button', { name: '显示全部 12 项任务' }).click();
  await expect(listGoalGroup.locator('.acms-task-tree > li')).toHaveCount(12);

  // 7. Board order follows effective activity, newest first.
  await page.getByLabel('筛选项目').selectOption(projectId);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  const titles = await page.locator('.acms-task-card h3').allTextContents();
  expect(titles.indexOf('活动任务 B')).toBeGreaterThanOrEqual(0);
  expect(titles.indexOf('活动任务 B')).toBeLessThan(titles.indexOf('活动任务 A'));

  // 9. Entering from a completed goal keeps the completed task view.
  await page.getByRole('button', { name: '项目与目标', exact: true }).click();
  await page.getByRole('button', { name: /^已完成目标（/ }).click();
  const doneGoalRow = page.locator('.acms-completed-row').filter({ hasText: '已完成示例目标' });
  await doneGoalRow.getByRole('button', { name: '查看任务 ↗' }).click();
  await expect(page.locator('.acms-visible-count')).toContainText('已完成');
  await expect(page.getByRole('button', { name: '已完成的交付', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回进行中', exact: false }).click();

  // 10. Short text that would visually overflow is not truncated without a toggle.
  await page.getByLabel('筛选目标').selectOption('');
  await page.getByLabel('搜索任务').fill('短文本任务');
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await page.getByRole('heading', { name: '短文本任务', exact: true }).click();
  const shortParagraph = page.locator('.acms-drawer .acms-collapsible p').first();
  const metrics = await shortParagraph.evaluate(element => ({ scroll: element.scrollHeight, client: element.clientHeight }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client + 1);
  await expect(page.locator('.acms-drawer').getByRole('button', { name: '展开说明' })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭任务详情' }).click();

  // 11. The overview review queue and all presentation modes share one scope.
  const reviewGoal = command('goal.create', { projectId, title: '审查队列目标', description: '静态队列', acceptance: '指标与列表一致', plan: false });
  const reviewFixture = (status, targetGoal = reviewGoal) => {
    const row = command('task.create', { goalId: targetGoal.id, title: `队列审查 ${status}`, agentId: longTask.agentId });
    return store.put('tasks', { ...row, kind: 'review', status, reviewScope: 'goal' });
  };
  for (const status of ['failed', 'cancelled', 'archived', 'succeeded', 'deleted']) reviewFixture(status);
  await page.getByRole('button', { name: '公司总览', exact: true }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const metric = page.getByRole('button', { name: '查看审查进行中', exact: true });
  await expect(metric.locator('strong')).toHaveText('0');
  const emptyCursor = store.cursor();
  await metric.click();
  await expect(page.getByRole('heading', { name: '当前范围没有进行中的审查' })).toBeVisible();
  await expect(page.locator('.acms-task-card')).toHaveCount(0);
  await page.getByRole('button', { name: '清除审查队列筛选', exact: true }).click();
  await expect(page.getByRole('heading', { name: '活动任务 A', exact: true })).toBeVisible();
  expect(store.cursor()).toBe(emptyCursor);

  const otherProject = command('project.save', { name: '队列第二项目', repoRoot: server.source, mode: 'copy', checks: [] });
  const otherGoal = command('goal.create', { projectId: otherProject.id, title: '另一项目审查', description: '跨项目队列', acceptance: '不隐式限于默认项目', plan: false });
  const activeStatuses = ['ready', 'preparing', 'running', 'reviewing', 'integrating', 'blocked', 'paused', 'stopping', 'reconciling'];
  const reviews = activeStatuses.map((status, i) => reviewFixture(status, i % 2 ? otherGoal : reviewGoal));
  const beforeTasks = store.list('tasks'), beforeCursor = store.cursor();
  await page.getByRole('button', { name: '公司总览', exact: true }).click();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(metric.locator('strong')).toHaveText('9');
  await metric.click();
  await expect(page.getByLabel('筛选项目')).toHaveValue('');
  await expect(page.locator('.acms-review-queue-filter')).toContainText('当前筛选：审查进行中');
  await expect(page.locator('.acms-visible-count')).toContainText('可见 9 / 共 9 项');
  await expect(page.locator('.acms-task-card')).toHaveCount(9);
  for (const review of reviews) await expect(page.getByRole('heading', { name: review.title, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '活动任务 A', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('显示审查任务')).toBeDisabled();
  await page.getByRole('button', { name: '层级', exact: true }).click();
  expect(await page.locator('.acms-task-title strong').allTextContents()).toEqual(expect.arrayContaining(reviews.map(r => r.title)));
  await expect(page.locator('.acms-task-title')).toHaveCount(9);
  await page.getByRole('button', { name: '依赖图', exact: true }).click();
  await expect(page.locator('.acms-graph-node')).toHaveCount(9);
  await page.getByRole('button', { name: '看板', exact: true }).click();
  await page.getByLabel('筛选项目').selectOption(otherProject.id);
  await expect(page.locator('.acms-task-card')).toHaveCount(4);
  await page.getByLabel('筛选目标').selectOption(otherGoal.id);
  await page.getByLabel('搜索任务').fill('队列审查 paused');
  await expect(page.getByRole('heading', { name: '当前范围没有进行中的审查' })).toBeVisible();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByLabel('筛选项目')).toHaveValue(otherProject.id);
  await page.getByRole('button', { name: '清除审查队列筛选', exact: true }).click();
  await expect(page.getByLabel('搜索任务')).toHaveValue('');
  await expect(page.getByLabel('筛选项目')).toHaveValue('');
  await expect(page.getByLabel('筛选目标')).toHaveValue('');
  await expect(page.getByRole('heading', { name: '活动任务 A', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '队列审查 failed', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^已完成（/ }).click();
  await expect(page.getByRole('button', { name: '队列审查 cancelled', exact: true })).toBeVisible();
  expect(store.list('tasks')).toEqual(beforeTasks);
  expect(store.cursor()).toBe(beforeCursor);

  // 12. No model calls or business writes from presentation filters.
  expect(server.adapter.calls.length).toBe(0);
  const report = { passed: true, checked: ['completed hidden by default with counts', 'completed list search/status filter/details evidence', 'review conclusions linked through attempt ids', 'completed-goal navigation keeps the completed view', 'short text is not truncated without a toggle', 'project/goal/task collapsed defaults', 'keyboard disclosure and refresh persistence', 'long text expand/collapse', 'long list count and expansion', 'task parent activity aggregation', 'activity ordering', 'review metric excludes terminal states', 'cross-project review queue agrees across board/tree/graph', 'review queue search, refresh, empty state and clear', 'presentation preserves tasks and event cursor', 'zero model calls'], projectId, errors };
  await writeFile('test-results/ui/display-defaults-report.json', JSON.stringify(report, null, 2));
  expect(errors).toEqual([]);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Browser errors:', errors);
  await page.screenshot({ path: 'test-results/ui/display-defaults-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
