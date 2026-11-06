/** Isolated development/test harness. Production uses the DSH host routes. */
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { Engine } from '../src/runtime/engine.js';
import { Conversations } from '../src/runtime/conversations.js';
import { WorkspaceManager } from '../src/runtime/workspaces.js';
import { SimulatedAdapter, defaultSimulation } from '../src/adapters/simulated.js';
import { createRoutes } from '../src/host/http.js';
import { OWNER } from '../src/core/util.js';

export async function startPreview({ seed = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acms-ui-test-')); const source = path.join(root, 'source'); const dataDir = path.join(root, 'data');
  await mkdir(source); await writeFile(path.join(source, 'README.md'), '# Isolated UI test project\n');
  const store = new Store(path.join(dataDir, 'company.db')); const company = new Company(store);
  const adapter = new SimulatedAdapter(async input => input.task.kind === 'work' && input.task.title.includes('品牌素材') && !input.task.lastAnswer ? { outcome: 'blocked', kind: 'human', reason: '当前没有可用的品牌文件。', question: '请提供品牌素材，或确认沿用默认样式。' } : defaultSimulation(input));
  // Model-name fixtures for the UI contract only; all executions remain simulated.
  const health = new Map(); adapter.paired = new PairedRuntimes(company, dataDir);
  const reasoning = { efforts: [{ id: 'low', name: '低' }, { id: 'max', name: '最高' }], effective: 'max', configured: 'max', source: '模拟 DSH 模型列表', selectable: true };
  const fixtureRoute = id => ({ provider: 'simulation', llmProvider: 'preview', displayName: 'DSH fixture', persistent: false, origin: 'internal', inheritsParentContext: false, reasoning, health: health.get(id) ?? { status: 'untested', reason: '尚未检测' } });
  adapter.modelCatalog = async () => ({ models: [...['deepseek-flash', 'deepseek-reasoner', 'offline-test-model'].map(id => ({ id, routes: [fixtureRoute(id), { ...fixtureRoute(id), provider: 'simulation-fork', inheritsParentContext: true }] })), ...adapter.paired.list().map(m => ({ id: m.model, routes: [{ provider: m.id, llmProvider: '', displayName: m.name, persistent: m.persistent, probeSupported: m.probeSupported, probeReason: m.probeReason, origin: 'external', inheritsParentContext: false, reasoning: { effective: m.reasoningEffort, source: '配对 agent 声明', selectable: false }, health: health.get(m.model) ?? { status: 'untested' } }] }))], defaultSelection: { model: 'deepseek-flash', ...fixtureRoute('deepseek-flash') }, warnings: [] });
  adapter.modelDetails = async input => ({ health: health.get(input.model) ?? { status: 'untested' }, reasoning: { ...reasoning, effective: input.reasoningEffort || 'max' } });
  adapter.probeModel = async input => {
    let result;
    if (input.provider.startsWith('paired:')) { const response = await adapter.paired.run(input.provider, { mode: 'probe', cwd: path.join(root, 'probe'), prompt: 'OK' }, new AbortController().signal); result = { status: 'available', reason: 'Fixture runner response', reasoning: { effective: response.reasoningEffort, selectable: false, source: '执行器实际返回' } }; }
    else { result = { status: input.model === 'offline-test-model' ? 'unavailable' : 'available', reason: input.model === 'offline-test-model' ? '模拟认证失败（401）' : '模拟模型请求成功', ...(await adapter.modelDetails(input)) }; delete result.health; }
    result.checkedAt = new Date().toISOString(); result.latencyMs = 10; health.set(input.model, result); store.transaction(() => store.event('model.checked', input.model, { status: result.status }, OWNER)); return result;
  };
  const workspaces = new WorkspaceManager(dataDir, company); const engine = new Engine(company, adapter, workspaces, { intervalMs: 50 });
  const conversations = new Conversations(company, engine, adapter, dataDir);
  const command = (name, args) => company.command(OWNER, randomUUID(), name, args);
  if (seed) {
    const project = command('project.save', { name: '产品演示项目', repoRoot: source, mode: 'copy', checks: [] });
    const goal = command('goal.create', { title: '交付待办应用 Demo', description: '用一个小型产品验证自主规划、执行、审查与交付。', acceptance: '交付物存在，功能说明完整，独立审查通过。', projectId: project.id, plan: false });
    const a = command('task.create', { goalId: goal.id, title: '搭建应用基础结构', description: '组织页面和数据结构，形成后续开发可使用的基础。', longLived: true });
    command('task.create', { goalId: goal.id, title: '完善待办交互与使用说明', description: '补全任务创建、状态切换和交接说明。', dependencies: [a.id] });
    command('task.create', { goalId: goal.id, title: '确认品牌素材', description: '核对图标和品牌配色，素材缺失时仅暂停这个分支。' });
  }
  await engine.start();
  const bundle = await build({ entryPoints: ['scripts/preview-entry.jsx'], bundle: true, format: 'iife', platform: 'browser', write: false, define: { 'process.env.NODE_ENV': '"production"' } });
  const client = await readFile('lib/client.js');
  const routes = createRoutes({ dataDir, store, company, adapter, workspaces, engine, conversations }); const pending = new Set();
  const server = http.createServer((req, res) => {
    const handler = (async () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ACMS · isolated UI test</title><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="/bootstrap.js"></script></body></html>'); return; }
      if (pathname === '/bootstrap.js' || pathname === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(pathname === '/client.js' ? client : bundle.outputFiles[0].contents); return; }
      const route = routes.find(r => r.path === pathname && r.methods.includes(req.method));
      if (!route) { res.writeHead(404); res.end('Not found'); return; }
      const parts = []; for await (const chunk of req) parts.push(chunk);
      const controller = new AbortController(); res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, signal: controller.signal, ...(req.method === 'POST' ? { body: Buffer.concat(parts) } : {}) });
      const response = await route.fetch(request); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(e => { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end(e.message); });
    pending.add(handler); handler.finally(() => pending.delete(handler));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { root, source, dataDir, company, engine, url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...pending]); await conversations.close(); await engine.stop(); store.close(); },
  };
}
