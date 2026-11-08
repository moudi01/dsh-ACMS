import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { WorkspaceManager, inside } from '../src/runtime/workspaces.js';
import { Engine } from '../src/runtime/engine.js';
import { SimulatedAdapter, defaultSimulation } from '../src/adapters/simulated.js';
import { OWNER } from '../src/core/util.js';

export async function fixture(t, handler = defaultSimulation) {
  const root = await mkdtemp(path.join(tmpdir(), 'acms-test-')); const source = path.join(root, 'source'); const dataDir = path.join(root, 'data');
  await mkdir(source); await writeFile(path.join(source, 'README.md'), '# Isolated ACMS test fixture\n');
  const store = new Store(path.join(dataDir, 'company.db')); const company = new Company(store);
  const workspaces = new WorkspaceManager(dataDir, company); const adapter = new SimulatedAdapter(handler);
  const engine = new Engine(company, adapter, workspaces, { intervalMs: 20 });
  const command = (name, args = {}, principal = OWNER, requestId = randomUUID()) => company.command(principal, requestId, name, args);
  const project = command('project.save', { name: 'Fixture', repoRoot: source, mode: 'copy', checks: [] });
  // The default fixture goal delivers without review: review is an explicit,
  // user-requested sub-task, so ordinary scheduling tests should not need one.
  const template = command('workflow.publish', { id: 'fixture-direct', name: '直接交付', phases: [{ id: 'execute', name: '执行' }] });
  const goal = command('goal.create', { title: 'Fixture goal', description: 'Create verified test files.', acceptance: 'Files exist and independent review passes.', projectId: project.id, templateId: template.id, plan: false });
  let started = false;
  t.after(async () => { if (started) await engine.stop(); store.close(); const absolute = path.resolve(root); if (!inside(path.resolve(tmpdir()), absolute) || !path.basename(absolute).startsWith('acms-test-')) throw new Error('Refusing unsafe fixture cleanup'); await rm(absolute, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }); });
  return { root, source, dataDir, store, company, workspaces, adapter, engine, project, goal, template, command,
    task: (args = {}) => command('task.create', { goalId: goal.id, title: 'Deliver a file', description: 'Create a useful output file.', acceptance: 'Output exists and has content.', ...args }),
    start: async () => { await engine.start(); started = true; },
  };
}
export async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('Condition not reached within test deadline');
}
