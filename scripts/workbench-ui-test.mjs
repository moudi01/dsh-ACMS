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

    store.transaction(() => {
      for (let index = 0; index < 55; index++) {
        const id = 'task_completed_' + String(index).padStart(2, '0');
        store.put('tasks', { id, projectId: projectB.id, goalId: goalB.id, title: '完成证据 ' + index,
          kind: 'work', status: 'succeeded', dependencies: [], artifactIds: ['artifact_latest_' + index] });
        for (let version = 0; version < 2; version++) store.put('artifacts', { id: `artifact_${index}_${version}`, taskId: id });
      }
      store.event('task.succeeded', 'task_completed_00', {}, OWNER);
    });
    await page.getByLabel('筛选项目').selectOption(projectB.id);
    await page.getByRole('button', { name: '已完成（55）', exact: true }).click();
    const finished = page.getByRole('region', { name: '已完成任务' });
    await expect(finished.getByText('2 份产物', { exact: true })).toHaveCount(40);
    await page.getByRole('button', { name: '下一页任务' }).click();
    await expect(finished.getByText('2 份产物', { exact: true })).toHaveCount(15);
    expect(calls('artifact-counts')).toHaveLength(0);

    const removable = command('task.create', { goalId: goalB.id, title: '核对已删除任务的选择' });
    const taskButton = cards.filter({ has: page.getByRole('heading', { name: removable.title, exact: true }) });
    const taskHeading = drawer.getByRole('heading', { name: removable.title, exact: true });
    const detailRead = url => url.pathname === '/api/acms/panel-context' && url.searchParams.get('taskId') === removable.id;
    const remoteCommand = async name => {
      const response = await page.request.post(server.url + '/api/acms/command', {
        data: { name, args: { id: removable.id }, requestId: crypto.randomUUID() },
      });
      expect(response.ok()).toBe(true);
    };
    const notify = () => store.transaction(() => store.event('task.changed', removable.id, {}, OWNER));
    await page.getByRole('button', { name: /^返回进行中/ }).click();
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await taskButton.click();
    await expect(taskHeading).toBeVisible();
    await page.route(detailRead, route => route.fulfill({
      status: 503, json: { ok: false, error: { code: 'TEMPORARY', message: '暂时无法读取任务详情' } },
    }), { times: 1 });
    notify();
    await expect(page.getByRole('alert').filter({ hasText: '暂时无法读取任务详情' })).toBeVisible();
    notify();
    await expect(taskHeading).toBeVisible();

    await remoteCommand('task.delete');
    await expect(drawer).toHaveCount(0);
    await remoteCommand('task.restore');
    await expect(taskButton).toBeVisible();
    await expect(drawer).toHaveCount(0);
    await taskButton.click();
    await expect(taskHeading).toBeVisible();

    const oldMissing = await pauseRead(page, detailRead);
    await remoteCommand('task.delete');
    await oldMissing.wait();
    await drawer.getByLabel('关闭任务详情').click();
    await remoteCommand('task.restore');
    await taskButton.click();
    await expect(taskHeading).toBeVisible();
    await oldMissing.finish();
    await expect(taskHeading).toBeVisible();

    expect(server.adapter.calls).toHaveLength(0);
    expect(errors).toEqual([]);
    console.log('Scoped workbench: bounded first reads, active pagination, full search, cross-scope dependency, ID detail, pause and confirmed deletion passed.');
  } finally {
    await page.close();
    await server.close();
  }
}

