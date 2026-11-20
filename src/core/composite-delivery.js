import { deliveredWork, deliveryGeneration, goalDeliveryHash, taskContractVersion } from './goal-contract.js';
import { assert, digest, id } from './util.js';

export const GIT_COMPOSITION = 'git-composite';
export const usesGitComposition = goal => goal?.deliveryMode === GIT_COMPOSITION;
export const supportsGitComposition = project => project?.mode === 'git' && !project.autoMerge;

export function newCompositionCheck(store, goal) {
  const task = deliveredWork(store, goal).sort((a, b) => a.id.localeCompare(b.id))[0];
  return task ? { id: id('composition'), taskId: task.id, status: 'queued' } : null;
}

export function compositionCheckContract(project) {
  return digest({ root: project.repoRoot, mode: project.mode, autoMerge: !!project.autoMerge,
    checks: project.checks, preparation: project.preparation ?? null });
}

export function acceptedGoalComposition(store, goal) {
  const candidate = goal.composition;
  const project = store.get('projects', goal.projectId);
  if (!usesGitComposition(goal) || !supportsGitComposition(project) || !candidate?.passed || goal.compositionRecheck ||
      candidate.baseCommit !== goal.compositionBase?.commit || candidate.checkContract !== compositionCheckContract(project) ||
      !candidate.checks?.length || !candidate.checks.every(check => check.passed && check.cleanupConfirmed === true)) return null;
  try {
    const roots = deliveredWork(store, goal);
    if (candidate.ledgerHash !== goalDeliveryHash(goal, roots)) return null;
    const current = orderedCompositionTasks(store, goal, roots);
    return candidate.inputs?.length === current.length && current.every((task, index) => {
      const input = candidate.inputs[index];
      return task.id === input.taskId && task.generation === input.generation && task.artifactHash === input.artifactHash &&
        task.integration?.delivery?.sha256 === input.bundleSha256 && (task.workspace?.compositionInput?.version ?? null) === input.baseline;
    }) ? candidate : null;
  } catch (error) {
    if (error.code === 'COMPOSITE_DEPENDENCIES') return null;
    throw error;
  }
}

export function orderedCompositionTasks(store, goal, roots, { consumer = null, includeHistorical = false } = {}) {
  const overrides = new Map(roots.map(task => [task.id, task]));
  const superseded = new Set(goal.supersededTaskIds ?? []);
  const visited = new Set(), visiting = new Set();
  const selected = [];
  const visit = (id, dependent) => {
    const task = overrides.get(id) ?? store.get('tasks', id);
    assert(task?.goalId === goal.id && task.status === 'succeeded', 'COMPOSITE_DEPENDENCIES',
      `任务 ${id} 没有当前目标可用的已交付版本，请核对依赖。`);
    const historical = superseded.has(id);
    if (historical) {
      const approved = (goal.compositionHistory ?? []).some(row => row.taskId === id && row.followUpTaskId === dependent?.id &&
        row.replacedDelivery.goalContractVersion === taskContractVersion(task) && row.replacedDelivery.generation === deliveryGeneration(task) &&
        row.replacedDelivery.artifactHash === task.artifactHash);
      const historicalAncestor = superseded.has(dependent?.id) && dependent?.workspace?.compositionInput?.inputs?.some(row =>
        row.taskId === id && row.generation === task.generation && row.artifactHash === task.artifactHash);
      assert(approved || historicalAncestor, 'COMPOSITE_DEPENDENCIES', `任务 ${id} 的历史交付只能供已批准的替代任务修订。`);
    }
    if (visited.has(id)) return;
    assert(!visiting.has(id), 'COMPOSITE_DEPENDENCIES', '组合候选的任务依赖包含循环。');
    visiting.add(id);
    for (const dependency of [...(task.dependencies ?? [])].sort()) visit(dependency, task);
    visiting.delete(id);
    visited.add(id);
    if ((!historical || includeHistorical) && ['work', 'repair'].includes(task.kind)) selected.push(task);
  };
  for (const root of [...overrides.keys()].sort()) visit(root, consumer);
  return selected;
}
