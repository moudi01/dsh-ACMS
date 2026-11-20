import { normalizedReceiptUsage, validExecution } from './execution-receipt.js';

export function withAttemptUsage(attempt, fact) {
  if (attempt.meteredUsage || fact?.cleanupConfirmed !== true || !['completed', 'stopped'].includes(fact.status)) return attempt;
  const ref = attempt.execution;
  if (!validExecution(ref) || ref.attemptId !== attempt.id || ref.provider !== attempt.provider || ref.model !== attempt.model ||
    ref.contextKey !== attempt.contextKey || ref.generation !== attempt.taskGeneration || ref.kind !== attempt.kind) return attempt;
  const usage = normalizedReceiptUsage(ref, fact.meteredUsage);
  if (!usage || !Number.isFinite(Date.parse(fact.finishedAt))) return attempt;
  return { ...attempt, meteredUsage: { ...usage, finishedAt: fact.finishedAt } };
}
