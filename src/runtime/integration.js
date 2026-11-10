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

function settle(engine, record, { result, error, reason, observed, commandCleanupConfirmed = false, retryCheckpoint = false }) {
  return engine.store.transaction(() => {
    engine.fenced();
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
      if (task.kind === 'work' && matchesGoalContract(goal, task, record) && goal.supersededTaskIds?.includes(task.id)) {
        engine.store.put('goals', { ...goal, supersededTaskIds: goal.supersededTaskIds.filter(id => id !== task.id) });
      }
      engine.company.releaseTemporaryAgent(task.agentId);
      engine.store.event('task.succeeded', task.id, { integration, artifactHash: record.artifactHash }, SYSTEM);
      engine.updateGoal(task.goalId);
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

async function inspect(engine, record) {
  return engine.workspaces.inspectIntegration(record, async (command, args, cwd) => {
    const inspectionCommandId = id('command');
    const cleanupReceipt = receipt(engine, inspectionCommandId);
    await mkdir(path.dirname(cleanupReceipt), { recursive: true });
    save(engine, record, { inspectionCommandId });
    let cleanupUnknown = false;
    try {
      return await engine.workspaces.runIntegrationCommand(command, args, cwd, {
        timeout: 5000, cleanupReceipt, beforeStart: () => engine.fenced(),
      });
    } catch (error) {
      cleanupUnknown = !!error.cleanupUncertain;
      throw error;
    } finally {
      if (!cleanupUnknown && owns(engine)) await clearCommand(engine, record, 'inspectionCommandId', cleanupReceipt);
    }
  });
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
  if (cleanup?.notStarted) {
    return settle(engine, record, { error: error ?? new Error('最终 Git 命令尚未启动'), retryCheckpoint: recovering });
  }
  // A pending integration owns one slot. Verify the preceding command's
  // cleanup before starting a read-only command in that slot.
  if (record.commandId && !cleanup) {
    return settle(engine, record, { reason: error?.message ?? '缺少集成命令的进程树清理回执', observed: record.observed });
  }
  let observed;
  if (record.applyStartedAt) {
    try { observed = await inspect(engine, record); }
    catch (failure) {
      return settle(engine, record, { reason: '无法核对 Git 合入结果：' + failure.message,
        observed: record.observed, commandCleanupConfirmed: !!cleanup });
    }
  }
  if (observed?.status === 'merged') return settle(engine, record, { result: observed });
  if (record.applyStartedAt && (observed?.status !== 'unchanged' || cleanup?.exitCode === 0)) {
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
  if (engine.closing || !owns(engine) || task?.stopRequested || task?.status !== 'integrating' ||
    (goalStopped(goal) && goal.executionControl?.mode !== 'after-current') ||
    (policy.paused && policy.pauseMode !== 'after-current')) {
    entry.controller.abort(new AcmsError('INTEGRATION_STOPPED', '集成在最终合入前停止'));
  }
}

export async function executeIntegration(engine, taskId) {
  if (engine.closing || !owns(engine) || engine.company.policy().paused ||
    engine.store.list('integrations').some(integrationPending)) return;
  const task = engine.store.require('tasks', taskId);
  if (task.status !== 'integrating' || ignoresBlocker(task)) return;
  const goal = engine.store.require('goals', task.goalId);
  if (goalStopped(goal) || !matchesGoalContract(goal, task) || goal.contractChange?.status === 'pending') return;
  if (goalRuntimeSpent(goal, engine.store.list('attempts')) >= goalRuntimeLimit(goal, engine.company.policy())) {
    engine.block(task, 'budget', '目标累计执行时间额度已用完', '请追加目标执行时间额度后继续。');
    return;
  }
  const record = engine.store.transaction(() => {
    engine.fenced();
    const current = engine.store.require('tasks', taskId);
    const policy = engine.company.policy();
    if (current.revision !== task.revision || policy.paused || goalStopped(engine.store.require('goals', task.goalId)) ||
      executionOccupancy(engine.store, engine.adapter, engine.live).used >= policy.maxConcurrent) return null;
    const saved = engine.store.put('integrations', {
      id: id('integration'), taskId, goalId: task.goalId, projectId: task.projectId, generation: task.generation,
      artifactHash: task.artifactHash, artifactIds: task.artifactIds, goalContractVersion: contractVersion(goal),
      contract: contract(engine, task.projectId), phase: 'preparing',
    });
    engine.store.put('tasks', { ...task, activeIntegrationId: saved.id });
    engine.store.event('integration.started', taskId, { integrationId: saved.id, generation: task.generation, artifactHash: task.artifactHash }, SYSTEM);
    return saved;
  });
  if (!record) return;
  const entry = { id: record.id, taskId, controller: new AbortController(), applying: false };
  engine.activeIntegration = entry;
  const { signal } = entry.controller;
  const isCurrent = () => {
    const current = engine.store.require('tasks', taskId);
    const policy = engine.company.policy();
    const currentGoal = engine.store.require('goals', task.goalId);
    return owns(engine) && !engine.closing && !signal.aborted && (!policy.paused || policy.pauseMode === 'after-current') &&
      (!goalStopped(currentGoal) || currentGoal.executionControl?.mode === 'after-current') &&
      current.activeIntegrationId === record.id && current.status === 'integrating' && !ignoresBlocker(current) &&
      current.generation === record.generation && current.artifactHash === record.artifactHash &&
      matchesGoalContract(currentGoal, current, record);
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
    });
    if (apply) entry.applying = true;
    let cleanupUnknown = false;
    try {
      return await engine.workspaces.runIntegrationCommand(executable, args, cwd, {
        ...options, cleanupReceipt, signal: apply ? undefined : signal,
        beforeStart: binary => {
          guard();
          if (apply) {
            engine.workspaces.assertIntegrationTarget(engine.store.require('integrations', record.id), binary);
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
    const result = await engine.workspaces.integrate(task, isCurrent, {
      id: record.id,
      run: (executable, args, cwd, options) => command(executable, args, cwd, options),
      checkpoint: patch => { guard(); save(engine, record, patch, patch.phase === 'checking' ? 'integration.checking' : null); },
      apply: async (checks, cwd, candidate) => {
        const result = await command('git', ['merge', '--ff-only', candidate], cwd, { timeout: 15000 }, { checks });
        assert(result.code === 0 && !result.timedOut, 'GIT_ERROR', result.stderr || 'Final Git command did not complete cleanly');
      },
    });
    if (!owns(engine)) return;
    const current = engine.store.require('integrations', record.id);
    if (current.applyStartedAt) await reconcile(engine, current);
    else if (isCurrent()) settle(engine, current, { result });
    else settle(engine, current, { error: new Error('Integration was stopped or replaced') });
  } catch (error) {
    if (!owns(engine)) return;
    const current = engine.store.require('integrations', record.id);
    if (current.applyStartedAt) await reconcile(engine, current, { error });
    else settle(engine, current, error.cleanupUncertain ? { reason: error.message } : { error });
  } finally { engine.activeIntegration = null; }
}
