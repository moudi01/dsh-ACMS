import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AcmsError, assert, digest, id, now, SYSTEM } from '../core/util.js';
import { ignoresBlocker } from '../core/blocker-policy.js';
import { goalRuntimeLimit, goalRuntimeSpent } from '../core/runtime-budget.js';
import { contractVersion, matchesGoalContract } from '../core/goal-contract.js';
import { integrationPending } from '../core/task-actions.js';
import { executionOccupancy } from '../core/execution-capacity.js';
import { readCommandCleanup } from './host-command.js';
import { goalStopped } from '../core/goal-control.js';
import { candidateMergeMatches } from '../core/candidate-confirmation.js';
import { applyConfirmedCandidate, assertCandidateReservation, candidateGitEnvironment, releaseCandidateReservation } from './candidate-merge.js';

function contract(engine, projectId) {
  const project = engine.store.require('projects', projectId);
  return digest({
    root: project.repoRoot, mode: project.mode, status: project.status ?? null, autoMerge: project.autoMerge,
    checks: project.checks, preparation: project.preparation ?? null, allowedRoots: engine.company.policy().allowedProjectRoots,
  });
}

const receipt = (engine, commandId) => path.join(engine.workspaces.dataDir, 'integration-receipts', commandId + '.json');
const owns = engine => engine.store.ownsLease(engine.owner, engine.epoch);

function save(engine, record, patch, event) {
  return engine.store.transaction(() => {
    engine.fenced();
    const current = engine.store.require('integrations', record.id);
    const saved = engine.store.put('integrations', { ...current, ...patch });
    if (event) engine.store.event(event, record.taskId, {
      integrationId: record.id, generation: saved.generation, phase: saved.phase,
      targetHead: saved.targetHead ?? null, targetRef: saved.targetRef ?? null,
      integratedCommit: saved.integratedCommit ?? null, stopRequested: saved.stopRequested ?? null,
      actualHead: saved.result?.actualHead ?? saved.observed?.actualHead ?? null,
    }, SYSTEM);
    return saved;
  });
}

function settleCompositionRecheck(engine, record, { result, error, reason, observed, commandCleanupConfirmed, retryCheckpoint }) {
  const goal = engine.store.require('goals', record.goalId);
  const request = goal.compositionRecheck;
  const matches = request?.id === record.compositionRecheckId && request.integrationId === record.id;
  if (reason) {
    save(engine, record, { phase: 'reconciling', reason, commandCleanupConfirmed, observed: observed ?? null }, 'integration.reconciling');
    if (matches) engine.store.put('goals', { ...goal, compositionRecheck: { ...request, status: 'reconciling', reason } });
    return;
  }
  if (!matches || ['cancelled', 'archived', 'deleted'].includes(goal.status)) {
    save(engine, record, { phase: 'stopped', finishedAt: now() }, 'integration.stopped');
    if (matches) engine.store.put('goals', { ...goal, compositionRecheck: null });
    return;
  }
  const currentContract = record.goalContractVersion === contractVersion(goal) && goal.contractChange?.status !== 'pending';
  if (result && currentContract) {
    save(engine, record, { phase: 'completed', result, finishedAt: now() }, 'integration.completed');
    engine.store.put('goals', { ...goal, composition: result.composition, compositionRecheck: null, completionPending: 'delivery' });
    engine.store.event('goal.composition.verified', goal.id, { version: result.composition.version }, SYSTEM);
    return;
  }
  const retry = currentContract && (retryCheckpoint || engine.closing || goalStopped(goal) || engine.company.policy().paused);
  const failure = currentContract ? error?.message ?? '无法重新核对完整候选。' : '目标合同已变化，请核对当前输入后重新检查。';
  save(engine, record, { phase: retry ? 'stopped' : 'failed', reason: retry ? null : failure, finishedAt: now() }, retry ? 'integration.stopped' : 'integration.failed');
  engine.store.put('goals', { ...goal, compositionRecheck: { ...request, status: retry ? 'queued' : 'failed', reason: retry ? null : failure, integrationId: null } });
}

