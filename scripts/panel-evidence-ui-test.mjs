import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OWNER } from '../src/core/util.js';
import { pauseRead } from './panel-events-ui-test.mjs';
import { startPreview } from './preview-server.mjs';

export async function verifyPanelEvidence(browser) {
  const server = await startPreview({ seed: false, startEngine: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
  const { store } = server.company;
  const command = (name, args) => server.company.command(OWNER, crypto.randomUUID(), name, args);
  const errors = [];
  const evidenceReads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (['/api/acms/evidence', '/api/acms/artifact-counts', '/api/acms/artifact-links'].includes(url.pathname)) evidenceReads.push(url);
  });
  const evidence = (url, kind, scope, id) => url.pathname === '/api/acms/evidence' &&
    url.searchParams.get('kind') === kind && url.searchParams.get(scope) === id;
  function artifact(task, number, title) {
    const id = task.id + '-artifact-' + number;
    store.put('artifacts', { id, taskId: task.id, title, path: number + '.md', bytes: 12 });
    return id;
  }
  function verification(task, number, summary, extra = {}) {
    store.put('verifications', { id: task.id + '-verification-' + number, kind: 'review', passed: true, summary, ...extra });
  }
  try {
    const anotherRoot = path.join(server.root, 'other-evidence-project');
    await mkdir(anotherRoot);
    const projectA = command('project.save', { name: '产物甲项目', repoRoot: server.source, mode: 'copy' });
    const projectB = command('project.save', { name: '产物乙项目', repoRoot: anotherRoot, mode: 'copy' });
    const goalFields = { description: '核对范围内的历史交付。', acceptance: '证据可追溯。', plan: false };
    const a = command('goal.create', { ...goalFields, title: '甲交付目标', projectId: projectA.id });
    const b = command('goal.create', { ...goalFields, title: '乙交付目标', projectId: projectB.id });
    const taskA = command('task.create', { title: '甲执行及证据', goalId: a.id });
    const taskB = command('task.create', { title: '乙执行及证据', goalId: b.id });
    let oldestArtifact, oldestVerification;
    store.transaction(() => {
      store.put('attempts', { id: 'legacy-evidence-attempt', taskId: taskA.id, goalId: a.id, status: 'completed' });
      oldestArtifact = artifact(taskA, 0, '甲最早历史文件');
      for (let index = 1; index < 25; index++) artifact(taskA, index, `甲历史文件 ${index}`);
      oldestVerification = taskA.id + '-verification-0';
      verification(taskA, 0, '甲旧式执行关联审查', { attemptId: 'legacy-evidence-attempt',
        checks: [{ id: '旧版检查证据', checkVersion: 'v1', command: 'verified-command', code: 0 }] });
      for (let index = 1; index <= 23; index++) verification(taskA, index, `甲历史验收 ${index}`, { taskId: taskA.id });
      artifact(taskB, 1, '乙范围唯一文件');
      verification(taskB, 1, '乙范围唯一验收', { taskId: taskB.id });
      store.put('tasks', { ...taskA, status: 'succeeded', artifactIds: [taskA.id + '-artifact-24'] });
    });

    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '让工作持续向前。' })).toBeVisible();
    expect(evidenceReads).toHaveLength(0);
    await page.getByRole('button', { name: '产物与验收', exact: true }).click();
    const projectFilter = page.getByLabel('筛选产物项目');
    const goalFilter = page.getByLabel('筛选产物目标');
    const artifacts = page.getByRole('region', { name: '交付产物' });
    const checks = page.getByRole('region', { name: '验收记录' });
    await projectFilter.selectOption(projectA.id);
    await expect(artifacts.locator('.acms-artifact-list > button')).toHaveCount(20);
    await expect(checks.locator('.acms-verification')).toHaveCount(20);
    await expect(artifacts).not.toContainText('乙范围唯一文件');
    await artifacts.getByRole('button', { name: '加载更早的产物' }).click();
    await checks.getByRole('button', { name: '加载更早的验收记录' }).click();
    await expect(artifacts).toContainText('甲最早历史文件');
    await expect(checks).toContainText('甲旧式执行关联审查');

    store.transaction(() => {
      artifact(taskA, 25, '甲最新补充文件');
      verification(taskA, 24, '甲最新补充验收', { taskId: taskA.id });
      store.event('task.changed', taskA.id, {}, OWNER);
    });
    await expect(artifacts).toContainText('甲最新补充文件');
    await expect(checks).toContainText('甲最新补充验收');
    await expect(artifacts.locator('.acms-artifact-list > button')).toHaveCount(26);
    await expect(checks).toContainText('甲旧式执行关联审查');

    await goalFilter.selectOption(a.id);
    await expect(artifacts.locator('.acms-artifact-list > button')).toHaveCount(20);
    const slow = await pauseRead(page, url => evidence(url, 'artifacts', 'goalId', a.id) && url.searchParams.has('before'));
    await artifacts.getByRole('button', { name: '加载更早的产物' }).click();
    await slow.wait();
    await projectFilter.selectOption(projectB.id);
    await expect(artifacts).toContainText('乙范围唯一文件');
    await expect(checks).toContainText('乙范围唯一验收');
    await slow.finish();
    await expect(artifacts).not.toContainText('甲最早历史文件');
    await expect(artifacts.locator('.acms-artifact-list > button')).toHaveCount(1);
    await expect(checks.locator('.acms-verification')).toHaveCount(1);

    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    await page.getByLabel('筛选项目').selectOption(projectA.id);
    await page.getByRole('button', { name: /^已完成（/ }).click();
    const done = page.getByRole('region', { name: '已完成任务' });
    await expect(done).toContainText('26 份产物');
    await done.getByRole('button', { name: taskA.title }).click();
    const drawer = page.getByLabel('任务详情');
    const taskEvidence = drawer.locator('.acms-evidence');
    await expect(taskEvidence.getByRole('heading')).toContainText('26');
    await taskEvidence.getByRole('button', { name: '加载更早的产物' }).click();
    await expect(taskEvidence).toContainText('甲最早历史文件');
    // Load through the earliest legacy verification and keep its expanded DOM
    // while an unrelated state notification refreshes the page head.
    for (let index = 0; index < 4; index++) await taskEvidence.getByRole('button', { name: '加载更早的验收记录' }).click();
    await expect(taskEvidence).toContainText('甲旧式执行关联审查');
    const hostEvidence = taskEvidence.getByText('宿主检查证据', { exact: true });
    await hostEvidence.click();
    await expect(taskEvidence.getByText('verified-command')).toBeVisible();
    const drawerReads = evidenceReads.length;
    store.transaction(() => store.event('project.saved', projectB.id, {}, OWNER));
    await expect.poll(() => evidenceReads.slice(drawerReads).some(url => evidence(url, 'verifications', 'taskId', taskA.id))).toBe(true);
    await expect(taskEvidence.getByText('verified-command')).toBeVisible();
    expect(evidenceReads.slice(drawerReads).filter(url => url.searchParams.get('taskId') === taskA.id).every(url => !url.searchParams.has('before'))).toBe(true);

    // Use the real event watermark to abandon the old epoch. The restored
    // state has the same task ID and can therefore catch stale local caching.
    const oldEpoch = await pauseRead(page, url => evidence(url, 'verifications', 'taskId', taskA.id));
    store.transaction(() => store.event('project.saved', projectB.id, {}, OWNER));
    await oldEpoch.wait();
    const currentCursor = store.cursor();
    await expect.poll(() => store.events.listenerCount('event')).toBeGreaterThan(0);
    store.transaction(() => {
      store.db.prepare('DELETE FROM events WHERE seq=?').run(currentCursor);
      store.remove('artifacts', oldestArtifact);
      store.remove('verifications', oldestVerification);
    });
    store.events.emit('event', { type: 'fixture.restore' });
    await expect(taskEvidence.getByRole('heading')).toContainText('25');
    await expect(taskEvidence).not.toContainText('甲最早历史文件');
    await expect(taskEvidence).not.toContainText('甲旧式执行关联审查');
    await oldEpoch.finish();
    await taskEvidence.getByRole('button', { name: '加载更早的产物' }).click();
    await expect(taskEvidence).toContainText('甲历史文件 1 ·');
    await expect(taskEvidence).not.toContainText('甲最早历史文件');
    expect(server.adapter.calls).toHaveLength(0);
    expect(errors).toEqual([]);
    console.log('Scoped evidence: no first-screen reads, pagination, live head refresh, scope and restored-epoch isolation passed.');
  } finally {
    await page.close();
    await server.close();
  }
}
