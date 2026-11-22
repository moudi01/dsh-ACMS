import { expect } from '@playwright/test';
import { OWNER } from '../src/core/util.js';
import { pauseRead } from './panel-events-ui-test.mjs';
import { startPreview } from './preview-server.mjs';

export async function verifyScopedWorkbench(browser) {
  const server = await startPreview({ seed: false, startEngine: false });
  const page = await browser.newPage();
  const { store } = server.company;
  const command = (name, args) => server.company.command(OWNER, crypto.randomUUID(), name, args);
  const requests = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(new URL(request.url())));
  const calls = name => requests.filter(url => url.pathname === '/api/acms/' + name);
  try {
    const projectA = command('project.save', { name: '范围甲', repoRoot: server.source, mode: 'copy' });
    const projectB = command('project.save', { name: '范围乙', repoRoot: server.source, mode: 'copy' });
    const conditions = { description: '正常筛选路径', acceptance: '可核对范围', plan: false };
    const goalA = command('goal.create', { ...conditions, title: '任务范围目标甲', projectId: projectA.id });
    const goalB = command('goal.create', { ...conditions, title: '任务范围目标乙', projectId: projectB.id });
    const foreign = command('task.create', { goalId: goalB.id, title: '范围乙真实前置' });
    store.transaction(() => {
      for (let index = 0; index < 61; index++) {
        const suffix = String(index).padStart(2, '0');
        store.put('tasks', { id: 'task_bounded_' + suffix, projectId: projectA.id, goalId: goalA.id, title: '分页任务 ' + suffix,
          kind: 'work', status: 'ready', acceptance: '可核对', createdAt: '2000-01-01T00:00:00.000Z',
          description: '长任务说明 '.repeat(100) + (index === 60 ? '原始说明中的唯一检索词' : ''),
          dependencies: index === 60 ? [foreign.id] : [], agentId: foreign.agentId });
      }
      store.event('task.changed', 'task_bounded_00', {}, OWNER);
    });
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '让工作持续向前。' })).toBeVisible();
    expect(calls('state').map(url => url.searchParams.get('view'))).toEqual(['dashboard']);
    for (const endpoint of ['task-attempts', 'evidence', 'activity', 'panel-context', 'dashboard', 'workbench']) expect(calls(endpoint)).toHaveLength(0);

    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    const projectFilter = page.getByLabel('筛选项目');
    await projectFilter.selectOption(projectA.id);
    await page.getByRole('button', { name: '看板', exact: true }).click();
    const cards = page.locator('.acms-task-card');
    await expect(cards).toHaveCount(40);
    await expect(page.locator('.acms-visible-count')).toContainText('共 61 项');
    expect(calls('state').every(url => url.searchParams.get('view') === 'dashboard')).toBeTruthy();
    expect(calls('task-attempts')).toHaveLength(0);
    const second = await pauseRead(page, url => url.pathname === '/api/acms/workbench' &&
      url.searchParams.get('projectId') === projectA.id && url.searchParams.has('after'));
    await page.getByRole('button', { name: '下一页任务' }).click();
    await second.wait();
    command('project.save', { id: projectB.id, name: '范围乙已更新', repoRoot: server.source, mode: 'copy' });
    await second.finish();
    await expect(cards).toHaveCount(21);
    await expect(cards.last()).toContainText('分页任务 60');
    await page.getByRole('button', { name: '上一页任务' }).click();
    await expect(cards).toHaveCount(40);

    await page.getByLabel('搜索任务').fill('原始说明中的唯一检索词');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('分页任务 60');
    await page.getByRole('button', { name: '依赖图', exact: true }).click();
    await expect(page.getByText(/跨分区依赖/)).toBeVisible();
    await page.locator('.acms-graph-hidden summary').click();
    await page.getByRole('button', { name: /范围乙真实前置/ }).click();
    const drawer = page.getByLabel('任务详情');
    await expect(drawer.getByRole('heading', { name: foreign.title })).toBeVisible();
    expect(calls('panel-context').at(-1).searchParams.get('taskId')).toBe(foreign.id);
    await drawer.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(drawer.getByText('已暂停', { exact: true })).toBeVisible();
    await drawer.getByLabel('关闭任务详情').click();
    await expect(page.getByLabel('搜索任务')).toHaveValue('原始说明中的唯一检索词');
    await page.getByLabel('搜索任务').clear();
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await projectFilter.selectOption(projectB.id);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(foreign.title);
    expect(calls('state').every(url => url.searchParams.get('view') === 'dashboard')).toBeTruthy();

    const previousView = await pauseRead(page, url => url.pathname === '/api/acms/state' && url.searchParams.get('view') === 'panel');
    await page.getByRole('button', { name: '动态日志', exact: true }).click();
    await previousView.wait();
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    await previousView.finish();
    await expect(page.getByRole('heading', { name: '任务工作台', exact: true })).toBeVisible();
    await expect(page.getByLabel('筛选项目')).toBeVisible();
    expect(calls('state').filter(url => url.searchParams.get('view') === 'panel')).toHaveLength(1);
    expect(server.adapter.calls).toHaveLength(0);
    expect(errors).toEqual([]);
    console.log('Scoped workbench: bounded first reads, active pagination, full search, cross-scope dependency, ID detail and pause passed.');
  } finally {
    await page.close();
    await server.close();
  }
}
