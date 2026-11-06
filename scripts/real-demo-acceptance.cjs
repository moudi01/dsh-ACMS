// Owner-controlled acceptance for the isolated todo demo, outside its worktree.
const { chromium, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const filename = path.resolve('index.html'); const source = fs.readFileSync(filename, 'utf8');
  for (const feature of ['localStorage', '<input', '<button']) if (!source.includes(feature)) throw new Error(`Missing ${feature}`);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(filename).href);
    const input = page.locator('#task-input'); const rows = page.locator('#task-list > li');
    await input.fill('ACMS 独立验收任务'); await input.press('Enter'); await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('ACMS 独立验收任务');
    await rows.first().getByRole('checkbox').check(); await page.reload();
    await expect(rows).toHaveCount(1); await expect(rows.first().getByRole('checkbox')).toBeChecked();
    await rows.first().getByRole('checkbox').uncheck(); await page.reload();
    await expect(rows.first().getByRole('checkbox')).not.toBeChecked();
    await rows.first().getByRole('button').click(); await page.reload(); await expect(rows).toHaveCount(0);
    await input.fill('   '); await input.press('Enter'); await expect(rows).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile horizontal overflow');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Owner acceptance passed: add, exact text, complete, persisted completion, undo, persisted deletion, empty input, mobile layout, no browser errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