function settleCandidateMerge(engine, record, { result, error, reason, observed, commandCleanupConfirmed, retryCheckpoint }) {
  const goal = engine.store.require('goals', record.goalId);
  const request = goal.candidateMerge;
  const current = request?.id === record.candidateMergeId && request.integrationId === record.id;
  const saveRequest = fields => {
    if (current) engine.store.put('goals', { ...goal, candidateMerge: { ...request, recoveryRequested: false, ...fields } });
  };
  if (reason) {
    save(engine, record, { phase: 'reconciling', reason, commandCleanupConfirmed, observed: observed ?? null }, 'integration.reconciling');
    saveRequest({ status: 'reconciling', reason });
    return;
  }
  if (result) {
    save(engine, record, { phase: 'completed', result, reason: null, finishedAt: now() }, 'integration.completed');
    saveRequest({ status: 'applied', reason: null, result });
    engine.store.event('goal.candidate_merge.applied', goal.id, { previewId: record.candidateMergeId, version: record.candidateVersion,
      confirmedBy: record.confirmedBy, targetRef: record.targetRef, targetHead: record.targetHead, actualHead: result.actualHead,
      integratedCommit: result.integratedCommit }, SYSTEM, { goalId: goal.id });
    return;
  }
  const cancelled = request?.stopRequested || ['cancelled', 'archived', 'deleted'].includes(goal.status);
  const resume = current && !cancelled && (retryCheckpoint || engine.closing || goal.executionControl?.state === 'paused' || engine.company.policy().paused);
  const reasonText = error?.message ?? '合入已停止，请重新预览目标分支。';
  const stopped = cancelled || resume;
  save(engine, record, { phase: stopped ? 'stopped' : 'failed', reason: stopped ? null : reasonText, observed: observed ?? null, finishedAt: now() },
    stopped ? 'integration.stopped' : 'integration.failed');
  saveRequest({ status: cancelled ? 'cancelled' : resume ? 'queued' : 'failed', reason: stopped ? null : reasonText, integrationId: null });
}

function settle(engine, record, { result, error, reason, observed, commandCleanupConfirmed = false, retryCheckpoint = false }) {
  return engine.store.transaction(() => {
    engine.fenced();
    if (record.candidateMergeId) return settleCandidateMerge(engine, record,
      { result, error, reason, observed, commandCleanupConfirmed, retryCheckpoint });
    if (record.compositionRecheckId) return settleCompositionRecheck(engine, record,
      { result, error, reason, observed, commandCleanupConfirmed, retryCheckpoint });
    const task = engine.store.require('tasks', record.taskId);
    if (task.activeIntegrationId !== record.id) return;
    const stopRequested = task.stopRequested ?? null;
    const fields = { activeIntegrationId: null, stopRequested: null, recoveryRequested: false, integrationRecovery: null };
    if (reason) {
      save(engine, record, { phase: 'reconciling', reason, stopRequested, commandCleanupConfirmed, observed: observed ?? null }, 'integration.reconciling');
      engine.store.put('tasks', { ...task, status: 'reconciling', recoveryRequested: false, integrationRecovery: { reason, observed: observed ?? null } });
      return;
    }
    if (task.generation !== record.generation || task.artifactHash !== record.artifactHash) {
      // Retain evidence from a superseded run without accepting it against
      // the current delivery contract.
      save(engine, record, { phase: result ? 'completed' : 'stopped', result: result ?? null, finishedAt: now() }, 'integration.superseded');
      engine.store.put('tasks', { ...task, activeIntegrationId: null, integrationRecovery: null });
      return;
    }
    if (result) {
      const integration = { ...result, integrationId: record.id, ...(stopRequested ? { stopRequested } : {}) };
      save(engine, record, { phase: 'completed', result: integration, reason: null, observed: null, stopRequested, finishedAt: now() }, 'integration.completed');
      engine.store.put('tasks', { ...task, ...fields, status: 'succeeded', integrationPending: false, integration });
      const goal = engine.store.require('goals', task.goalId);
      // A replacement excluded the previous delivery. Successful integration
      // of this task under the current contract puts the new delivery back in
      // the goal hash before the scheduler decides which review applies.
      const replacesDelivery = task.kind === 'work' && matchesGoalContract(goal, task, record) && goal.supersededTaskIds?.includes(task.id);
      // Persist the need to update the goal alongside the delivery. Review
      // allocation must happen in a later transaction: Git cannot roll back.
      engine.store.put('goals', { ...goal, completionPending: goal.status === 'cancelled' ? null : 'delivery',
        ...(replacesDelivery ? { supersededTaskIds: goal.supersededTaskIds.filter(id => id !== task.id) } : {}) });
      engine.company.releaseTemporaryAgent(task.agentId);
      // Snapshot the executor at delivery time; later reassignment must not rewrite history.
      const executor = task.agentId ? engine.store.get('agents', task.agentId) : null;
      engine.store.event('task.succeeded', task.id, { integration, artifactHash: record.artifactHash, ...(task.agentId ? { executorId: task.agentId, executorName: executor?.name ?? null, executorRole: executor?.role ?? null } : {}) }, SYSTEM);
      return;
    }
    if (stopRequested || engine.closing || retryCheckpoint) {
      const status = stopRequested ?? 'integrating';
      save(engine, record, { phase: 'stopped', reason: null, observed: null, stopRequested, finishedAt: now() }, 'integration.stopped');
      engine.store.put('tasks', { ...task, ...fields, status, integrationPending: status !== 'cancelled' });
      if (status === 'cancelled') engine.company.releaseTemporaryAgent(task.agentId);
      return;
    }
    save(engine, record, { phase: 'failed', reason: error.message, observed: observed ?? null, finishedAt: now() }, 'integration.failed');
    const pending = engine.store.put('tasks', { ...task, ...fields, status: 'integrating', integrationPending: true });
    if (goalStopped(engine.store.require('goals', task.goalId))) return;
    engine.block(pending, 'integration', error.message, '请解决目标工作区冲突或集成检查问题后恢复。', error.integrationEvidence);
  });
}

