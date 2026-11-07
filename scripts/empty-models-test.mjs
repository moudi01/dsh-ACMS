import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { startPreview } from './preview-server.mjs';
const server = await startPreview({ seed: false });
server.engine.adapter.modelCatalog = async () => ({ models: [], defaultSelection: null, warnings: [] });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage(); const errors = [], probes = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', r => { if (/model-(details|check)/.test(r.url())) probes.push(r.url()); });
try {
  await mkdir('test-results/ui', { recursive: true });
  await page.goto(server.url);
  await page.getByRole('button', { name: '模型列表', exact: true }).click();
  await expect(page.getByText('DSH 暂无模型列表，请检查 DSH 模型设置或配对外部 agent。')).toBeVisible();
  await page.getByRole('button', { name: '＋ 配对外部 agent' }).click();
  await expect(page.getByLabel('配对 prompt')).toHaveValue(/acms.runner.v1/);
  await page.screenshot({ path: 'test-results/ui/empty-models.png' });
  await page.getByRole('button', { name: '关闭配对' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '组织管理', exact: true }).click();
  await page.getByRole('button', { name: '＋ 创建角色', exact: true }).click();
  await page.getByLabel('角色名称').fill('未绑定模型的角色');
  await expect(page.getByRole('dialog')).toContainText('请选择 DSH 模型或已配对的外部模型');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  expect(errors).toEqual([]); expect(probes).toEqual([]);
  await writeFile('test-results/empty-models-result.json', JSON.stringify({ pairingUsable: true, unboundRoleUsable: true, browserErrors: errors, automaticProbes: probes }, null, 2));
  console.log('Empty catalog: pairing and unbound role remain usable; no page errors or automatic probes.');
} finally { await browser.close(); await server.close(); }
