import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startPreview } from './preview-server.mjs';

// Issue #35 acceptance: the panel downloads the complete original file, while
// the text preview stays bounded. Binary bytes and Unicode names are preserved.
const server = await startPreview({ seed: true, startEngine: false });
const task = server.company.snapshot().tasks[0];
const bytes = Buffer.alloc(300000);
for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
const blob = path.join(server.dataDir, 'artifacts', 'ui-download-blob');
const emptyBlob = path.join(server.dataDir, 'artifacts', 'ui-empty-blob');
await mkdir(path.dirname(blob), { recursive: true });
await writeFile(blob, bytes);
await writeFile(emptyBlob, Buffer.alloc(0));
server.company.store.put('artifacts', { id: 'artifact_ui_download', taskId: task.id, attemptId: 'attempt_ui_download', path: '交付/UI 二进制.bin', title: 'UI 二进制交付', hash: 'acms-base64-digest', bytes: bytes.length, blob });
server.company.store.put('artifacts', { id: 'artifact_ui_empty', taskId: task.id, attemptId: 'attempt_ui_empty', path: '交付/空文件.txt', title: 'UI 空文件交付', hash: 'acms-empty-digest', bytes: 0, blob: emptyBlob });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light', acceptDownloads: true });
const errors = []; page.on('pageerror', error => errors.push(error.message));
await mkdir('test-results/ui', { recursive: true });
async function downloadThrough(title, { truncated = true } = {}) {
  await page.getByRole('button', { name: '产物与验收', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  if (truncated) await expect(page.locator('.acms-modal')).toContainText('预览已截断；完整原始文件仍可下载');
  await expect(page.getByRole('link', { name: /下载原始文件/ })).toBeVisible();
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: /下载原始文件/ }).click();
  const download = await pending;
  const saved = await download.path();
  return { suggested: download.suggestedFilename(), body: await readFile(saved) };
}
try {
  await page.goto(server.url);
  const large = await downloadThrough('UI 二进制交付');
  expect(large.body.equals(bytes)).toBeTruthy();
  expect(large.body.length).toBe(bytes.length);
  expect(large.suggested).toBe('UI 二进制.bin');
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  const empty = await downloadThrough('UI 空文件交付', { truncated: false });
  expect(empty.body.length).toBe(0);
  expect(empty.suggested).toBe('空文件.txt');
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  await page.screenshot({ path: 'test-results/ui/artifact-download.png', fullPage: true });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('artifact download UI checks passed');
} finally {
  await browser.close();
  await server.close();
}
