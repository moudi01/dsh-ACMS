/**
 * Blocker triage policy (issue #16).
 *
 * The project manager owns recoverable blockers. The owner only receives blockers
 * that genuinely require a user decision: missing permissions, material that only
 * the owner can provide, major scope changes, real budget shortages, or work that
 * already went through the manager path. Anything unrecognised stays with the
 * owner on purpose, so an unknown blocker can never be silently absorbed by the
 * manager and a paused/cancelled/cleanup gate cannot be bypassed.
 */

const OWNER_ONLY_KINDS = new Set(['human', 'budget', 'reworks', 'assignment', 'permission', 'repair_limit', 'execution_limit']);

export function blockerRoute(task, kind) {
  if (!task || task.kind === 'coordination') return 'owner';
  if (OWNER_ONLY_KINDS.has(kind)) return 'owner';
  if (kind === 'model-selection' || kind === 'integration' || kind === 'dependency') return 'manager';
  if ((kind === 'technical' || kind === 'execution') && ['plan', 'review', 'repair'].includes(task.kind)) return 'manager';
  return 'owner';
}

export function blockerCoordinationKey(task, kind) {
  return `executor:${task.id}:g${task.generation}:blocker:${kind}`;
}

// A failed execution can be handed off. An explicit stop or an uncertain
// execution must settle before any blocker may change the task state.
export function ignoresBlocker(task) {
  return task.stopRequested || task.legacyBatch || task.workflowSnapshot ||
    ['succeeded', 'cancelled', 'archived', 'deleted', 'stopping', 'reconciling'].includes(task.status);
}
