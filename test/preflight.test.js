import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DshAdapter } from '../src/adapters/dsh.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { classifyEnvironment, environmentFailure } from '../src/runtime/preflight.js';
import { createRoutes } from '../src/host/http.js';
import { fixture, until } from './helpers.js';

const readTask = (f, task) => f.store.require('tasks', task.id);
const handoffs = f => f.store.list('tasks').filter(t => t.origin?.blockerKind === 'environment');
const blocked = (f, task) => until(() => !f.engine.live.size && readTask(f, task).status === 'blocked' && readTask(f, task).environmentBlock);

for (const finalReview of [false, true]) test(`dependency recovery completes the goal with finalReview=${finalReview}`, async t => {
  const f = await fixture(t);
  f.command('project.save', { id: f.project.id, checks: [
    { id: 'package-check', command: 'node', args: ['-e', "require('fixture-package')"], requiredPackages: ['fixture-package'] },
  ] });
  const goal = finalReview ? f.command('goal.create', { projectId: f.project.id, title: 'Review after recovery',
    description: 'Verify recovery under the standard template', acceptance: 'Deliver and review the artifact', templateId: 'base', plan: false }) : f.goal;
  const task = f.task({ goalId: goal.id });
  await f.start();
  const before = await blocked(f, task);
  assert.equal(before.failures[0].subject, 'fixture-package');
  assert.equal(readTask(f, task).attempts, 0);
  assert.equal(f.adapter.calls.length, 0);
  assert.equal(handoffs(f).length, 1);
  assert.equal(handoffs(f)[0].status, 'blocked');
  const workspace = readTask(f, task).workspace.path;
  const installed = path.join(workspace, 'node_modules', 'fixture-package');
  await mkdir(installed, { recursive: true });
  await writeFile(path.join(installed, 'package.json'), '{"main":"index.js"}');
  await writeFile(path.join(installed, 'index.js'), 'module.exports = {};');
  f.command('task.resume', { id: task.id });
  await until(() => f.store.require('goals', goal.id).status === 'succeeded');
  assert.equal(readTask(f, task).status, 'succeeded');
  assert.equal(f.adapter.calls.length, finalReview ? 2 : 1);
  assert.equal(f.adapter.calls[0].task.workspace.path, workspace);
  assert.equal(readTask(f, task).generation, task.generation);
  assert.equal(handoffs(f)[0].status, 'cancelled');
  assert.equal(handoffs(f)[0].environmentResolution.sourceTaskId, task.id);
  assert.equal(f.store.list('verifications').filter(v => v.kind === 'goal-review' && v.passed).length, finalReview ? 1 : 0);
});

function routingFixture(f) {
  const launched = [];
  const llm = {
    listProviders: () => [{ id: 'fixture' }],
    listModels: async () => ['old-model', 'new-model'].map(id => ({ id, provider: 'fixture' })),
    resolveModelInfo: async () => ({}),
  };
  const providers = new Map(['spawn', 'fork'].map(name => [name, { name, capabilities: { agentOptions: true }, prepareContinuable() {} }]));
  const services = { llm, tools: { get: name => name === 'write' ? {} : undefined } };
  const ctx = { get: key => services[key], agents: { create: async () => ({ agent: { id: 'parent' }, dispose: async () => {} }) },
    subagents: { providers, startActivation: async request => { launched.push(request); throw new Error('Unexpected fixture launch'); } } };
  const adapter = new DshAdapter(ctx, f.company, f.dataDir);
  f.engine.adapter = adapter;
  f.command('agent.save', { id: 'manager', status: 'retired' });
  return { adapter, llm, launched };
}

