export function goalRuntimeLimit(goal, policy) {
  return policy.maxGoalRuntimeMs + (goal.runtimeExtraMs ?? 0);
}

export function goalRuntimeSpent(goal, attempts, now = Date.now()) {
  return (goal.runtimeMs ?? 0) + attempts
    .filter(a => a.goalId === goal.id && ['preparing', 'running'].includes(a.status))
    .reduce((sum, a) => sum + Math.max(0, now - Date.parse(a.startedAt)), 0);
}

/**
 * Efficiency time box for one goal (issue #7). It is separate from the hard
 * runtime cap: at the time box the manager is asked to save a checkpoint and
 * wrap up; ordinary dispatch pauses until that decision. `0` disables it.
 * `timeBoxReserveMs` reserves the tail of the hard cap for wrap-up.
 */
export function goalTimeBoxLimit(goal, policy) {
  const hardLimit = goalRuntimeLimit(goal, policy);
  const configured = policy.goalTimeBoxMs ?? 0;
  // Extra budget extends an explicitly enabled box, but must never turn an
  // unconfigured box on.
  const box = configured > 0 ? configured + (goal.runtimeExtraMs ?? 0) : 0;
  const reserve = policy.timeBoxReserveMs ?? 0;
  const candidates = [];
  if (box > 0) candidates.push(box);
  if (reserve > 0) candidates.push(Math.max(0, hardLimit - reserve));
  if (!candidates.length) return null;
  return Math.min(hardLimit, ...candidates);
}
