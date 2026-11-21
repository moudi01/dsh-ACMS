import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startPreview } from './preview-server.mjs';

const server = await startPreview({ seed: false });
const command = (name, args) => server.company.command({ kind: 'owner', id: 'owner' }, crypto.randomUUID(), name, args);
command('company.pause', {});
const project = command('project.save', { name: '层级演示项目', repoRoot: server.source, mode: 'copy' });
const goal = command('goal.create', { projectId: project.id, title: '清楚的交付目标', description: '层级测试', acceptance: '层级关系正确', plan: false });
const parent = command('task.create', { goalId: goal.id, title: '父任务示例' });
const child = command('task.create', { goalId: goal.id, parentId: parent.id, title: '子任务示例' });
const nested = command('task.create', { goalId: goal.id, parentId: child.id, title: '下一级任务' });
const emptyGoal = command('goal.create', { projectId: project.id, title: '已删除规划的目标', description: '仅保留目标', acceptance: 'Fixture' });
const deleted = server.company.store.list('tasks').find(t => t.goalId === emptyGoal.id); command('task.delete', { id: deleted.id });
const anotherRoot = path.join(server.root, 'other-project');
await mkdir(anotherRoot);
const anotherProject = command('project.save', { name: '另一项目', repoRoot: anotherRoot, mode: 'copy' });
const anotherGoal = command('goal.create', { projectId: anotherProject.id, title: '另一个目标', description: 'Fixture', acceptance: 'Fixture', plan: false });
const anotherTask = command('task.create', { goalId: anotherGoal.id, title: '另一项目的任务' });
const store = server.company.store;
function completedAttempt(task, sequence, extra = {}) {
  return store.put('attempts', { id: task.id + '-attempt-' + sequence, taskId: task.id, goalId: task.goalId,
    agentId: 'manager', status: 'completed', startedAt: '2026-01-02T03:04:00.000Z',
    summary: '历史证据 ' + task.title + ' #' + sequence, ...extra });
}
store.transaction(() => {
  completedAttempt(parent, 0, { status: 'reconciling', cleanupPending: true, recovery: { reason: '旧执行待核对' } });
  for (let sequence = 1; sequence < 34; sequence++) completedAttempt(parent, sequence);
  completedAttempt(nested, 0);
  completedAttempt(anotherTask, 0);
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = []; const diagnostics = []; const historyReads = []; const eventReads = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (/model-(details|check)/.test(url.pathname)) diagnostics.push(request.url());
  if (url.pathname === '/api/acms/task-attempts') historyReads.push(url.searchParams);
  if (url.pathname === '/api/acms/events') eventReads.push(Number(url.searchParams.get('after')));
});
async function pauseRead(match, beforeRead = false) {
  const release = Promise.withResolvers();
  let reached = false, finished = false;
  await page.route(match, async route => {
    if (beforeRead) { reached = true; await release.promise; }
    const response = await route.fetch();
    if (!beforeRead) { reached = true; await release.promise; }
    try { await route.fulfill({ response }); } catch {
      // Chromium can abort this request when the drawer scope or version changes.
    } finally { finished = true; }
  }, { times: 1 });
  return { wait: () => expect.poll(() => reached).toBe(true),
    finish: async () => { release.resolve(); await expect.poll(() => finished).toBe(true); } };
}
const pauseHistory = (taskId, older) => pauseRead(url => url.pathname === '/api/acms/task-attempts' &&
  url.searchParams.get('taskId') === taskId && url.searchParams.has('before') === older);
