import { digest, now, SYSTEM } from '../core/util.js';
import { ignoresBlocker } from '../core/blocker-policy.js';
import { matchesGoalContract } from '../core/goal-contract.js';
import { ENVIRONMENT_RECOVERED_REASON } from '../core/hierarchy.js';
import { inspectHost } from './preflight.js';

export async function inspectEnvironment(engine, task, agent, previous, route) {
  const [host, runtime] = await Promise.all([
    inspectHost(engine.workspaces, task, previous),
    route ?? engine.adapter.inspectTaskRoute?.(task, agent),
  ]);
  const { failures: hostFailures, ...hostReport } = host;
  const { failures: runtimeFailures = [], modelVerification, ...routeReport } = runtime?.report ?? {};
  return { selection: runtime?.selection, route: runtime, failures: [...hostFailures, ...runtimeFailures],
    report: { host: hostReport, runtime: { ...routeReport, modelVerification }, version: digest([hostReport, routeReport]) } };
}

export function holdEnvironment(engine, task, failures, report) {
  const { store } = engine;
  const previous = task.environmentBlock;
  const reason = failures.map(f => f.reason).join('；');
  const question = [...new Set(failures.map(f => f.recovery))].join(' ');
  const evidence = { failures, report, observedAt: previous?.observedAt ?? now() };
  let saved = store.put('tasks', { ...task, status: 'blocked', retryAt: null,
    blocker: task.blocker?.resolutionTaskIds?.length ? task.blocker : { kind: 'environment', reason },
    environmentBlock: { ...evidence, handoffId: previous?.handoffId ?? null, interactionId: previous?.interactionId ?? null } });
  if (!previous) {
    saved = engine.block(saved, 'environment', reason, question, evidence);
    const handoffId = saved.blocker?.resolutionTaskIds?.[0];
    const handoff = handoffId && store.get('tasks', handoffId);
    const interaction = store.list('interactions').find(i => i.taskId === task.id && i.status === 'pending' && i.reason.includes(reason));
    saved = store.put('tasks', { ...saved, environmentBlock: { ...saved.environmentBlock,
      handoffId: handoff?.origin?.blockerKind === 'environment' ? handoffId : null, interactionId: interaction?.id ?? null } });
  } else {
    const handoff = previous.handoffId && store.get('tasks', previous.handoffId);
    if (handoff?.blocker?.kind === 'environment-handoff') {
      const fact = { kind: 'environment', reason, evidence };
      store.put('tasks', { ...handoff, feedbackHash: digest(fact), blockerEvidence: fact,
        blocker: { ...handoff.blocker, reason },
        description: ('执行环境待恢复。\n' + reason + '\n' + question + '\n原任务：' + task.description).slice(0, 15000) });
    }
    const interaction = previous.interactionId && store.get('interactions', previous.interactionId);
    if (interaction?.status === 'pending') store.put('interactions', { ...interaction, reason, question });
  }
  store.event('task.environment.blocked', task.id, { fingerprints: failures.map(f => f.fingerprint), environmentVersion: report.version }, SYSTEM);
  engine.updateGoal(task.goalId);
  return saved;
}

function verifiedAfter(failure, previous, report) {
  const route = report.runtime;
  const oldRoute = previous.report.runtime;
  // Runtime-only failures can be checked against a different execution route
  // or changed runtime configuration. Host permissions alone do not verify a
  // child sandbox. A manual model probe is evidence only for authentication.
  const routeChanged = !!route.routeVersion && !!oldRoute.routeVersion && route.routeVersion !== oldRoute.routeVersion;
  if (failure.code === 'package') {
    const missingBefore = previous.report.host.packages.some(p => p.subject === failure.subject && p.status === 'missing');
    return (missingBefore || routeChanged) && report.host.packages.some(p => p.subject === failure.subject && p.status === 'available');
  }
  if (failure.observable) {
    if (failure.code === 'tools') return route.mounted === 'available';
    if (failure.code === 'authorization') return route.sandboxMode === 'workspace-write' || route.sandboxMode === 'danger-full-access';
    if (failure.code === 'directory') return report.host.directories.some(d => d.subject === failure.subject && d.status === 'available') ||
      (failure.subject === 'ACMS 数据目录' && report.host.directories.some(d => d.subject === '工作副本父目录' && d.status === 'available'));
    if (failure.code === 'program') return report.host.programs.some(p => p.subject === failure.subject && p.status === 'available') ||
      (failure.subject.startsWith('配对') && route.entry === 'available');
  }
  if (failure.code === 'authentication' && route.modelVerification?.status === 'available' &&
      Date.parse(route.modelVerification.checkedAt) > Date.parse(previous.observedAt)) return true;
  if (failure.code === 'esbuild' && failure.subject === 'esbuild directory') {
    const ancestors = report.host.directories.filter(d => d.subject.startsWith('esbuild 上级目录 '));
    const deniedBefore = previous.report.host.directories.some(d => d.subject.startsWith('esbuild 上级目录 ') && d.status === 'denied');
    if (deniedBefore && ancestors.length && ancestors.every(d => d.status === 'available')) return true;
  }
  return routeChanged;
}

