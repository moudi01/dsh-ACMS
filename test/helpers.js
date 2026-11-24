import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { WorkspaceManager, inside, run } from '../src/runtime/workspaces.js';
import { Engine } from '../src/runtime/engine.js';
import { SimulatedAdapter, defaultSimulation } from '../src/adapters/simulated.js';
import { OWNER } from '../src/core/util.js';

// Hosted Windows runners can be slow to observe the same scheduled state.
// Explicit test bounds still apply when a test supplies its own timeout.
export const hostedWindows = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const stateWaitMs = hostedWindows ? 24000 : 8000;

export async function fixture(t, handler = defaultSimulation, { inMemory = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'acms-test-')); const source = path.join(root, 'source'); const dataDir = path.join(root, 'data');
  await mkdir(source); await writeFile(path.join(source, 'README.md'), '# Isolated ACMS test fixture\n');
  if (inMemory) await mkdir(dataDir);
  const store = new Store(inMemory ? ':memory:' : path.join(dataDir, 'company.db')); const company = new Company(store);
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
export async function until(predicate, timeout = stateWaitMs, diagnostics) {
  const started = performance.now();
  let polls = 0;
  while (performance.now() - started < timeout) {
    polls += 1;
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const elapsed = Math.round(performance.now() - started);
  const detail = diagnostics ? JSON.stringify(await diagnostics()) : '';
  const condition = predicate.toString().replace(/\s+/g, ' ').slice(0, 180);
  throw new Error(`Condition not reached within test deadline (${timeout} ms). Observed ${polls} polls in ${elapsed} ms while checking ${condition}${detail ? '\nState ' + detail : ''}`);
}

// Only state and event types: enough to distinguish slow native I/O from a
// stalled workflow, without dumping prompts, command output or credentials.
export function taskWaitDiagnostics(f, taskId) {
  return () => {
    const task = f.store.require('tasks', taskId);
    return { taskId, status: task.status, blockerKind: task.blocker?.kind, integrationStatus: task.integration?.status,
      attempts: f.store.list('attempts').filter(a => a.taskId === taskId).map(a => ({ id: a.id, status: a.status, cleanupPending: a.cleanupPending })),
      recentEvents: f.store.page(Math.max(0, f.store.cursor() - 15), 15).entries.map(e => ({ seq: e.seq, type: e.type, entityId: e.entityId })) };
  };
}

export async function gitProject(f, checks = []) {
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=ACMS Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'Initial fixture']]) {
    const result = await run('git', args, f.source); assert.equal(result.code, 0, result.stderr);
  }
  f.command('project.save', { id: f.project.id, mode: 'git', autoMerge: true, checks });
  return (await run('git', ['rev-parse', 'HEAD'], f.source)).stdout;
}
