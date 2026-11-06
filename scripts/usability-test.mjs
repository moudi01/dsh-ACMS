import { chromium, expect } from '@playwright/test';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { startPreview } from './preview-server.mjs';

const server = await startPreview({ seed: false }); const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 900 } });
const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
const directory = path.join(server.source, '项目 有空格'); await mkdir(directory);
// The directory browser returns real paths, expanding Windows short names and casing.
// Native picker/clipboard input still preserves the supplied path until browsing.
const canonicalSource = await realpath(server.source); const canonicalDirectory = await realpath(directory);
server.company.command({ kind: 'owner', id: 'owner' }, crypto.randomUUID(), 'policy.update', { patch: { allowedProjectRoots: [server.source] } });
try {
  await mkdir('test-results/ui', { recursive: true });
  await page.goto(server.url); await expect(page.getByRole('heading', { name: '让工作持续向前。' })).toBeVisible();
  await page.getByRole('button', { name: '任务工作台', exact: true }).click();
  await expect(page.getByRole('button', { name: '＋ 新建任务', exact: true })).toBeDisabled(); await expect(page.getByText('请先创建一个进行中的目标，任务需要归属于目标。')).toBeVisible();
  await page.getByRole('button', { name: '＋ 新建目标', exact: true }).click(); await expect(page.getByRole('heading', { name: '新建目标', exact: true })).toBeVisible();
  await page.getByLabel('标题', { exact: true }).fill('从空公司直接创建目标'); await page.getByLabel('目标说明', { exact: true }).fill('无需先创建任务，生成示例文件。'); await page.getByLabel('验收标准', { exact: true }).fill('独立审查通过。'); await page.getByLabel('项目名称', { exact: true }).fill('一步创建的项目');
  // Exercise the native picker contract without opening the operating-system dialog in CI.
  await page.evaluate(directory => { globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => directory }; }, directory);
  await page.getByRole('button', { name: '选择目录', exact: true }).click(); await expect(page.getByLabel('项目目录', { exact: true })).toHaveValue(directory);
  await page.getByLabel('项目目录', { exact: true }).fill(''); await page.evaluate(directory => navigator.clipboard.writeText(directory), directory);
  await page.getByLabel('项目目录', { exact: true }).focus(); await page.keyboard.press('Control+V'); await expect(page.getByLabel('项目目录', { exact: true })).toHaveValue(directory);
  await page.getByLabel('项目目录', { exact: true }).fill(''); await page.getByRole('button', { name: '粘贴路径', exact: true }).click(); await expect(page.getByLabel('项目目录', { exact: true })).toHaveValue(directory);
  await page.evaluate(() => { delete globalThis.__DSH_DIRECTORY_PICKER__; }); await page.getByRole('button', { name: '选择目录', exact: true }).click();
  await page.getByRole('button', { name: `▱ ${canonicalSource}`, exact: true }).click(); await page.getByRole('button', { name: '▱ 项目 有空格', exact: true }).click(); await page.getByRole('button', { name: '使用此目录', exact: true }).click();
  await expect(page.getByLabel('项目目录', { exact: true })).toHaveValue(canonicalDirectory);
  await page.screenshot({ path: 'test-results/ui/first-goal.png', fullPage: true });
  await page.getByRole('button', { name: '创建目标并启动', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(server.company.snapshot().projects).toHaveLength(1); expect(server.company.snapshot().goals).toHaveLength(1); expect(server.company.snapshot().projects[0].repoRoot).toBe(canonicalDirectory);
  expect(server.company.snapshot().tasks.some(t => t.kind === 'plan')).toBe(true);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('First-goal creation, native picker contract, directory browser, real clipboard paste, and disabled-action guidance passed.');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Directory paths:', { source: server.source, canonicalSource, directory, canonicalDirectory });
  await page.screenshot({ path: 'test-results/ui/usability-failure.png', fullPage: true }).catch(e => console.error('Failure screenshot:', e.message));
  throw error;
} finally { await browser.close(); await server.close(); }