async function clearCommand(engine, record, field, file) {
  save(engine, record, { [field]: null });
  await unlink(file).catch(() => {});
}

async function inspect(engine, record, observe) {
  const invoke = async (command, args, cwd, options) => {
    const inspectionCommandId = id('command');
    const cleanupReceipt = receipt(engine, inspectionCommandId);
    await mkdir(path.dirname(cleanupReceipt), { recursive: true });
    save(engine, record, { inspectionCommandId });
    let cleanupUnknown = false;
    try {
      return await engine.workspaces.runIntegrationCommand(command, args, cwd, {
        timeout: 5000, ...options, cleanupReceipt, beforeStart: () => engine.fenced(),
        ...(record.candidateMergeId ? { env: candidateGitEnvironment() } : {}),
      });
    } catch (error) {
      cleanupUnknown = !!error.cleanupUncertain;
      throw error;
    } finally {
      if (!cleanupUnknown && owns(engine)) await clearCommand(engine, record, 'inspectionCommandId', cleanupReceipt);
    }
  };
  const observed = observe ? await engine.workspaces.inspectIntegration(record, invoke) : null;
  if (record.ownerReservation) await releaseCandidateReservation(engine.workspaces, record, invoke);
  return observed;
}

async function reconcile(engine, record, { error, recovering = false, cleanup } = {}) {
  cleanup ??= record.commandId ? await readCommandCleanup(receipt(engine, record.commandId)) : null;
  if (record.inspectionCommandId) {
    const file = receipt(engine, record.inspectionCommandId);
    if (!await readCommandCleanup(file)) {
      return settle(engine, record, { reason: record.reason ?? '缺少 Git 核对命令的进程树清理回执',
        observed: record.observed, commandCleanupConfirmed: !!cleanup });
    }
    await clearCommand(engine, record, 'inspectionCommandId', file);
  }
  // A pending integration owns one slot. Verify the preceding command's
  // cleanup before starting a read-only command in that slot.
  if (record.commandId && !cleanup) {
    return settle(engine, record, { reason: error?.message ?? '缺少集成命令的进程树清理回执', observed: record.observed });
  }
  let observed;
  if (record.ownerReservation || (record.applyStartedAt && !cleanup?.notStarted)) {
    try { observed = await inspect(engine, record, !!record.applyStartedAt && !cleanup?.notStarted); }
    catch (failure) {
      return settle(engine, record, { reason: '无法核对 Git 合入结果：' + failure.message,
        observed: record.observed, commandCleanupConfirmed: !!cleanup });
    }
  }
  if (cleanup?.notStarted) {
    return settle(engine, record, { error: error ?? new Error('最终 Git 命令尚未启动'), retryCheckpoint: recovering });
  }
  if (observed?.status === 'merged') return settle(engine, record, { result: observed });
  const compareFailed = !!record.ownerReservation && typeof cleanup?.exitCode === 'number' && cleanup.exitCode > 0 && observed?.status === 'target-changed';
  if (record.applyStartedAt && ((observed?.status !== 'unchanged' && !compareFailed) || cleanup?.exitCode === 0)) {
    return settle(engine, record, { reason: '无法确认最终 Git 命令是否合入候选提交', observed, commandCleanupConfirmed: !!cleanup });
  }
  settle(engine, record, { error: error ?? new Error('最终 Git 命令未合入候选提交'), observed, retryCheckpoint: recovering && !record.applyStartedAt });
}

