import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startPreview } from './preview-server.mjs';
import { OWNER } from '../src/core/util.js';

const server = await startPreview({ seed: false });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
  await mkdir('test-results/ui', { recursive: true }); await page.goto(server.url);
  await page.getByRole('button', { name: '组织管理', exact: true }).click();
  const agent = server.company.store.list('agents')[0];
  await page.locator('.acms-agent-card').filter({ has: page.getByRole('heading', { name: agent.name, exact: true }) }).click();
  const entry = page.getByRole('button', { name: '与智能体对话', exact: true }); await entry.click();
  const dialog = page.getByRole('dialog', { name: `与 ${agent.name} 对话`, exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog.getByLabel('消息', { exact: true })).toBeEnabled();
  expect(server.company.store.list('conversationMessages').length).toBe(0);
  expect(server.company.store.list('attempts').length).toBe(0);
  await dialog.getByLabel('消息', { exact: true }).fill('目前有哪些阻塞？');
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByText('回复完成', { exact: true })).toHaveCount(1);
  expect(server.company.store.list('attempts').length).toBe(0);
  // Lose an accepted HTTP response; retry must reuse the same request id.
  let lost = false;
  await page.route('**/api/acms/conversation', async route => {
    const req = route.request();
    if (req.method() === 'POST' && req.postDataJSON()?.action === 'send' && !lost) { lost = true; await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await dialog.getByLabel('消息', { exact: true }).fill('先给我一个建议');
  await dialog.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '核对并重试', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '核对并重试', exact: true }).click();
  await expect(dialog.getByLabel('消息', { exact: true })).toHaveValue('');
  expect(server.company.store.list('conversationMessages').filter(m => m.role === 'user').length).toBe(2);
  await page.unroute('**/api/acms/conversation');
  await page.screenshot({ path: 'test-results/ui/conversation-desktop.png' });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(entry).toBeFocused();
  await entry.click(); await expect(dialog.getByText('目前有哪些阻塞？', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/ui/conversation-mobile.png' });
  await dialog.getByRole('button', { name: '关闭会话', exact: true }).click();
  // A paused task gets a queued instruction, without waking the engine.
  const command = (name, args) => server.company.command(OWNER, randomUUID(), name, args);
  command('company.pause', { afterCurrent: true });
  const project = command('project.save', { name: 'Conversation fixture', repoRoot: server.source, mode: 'copy', checks: [] });
  const goal = command('goal.create', { title: 'Conversation goal', description: 'fixture', acceptance: 'fixture', projectId: project.id, plan: false });
  const task = command('task.create', { title: '待材料任务', goalId: goal.id, agentId: agent.id, description: 'fixture', acceptance: 'fixture' });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.reload();
  await page.getByRole('button', { name: '组织管理', exact: true }).click();
  await page.locator('.acms-agent-card').filter({ has: page.getByRole('heading', { name: agent.name, exact: true }) }).click();
  await entry.click(); await dialog.getByLabel('会话范围').selectOption(task.id);
  await expect(dialog.getByText('等待下一轮', { exact: true })).toBeVisible();
  await dialog.getByLabel('消息', { exact: true }).fill('等材料齐备再送审');
  await dialog.getByRole('button', { name: '留给下一轮', exact: true }).click();
  await expect(dialog.getByText('等材料齐备再送审', { exact: true })).toBeVisible();
  expect(server.company.store.list('attempts').length).toBe(0); expect(server.company.policy().paused).toBe(true);
  expect(errors).toEqual([]); console.log('Conversation UI passed: idle chat, lost-response retry, persistence, pause gate, mobile and focus.');
} finally { await page.close(); await browser.close(); await server.close(); }