function clearEnvironment(engine, task, report) {
  const { store, company } = engine;
  const { handoffId, interactionId } = task.environmentBlock;
  const handoff = handoffId && store.get('tasks', handoffId);
  const waiting = handoff?.status === 'blocked' && handoff.blocker?.kind === 'environment-handoff';
  const detachable = waiting || handoff?.status === 'cancelled' || handoff?.status === 'deleted';
  const dependencies = detachable ? task.dependencies.filter(id => id !== handoffId) : task.dependencies;
  if (waiting) {
    const closed = company.controlTask({ id: handoffId, reason: ENVIRONMENT_RECOVERED_REASON }, 'cancelled', SYSTEM);
    store.put('tasks', { ...closed, environmentResolution: {
      sourceTaskId: task.id, environmentVersion: report.version, resolvedAt: now(),
    } });
  }
  const interaction = interactionId && store.get('interactions', interactionId);
  if (interaction?.status === 'pending') store.put('interactions', { ...interaction, status: 'cancelled', reason: '环境重新预检通过' });
  const relatedBlocker = task.blocker?.kind === 'environment' || (interaction && task.blocker?.kind === interaction.kind) ||
    (detachable && task.blocker?.resolutionTaskIds?.includes(handoffId));
  const blocker = relatedBlocker ? null : task.blocker;
  const pending = store.list('interactions').some(i => i.taskId === task.id && i.status === 'pending');
  const ready = !pending && !blocker && dependencies.every(id => store.get('tasks', id)?.status === 'succeeded');
  store.put('tasks', { ...task, dependencies, blocker, environmentBlock: null, status: ready ? 'ready' : 'blocked',
    attempts: 0, retryAt: null });
  store.event('task.environment.recovered', task.id, { environmentVersion: report.version }, SYSTEM);
  engine.updateGoal(task.goalId);
}

export async function refreshEnvironmentGates(engine) {
  const { store } = engine;
  const poll = Date.now() >= (engine.nextEnvironmentCheck ?? 0);
  if (poll) engine.nextEnvironmentCheck = Date.now() + 5000;
  for (const task of store.list('tasks')) {
    if (!task.environmentBlock || !['ready', 'blocked'].includes(task.status) || (!poll && task.status !== 'ready') ||
        ignoresBlocker(task) || task.contractObsolete || [...engine.live.values()].some(entry => entry.taskId === task.id)) continue;
    const goal = store.require('goals', task.goalId);
    if (!matchesGoalContract(goal, task) || goal.contractChange?.status === 'pending') continue;
    const agent = store.get('agents', task.agentId);
    if (!agent || agent.status !== 'available') continue;
    let observed;
    try {
      observed = await inspectEnvironment(engine, task, agent, task.environmentBlock);
      engine.adapter.assertTaskRouteCurrent?.(agent, observed.selection);
    }
    catch { continue; } // Unavailable observations cannot clear a durable gate.
    engine.fenced();
    store.transaction(() => {
      const current = store.require('tasks', task.id);
      if (current.revision !== task.revision || engine.company.policy().paused || engine.closing) return;
      const previous = task.environmentBlock;
      const unresolved = previous.failures.filter(failure => !verifiedAfter(failure, previous, observed.report));
      const failures = [...new Map([...unresolved, ...observed.failures].map(f => [f.fingerprint, f])).values()];
      if (!failures.length) clearEnvironment(engine, task, observed.report);
      else if (observed.report.version !== previous.report.version || digest(failures) !== digest(previous.failures)) {
        holdEnvironment(engine, task, failures, observed.report);
      } else if (task.status === 'ready') store.put('tasks', { ...task, status: 'blocked' });
    });
  }
}
