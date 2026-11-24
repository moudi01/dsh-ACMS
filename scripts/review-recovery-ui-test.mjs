import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startPreview } from './preview-server.mjs';
import { OWNER } from '../src/core/util.js';

// Issue #20 acceptance under the #25 review-subtask model: a cancelled task or
// goal review explains its state, keeps the delivered work untouched, and the
// owner can rebuild exactly one new review from the panel without rerunning work.
const server = await startPreview({ seed: false, startEngine: false });
const command = (name, args) => server.company.command(OWNER, randomUUID(), name, args);
const store = server.company.store;
const project = command('project.save', { name: '审查恢复项目', repoRoot: server.source, mode: 'copy', checks: [] });
const goal = command('goal.create', { projectId: project.id, title: '审查恢复目标', description: '交付一次', acceptance: '可恢复审查', plan: false });
const task = command('task.create', { goalId: goal.id, title: '已交付任务', description: '已交付', acceptance: '已验收', requiresArtifacts: false });
store.put('tasks', { ...store.require('tasks', task.id), status: 'succeeded', artifactHash: 'hash-task-v1', artifactIds: [], lastAuthorId: 'worker' });
const deliveryHash = server.company.deliveryHash(goal.id);
const taskReview = store.put('tasks', { id: 'task_cancelled_task_review', goalId: goal.id, projectId: project.id, title: '审查：已交付任务', description: '审查已交付成果', acceptance: '已验收', kind: 'review', status: 'cancelled', reviewScope: 'task', reviewOf: task.id, parentId: task.id, reviewArtifactHash: 'hash-task-v1', dependencies: [], cancelledAt: new Date().toISOString(), cancelledBy: 'owner', cancelReason: '重复请求，已取消', createdAt: new Date(Date.now() - 5000).toISOString(), updatedAt: new Date().toISOString() });
const goalReview = store.put('tasks', { id: 'task_cancelled_goal_review', goalId: goal.id, projectId: project.id, title: '最终审查：审查恢复目标', description: '目标整体交付审查', acceptance: '可恢复审查', kind: 'review', status: 'cancelled', reviewScope: 'goal', deliveryHash, dependencies: [], cancelledAt: new Date().toISOString(), cancelledBy: 'owner', cancelReason: '误操作取消', createdAt: new Date(Date.now() - 4000).toISOString(), updatedAt: new Date().toISOString() });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const modelRequests = [];
page.on('request', request => { if (/model-(check|details)/.test(request.url())) modelRequests.push(request.url()); });
await mkdir('test-results/ui', { recursive: true });
try {
  await page.goto(server.url);
  await page.locator('.acms-project-group').filter({ hasText: '审查恢复项目' }).locator('summary').first().click({ position: { x: 8, y: 8 } });
  const goalGroup = page.locator('.acms-goal-group').filter({ hasText: '审查恢复目标' });
  await goalGroup.locator('summary').first().click({ position: { x: 8, y: 8 } });
  await goalGroup.locator('summary .acms-entity-title').click();
  const goalDrawer = page.locator('aside.acms-drawer');
  await expect(goalDrawer.getByLabel('最终审查状态')).toContainText('已取消');
  await expect(goalDrawer.getByLabel('最终审查状态')).toContainText('误操作取消');
  await expect(goalDrawer.getByLabel('最终审查状态')).toContainText('所有者');
  await expect(goalDrawer.getByRole('button', { name: '重新发起最终审查' })).toBeVisible();
  await expect(goalDrawer.getByLabel('允许这次低风险审查比较等价模型费率')).toHaveCount(0);
  const beforeGoalReviews = store.list('tasks').filter(item => item.kind === 'review' && item.reviewScope === 'goal').length;
  await goalDrawer.getByRole('button', { name: '重新发起最终审查' }).click();
  await expect.poll(() => store.list('tasks').filter(item => item.kind === 'review' && item.reviewScope === 'goal' && item.status === 'ready').length).toBe(1);
  expect(store.list('tasks').filter(item => item.kind === 'review' && item.reviewScope === 'goal').length).toBe(beforeGoalReviews + 1);
  await expect(goalDrawer.getByLabel('最终审查状态')).toContainText('待执行');
  await page.getByRole('button', { name: '关闭详情' }).click();

  await page.getByRole('button', { name: '任务工作台', exact: true }).click();
  await page.getByRole('button', { name: /^已完成（/ }).click();
  await page.getByRole('button', { name: '已交付任务', exact: true }).click();
  const taskDrawer = page.locator('aside.acms-drawer');
  await expect(taskDrawer).toContainText('审查记录（1）');
  await expect(taskDrawer).toContainText('重复请求，已取消');
  await expect(taskDrawer.getByRole('button', { name: '重新发起审查' })).toBeVisible();
  const compareRates = taskDrawer.getByRole('checkbox', { name: '允许这次低风险审查比较等价模型费率' });
  await expect(compareRates).toBeVisible();
  await expect(compareRates).not.toBeChecked();
  await compareRates.check();
  store.transaction(() => {
    const source = store.require('tasks', task.id);
    store.put('tasks', { ...source, title: '已交付任务（第二版）', artifactHash: 'hash-task-v2', deliveryGeneration: 2 });
    store.event('task.changed', task.id, { fields: ['title', 'artifactHash', 'deliveryGeneration'] }, OWNER);
  });
  await expect(taskDrawer.getByRole('heading', { name: '已交付任务（第二版）', exact: true })).toBeVisible();
  await expect(compareRates).not.toBeChecked();
  await taskDrawer.getByRole('button', { name: '添加审查', exact: true }).click();
  const latestReadyReview = () => store.list('tasks').find(item => item.reviewOf === task.id && item.status === 'ready');
  await expect.poll(() => latestReadyReview()?.reviewArtifactHash).toBe('hash-task-v2');
  const defaultReview = latestReadyReview();
  expect(defaultReview.costRouting).toBeUndefined();
  command('task.cancel', { id: defaultReview.id });
  await expect(taskDrawer.getByRole('button', { name: '重新发起审查' })).toBeVisible();
  await expect(compareRates).not.toBeChecked();
  await compareRates.check();
  const beforeTaskReviews = store.list('tasks').filter(item => item.kind === 'review' && item.reviewOf === task.id).length;
  await taskDrawer.getByRole('button', { name: '重新发起审查' }).click();
  await expect.poll(() => store.list('tasks').filter(item => item.kind === 'review' && item.reviewOf === task.id && item.status === 'ready').length).toBe(1);
  expect(store.list('tasks').filter(item => item.kind === 'review' && item.reviewOf === task.id).length).toBe(beforeTaskReviews + 1);
  const activeTaskReview = store.list('tasks').find(item => item.reviewOf === task.id && item.status === 'ready');
  expect(activeTaskReview.costRouting).toBe(true);
  expect(activeTaskReview.reviewArtifactHash).toBe('hash-task-v2');
  expect(activeTaskReview.reviewedTaskGeneration).toBe(2);
  await expect(compareRates).toHaveCount(0);
  expect(store.require('tasks', task.id).status).toBe('succeeded');
  expect(store.require('tasks', taskReview.id).status).toBe('cancelled');
  expect(store.require('tasks', goalReview.id).status).toBe('cancelled');

  const waiting = command('goal.create', { projectId: project.id, title: '等待最终审查名额', description: '交付一次', acceptance: '需要最终审查', plan: false });
  const delivered = command('task.create', { goalId: waiting.id, title: '已保留的交付' });
  command('policy.update', { patch: { maxTasksPerGoal: 1 } });
  store.transaction(() => {
    store.put('tasks', { ...delivered, status: 'succeeded', artifactHash: 'waiting-delivery' });
    server.company.refreshGoal(waiting.id);
  });
  await page.reload();
  await page.locator('.acms-project-group').filter({ hasText: '审查恢复项目' }).locator('summary').first().click({ position: { x: 8, y: 8 } });
  await page.locator('.acms-goal-group').filter({ hasText: '等待最终审查名额' }).locator('summary .acms-entity-title').click();
  const waitingReview = goalDrawer.getByLabel('最终审查状态');
  await expect(waitingReview.getByRole('status')).toContainText('已用 1 项，上限 1 项');
  await expect(waitingReview.getByRole('status')).toContainText('公司设置 → 编辑边界');
  await expect(waitingReview.getByRole('button', { name: '发起最终审查' })).toBeDisabled();
  expect(store.require('tasks', delivered.id).status).toBe('succeeded');
  expect(server.adapter.calls.length).toBe(0);
  expect(modelRequests).toEqual([]);
  expect(errors).toEqual([]);
  const report = { passed: true, checked: ['cancelled goal review state and rebuild entry', 'cancelled task review state and rebuild entry', 'rate opt-in resets when the displayed delivery changes and can be reconfirmed', 'delivered work unchanged', 'goal review explains capacity and where to adjust it', 'zero model calls or model inspection requests'], goalId: goal.id, taskId: task.id };
  await writeFile('test-results/ui/review-recovery-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('Browser errors:', errors);
  await page.screenshot({ path: 'test-results/ui/review-recovery-failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