for (const field of ['allowedModels', 'allowedProviders']) test(`revoking ${field} during final preflight prevents dispatch`, async t => {
  const f = await fixture(t);
  const { adapter, launched } = routingFixture(f);
  const agent = f.command('agent.save', { name: 'Bound worker', provider: 'spawn', model: 'old-model' });
  const task = f.task({ agentId: agent.id });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const inspect = adapter.inspectEntry.bind(adapter);
  let inspections = 0;
  adapter.inspectEntry = async (...args) => {
    if (++inspections === 2) { entered.resolve(); await release.promise; }
    return inspect(...args);
  };
  await f.start();
  try {
    await Promise.race([entered.promise, until(() => inspections === 2)]);
    f.command('policy.update', { patch: { [field]: [field === 'allowedModels' ? 'new-model' : 'fork'] } });
  } finally { release.resolve(); }
  await until(() => readTask(f, task).status === 'blocked' &&
    f.store.list('attempts').some(a => a.taskId === task.id && a.selection?.status === 'blocked'));
  assert.equal(launched.length, 0);
  const attempts = f.store.list('attempts').filter(a => a.taskId === task.id);
  assert.equal(attempts[0].preflightOnly, true);
  assert.equal(attempts.at(-1).selection.status, 'blocked');
});

test('a binding change during model metadata lookup preflights the new provider before launch', async t => {
  const f = await fixture(t);
  const { adapter, llm, launched } = routingFixture(f);
  const agent = f.command('agent.save', { name: 'Bound worker', provider: 'spawn', model: 'old-model' });
  const task = f.task({ agentId: agent.id });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let waiting = false;
  llm.resolveModelInfo = async () => { waiting = true; entered.resolve(); await release.promise; return {}; };
  const inspect = adapter.inspectEntry.bind(adapter);
  adapter.inspectEntry = async (provider, ...args) => {
    const report = await inspect(provider, ...args);
    if (provider.name === 'fork') return { ...report, mounted: 'missing', failures: [environmentFailure('tools', '文件写入', true)] };
    return report;
  };
  await f.start();
  try {
    await Promise.race([entered.promise, until(() => waiting)]);
    f.command('agent.save', { id: agent.id, provider: 'fork', model: 'new-model' });
  } finally { release.resolve(); }
  const evidence = await blocked(f, task);
  assert.equal(evidence.report.runtime.mounted, 'missing');
  assert.equal(launched.length, 0);
  assert.equal(readTask(f, task).attempts, 0);
});

test('program and missing directory checks run before a model or workspace setup', async t => {
  const f = await fixture(t);
  f.command('project.save', { id: f.project.id, checks: [
    { id: 'fixture-executable', command: path.join(f.root, 'acms-missing-executable.exe'), args: [] },
  ] });
  const task = f.task();
  await rename(f.source, path.join(f.root, 'moved-source'));
  await f.start();
  const evidence = await blocked(f, task);
  assert.deepEqual(evidence.failures.map(failure => failure.code).sort(), ['directory', 'program']);
  assert.equal(readTask(f, task).workspace, undefined);
  assert.equal(f.adapter.calls.length, 0);
  await rename(path.join(f.root, 'moved-source'), f.source);
  f.command('task.resume', { id: task.id });
  const current = await until(() => readTask(f, task).environmentBlock?.failures.length === 1 && readTask(f, task).environmentBlock);
  assert.equal(current.failures[0].code, 'program');
  assert.notEqual(current.report.version, evidence.report.version);
  assert.equal(handoffs(f).length, 1);
  assert.equal(f.adapter.calls.length, 0);
});

test('Windows preflight detects a real create-file ACL denial without probing writes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const workspaceParent = path.join(f.dataDir, 'workspaces');
  await mkdir(workspaceParent);
  const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[\d-]+/)[0];
  const acl = (...args) => execFileSync('icacls.exe', [workspaceParent, ...args], { windowsHide: true });
  const task = f.task();
  try {
    acl('/deny', '*' + sid + ':(WD,AD)');
    await f.start();
    const evidence = await blocked(f, task);
    assert.equal(evidence.failures[0].subject, '工作副本父目录');
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(readTask(f, task).workspace, undefined);
  } finally { acl('/remove:d', '*' + sid); }
  f.command('task.resume', { id: task.id });
  await until(() => readTask(f, task).status === 'succeeded');
  assert.equal(f.adapter.calls.length, 1);
});

