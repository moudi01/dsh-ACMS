export function goalRuntimeLimit(goal, policy) {
  return policy.maxGoalRuntimeMs + (goal.runtimeExtraMs ?? 0);
}

export function goalRuntimeSpent(goal, attempts, now = Date.now()) {
  return (goal.runtimeMs ?? 0) + attempts
    .filter(a => a.goalId === goal.id && ['preparing', 'running'].includes(a.status))
    .reduce((sum, a) => sum + Math.max(0, now - Date.parse(a.startedAt)), 0);
}
