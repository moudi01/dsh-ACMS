import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startPreview } from './preview-server.mjs';
import { OWNER } from '../src/core/util.js';

// Issue #47 acceptance: the overview reads the host capacity snapshot, lists
// every occupancy kind with an entry point, and covers task, integration,
// cleanup-pending, chat and probe fixtures without starting a model.
const server = await startPreview({ seed: true, startEngine: false });
const command = (name, args) => server.company.command(OWNER, randomUUID(), name, args);
const store = server.company.store;
const project = server.company.snapshot().projects[0];
const agent = command('agent.save', { name: '容量夹具执行员', role: 'worker' });

const goal = command('goal.create', { projectId: project.id, title: '容量夹具目标', description: '执行容量验收夹具。', acceptance: '容量与关联入口可核对。', plan: false });
const running = command('task.create', { goalId: goal.id, title: '运行中的任务' });
const cleaning = command('task.create', { goalId: goal.id, title: '待清理核对的集成任务' });
const startedAt = new Date().toISOString();
store.put('attempts', { id: 'attempt_capacity_running', taskId: running.id, goalId: goal.id, agentId: agent.id, role: 'worker', kind: 'work', status: 'running', startedAt });
store.put('attempts', { id: 'attempt_capacity_cleanup', taskId: cleaning.id, goalId: goal.id, agentId: agent.id, role: 'worker', kind: 'work', status: 'completed', cleanupPending: true, startedAt });
store.put('integrations', { id: 'integration_capacity', taskId: cleaning.id, goalId: goal.id, generation: cleaning.generation, phase: 'applying' });
server.adapter.activeChats = 1;
server.adapter.activeChatDetails = new Map([['conversation_capacity', { conversationId: 'conversation_capacity', agentId: agent.id, taskId: null, messageId: 'message_capacity', phase: 'chat' }]]);
server.adapter.activeProbes = 1;
command('policy.update', { patch: { maxConcurrent: 6, controlSlots: 1 } });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, colorScheme: 'light' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('test-results/ui', { recursive: true });
const phase = label => page.locator('.acms-capacity-phases > div').filter({ hasText: label });
try {
  await page.goto(server.url);
  const metric = page.getByRole('button', { name: '查看执行资源' });
  await expect(metric).toContainText('5 / 6');
  await metric.click();

  const panel = page.getByLabel('执行容量');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('5 / 6');
  await expect(panel).toContainText('空闲名额');
  await expect(panel).toContainText('协调预留');
  await expect(panel).toContainText('普通任务上限 5');
  for (const [label, count] of [['运行中', '1'], ['正在停止', '0'], ['待清理核对', '1'], ['Git 集成', '1'], ['独立对话', '1'], ['模型检测', '1']]) {
    await expect(phase(label)).toContainText(count);
  }

  // Each occupancy kind exposes a usable entry point. The pending integration
  // is listed separately from the cleanup-pending task attempt, so both the
  // integration badge and the task entry are asserted here.
  const entry = pattern => page.locator('.acms-capacity-entry').filter({ hasText: pattern });
  await expect(entry(/运行中的任务/)).toBeVisible();
  await expect(entry(/Git 集成/)).toBeVisible();
  await expect(entry(/容量夹具执行员/)).toBeVisible();
  await expect(entry(/模型连通性检测/)).toBeVisible();

  await entry(/运行中的任务/).click();
  await expect(page.locator('.acms-drawer')).toContainText('运行中的任务');
  await page.getByLabel('关闭任务详情').click();

  await entry(/容量夹具执行员/).click();
  await expect(page.getByRole('heading', { name: `与 ${agent.name} 对话` })).toBeVisible();
  await page.getByLabel('关闭会话').click();

  await entry(/模型连通性检测/).click();
  await expect(page.getByRole('heading', { name: '模型列表' })).toBeVisible();

  await page.getByRole('button', { name: '公司总览', exact: true }).click();
  await page.screenshot({ path: 'test-results/ui/capacity-overview.png', fullPage: true });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('capacity UI checks passed');
} finally {
  await browser.close();
  await server.close();
}