test('a native provider declaration does not substitute for actual scoped tool mounts or model verification', async t => {
  const f = await fixture(t);
  const tools = new Set();
  let mountsRead = 0, modelCalls = 0;
  const llm = { listProviders: () => [{ id: 'fixture' }], listModels: async () => [{ id: 'fixture-model', provider: 'fixture' }],
    resolveModelInfo: async () => ({}), stream: async function* () { modelCalls++; } };
  const parent = { id: 'parent' };
  const services = { llm, agentPresets: {}, tools: { get: (name, scope) => { mountsRead++; return scope === parent && tools.has(name) ? {} : undefined; } } };
  const ctx = { get: key => services[key], agents: { create: async () => ({ agent: parent, dispose: async () => {} }) },
    subagents: { providers: new Map([['spawn', { name: 'spawn', capabilities: { agentOptions: true }, prepareContinuable() {} }]]),
      startActivation: async () => { modelCalls++; throw new Error('Fixture must never launch the DSH model'); } } };
  const adapter = new DshAdapter(ctx, f.company, f.dataDir);
  f.adapter.inspectTaskRoute = adapter.inspectTaskRoute.bind(adapter);
  const task = f.task();
  const details = await adapter.modelDetails({ provider: 'spawn', model: 'fixture-model' });
  assert.equal(details.environment.entry, 'available');
  assert.equal(details.environment.mounted, 'unknown');
  await f.start();
  const evidence = await blocked(f, task);
  assert.equal(evidence.failures[0].code, 'tools');
  assert.equal(evidence.report.runtime.mounted, 'missing');
  assert.equal(evidence.report.runtime.authorization, 'unknown');
  assert.equal(evidence.report.runtime.modelVerification.status, 'untested');
  assert.deepEqual(f.store.require('agents', task.agentId).grants, []);
  assert.equal(f.adapter.calls.length, 0);
  assert(mountsRead > 0);
  tools.add('write');
  f.command('task.resume', { id: task.id });
  await until(() => readTask(f, task).status === 'succeeded');
  assert.equal(modelCalls, 0);
  assert.equal(f.adapter.calls.length, 1);
  await adapter.close();
});

test('late review ACL errors are held across ticks, restart and resume without false verdicts', async t => {
  let routeVersion = 'fixture-v1';
  const secret = 'acms_ag_secret_should_not_export';
  const f = await fixture(t, input => input.task.kind === 'review' && routeVersion === 'fixture-v1'
    ? { outcome: 'reviewed', decision: 'changes_requested', summary: 'Get-Acl: SeSecurityPrivilege required at C:\\Temp\\random\\file; token=' + secret }
    : defaultSimulation(input));
  f.adapter.inspectTaskRoute = async () => ({ report: { routeVersion, entry: 'available' } });
  const task = f.task();
  await f.start();
  await until(() => readTask(f, task).status === 'succeeded');
  const review = f.command('review.request', { id: task.id });
  const evidence = await blocked(f, review);
  const reviewCalls = () => f.adapter.calls.filter(call => call.task.id === review.id).length;
  assert.equal(reviewCalls(), 1);
  assert.equal(evidence.failures[0].code, 'acl');
  assert.equal(readTask(f, review).passed, undefined);
  assert.equal(f.store.list('verifications').filter(v => v.kind === 'review').length, 0);
  const exportRoute = createRoutes(f).find(r => r.path === '/api/acms/environment');
  const diagnostic = await (await exportRoute.fetch(new Request('http://localhost/api/acms/environment?id=' + review.id))).text();
  assert(!diagnostic.includes(secret));
  assert(!diagnostic.includes('random'));
  assert(diagnostic.includes(evidence.failures[0].fingerprint));
  await f.engine.stop();
  await f.start();
  for (let i = 0; i < 2; i++) {
    f.command('task.resume', { id: review.id });
    await blocked(f, review);
  }
  assert.equal(reviewCalls(), 1);
  assert.equal(handoffs(f).length, 1);
  assert.equal(readTask(f, review).environmentBlock.failures[0].fingerprint, evidence.failures[0].fingerprint);
  routeVersion = 'fixture-v2';
  f.command('task.resume', { id: review.id });
  await until(() => readTask(f, review).status === 'succeeded');
  assert.equal(reviewCalls(), 2);
  assert.equal(f.store.list('verifications').filter(v => v.kind === 'review').length, 1);
  assert.equal(readTask(f, task).reworks, 0);
});

