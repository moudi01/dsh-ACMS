import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startPreview } from './preview-server.mjs';
import { OWNER } from '../src/core/util.js';

// Issue #24 acceptance: the dependency graph must never mix projects, must default to one
// project, must partition "全部项目" by project/goal with counts, and must keep hidden
// predecessors reachable as placeholders. Model calls stay at zero and business state is
// never written by filtering or folding.
const server = await startPreview({ seed: false, startEngine: false });
const command = (name, args) => server.company.command(OWNER, randomUUID(), name, args);
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

const projectB = command('project.save', { name: '隔离测试项目 B', repoRoot: server.source, mode: 'copy', checks: [] });
const goalB1 = command('goal.create', { title: 'B 目标一', description: '第一个目标', acceptance: '可验收', projectId: projectB.id, plan: false });
const goalB2 = command('goal.create', { title: 'B 目标二', description: '第二个目标', acceptance: '可验收', projectId: projectB.id, plan: false });
const b1 = command('task.create', { goalId: goalB1.id, title: 'B1 基线任务', description: 'B 项目基线' });
command('task.create', { goalId: goalB1.id, title: 'B2 依赖任务', description: '依赖 B1', dependencies: [b1.id] });
command('task.create', { goalId: goalB2.id, title: 'B3 第二目标任务', description: 'B 项目第二目标' });

await settle();
const projectA = command('project.save', { name: '隔离测试项目 A', repoRoot: server.source, mode: 'copy', checks: [] });
const goalA1 = command('goal.create', { title: 'A 目标一', description: '最近活跃目标', acceptance: '可验收', projectId: projectA.id, plan: false });
const goalA2 = command('goal.create', { title: 'A 目标二', description: '另一个目标', acceptance: '可验收', projectId: projectA.id, plan: false });
const a1 = command('task.create', { goalId: goalA1.id, title: 'A1 基线任务', description: 'A 项目基线' });
command('task.create', { goalId: goalA1.id, title: 'A2 依赖任务', description: '依赖 A1', dependencies: [a1.id] });
command('task.create', { goalId: goalA2.id, title: 'A3 第二目标任务', description: 'A 项目第二目标' });

await settle();
const projectEmpty = command('project.save', { name: '空范围项目 C', repoRoot: server.source, mode: 'copy', checks: [] });
await settle();

const businessState = snapshot => JSON.stringify({
  tasks: snapshot.tasks.map(task => ({ id: task.id, status: task.status, revision: task.revision, dependencies: task.dependencies, projectId: task.projectId, goalId: task.goalId })).sort((a, b) => a.id.localeCompare(b.id)),
  goals: snapshot.goals.map(goal => ({ id: goal.id, status: goal.status, revision: goal.revision })).sort((a, b) => a.id.localeCompare(b.id)),
});
const beforeState = businessState(server.company.snapshot());

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
const errors = []; const modelCalls = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/\/api\/acms\/model-(check|details)/.test(request.url())) modelCalls.push(request.url()); });
const section = name => page.locator('.acms-graph-section').filter({ hasText: name });
const nodes = root => root.locator('.acms-graph-node:visible');
const openState = locator => locator.evaluate(element => element.open);