export async function recoverIntegrations(engine, taskId) {
  for (const record of engine.store.list('integrations')) {
    if (!integrationPending(record) || (taskId && record.taskId !== taskId) || engine.activeIntegration?.id === record.id) continue;
    await reconcile(engine, record, { recovering: true });
  }
}

export async function refreshIntegrationReceipts(engine) {
  for (const record of engine.store.list('integrations')) {
    if (!integrationPending(record) || engine.activeIntegration?.id === record.id) continue;
    if (record.phase !== 'reconciling') {
      await reconcile(engine, record, { recovering: true });
      continue;
    }
    if (record.inspectionCommandId) {
      if (await readCommandCleanup(receipt(engine, record.inspectionCommandId))) await reconcile(engine, record, { recovering: true });
      continue;
    }
    if (record.candidateMergeId && engine.store.get('goals', record.goalId)?.candidateMerge?.recoveryRequested) {
      await reconcile(engine, record, { recovering: true });
      continue;
    }
    if (record.commandCleanupConfirmed || !record.commandId) continue;
    const cleanup = await readCommandCleanup(receipt(engine, record.commandId));
    if (cleanup) await reconcile(engine, record, { recovering: true, cleanup });
  }
}

export function interruptIntegration(engine) {
  const entry = engine.activeIntegration;
  if (!entry || entry.applying || entry.controller.signal.aborted) return;
  const task = engine.store.get('tasks', entry.taskId);
  const policy = engine.company.policy();
  const goal = task && engine.store.get('goals', task.goalId);
  const request = goal?.candidateMerge;
  const taskCurrent = entry.candidateMergeId ? task?.status === 'succeeded' && request?.id === entry.candidateMergeId &&
    !request.stopRequested && candidateMergeMatches(engine.company, goal, request, true)
    : entry.compositionRecheckId ? task?.status === 'succeeded' && goal?.compositionRecheck?.id === entry.compositionRecheckId
      : task?.status === 'integrating';
  if (engine.closing || !owns(engine) || task?.stopRequested || !taskCurrent ||
    (goalStopped(goal) && goal.executionControl?.mode !== 'after-current') ||
    (policy.paused && policy.pauseMode !== 'after-current')) {
    entry.controller.abort(new AcmsError('INTEGRATION_STOPPED', '集成在最终合入前停止'));
  }
}