test('known environment fingerprints distinguish failure categories and omit arbitrary messages', () => {
  const fingerprint = message => classifyEnvironment({ message })?.fingerprint;
  assert.equal(fingerprint("esbuild spawn EPERM path=C:\\tmp\\one.exe token=secret"), fingerprint('esbuild spawn EPERM path=D:\\tmp\\two.exe'));
  assert.notEqual(fingerprint('esbuild spawn EPERM'), fingerprint('esbuild Cannot read directory "../..": Access is denied'));
  assert.notEqual(fingerprint("Cannot find package 'esbuild'"), fingerprint("Cannot find package 'react'"));
  assert.notEqual(fingerprint("EPERM: unlink 'C:\\temp\\one'"), fingerprint("EPERM: rmdir 'C:\\temp\\one'"));
  assert.equal(fingerprint('Fetch failed: ECONNRESET'), undefined);
  assert.equal(fingerprint("Cannot find module 'C:\\temp\\secret'"), undefined);
});

test('a package first discovered at runtime is rechecked against the retained copy', async t => {
  let runs = 0;
  const f = await fixture(t, input => ++runs === 1 ?
    { outcome: 'blocked', kind: 'technical', reason: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'late-package'" } : defaultSimulation(input));
  const task = f.task();
  await f.start();
  const evidence = await blocked(f, task);
  assert.equal(evidence.failures[0].subject, 'late-package');
  f.command('task.retry', { id: task.id });
  await blocked(f, task);
  assert.equal(runs, 1);
  assert.equal(handoffs(f).length, 1);
  const directory = path.join(readTask(f, task).workspace.path, 'node_modules', 'late-package');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{"name":"late-package"}');
  f.command('task.resume', { id: task.id });
  await until(() => readTask(f, task).status === 'succeeded');
  assert.equal(runs, 2);
});

test('transient network errors retain the existing bounded retry path', async t => {
  let runs = 0;
  const f = await fixture(t, input => {
    if (++runs === 1) throw new Error('Fetch failed: ECONNRESET');
    return defaultSimulation(input);
  });
  const task = f.task();
  await f.start();
  await until(() => readTask(f, task).status === 'succeeded');
  assert.equal(runs, 2);
  assert.equal(handoffs(f).length, 0);
  assert.equal(readTask(f, task).environmentBlock, undefined);
});

test('paired diagnostics separate company, declared total, idle and cleanup without launching the runner', async t => {
  const f = await fixture(t);
  f.command('policy.update', { patch: { turnTimeoutMs: 3600000 } });
  const paired = new PairedRuntimes(f.company, f.dataDir, { spawn: () => { throw new Error('unexpected launch'); } });
  const model = { id: 'paired:fixture', command: process.execPath, args: [], limits: { totalMs: 1080000, idleMs: 300000, cleanupMs: 12000 } };
  f.store.put('externalModels', model);
  const result = await paired.inspectEntry(model.id);
  assert.equal(result.entry, 'available');
  assert.deepEqual(result.limits, { companyMs: 3600000, runnerMs: 1080000, idleMs: 300000, runnerCleanupMs: 12000, hostCleanupMs: 5000,
    disposeMs: 5000, runnerSource: 'declared', effectiveTotalMs: 1080000, effectiveLimitKnown: true, earliestKnownTimeoutMs: 300000 });
  assert.equal(paired.limits({}).effectiveLimitKnown, false);
  assert.equal(paired.limits({}).runnerMs, null);
});