const pausePanel = beforeRead => pauseRead(url => url.pathname === '/api/acms/state', beforeRead);
try {
  await mkdir('test-results/ui', { recursive: true }); await page.goto(server.url);
  await expect(page.getByLabel('项目目标层级')).toContainText('层级演示项目');
  const expand = async title => { const button = page.getByRole('button', { name: new RegExp(`“${title}”的子任务`) }); if (await button.getAttribute('aria-expanded') !== 'true') await button.click(); };
  const projectGroup = page.locator('.acms-project-group').filter({ hasText: '层级演示项目' });
  await projectGroup.locator('summary').first().click({ position: { x: 8, y: 8 } });
  const group = page.locator('.acms-goal-group').filter({ hasText: '清楚的交付目标' });
  await group.locator('summary').first().click({ position: { x: 8, y: 8 } });
  await expect(group.locator('.acms-task-tree')).toContainText('父任务示例');
  await expand('父任务示例'); await expand('子任务示例');
  await expect(group.locator('.acms-task-tree')).toContainText('下一级任务');
  await expect(page.getByText(deleted.title, { exact: true })).toHaveCount(0);
  const emptyGroup = page.locator('.acms-goal-group').filter({ hasText: emptyGoal.title });
  await emptyGroup.locator('summary').first().click({ position: { x: 8, y: 8 } });
  await expect(emptyGroup).toContainText('暂无任务');
  await group.getByRole('button', { name: '查看此目标的任务 →' }).click();
  await expect(page.getByLabel('筛选目标')).toHaveValue(goal.id); await expect(page.getByLabel('筛选项目')).toHaveValue(project.id);
  expect(historyReads).toHaveLength(0);
  await expand('父任务示例'); await expand('子任务示例');
  const nestedHistory = await pauseHistory(nested.id, false);
  await page.getByRole('button', { name: /子任务 下一级任务/ }).click();
  await nestedHistory.wait();
  await expect(page.getByLabel('任务详情').getByLabel('任务归属')).toContainText('父任务：父任务示例');
  await expect(page.getByLabel('任务详情').getByLabel('任务归属')).toContainText('父任务：子任务示例');
  await page.getByRole('button', { name: /父任务：父任务示例$/ }).click(); await expect(page.getByRole('heading', { name: '父任务示例', exact: true })).toBeVisible();
  const details = page.getByLabel('任务详情');
  await expect(details.locator('.acms-run')).toHaveCount(30);
  await nestedHistory.finish();
  await expect(details.locator('.acms-run')).toHaveCount(30);
  const oldPage = await pauseHistory(parent.id, true);
  await details.getByRole('button', { name: '加载更早的执行记录' }).click();
  await oldPage.wait();
  store.transaction(() => {
    completedAttempt(parent, 34, { status: 'running', progress: { lastSnippet: '原始执行进度' } });
    store.event('attempt.finished', parent.id, {}, { kind: 'system', id: 'scheduler' });
  });
  await expect(details.locator('.acms-run')).toHaveCount(30);
  await expect(details.locator('.acms-run').first()).toContainText('历史证据 父任务示例 #34');
  await details.locator('.acms-run').first().locator('summary').click();
  await expect(details.getByText('历史证据 父任务示例 #34', { exact: true })).toBeVisible();
  await oldPage.finish();
  await expect(details.locator('.acms-run')).toHaveCount(30);
  await details.getByRole('button', { name: '加载更早的执行记录' }).click();
  await expect(details.locator('.acms-run')).toHaveCount(35);
  await details.locator('.acms-run').last().locator('summary').click();
  await expect(details.getByText('历史证据 父任务示例 #0', { exact: true })).toBeVisible();
  const readsBeforeProgress = historyReads.length;
  const parentRevisionBeforeProgress = store.require('tasks', parent.id).revision;
  store.transaction(() => {
    const running = store.require('attempts', parent.id + '-attempt-34');
    store.put('attempts', { ...running, progress: { lastSnippet: '收到新的执行进度' } });
    store.event('attempt.progress', running.id, { taskId: parent.id }, { kind: 'system', id: 'scheduler' });
  });
  expect(store.require('tasks', parent.id).revision).toBe(parentRevisionBeforeProgress);
  await expect(details.getByText('收到新的执行进度', { exact: true })).toBeVisible();
  await expect(details.locator('.acms-run')).toHaveCount(35);
  await expect(details.getByText('历史证据 父任务示例 #0', { exact: true })).toBeVisible();
  expect(historyReads.slice(readsBeforeProgress).map(query => query.has('before'))).toEqual([false]);

  const oldestId = parent.id + '-attempt-0';
  store.transaction(() => {
    const prior = store.require('attempts', oldestId);
    store.put('attempts', { ...prior, status: 'completed', cleanupPending: false, summary: '早期回执已核对' });
    store.event('attempt.cleanup.confirmed', prior.id, { taskId: parent.id }, { kind: 'system', id: 'scheduler' });
  });
  await expect(details.getByText('早期回执已核对', { exact: true })).toBeVisible();
  expect(historyReads.at(-1).getAll('refresh')).toContain(oldestId);

  store.transaction(() => {
    const previous = store.require('attempts', parent.id + '-attempt-34');
    store.put('attempts', { ...previous, status: 'completed' });
    completedAttempt(parent, 35, { status: 'running' });
    store.event('attempt.starting', parent.id + '-attempt-35', { taskId: parent.id }, { kind: 'system', id: 'scheduler' });
  });
  await expect(details.locator('.acms-run')).toHaveCount(36);
  await expect(details.locator('.acms-run').first()).toContainText('历史证据 父任务示例 #35');
  await expect(details.getByText('早期回执已核对', { exact: true })).toBeVisible();
  await expect(details.getByRole('button', { name: '加载更早的执行记录' })).toHaveCount(0);

  const firstSnapshot = await pausePanel(true);
  const reportProgress = lastSnippet => store.transaction(() => {
    const current = store.require('attempts', parent.id + '-attempt-35');
    store.put('attempts', { ...current, progress: { lastSnippet } });
    store.event('attempt.progress', current.id, { taskId: parent.id }, { kind: 'system', id: 'scheduler' });
  });
  reportProgress('等待下一次状态读取');
  await firstSnapshot.wait();

  const actionSnapshot = await pausePanel(false);
  await page.getByRole('button', { name: '＋ 创建子任务' }).click();
  await expect(page.getByLabel('父任务', { exact: true })).toHaveValue(parent.id); await expect(page.getByLabel('授权目标')).toHaveValue(goal.id);
  await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill('界面新建子任务');
  await page.getByLabel('任务说明').fill('归属于选定的父任务'); await page.getByLabel('验收标准').fill('保留正确归属');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await actionSnapshot.wait();

  const nextEvents = await pauseRead(url => url.pathname === '/api/acms/events', true);
  reportProgress('真实较新的状态进度');
  await firstSnapshot.finish();
  await nextEvents.wait();
  await expect(details.getByText('真实较新的状态进度', { exact: true })).toBeVisible();
  await actionSnapshot.finish();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(details.locator('.acms-run')).toHaveCount(36);
  await expect(details.getByText('早期回执已核对', { exact: true })).toBeVisible();
  await expect(details.getByText('真实较新的状态进度', { exact: true })).toBeVisible();
  expect(server.company.snapshot().tasks.find(t => t.title === '界面新建子任务').parentId).toBe(parent.id);
  await nextEvents.finish();

  const cursorBeforeRestore = store.cursor();
  await expect.poll(() => eventReads.at(-1)).toBe(cursorBeforeRestore);
  await expect.poll(() => store.events.listenerCount('event')).toBeGreaterThan(1);
  // Restore a database checkpoint without changing the current task revision
  // or the latest attempt rows the panel uses to watch this task.
  store.transaction(() => {
    store.remove('attempts', oldestId);
    store.db.prepare('DELETE FROM events WHERE seq=?').run(cursorBeforeRestore);
  });
  store.events.emit('event', { type: 'fixture.restored' });
  await expect(details.locator('.acms-run')).toHaveCount(30);
  await expect(details.getByText('早期回执已核对', { exact: true })).toHaveCount(0);
  await details.getByRole('button', { name: '加载更早的执行记录' }).click();
  await expect(details.locator('.acms-run')).toHaveCount(35);
  await expect(details.getByText('早期回执已核对', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.screenshot({ path: 'test-results/ui/hierarchy.png', fullPage: true });
  const priorReads = historyReads.length;
  await page.getByLabel('筛选项目').selectOption(anotherProject.id);
  await expect(page.getByLabel('筛选项目')).toHaveValue(anotherProject.id);
  expect(historyReads).toHaveLength(priorReads);
  await page.locator('.acms-project-group').filter({ hasText: anotherProject.name }).locator('summary').first().click({ position: { x: 8, y: 8 } });
  await page.locator('.acms-goal-group').filter({ hasText: anotherGoal.title }).locator('summary').first().click({ position: { x: 8, y: 8 } });
  await page.getByRole('button', { name: /另一项目的任务/ }).click();
  await expect(details.locator('.acms-run')).toHaveCount(1);
  await details.locator('.acms-run').first().locator('summary').click();
  await expect(details.getByText('历史证据 另一项目的任务 #0', { exact: true })).toBeVisible();
  expect(historyReads.at(-1).get('taskId')).toBe(anotherTask.id);
  await details.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByRole('button', { name: '回收站（1）' }).click(); await page.getByRole('button', { name: '彻底删除', exact: true }).click();
  await page.getByLabel('输入任务标题确认').fill(deleted.title); await page.getByRole('button', { name: '确认彻底删除' }).click();
  await expect(page.getByRole('heading', { name: '回收站为空' })).toBeVisible(); expect(server.company.store.get('tasks', deleted.id)).toBeNull();
  await page.getByRole('button', { name: '模型列表', exact: true }).click();
  await expect(page.getByRole('radio', { name: /^gpt-/ })).toHaveCount(0); expect(diagnostics.length).toBe(0);
  await page.getByRole('button', { name: '＋ 配对外部 agent' }).click(); const prompt = await page.getByLabel('配对 prompt').inputValue();
  const receipt = JSON.parse(prompt.slice(prompt.indexOf('{\n  "protocol"'), prompt.lastIndexOf('\n完成后')));
  const invite = server.company.store.require('modelInvites', receipt.inviteId); const runner = path.join(server.root, 'paired-runner.mjs');
  await writeFile(runner, `let raw='';for await(const b of process.stdin)raw+=b;const r=JSON.parse(raw);console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,model:r.model,executed:true,reasoningEffort:'high',output:'Fixture OK'}));`);
  await writeFile(invite.responseFile, JSON.stringify({ ...receipt, name: '配对环境样例', model: 'gpt-paired-fixture', command: process.execPath, args: [runner], persistent: true, reasoningEffort: 'high', probeSupported: true, probeReason: null }));
  await page.getByRole('button', { name: '读取配对结果' }).click(); await expect(page.getByRole('heading', { name: '核对运行配置' })).toBeVisible(); expect(diagnostics.length).toBe(0);
  await page.getByRole('button', { name: '确认添加模型' }).click(); await expect(page.getByRole('radio', { name: /^gpt-paired-fixture ·/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '继承父代理上下文' })).toHaveCount(0); expect(diagnostics.length).toBe(0);
  await page.getByRole('button', { name: '检测模型连通性' }).click(); await expect(page.locator('.acms-model-health')).toContainText('检测通过'); expect(diagnostics.length).toBe(1);
  await page.screenshot({ path: 'test-results/ui/paired-model.png', fullPage: true });
  await page.getByRole('radio', { name: /^deepseek-flash ·/ }).check(); await expect(page.getByRole('checkbox', { name: '继承父代理上下文' })).toBeVisible(); expect(diagnostics.length).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByRole('heading', { name: '模型列表' })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Hierarchy, scoped navigation, permanent trash deletion, model pairing, manual-only probes and internal-only parent context passed.');
} catch(e) { console.error(errors); await page.screenshot({ path: 'test-results/ui/structure-failure.png', fullPage: true }); throw e; }
finally { await browser.close(); await server.close(); }
