import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { Engine } from '../src/runtime/engine.js';
import { WorkspaceManager } from '../src/runtime/workspaces.js';
import { SimulatedAdapter, defaultSimulation } from '../src/adapters/simulated.js';
import { OWNER } from '../src/core/util.js';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(os.tmpdir(), 'acms-demo-')); const source = path.join(root, 'source'); const dataDir = path.join(root, 'data');
await mkdir(source); await writeFile(path.join(source, 'README.md'), '# ACMS deterministic demo\n');
const store = new Store(path.join(dataDir, 'company.db')); const company = new Company(store);
const project = company.command(OWNER, randomUUID(), 'project.save', { name: '模拟项目', repoRoot: source, mode: 'copy', checks: [] });
const goal = company.command(OWNER, randomUUID(), 'goal.create', { title: '验证自动公司闭环', description: '自动规划、执行、审查和交付。', acceptance: '所有任务有真实文件和独立审查记录。', projectId: project.id });
store.events.on('event', e => { if (['plan.accepted', 'review.queued', 'review.decided', 'task.succeeded', 'goal.succeeded'].includes(e.type)) console.log(`${e.seq} ${e.type} ${e.entityId}`); });
const engine = new Engine(company, new SimulatedAdapter(defaultSimulation), new WorkspaceManager(dataDir, company), { intervalMs: 30 });
try {
  await engine.start(); const deadline = Date.now() + 15000;
  while (store.require('goals', goal.id).status !== 'succeeded' && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  if (store.require('goals', goal.id).status !== 'succeeded') throw new Error(`Demo did not complete: ${engine.lastError ?? JSON.stringify(store.list('tasks').map(t => ({ title: t.title, status: t.status, feedback: t.feedback })))}`);
  console.log(JSON.stringify({ mode: 'simulation', result: 'passed', artifacts: store.list('artifacts').length, reviews: store.list('verifications').filter(v => v.kind === 'review' || v.kind === 'goal-review').length, dataDir }, null, 2));
} finally { await engine.stop(); store.close(); }
