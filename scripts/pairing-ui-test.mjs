import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { startPreview } from './preview-server.mjs';

const server = await startPreview({ seed: false });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
const errors = [], probes = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/model-(details|check)/.test(request.url())) probes.push(request.url()); });
try {
  await mkdir('test-results/ui', { recursive: true });
  await page.goto(server.url);
  await page.getByRole('button', { name: '模型列表', exact: true }).click();
  await page.getByRole('button', { name: '＋ 配对外部 agent', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '配对外部 agent', exact: true });
  const heading = modal.getByRole('heading', { name: '配对外部 agent', exact: true });
  await expect(modal).toBeVisible();
  await expect(page.getByLabel('配对 prompt')).toHaveValue(/acms.runner.v1/);
  // Visibility alone passes for a section far below the current viewport.
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  const prompt = await page.getByLabel('配对 prompt').inputValue();
  const inviteCount = server.company.store.list('modelInvites').length;
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await page.getByRole('button', { name: '查看配对邀请', exact: true }).click();
  await expect(modal).toBeVisible();
  await expect(heading).toBeInViewport();
  await expect(page.getByLabel('配对 prompt')).toHaveValue(prompt);
  expect(server.company.store.list('modelInvites').length).toBe(inviteCount);
  await page.screenshot({ path: 'test-results/ui/pairing-visible.png' });
  await page.getByRole('button', { name: '关闭配对', exact: true }).click();
  await expect(heading).toHaveCount(0);

  await page.route('**/api/acms/pairing', route => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { message: '测试：配对服务暂时不可用' } }),
  }));
  await page.getByRole('button', { name: '查看配对邀请', exact: true }).click();
  await page.getByRole('button', { name: '重新生成邀请', exact: true }).click();
  await expect(page.getByText('测试：配对服务暂时不可用', { exact: true })).toBeInViewport();
  await page.unroute('**/api/acms/pairing');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '查看配对邀请', exact: true }).click();
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();
  await page.screenshot({ path: 'test-results/ui/pairing-mobile.png' });
  const receipt = JSON.parse(prompt.slice(prompt.indexOf('{\n  \"protocol\"'), prompt.lastIndexOf('\n完成后')));
  const invite = server.company.store.list('modelInvites').find(i => i.id === receipt.inviteId);
  await writeFile(invite.responseFile, JSON.stringify({ ...receipt, name: 'Task only fixture', model: 'task-only-fixture', command: process.execPath, args: [], persistent: false, probeSupported: false, probeReason: '无法验证全部工具已禁用' }));
  await page.getByRole('button', { name: '读取配对结果', exact: true }).click();
  await expect(page.getByText('暂不支持：无法验证全部工具已禁用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认添加模型', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检测模型连通性', exact: true })).toBeDisabled();
  expect(server.company.store.list('externalModels').length).toBe(1);
  expect(server.company.store.list('modelHealth').length).toBe(0);
  expect(errors).toEqual([]);
  expect(probes).toEqual([]);
  await writeFile('test-results/pairing-ui-result.json', JSON.stringify({
    invitationInViewport: true, focusMoved: true, existingInvitationReused: true,
    failureInViewport: true, mobileInViewport: true, browserErrors: errors, automaticProbes: probes,
  }, null, 2));
  console.log('Pairing: visible/focused invitation, no duplicate invitation, visible errors, mobile and no automatic probes passed.');
} finally { await browser.close(); await server.close(); }
