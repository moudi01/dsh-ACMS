import { assert, digest, now, TERMINAL } from './util.js';

export const contractVersion = goal => goal.contractVersion ?? 1;
export const taskContractVersion = task => task.goalContractVersion ?? 1;
export const deliveryGeneration = task => task.deliveryGeneration ?? 1;

export function matchesGoalContract(goal, task, attempt = task) {
  return taskContractVersion(task) === contractVersion(goal) && taskContractVersion(attempt) === contractVersion(goal);
}

export function deliveredWork(store, goal) {
  const superseded = new Set(goal.supersededTaskIds ?? []);
  return store.list('tasks').filter(task => task.goalId === goal.id && task.kind === 'work' && task.status === 'succeeded' &&
    !task.legacyBatch && !task.workflowSnapshot && !superseded.has(task.id));
}

export function goalDeliveryHash(goal, tasks) {
  const rows = tasks.map(t => [t.id, t.artifactHash ?? '', deliveryGeneration(t)]).sort((a, b) => a[0].localeCompare(b[0]));
  const version = contractVersion(goal);
  // Keep unchanged v1 evidence readable across the upgrade.
  if (version === 1 && rows.every(row => row[2] === 1)) return digest(rows.map(row => row.slice(0, 2).join(':')).sort().join('|'));
  return digest({ version, rows });
}

export function matchesTaskReview(review, source) {
  return review.reviewArtifactHash === source.artifactHash &&
    (review.reviewedTaskGeneration ?? 1) === deliveryGeneration(source) &&
    (review.reviewedContractVersion ?? 1) === taskContractVersion(source);
}

export function completeGoalContract(company, task, output, actor, planTasks = new Map()) {
  if (task.origin?.kind !== 'goal-contract') return null;
  const { store } = company;
  const goal = store.require('goals', task.goalId);
  const change = goal.contractChange;
  assert(change?.status === 'pending' && change.coordinationTaskId === task.id && matchesGoalContract(goal, task),
    'STALE_RESULT', 'This contract assessment has been superseded');
  const assessment = output.contractAssessment;
  assert(typeof assessment?.reason === 'string' && assessment.reason.trim() && assessment.reason.length <= 4000 &&
    Array.isArray(assessment.reuse) && Array.isArray(assessment.followUps),
  'INVALID_CONTRACT_ASSESSMENT', 'Give a reason and account for prior deliverables using reuse and followUps');
  const historical = deliveredWork(store, goal).filter(row => taskContractVersion(row) !== contractVersion(goal));
  const remaining = new Set(historical.map(row => row.id));
  const reuse = assessment.reuse.map(taskId => {
    assert(remaining.delete(taskId), 'INVALID_CONTRACT_ASSESSMENT', 'Each reused deliverable must be a distinct prior task in this goal');
    return taskId;
  });
  const followUps = assessment.followUps.map(entry => {
    assert(remaining.delete(entry?.taskId), 'INVALID_CONTRACT_ASSESSMENT', 'Each replaced deliverable must be a distinct prior task in this goal');
    assert(typeof entry.followUp === 'string', 'INVALID_CONTRACT_ASSESSMENT', 'Identify the replacement task or plan key');
    const followUp = store.get('tasks', planTasks.get(entry.followUp) ?? entry.followUp);
    assert(followUp?.goalId === goal.id && followUp.kind === 'work' && !['cancelled', 'deleted', 'archived', 'failed'].includes(followUp.status) &&
      matchesGoalContract(goal, followUp), 'INVALID_CONTRACT_ASSESSMENT', 'Replacement work must exist under the current goal contract');
    const prior = store.require('tasks', entry.taskId);
    return { taskId: prior.id, followUpTaskId: followUp.id, replacedDelivery: {
      goalContractVersion: taskContractVersion(prior), generation: deliveryGeneration(prior), artifactHash: prior.artifactHash ?? null,
    } };
  });
  assert(remaining.size === 0, 'INVALID_CONTRACT_ASSESSMENT', 'Assess every prior deliverable before releasing the new contract');
  const replacements = new Map(followUps.map(item => [item.taskId, item.followUpTaskId]));
  const ancestors = (taskId, seen = new Set()) => {
    for (const dependency of store.get('tasks', taskId)?.dependencies ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      ancestors(dependency, seen);
    }
    return seen;
  };
  assert(!reuse.some(id => [...ancestors(id)].some(dependency => replacements.has(dependency))), 'INVALID_CONTRACT_ASSESSMENT',
    'Assign follow-up work to prior deliverables that depended on a replaced deliverable');
  const unfinished = store.list('tasks').filter(row => row.goalId === goal.id && row.kind === 'work' &&
    !row.legacyBatch && !row.workflowSnapshot && !TERMINAL.has(row.status));
  assert(!unfinished.some(row => row.dependencies.some(id => replacements.has(id) && replacements.get(id) !== row.id)),
    'INVALID_CONTRACT_ASSESSMENT', 'Use replacement dependencies; historical input is allowed only for the task replacing it');
  for (const { taskId, followUpTaskId } of followUps) {
    const currentDependencies = ancestors(followUpTaskId);
    for (const dependency of ancestors(taskId)) {
      const replacement = replacements.get(dependency);
      assert(!replacement || replacement === followUpTaskId || currentDependencies.has(replacement),
        'INVALID_CONTRACT_ASSESSMENT', 'A downstream replacement must wait for the current upstream replacement');
    }
  }
  const decision = { reason: assessment.reason.trim(), reuse, followUps, decidedBy: actor.id, decidedAt: now() };
  store.put('goals', { ...goal, contractChange: { ...change, status: 'assessed', decision },
    supersededTaskIds: [...new Set([...(goal.supersededTaskIds ?? []), ...replacements.keys()])] });
  store.event('goal.contract.assessed', goal.id, { contractVersion: contractVersion(goal), coordinationTaskId: task.id, decision }, actor);
  return decision;
}
