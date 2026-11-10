import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startPreview } from './preview-server.mjs';

// Issue #46 acceptance: the owner can set, view and change goal priority in the
// panel. External submission defaults are covered by test/goal-priority.test.js.
const server = await startPreview({ seed: true, startEngine: false });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('test-results/ui', { recursive: true });
const title = '优先级界面夹具目标';
try {
  await page.goto(server.url);
  await page.getByRole('button', { name: '＋ 新建目标' }).click();
  const priorityInput = page.getByLabel('优先级（0–100）');
  await expect(priorityInput).toHaveValue('50');
  await page.getByLabel('标题').fill(title);
  await page.getByLabel('目标说明').fill('验证所有者可以在界面设置目标优先级。');
  await page.getByLabel('验收标准').fill('优先级可设置、查看并修改，默认 50。');
  await priorityInput.fill('80');
  await page.getByRole('button', { name: '创建目标并启动' }).click();
  const projectGroup = page.locator('.acms-project-group').first();
  await projectGroup.locator('summary').first().click();
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();

  const created = server.company.snapshot().goals.find(goal => goal.title === title);
  if (created?.priority !== 80) throw new Error(`stored priority is ${created?.priority}, expected 80`);

  await page.getByRole('button', { name: title, exact: true }).click();
  const drawer = page.getByLabel('目标详情');
  await expect(drawer).toContainText('优先级：80');

  await drawer.getByRole('button', { name: '编辑目标' }).click();
  const editPriority = page.getByLabel('优先级（0–100）');
  await expect(editPriority).toHaveValue('80');
  await editPriority.fill('10');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer).toContainText('优先级：10');
  const edited = server.company.snapshot().goals.find(goal => goal.id === created.id);
  if (edited?.priority !== 10) throw new Error(`edited priority is ${edited?.priority}, expected 10`);

  // Clearing the field falls back to the documented default instead of 0.
  await drawer.getByRole('button', { name: '编辑目标' }).click();
  await page.getByLabel('优先级（0–100）').fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(drawer).toContainText('优先级：50');
  const fallback = server.company.snapshot().goals.find(goal => goal.id === created.id);
  if (fallback?.priority !== 50) throw new Error(`cleared priority is ${fallback?.priority}, expected 50`);

  await page.screenshot({ path: 'test-results/ui/goal-priority.png', fullPage: true });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('goal priority UI checks passed');
} finally {
  await browser.close();
  await server.close();
}
