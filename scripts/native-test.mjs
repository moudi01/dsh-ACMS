/** Real DSH integration test. Reads a private lab launch log; never prints tokens. */
import { chromium, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from '../src/runtime/workspaces.js';

const lab = path.resolve(process.env.ACMS_LAB_DIR ?? '.acms-lab');
const log = (await fs.readFile(path.join(lab, 'host.stdout.log'), 'utf8')).replace(/\x1b\[[0-9;]*m/g, '');
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
if (!url) throw new Error('No isolated DSH launch URL was found');
const origin = new URL(url).origin;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', e => errors.push(e.message));
await fs.mkdir(path.join(lab, 'evidence'), { recursive: true });
const command = async (name, args) => {
  const response = await context.request.post(`${origin}/api/acms/command`, { data: { requestId: randomUUID(), name, args } }); const result = await response.json();
  if (!response.ok() || result.ok === false) throw new Error(`${name}: ${result.error?.message ?? response.status()}`); return result.value;
};
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const previewNotice = page.getByRole('button', { name: '继续', exact: true });
  try { await previewNotice.waitFor({ state: 'visible', timeout: 8000 }); await previewNotice.click(); } catch {}
  // A fresh QA profile may show an optional DeepSeek account welcome dialog.
  // ACMS's external provider is authenticated independently; close the prompt.
  try { await page.getByText('开始使用', { exact: true }).waitFor({ state: 'visible', timeout: 1500 }); await page.keyboard.press('Escape'); } catch {}
  const response = await context.request.get(`${origin}/api/acms/state`);
  if (!response.ok()) throw new Error(`Native ACMS state route returned HTTP ${response.status()}`);
  const state = await response.json();
  console.log(JSON.stringify({ nativeHost: 'connected', providers: state.runtime.providers.map(p => p.name), tasks: state.tasks.length }));
  const launcher = page.getByText('ACMS', { exact: true }).first();
  try { await launcher.click({ timeout: 20000 }); await expect(page.getByRole('heading', { name: '让工作持续向前。' })).toBeVisible({ timeout: 15000 }); }
  catch (e) { await fs.writeFile(path.join(lab, 'evidence', 'body.txt'), await page.locator('body').innerText()); throw e; }
  await page.screenshot({ path: path.join(lab, 'evidence', 'native-dsh.png'), fullPage: true });
  const existingDemo = await fs.access(path.join(lab, 'real-demo.json')).then(() => true, () => false);
  if (process.argv.includes('--with-real-demo') && existingDemo) console.log('Existing real demo retained; inspect its status with lab-control.mjs.');
  if (process.argv.includes('--with-real-demo') && !existingDemo) {
    const source = path.join(lab, 'real-demo-source'); const acceptanceDir = path.join(lab, 'acceptance');
    await fs.mkdir(source, { recursive: true }); await fs.mkdir(acceptanceDir, { recursive: true });
    await fs.writeFile(path.join(source, 'README.md'), '# ACMS real-agent demo\n\nCreate a small self-contained todo app in index.html.\n');
    const check = path.join(acceptanceDir, 'verify-todo.cjs');
    await fs.writeFile(check, `const fs=require('node:fs'); const assert=require('node:assert/strict'); const s=fs.readFileSync('index.html','utf8'); assert(s.length>500,'A working UI must be delivered'); for(const feature of ['localStorage','<input','<button']) assert(s.includes(feature),'Missing '+feature); console.log('Owner-defined artifact checks passed');\n`);
    for (const args of [['init', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=ACMS Test', '-c', 'user.email=acms-test@localhost', 'commit', '-m', 'Initialize isolated real-agent demo']]) { const result = await run('git', args, source); if (result.code !== 0) throw new Error(result.stderr); }
    await command('policy.update', { patch: { allowedProviders: ['acms-codex'], allowedProjectRoots: [source], maxConcurrent: 4, controlSlots: 1 } });
    const project = await command('project.save', { name: '真实 AI 待办 Demo', repoRoot: source, mode: 'git', autoMerge: true, checks: [{ id: 'owner-acceptance', command: 'node', args: [check], timeoutMs: 10000 }] });
    const goal = await command('goal.create', { projectId: project.id, title: '交付一个可用的待办应用', description: '这是隔离的 ACMS 真实闭环验证。请只拆成一个实现任务，由执行员在 index.html 中实现中文待办应用：输入并添加任务、标记完成、删除任务，并用 localStorage 持久化。无需依赖、构建或服务器，直接打开文件可使用。可以补充 README，但不要修改验收脚本。完成后由独立审查者检查。', acceptance: 'index.html 可独立打开；能添加、完成、删除待办；刷新保留任务；界面清晰；所有者配置的检查通过；独立审查通过。' });
    await fs.writeFile(path.join(lab, 'real-demo.json'), JSON.stringify({ goalId: goal.id, projectId: project.id, source, startedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ realDemo: 'started', goalId: goal.id, source }));
  }
  await fs.writeFile(path.join(lab, 'evidence', 'native-report.json'), JSON.stringify({ nativeHost: true, nativePanel: true, provider: state.runtime.providers.some(p => p.name === 'acms-codex'), browserErrors: errors }, null, 2));
  if (errors.some(e => /acms|Invalid effect/i.test(e))) throw new Error('ACMS browser runtime reported an error');
  console.log('Native DSH panel and authenticated host routes passed.');
} catch (e) {
  await page.screenshot({ path: path.join(lab, 'evidence', 'native-failure.png'), fullPage: true }).catch(() => {});
  console.error(String(e.stack ?? e).replace(/token=[^\s&]+/g, 'token=[REDACTED]')); process.exitCode = 1;
} finally { await browser.close(); }
