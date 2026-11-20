import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../src/runtime/workspaces.js';

const tracedGitCommands = new Set(['add', 'bundle', 'checkout', 'checkout-index', 'check-ref-format', 'commit', 'commit-tree',
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
    ['prepareCopyCompositionTask', 'prepare-copy-composition']);
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

export function simulateFixtureCleanup(workspaces, trace) {
  const invoke = async (command, args, cwd, options, span) => {
    if (span) span.stage = 'guard';
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
      goalStatus: goal.status, compositionRecheck: goal.compositionRecheck?.status,
      tasks: tasks.map(({ id, kind, status, activeAttemptId, blocker }) =>
        ({ id, kind, status, activeAttemptId, blockerKind: blocker?.kind })),
      attempts: attempts.map(({ id, taskId, status, cleanupPending, cleanupUncertain }) =>
        ({ id, taskId, status, cleanupPending: cleanupPending ?? null, cleanupUncertain: cleanupUncertain ?? null })),
      integrations: store.list('integrations').filter(row => row.goalId === goalId).slice(-8).map(row => ({
        taskId: row.taskId, phase: row.phase, commandPending: !!row.commandId, inspectionPending: !!row.inspectionCommandId,
      })),
      recentEvents: store.page(Math.max(0, store.cursor() - 15), 15).entries.filter(event => event.goalId === goalId)
        .map(({ seq, type, entityId }) => ({ seq, type, entityId })),
      trace: trace.read(),
    };
  };
}
