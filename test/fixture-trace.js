import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCommandCleanup } from '../src/runtime/host-command.js';
import { run } from '../src/runtime/workspaces.js';

const tracedGitCommands = new Set(['add', 'bundle', 'checkout', 'checkout-index', 'check-ref-format', 'clone', 'commit', 'commit-tree', 'config',
  'diff', 'fetch', 'hash-object', 'init', 'ls-files', 'ls-tree', 'merge', 'merge-base', 'read-tree', 'reflog', 'reset',
  'rev-parse', 'show', 'status', 'symbolic-ref', 'update-index', 'update-ref', 'worktree', 'write-tree']);
const gitOptionsWithValue = new Set(['-c', '-C', '--git-dir', '--work-tree', '--config-env']);

export function fixtureCommandLabel(command, args) {
  if (!['git', 'git.exe'].includes(path.basename(command).toLowerCase())) return 'project-check';
  let index = 0;
  while (args[index]?.startsWith('-')) index += gitOptionsWithValue.has(args[index]) ? 2 : 1;
  const subcommand = args[index];
  return tracedGitCommands.has(subcommand) ? 'git:' + subcommand : 'git:other';
}

function fixtureTrace() {
  const limit = 12, inFlight = new Set(), recent = [];
  return {
    async observe(operation, invoke, subject) {
      const span = { operation, stage: 'entered' };
      if (typeof subject === 'string' && /^(?:task|project)_[0-9a-f-]{36}$/.test(subject)) span.subject = subject;
      const started = performance.now();
      const entry = { span, started };
      inFlight.add(entry);
      let outcome = 'returned';
      try {
        return await invoke(span);
      } catch (error) {
        outcome = 'threw';
        if (error?.cleanupUncertain === true) span.cleanupUncertain = true;
        throw error;
      } finally {
        inFlight.delete(entry);
        recent.push({ ...span, outcome, elapsedMs: Math.round(performance.now() - started) });
        if (recent.length > limit) recent.shift();
      }
    },
    read() {
      const snapshotTime = performance.now();
      return { inFlight: [...inFlight].slice(-limit).map(({ span, started }) => ({
        ...span, elapsedMs: Math.round(snapshotTime - started),
      })), recent: recent.slice() };
    },
  };
}

export async function tracedRun(span, command, args, cwd, options) {
  span.stage = 'running';
  const started = performance.now();
  try {
    const result = await run(command, args, cwd, options);
    span.exitCode = result.code;
    span.timedOut = result.timedOut === true;
    return result;
  } finally {
    span.commandMs = Math.round(performance.now() - started);
  }
}

export function traceFixtureWorkspace(workspaces, { composition = false } = {}) {
  const trace = fixtureTrace();
  const methods = [['prepare', 'prepare'], ['integrate', 'integrate']];
  if (composition) methods.push(['prepareCompositionTask', 'prepare-git-composition'],
    ['prepareCopyCompositionTask', 'prepare-copy-composition'], ['recheckGoalComposition', 'recheck-composition']);
  for (const [method, operation] of methods) {
    const invoke = workspaces[method].bind(workspaces);
    workspaces[method] = (task, ...args) => trace.observe(operation, () => invoke(task, ...args), task?.id);
  }
  const validate = workspaces.validateProject.bind(workspaces);
  const validationCommand = (command, args, cwd, options) => trace.observe(fixtureCommandLabel(command, args),
    span => tracedRun(span, command, args, cwd, options));
  workspaces.validateProject = (project, invoke = validationCommand) =>
    trace.observe('validate-project', () => validate(project, invoke), project?.id);
  return trace;
}

export function traceContainedFixture(t, workspaces) {
  const trace = traceFixtureWorkspace(workspaces);
  const context = new AsyncLocalStorage();
  const phases = channel('acms.owned-process.native-phase');
  const observeNative = record => {
    const span = context.getStore();
    if (!span) return;
    if (record.phase === 'helper-lookup' || record.phase === 'helper-compile' || record.phase === 'compiler-cleanup') {
      span.bootstrap ??= [];
      if (span.bootstrap.length < 4) span.bootstrap.push({ phase: record.phase, outcome: record.outcome, elapsedMs: record.elapsedMs,
        exitCode: record.exitCode, confirmed: record.confirmed });
    } else if (record.phase === 'helper-acquire') {
      span.helper = { use: record.use, outcome: record.outcome, elapsedMs: record.elapsedMs };
    } else if (record.phase === 'supervisor-handshake') {
      span.handshake = { outcome: record.outcome, elapsedMs: record.elapsedMs };
      if (record.outcome === 'started') span.stage = 'running-or-awaiting-native-cleanup';
    } else if (record.phase === 'supervisor-cleanup') {
      span.stage = 'native-cleanup-returned';
      span.nativeCleanup = { outcome: record.outcome, elapsedMs: record.elapsedMs, confirmed: record.confirmed,
        jobConfirmed: record.jobConfirmed, supervisorExited: record.supervisorExited, exitCode: record.rootExitCode };
    }
  };
  phases.subscribe(observeNative);
  t.after(() => phases.unsubscribe(observeNative));
  for (const method of ['runIntegrationCommand', 'runDeliveryCheck']) {
    const invoke = workspaces[method].bind(workspaces);
    workspaces[method] = (command, args, cwd, options) => trace.observe(fixtureCommandLabel(command, args), span => context.run(span, async () => {
      span.source = 'windows-job';
      span.stage = 'preparing-native-command';
      const started = performance.now();
      try {
        const result = await invoke(command, args, cwd, { ...options, beforeStart: executable => {
          span.stage = 'guard';
          options?.beforeStart?.(executable);
          span.stage = 'awaiting-native-result';
        } });
        span.exitCode = result.code;
        span.timedOut = result.timedOut === true;
        span.cleanupConfirmed = result.cleanupConfirmed === true;
        span.stage = 'command-returned';
        return result;
      } finally {
        span.commandMs = Math.round(performance.now() - started);
      }
    }));
  }
  return trace;
}

