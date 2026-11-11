import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startPreview } from './preview-server.mjs';
import { OWNER, SYSTEM } from '../src/core/util.js';

// Issue #18 acceptance: the activity log shows who created, blocked, reviewed and
// completed work, links every entry back to its subject, filters by project/goal/
// task, pages older business events without duplicates, and never shows polling
// or heartbeat noise. Deterministic fixtures only; no model calls are started.
const server = await startPreview({ seed: true, startEngine: false });
const command = (name, args) => server.company.command(OWNER, randomUUID(), name, args);
const store = server.company.store;
const iso = offset => new Date(Date.now() + offset).toISOString();
const insertEvent = (at, type, entityId, goalId, { actor = 'scheduler', principalKind = 'system', onBehalfOf = null, body = {} } = {}) =>
  store.db.prepare('INSERT INTO events(at,type,entity_id,goal_id,actor,principal_kind,on_behalf_of,body) VALUES (?,?,?,?,?,?,?,?)')
    .run(at, type, entityId, goalId, actor, principalKind, onBehalfOf ? JSON.stringify(onBehalfOf) : null, JSON.stringify(body));

try {
  const initial = server.company.snapshot();
  const projectId = initial.projects[0].id;
  const goal = initial.goals[0];
  const seeded = initial.tasks.filter(task => task.goalId === goal.id);
  const blockedTask = seeded.find(task => task.title.includes('品牌素材')) ?? seeded.at(-1);
  const reviewedTask = seeded.find(task => task.id !== blockedTask.id) ?? seeded[0];
  const pendingTask = seeded.find(task => ![blockedTask.id, reviewedTask.id].includes(task.id));

  // Older business events first, so the first page is bounded and "load older"
  // has real work to reveal without pushing the newest fixtures off the page.
  for (let index = 0; index < 60; index += 1) insertEvent(iso(-9_000_000 + index * 1000), 'task.changed', reviewedTask.id, goal.id, { body: { fields: ['description'] } });

  server.engine.block(blockedTask, 'human', '当前没有可用的品牌文件。', '请提供品牌素材，或确认沿用默认样式。');
  const interaction = server.company.snapshot().interactions.find(item => item.taskId === blockedTask.id && item.status === 'pending');
  command('interaction.answer', { id: interaction.id, answer: '沿用默认样式。', expectedRevision: interaction.revision });
  if (pendingTask) server.engine.block(pendingTask, 'human', '需要确认交付范围：{\\"token\\":\\"FAKE,UI}SECRET\\"}', '请确认本次交付范围。');
  const longReasonTask = command('task.create', { goalId: goal.id, title: '长原因任务' });
  server.engine.block(longReasonTask, 'human', `${'说明'.repeat(240)}{"password":"abcFAKE_LONG_SECRET`, '请确认长原因任务。');

  const review = store.put('tasks', { id: 'task_review_demo', goalId: goal.id, projectId, title: `审查：${reviewedTask.title}`, description: '', acceptance: '', kind: 'review', status: 'succeeded', reviewOf: reviewedTask.id, dependencies: [], createdAt: iso(-30_000) });
  insertEvent(iso(-20_000), 'review.decided', review.id, goal.id, { actor: 'reviewer', principalKind: 'agent', body: { taskId: reviewedTask.id, scope: 'task', decision: 'approve', artifactHash: 'a'.repeat(64), actorRole: 'reviewer', actorName: '质量审查员' } });
  insertEvent(iso(-15_000), 'goal.submitted', goal.id, goal.id, { actor: 'credential_demo', principalKind: 'user-agent', onBehalfOf: { kind: 'owner', id: 'owner' }, body: {} });
  insertEvent(iso(-10_000), 'attempt.failed', 'attempt_demo', goal.id, { body: { taskId: reviewedTask.id, code: 'PROVIDER_FAILED', message: 'Authorization: Basic RkFLRV9TRUNSRVQ=' } });

  const doneGoal = command('goal.create', { projectId, title: '已交付目标', description: '已交付', acceptance: '已交付', plan: false });
  const doneTask = command('task.create', { goalId: doneGoal.id, title: '已交付示例' });
  const artifactDir = path.join(server.dataDir, 'artifacts'); await mkdir(artifactDir, { recursive: true });
  const artifactBlob = path.join(artifactDir, 'delivered-demo'); await writeFile(artifactBlob, 'delivered demo content');
  store.put('artifacts', { id: 'artifact_delivered', taskId: doneTask.id, attemptId: 'attempt_demo_done', path: 'deliverable.txt', title: '交付文件', hash: 'd'.repeat(64), bytes: 22, blob: artifactBlob });
  store.put('tasks', { ...store.require('tasks', doneTask.id), status: 'succeeded', artifactHash: 'd'.repeat(64), artifactIds: ['artifact_delivered'] });
  store.put('goals', { ...store.require('goals', doneGoal.id), status: 'succeeded', completedContractVersion: 1, completedDeliveryHash: 'b'.repeat(64) });
  insertEvent(iso(-5_000), 'goal.succeeded', doneGoal.id, doneGoal.id, { body: { from: 'active', status: 'succeeded', contractVersion: 1, deliveryHash: 'b'.repeat(64), delivery: [{ id: doneTask.id, title: '已交付示例', artifactHash: 'd'.repeat(64), artifactIds: ['artifact_delivered'], generation: 1, contractVersion: 1 }], review: { taskId: 'task_review_demo', passed: true, deliveryHash: 'stale' } } });

  const secondProject = command('project.save', { name: '第二项目 token=FAKE_OPTION_SECRET', repoRoot: server.source, mode: 'copy' });
  const secondGoal = command('goal.create', { projectId: secondProject.id, title: '第二目标', description: '第二目标', acceptance: '第二目标', plan: false });
  command('task.create', { goalId: secondGoal.id, title: '第二任务' });

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await mkdir('test-results/ui', { recursive: true });
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: '动态日志', exact: true }).click();
    await expect(page.getByRole('heading', { name: '动态日志', exact: true })).toBeVisible();
    await expect(page.locator('.acms-activity-entry').first()).toBeVisible();
    await expect(page.getByLabel('筛选动态项目')).not.toContainText('FAKE_OPTION_SECRET');
    await expect(page.getByLabel('筛选动态项目')).toContainText('已隐藏');

    // 1. Blocking records the scheduler, the executor and the concrete reason.
    const blockedEntry = page.locator('.acms-activity-entry').filter({ hasText: `任务「${blockedTask.title}」已阻塞` }).first();
    await expect(blockedEntry).toBeVisible();
    await expect(blockedEntry.locator('.acms-activity-actor')).toHaveText('调度器');
    await expect(blockedEntry).toContainText('当前没有可用的品牌文件');
    await expect(blockedEntry).toContainText(`执行者`);

    // 1b. A still-pending blocker offers a direct reply entry from the log.
    const longEntry = page.locator('.acms-activity-entry').filter({ hasText: '长原因任务」已阻塞' }).first();
    await expect(longEntry).toBeVisible();
    await expect(longEntry).not.toContainText('FAKE_LONG_SECRET');
    await expect(longEntry).toContainText('已隐藏');
    if (pendingTask) {
      const pendingEntry = page.locator('.acms-activity-entry').filter({ hasText: `任务「${pendingTask.title}」已阻塞` }).first();
      await expect(pendingEntry).toBeVisible();
      await expect(pendingEntry).toContainText('待你回复');
      await expect(pendingEntry).not.toContainText('FAKE,UI}SECRET');
      await expect(pendingEntry).toContainText('已隐藏');
      await pendingEntry.getByRole('button', { name: '回复待处理问题 →' }).click();
      await expect(page.getByRole('dialog')).toContainText('回复阻塞问题');
      await page.getByRole('button', { name: '关闭对话框' }).click();
    }

    // 2. The owner reply is attributed to the owner, not to the scheduler.
    await page.getByRole('button', { name: '刷新动态', exact: true }).click();
    const answeredEntry = page.locator('.acms-activity-entry').filter({ hasText: `回复了任务「${blockedTask.title}」的待处理问题` }).first();
    await expect(answeredEntry).toBeVisible();
    await expect(answeredEntry.locator('.acms-activity-actor')).toHaveText('所有者');

    // 3. Review conclusions, external submissions and failed executions are explicit.
    const reviewEntry = page.locator('.acms-activity-entry').filter({ hasText: `审查通过：任务「${reviewedTask.title}」` }).first();
    await expect(reviewEntry).toBeVisible();
    await expect(reviewEntry.locator('.acms-activity-actor')).toHaveText('审查者 · 质量审查员');
    const externalEntry = page.locator('.acms-activity-entry').filter({ hasText: '外部智能体代表所有者提交了目标' }).first();
    await expect(externalEntry).toBeVisible();
    await expect(externalEntry.locator('.acms-activity-actor')).toHaveText('外部智能体（代表所有者）');
    const failedEntry = page.locator('.acms-activity-entry').filter({ hasText: '执行失败' }).first();
    await expect(failedEntry).toBeVisible();
    await expect(failedEntry).not.toContainText('RkFLRV9TRUNSRVQ');
    await expect(failedEntry).toContainText('已隐藏');

    // 3b. Goal completion keeps the delivered version and exposes per-delivery evidence.
    const completedEntry = page.locator('.acms-activity-entry').filter({ hasText: '目标「已交付目标」完成（交付版本 1）' }).first();
    await expect(completedEntry).toBeVisible();
    await expect(completedEntry).toContainText('交付证据');
    await expect(completedEntry).toContainText('历史审查记录与当次交付不一致');
    await expect(completedEntry.getByRole('button', { name: '查看当次审查记录 →' })).toHaveCount(0);
    await expect(completedEntry.getByRole('button', { name: /打开任务/ })).toHaveCount(0);
    const artifactButton = completedEntry.getByRole('button', { name: /打开产物「交付文件」/ }).first();
    await expect(artifactButton).toBeVisible();
    await artifactButton.click();
    await expect(page.getByRole('dialog')).toContainText('交付文件');
    await expect(page.getByRole('dialog')).toContainText('delivered demo content');
    await page.getByRole('button', { name: '关闭', exact: true }).click();

    // 4. Technical details expand on demand and stay bounded.
    await reviewEntry.locator('summary').click();
    await expect(reviewEntry.locator('pre')).toBeVisible();
    await expect(reviewEntry.locator('pre')).toContainText('decision');

    // 5. Project, goal and task filters all use the same durable cursors.
    await page.getByLabel('筛选动态项目').selectOption(secondProject.id);
    await expect(page.locator('.acms-activity-entry').filter({ hasText: '创建了目标「第二目标」' }).first()).toBeVisible();
    await expect(page.locator('.acms-activity-entry').filter({ hasText: `任务「${blockedTask.title}」已阻塞` })).toHaveCount(0);
    await page.getByLabel('筛选动态项目').selectOption(projectId);
    await page.getByLabel('筛选动态目标').selectOption(goal.id);
    await page.getByLabel('筛选动态任务').selectOption(blockedTask.id);
    await expect(page.locator('.acms-activity-entry').filter({ hasText: `任务「${blockedTask.title}」已阻塞` }).first()).toBeVisible();
    await expect(page.locator('.acms-activity-entry').filter({ hasText: `审查通过：任务「${reviewedTask.title}」` })).toHaveCount(0);

    // 6. Older business events page in without duplicates.
    await page.getByLabel('筛选动态任务').selectOption('');
    await expect.poll(async () => page.locator('.acms-activity-entry').count()).toBe(50);
    await page.getByRole('button', { name: '加载更早的动态', exact: true }).click();
    await expect.poll(async () => page.locator('.acms-activity-entry').count()).toBeGreaterThan(50);
    const sequenceIds = await page.locator('.acms-activity-entry .acms-activity-head > span.acms-muted').allTextContents();
    expect(new Set(sequenceIds).size).toBe(sequenceIds.length);

    // 6b. Events that arrive while the log is open are drained automatically.
    const beforeSync = await page.locator('.acms-activity-entry').count();
    store.transaction(() => { for (let index = 0; index < 3; index += 1) store.event('task.changed', reviewedTask.id, { fields: ['description'] }, SYSTEM); });
    await expect.poll(async () => page.locator('.acms-activity-entry').count(), { timeout: 15000 }).toBeGreaterThan(beforeSync);

    // 7. Reload rebuilds the same visible history from the database.
    await page.reload();
    await page.getByRole('button', { name: '动态日志', exact: true }).click();
    await expect.poll(async () => page.locator('.acms-activity-entry').count()).toBe(50);
    const afterReload = await page.locator('.acms-activity-entry .acms-activity-head > span.acms-muted').allTextContents();
    expect(new Set(afterReload).size).toBe(afterReload.length);

    expect(server.adapter.calls.length).toBe(0);
    const report = { passed: true, checked: ['scheduler/owner/reviewer/external-agent attribution', 'blocked reason and executor', 'review conclusion', 'failed execution', 'expandable redacted details', 'project/goal/task filters', 'bounded first page and older paging without duplicates', 'reload keeps the same durable history', 'zero model calls'], projectId, goalId: goal.id, errors };
    await writeFile('test-results/ui/activity-report.json', JSON.stringify(report, null, 2));
    expect(errors).toEqual([]);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('Browser errors:', errors);
    await page.screenshot({ path: 'test-results/ui/activity-failure.png', fullPage: true });
    throw error;
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