try {
  await mkdir('test-results/ui', { recursive: true });
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '让工作持续向前。' })).toBeVisible();

  // 1. Default focus: the most recently active project; no task from another project leaks in.
  await page.getByRole('button', { name: '任务工作台', exact: true }).click();
  await expect(page.getByLabel('筛选项目')).toHaveValue(projectA.id);
  await page.getByRole('button', { name: '依赖图', exact: true }).click();
  await expect(nodes(page)).toHaveCount(3);
  await expect(page.locator('.acms-graph-scope')).toContainText('项目：隔离测试项目 A');
  await expect(page.locator('.acms-graph-view')).not.toContainText('B1 基线任务');
  await expect(section('A 目标一')).toContainText('2 项任务');
  await page.screenshot({ path: 'test-results/ui/graph-focus.png', fullPage: true });

  // 1b. Create actions inherit the focused project/goal instead of the first array item.
  await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click();
  const taskDialog = page.getByRole('dialog');
  await expect(taskDialog.getByLabel('授权目标')).toHaveValue(goalA1.id);
  await taskDialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '＋ 新建目标', exact: true }).click();
  const goalDialog = page.getByRole('dialog');
  await expect(goalDialog.getByLabel('所属项目')).toHaveValue(projectA.id);
  await goalDialog.getByRole('button', { name: '取消', exact: true }).click();

  // 1c. No open goal in the focused project: creation is disabled with guidance.
  await page.getByLabel('筛选项目').selectOption(projectEmpty.id);
  await expect(page.getByRole('button', { name: '＋ 新建任务', exact: true })).toBeDisabled();
  await expect(page.getByText('当前项目没有进行中的目标；请先新建目标，再创建任务。')).toBeVisible();
  await page.getByLabel('筛选项目').selectOption('');
  await expect(page.getByRole('button', { name: '＋ 新建任务', exact: true })).toBeEnabled();

  // 1d. An empty goal selection blocks submit instead of sending an unbound value.
  await page.getByLabel('筛选项目').selectOption(projectA.id);
  await page.getByRole('button', { name: '＋ 新建任务', exact: true }).click();
  const guardedDialog = page.getByRole('dialog');
  await expect(guardedDialog.getByLabel('授权目标')).toHaveValue(goalA1.id);
  await guardedDialog.getByLabel('授权目标').selectOption('');
  await expect(guardedDialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(guardedDialog.getByText('请先选择授权目标，任务必须归属于目标。')).toBeVisible();
  await guardedDialog.getByRole('button', { name: '取消', exact: true }).click();

  // 2. "全部项目" partitions by project with counts and is folded by default.
  await page.getByLabel('筛选项目').selectOption('');
  await expect(page.locator('.acms-graph-section')).toHaveCount(2);
  await expect(section('隔离测试项目 A')).toContainText('3 项任务');
  await expect(section('隔离测试项目 B')).toContainText('3 项任务');
  await expect(page.locator('.acms-graph-scope')).toContainText('全部项目（2 个有任务的项目）');
  await expect(nodes(page)).toHaveCount(0);
  expect(await openState(section('隔离测试项目 A'))).toBe(false);
  expect(await openState(section('隔离测试项目 B'))).toBe(false);

  // 3. Expanding one project never shows another project's tasks; goals stay identifiable.
  await section('隔离测试项目 A').locator('summary').click();
  await expect(nodes(section('隔离测试项目 A'))).toHaveCount(3);
  await expect(section('隔离测试项目 A')).not.toContainText('B1 基线任务');
  await expect(section('隔离测试项目 A')).toContainText('A 目标一');
  await expect(nodes(section('隔离测试项目 B'))).toHaveCount(0);
  await section('隔离测试项目 B').locator('summary').click();
  await expect(nodes(section('隔离测试项目 B'))).toHaveCount(3);
  await expect(section('隔离测试项目 B')).not.toContainText('A1 基线任务');
  await page.screenshot({ path: 'test-results/ui/graph-partitions.png', fullPage: true });

  // 4. A data refresh keeps expansion state instead of folding back.
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  expect(await openState(section('隔离测试项目 A'))).toBe(true);
  await expect(nodes(section('隔离测试项目 A'))).toHaveCount(3);

  // 5. A single project shows its goals expanded; folding one keeps the other reachable.
  await page.getByLabel('筛选项目').selectOption(projectB.id);
  await expect(page.locator('.acms-graph-section')).toHaveCount(2);
  await expect(nodes(page)).toHaveCount(3);
  await expect(page.locator('.acms-graph-view')).toContainText('B 目标一');
  await section('B 目标一').locator('summary').click();
  await expect(nodes(page)).toHaveCount(1);
  await expect(section('B 目标二')).toContainText('B3 第二目标任务');

  // 5b. Filtering down to the folded section keeps the section, its title and its folded state.
  await page.getByLabel('搜索任务').fill('B1 基线');
  await expect(page.locator('.acms-graph-section')).toHaveCount(1);
  await expect(section('B 目标一')).toContainText('B 目标一');
  await expect(nodes(page)).toHaveCount(0);
  expect(await openState(section('B 目标一'))).toBe(false);
  await section('B 目标一').locator('summary').click();
  await expect(nodes(page)).toHaveCount(1);
  await page.getByLabel('搜索任务').fill('');

  // 6. Per-object state: project A stays expanded after switching scopes.
  await page.getByLabel('筛选项目').selectOption('');
  expect(await openState(section('隔离测试项目 A'))).toBe(true);

  // 6b. A single matching project partition is still a section, not a bypass of folding.
  await section('隔离测试项目 A').locator('summary').click();
  await page.getByLabel('搜索任务').fill('A1 基线');
  await expect(page.locator('.acms-graph-section')).toHaveCount(1);
  expect(await openState(section('隔离测试项目 A'))).toBe(false);
  await expect(nodes(page)).toHaveCount(0);
  await page.getByLabel('搜索任务').fill('');
  await expect(page.locator('.acms-graph-section')).toHaveCount(2);

  // 7. A goal scope renders a single canvas without any project section.
  await page.getByLabel('筛选项目').selectOption(projectB.id);
  await page.getByLabel('筛选目标').selectOption(goalB1.id);
  await expect(page.locator('.acms-graph-section')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator('.acms-graph-scope')).toContainText('目标：B 目标一');

  // 8. Hidden predecessors are expandable placeholders, never silent missing edges.
  await page.getByLabel('搜索任务').fill('B2 依赖');
  await expect(nodes(page)).toHaveCount(1);
  await expect(page.locator('.acms-graph-node')).toContainText('前置未显示 1 项');
  await page.locator('.acms-graph-hidden summary').click();
  await expect(page.locator('.acms-graph-hidden')).toContainText('B1 基线任务');
  await page.locator('.acms-graph-hidden button').first().click();
  await expect(page.locator('.acms-drawer')).toContainText('B1 基线任务');
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.getByLabel('搜索任务').fill('');

  // 9. Empty scope has an explicit empty state instead of a blank graph.
  await page.getByLabel('筛选项目').selectOption(projectEmpty.id);
  await expect(page.locator('.acms-empty')).toContainText('当前范围没有任务');
  await expect(page.locator('.acms-empty')).toContainText('所选项目或目标当前没有任务');

  // 10. Deep links resolve to the same scope and the same single-canvas rule.
  await page.getByRole('button', { name: '公司总览', exact: true }).click();
  await page.locator('.acms-goal-group').filter({ hasText: 'B 目标一' }).getByRole('button', { name: '查看此目标的任务 →' }).click();
  await expect(page.getByLabel('筛选项目')).toHaveValue(projectB.id);
  await expect(page.getByLabel('筛选目标')).toHaveValue(goalB1.id);
  await page.getByRole('button', { name: '依赖图', exact: true }).click();
  await expect(page.locator('.acms-graph-section')).toHaveCount(0);
  await expect(nodes(page)).toHaveCount(2);

  // 11. Filtering and folding never write business state and never call a model.
  expect(businessState(server.company.snapshot())).toBe(beforeState);
  expect(modelCalls).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/ui/graph-isolation.png', fullPage: true });
  await writeFile('test-results/graph-isolation-result.json', JSON.stringify({
    defaultFocusProject: '隔离测试项目 A',
    projectPartitions: 2,
    crossProjectNodes: 0,
    hiddenPredecessorPlaceholder: true,
    refreshKeepsExpansion: true,
    emptyScopeMessage: true,
    deepLinkScope: true,
    businessStateUnchanged: true,
    modelCalls: 0,
    browserErrors: errors,
  }, null, 2));
  console.log('Graph scope isolation: default focus, project/goal partitions, hidden predecessors and unchanged business state passed.');
} finally { await browser.close(); await server.close(); }