export function simulateFixtureCleanup(workspaces, trace) {
  const invoke = async (command, args, cwd, options, span) => {
    if (span) { span.source = 'fixture-simulated'; span.stage = 'guard'; }
    options.beforeStart?.(command);
    const result = span ? await tracedRun(span, command, args, cwd, options) : await run(command, args, cwd, options);
    if (options.cleanupReceipt) {
      if (span) span.stage = 'cleanup-receipt';
      await writeFile(options.cleanupReceipt, JSON.stringify({ confirmed: true, exitCode: result.code ?? 1 }));
      if (span) span.cleanupConfirmed = true;
    }
    return { ...result, cleanupConfirmed: true };
  };
  const command = trace ? (executable, args, cwd, options) => trace.observe(fixtureCommandLabel(executable, args),
    span => invoke(executable, args, cwd, options, span)) : invoke;
  workspaces.runIntegrationCommand = workspaces.runDeliveryCheck = command;
}

export function compositionWaitDiagnostics(f, goalId, trace) {
  return () => {
    const { store } = f;
    const goal = store.require('goals', goalId);
    const tasks = store.list('tasks').filter(task => task.goalId === goalId);
    const attempts = store.list('attempts').filter(attempt => attempt.goalId === goalId);
    return {
      goalStatus: goal.status, completionPending: goal.completionPending, compositionRecheck: goal.compositionRecheck?.status,
      scheduler: { ticking: f.engine.ticking, closing: f.engine.closing, activeIntegration: !!f.engine.activeIntegration,
        queuedIntegrations: f.engine.queuedIntegrations.size },
      tasks: tasks.map(({ id, kind, status, activeAttemptId, blocker, integrationPending, recoveryRequested, integrationRecovery }) =>
        ({ id, kind, status, activeAttemptId, blockerKind: blocker?.kind, integrationPending, recoveryRequested, recoveryHold: !!integrationRecovery })),
      attempts: attempts.map(({ id, taskId, status, cleanupPending, cleanupUncertain }) =>
        ({ id, taskId, status, cleanupPending: cleanupPending ?? null, cleanupUncertain: cleanupUncertain ?? null })),
      integrations: store.list('integrations').filter(row => row.goalId === goalId).slice(-8).map(row => ({
        id: row.id, taskId: row.taskId, phase: row.phase, commandPending: !!row.commandId, inspectionPending: !!row.inspectionCommandId,
        commandCleanupConfirmed: row.commandCleanupConfirmed ?? null, applyStarted: !!row.applyStartedAt,
      })),
      recentEvents: store.page(Math.max(0, store.cursor() - 15), 15).entries.filter(event => event.goalId === goalId)
        .map(({ seq, type, entityId }) => ({ seq, type, entityId })),
      trace: trace.read(),
    };
  };
}

export function integrationWaitDiagnostics(f, goalId, trace) {
  const state = compositionWaitDiagnostics(f, goalId, trace);
  return async () => {
    const snapshot = state();
    const commands = snapshot.integrations.flatMap(({ id, commandPending, inspectionPending }) => {
      const row = f.store.require('integrations', id);
      return [...(commandPending ? [{ integrationId: id, kind: 'execution', commandId: row.commandId }] : []),
        ...(inspectionPending ? [{ integrationId: id, kind: 'inspection', commandId: row.inspectionCommandId }] : [])];
    });
    const receipts = await Promise.all(commands.map(async ({ integrationId, kind, commandId }) => {
      const proof = await readCommandCleanup(path.join(f.dataDir, 'integration-receipts', commandId + '.json'));
      // A live engine can consume/unlink the receipt during this diagnostic read.
      const current = f.store.get('integrations', integrationId);
      const checkpointMoved = current?.[kind === 'execution' ? 'commandId' : 'inspectionCommandId'] !== commandId;
      return { integrationId, kind, checkpointMoved, confirmed: !!proof, notStarted: proof?.notStarted === true, exitCode: proof?.exitCode ?? null };
    }));
    return { ...snapshot, receipts };
  };
}