export async function executeIntegration(engine, taskId, compositionRecheckId = null, candidateMergeId = null) {
  if (engine.closing || !owns(engine) || engine.company.policy().paused ||
    engine.store.list('integrations').some(integrationPending)) return;
  const task = engine.store.require('tasks', taskId);
  const goal = engine.store.require('goals', task.goalId);
  const eligible = (currentTask, currentGoal) => {
    if (candidateMergeId) {
      const request = currentGoal.candidateMerge;
      return currentTask.status === 'succeeded' && request?.id === candidateMergeId && request.status === 'queued' &&
        candidateMergeMatches(engine.company, currentGoal, request);
    }
    return compositionRecheckId
      ? currentTask.status === 'succeeded' && currentGoal.compositionRecheck?.id === compositionRecheckId && currentGoal.compositionRecheck.status === 'queued'
      : currentTask.status === 'integrating' && !ignoresBlocker(currentTask) && matchesGoalContract(currentGoal, currentTask);
  };
  if (!eligible(task, goal) || goalStopped(goal) || goal.contractChange?.status === 'pending') return;
  if (!candidateMergeId && goalRuntimeSpent(goal, engine.store.list('attempts')) >= goalRuntimeLimit(goal, engine.company.policy())) {
    if (compositionRecheckId) engine.store.put('goals', { ...goal,
      compositionRecheck: { ...goal.compositionRecheck, status: 'failed', reason: '目标累计执行时间额度已用完，请追加额度后重验。' } });
    else engine.block(task, 'budget', '目标累计执行时间额度已用完', '请追加目标执行时间额度后继续。');
    return;
  }
  const record = engine.store.transaction(() => {
    engine.fenced();
    const current = engine.store.require('tasks', taskId);
    const currentGoal = engine.store.require('goals', task.goalId);
    const policy = engine.company.policy();
    if (current.revision !== task.revision || policy.paused || goalStopped(currentGoal) || !eligible(current, currentGoal) ||
      executionOccupancy(engine.store, engine.adapter, engine.live).used >= policy.maxConcurrent) return null;
    const request = currentGoal.candidateMerge;
    const saved = engine.store.put('integrations', {
      id: id('integration'), taskId, goalId: task.goalId, projectId: task.projectId, generation: task.generation,
      artifactHash: task.artifactHash, artifactIds: task.artifactIds, goalContractVersion: contractVersion(goal),
      contract: contract(engine, task.projectId), phase: 'preparing', ...(compositionRecheckId ? { compositionRecheckId } : {}),
      ...(candidateMergeId ? { candidateMergeId, candidateVersion: request.selection.version, confirmedBy: request.confirmedBy,
        targetRef: request.targetRef, targetHead: request.targetHead } : {}),
    });
    if (candidateMergeId) engine.store.put('goals', { ...currentGoal,
      candidateMerge: { ...request, status: 'preparing', integrationId: saved.id } });
    else if (compositionRecheckId) engine.store.put('goals', { ...currentGoal,
      compositionRecheck: { ...currentGoal.compositionRecheck, status: 'checking', integrationId: saved.id } });
    else engine.store.put('tasks', { ...task, activeIntegrationId: saved.id });
    engine.store.event('integration.started', taskId, { integrationId: saved.id, generation: task.generation, artifactHash: task.artifactHash }, SYSTEM);
    return saved;
  });
  if (!record) return;
  const entry = { id: record.id, taskId, controller: new AbortController(), applying: false, compositionRecheckId, candidateMergeId };
  engine.activeIntegration = entry;
  const { signal } = entry.controller;
  const isCurrent = () => {
    const current = engine.store.require('tasks', taskId);
    const policy = engine.company.policy();
    const currentGoal = engine.store.require('goals', task.goalId);
    const request = currentGoal.candidateMerge;
    const ownerCurrent = candidateMergeId && request?.id === candidateMergeId && request.integrationId === record.id &&
      !request.stopRequested && current.status === 'succeeded' && candidateMergeMatches(engine.company, currentGoal, request, true);
    const taskCurrent = candidateMergeId ? ownerCurrent : compositionRecheckId ? current.status === 'succeeded' && currentGoal.compositionRecheck?.id === compositionRecheckId &&
      currentGoal.compositionRecheck.integrationId === record.id && contractVersion(currentGoal) === record.goalContractVersion && currentGoal.contractChange?.status !== 'pending'
      : current.activeIntegrationId === record.id && current.status === 'integrating' && !ignoresBlocker(current) && matchesGoalContract(currentGoal, current, record);
    return owns(engine) && !engine.closing && !signal.aborted && (!policy.paused || policy.pauseMode === 'after-current') &&
      (!goalStopped(currentGoal) || currentGoal.executionControl?.mode === 'after-current') &&
      taskCurrent && !current.stopRequested && current.generation === record.generation && current.artifactHash === record.artifactHash;
  };
  const guard = () => {
    assert(isCurrent(), 'STALE_INTEGRATION', 'Integration was stopped or replaced');
    assert(contract(engine, task.projectId) === record.contract, 'INTEGRATION_POLICY_CHANGED', 'Project integration authorization or checks changed');
  };
  const command = async (executable, args, cwd, options, apply) => {
    const commandId = id('command');
    const cleanupReceipt = receipt(engine, commandId);
    await mkdir(path.dirname(cleanupReceipt), { recursive: true });
    engine.store.transaction(() => {
      guard();
      // This durable admission is the final stop/lease/contract fence. A stop
      // arriving after admission waits for the actual Git result and cleanup.
      save(engine, record, { commandId, ...(apply ? { phase: 'applying', applyStartedAt: now(), checks: apply.checks } : {}) },
        apply ? 'integration.applying' : null);
      if (apply && candidateMergeId) {
        const goal = engine.store.require('goals', record.goalId);
        engine.store.put('goals', { ...goal, candidateMerge: { ...goal.candidateMerge, status: 'applying' } });
      }
    });
    if (apply) entry.applying = true;
    let cleanupUnknown = false;
    try {
      return await engine.workspaces.runIntegrationCommand(executable, args, cwd, {
        ...options, cleanupReceipt, signal: apply ? undefined : signal,
        beforeStart: binary => {
          guard();
          if (apply) {
            const current = engine.store.require('integrations', record.id);
            if (candidateMergeId) assertCandidateReservation(current, binary);
            else engine.workspaces.assertIntegrationTarget(current, binary);
            guard();
          }
        },
      });
    } catch (error) {
      cleanupUnknown = !!error.cleanupUncertain;
      throw error;
    } finally {
      if (!apply && !cleanupUnknown && owns(engine)) {
        await clearCommand(engine, record, 'commandId', cleanupReceipt);
      }
    }
  };
  try {
    const execution = {
      id: record.id,
      signal,
      run: (executable, args, cwd, options) => command(executable, args, cwd, options),
      checkpoint: patch => { guard(); save(engine, record, patch, patch.phase === 'checking' ? 'integration.checking' : null); },
      apply: async (checks, cwd, candidate, ownerOptions) => {
        const args = ownerOptions ? ['-c', 'core.hooksPath=' + ownerOptions.hooks, 'update-ref', '--no-deref', '-m',
          ownerOptions.message, ownerOptions.targetRef, candidate, ownerOptions.targetHead] : ['merge', '--ff-only', candidate];
        const result = await command('git', args, cwd, { timeout: 15000, env: ownerOptions?.env }, { checks });
        assert(result.code === 0 && !result.timedOut, 'GIT_ERROR', result.stderr || 'Final Git command did not complete cleanly');
      },
    };
    const result = candidateMergeId ? await applyConfirmedCandidate(engine.company, engine.workspaces, goal, goal.candidateMerge, execution)
      : compositionRecheckId ? await engine.workspaces.recheckGoalComposition(goal, task, execution)
      : await engine.workspaces.integrate(task, isCurrent, execution);
    if (!owns(engine)) return;
    const current = engine.store.require('integrations', record.id);
    if (current.applyStartedAt) await reconcile(engine, current);
    else if (isCurrent()) settle(engine, current, { result });
    else settle(engine, current, { error: new Error('Integration was stopped or replaced') });
  } catch (error) {
    if (!owns(engine)) return;
    const current = engine.store.require('integrations', record.id);
    if (current.applyStartedAt || current.ownerReservation) await reconcile(engine, current, { error });
    else settle(engine, current, error.cleanupUncertain ? { reason: error.message } : { error });
  } finally { engine.activeIntegration = null; }
}