export async function verifyDashboardDepth(browser) {
  const server = await startPreview({ seed: false, startEngine: false });
  const page = await browser.newPage();
  const { store } = server.company;
  const command = (name, args) => server.company.command(OWNER, crypto.randomUUID(), name, args);
  const groups = page.locator('.acms-project-group');
  const laterProject = url => url.pathname === '/api/acms/dashboard' && url.searchParams.get('section') === 'projects' && url.searchParams.has('after');
  try {
    const projects = Array.from({ length: 15 }, (_, i) => command('project.save',
      { name: '尾页项目 ' + i, repoRoot: server.source, mode: 'copy' }));
    await page.goto(server.url);
    await expect(groups).toHaveCount(12);
    const delayed = await pauseRead(page, laterProject);
    await page.getByRole('button', { name: '查看更多项目', exact: true }).click();
    await delayed.wait();
    store.transaction(() => store.event('company.fixture.changed', null, {}, OWNER));
    await delayed.finish();
    await expect(groups).toHaveCount(15);
    const tailNames = await groups.locator('summary .acms-entity-title').allTextContents();
    const removedName = tailNames.at(-1), retainedName = tailNames.at(-2);
    const retained = groups.filter({ has: page.getByRole('button', { name: retainedName, exact: true }) });
    await retained.locator('summary').first().click({ position: { x: 6, y: 6 } });
    await expect(retained).toHaveAttribute('open', '');
    const removed = projects.find(project => project.name === removedName);
    const response = await page.request.post(server.url + '/api/acms/command',
      { data: { name: 'project.delete', args: { id: removed.id }, requestId: crypto.randomUUID() } });
    expect(response.ok()).toBe(true);
    await expect(groups).toHaveCount(14);
    await expect(page.getByRole('button', { name: removedName, exact: true })).toHaveCount(0);
    await expect(retained).toHaveAttribute('open', '');
    await expect(retained).toContainText('当前没有进行中的目标');

    const project = projects.find(item => item.id !== removed.id);
    const goal = command('goal.create', { title: '尾页决定目标', description: '核对待办退回',
      acceptance: '待办只显示当前可决定项', projectId: project.id, plan: false });
    for (let i = 0; i < 10; i++) {
      const task = command('task.create', { goalId: goal.id, title: '等待确认 ' + i });
      server.engine.block(task, 'human', '需要现场输入', '尾页待办 ' + i);
    }
    await page.getByRole('button', { name: '查看更多待办', exact: true }).click();
    await expect(page.getByText('尾页待办 9', { exact: true })).toBeVisible();
    const lastQuestion = store.list('interactions').find(item => item.question === '尾页待办 9');
    const answer = await page.request.post(server.url + '/api/acms/command',
      { data: { name: 'interaction.answer', args: { id: lastQuestion.id, answer: '现场已确认' }, requestId: crypto.randomUUID() } });
    expect(answer.ok()).toBe(true);
    await expect(page.getByText('尾页待办 9', { exact: true })).toHaveCount(0);
    await expect(page.getByText('尾页待办 8', { exact: true })).toBeVisible();
    expect(server.adapter.calls).toHaveLength(0);
  } finally {
    await page.close();
    await server.close();
  }
}

export async function verifyPagedParentTree(browser) {
  const server = await startPreview({ seed: false, startEngine: false });
  const page = await browser.newPage();
  const { store } = server.company;
  const command = (name, args) => server.company.command(OWNER, crypto.randomUUID(), name, args);
  try {
    const project = command('project.save', { name: '父子分页项目', repoRoot: server.source, mode: 'copy' });
    const goal = command('goal.create', { title: '父子分页目标', description: '保留页外后代', acceptance: '范围准确',
      projectId: project.id, plan: false });
    store.transaction(() => {
      for (let i = 0; i < 40; i++) {
        const index = String(i).padStart(2, '0');
        const body = { projectId: project.id, goalId: goal.id, kind: 'work', description: '在正确页面展示', acceptance: '按节排序',
          dependencies: [], createdAt: '2000-01-01T00:00:00.000Z', artifactIds: [] };
        const parent = 'task_a_parent_' + index;
        store.put('tasks', { ...body, id: parent, title: '已交付父任务 ' + index, status: 'succeeded' });
        store.put('tasks', { ...body, id: 'task_z_child_' + index, title: '未执行子任务 ' + index, status: 'ready', parentId: parent });
      }
    });
    await page.goto(server.url);
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    const group = page.locator('.acms-project-group').filter({ hasText: project.name });
    await group.locator('summary').first().click({ position: { x: 6, y: 6 } });
    const branch = group.locator('.acms-goal-group').filter({ hasText: goal.title });
    await branch.locator('summary').first().click({ position: { x: 6, y: 6 } });
    await expect(page.locator('.acms-visible-count')).toContainText('可见 80 / 共 80 项');
    const nodes = branch.locator('.acms-task-tree > li');
    await expect(nodes).toHaveCount(8);
    await expect(nodes.first()).toContainText('已交付父任务 00');
    await expect(nodes.first()).toContainText('已完成 · 含未完成后代');
    await expect(nodes.first()).toContainText('1 项在其他页');
    await page.getByRole('button', { name: '显示全部 40 项任务' }).click();
    await expect(nodes).toHaveCount(40);
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await expect(page.locator('.acms-task-card')).toHaveCount(40);
    await page.getByRole('button', { name: '依赖图', exact: true }).click();
    await expect(page.locator('.acms-graph-node')).toHaveCount(40);
    await page.getByRole('button', { name: '层级', exact: true }).click();
    await page.getByRole('button', { name: '下一页任务' }).click();
    await expect(nodes.first()).toContainText('未执行子任务 00');
    await nodes.first().getByRole('button', { name: /父任务：已交付父任务 00.*不在本页/ }).click();
    await expect(page.getByLabel('任务详情').getByRole('heading', { name: '已交付父任务 00', exact: true })).toBeVisible();
    expect(server.adapter.calls).toHaveLength(0);
  } finally {
    await page.close();
    await server.close();
  }
}
