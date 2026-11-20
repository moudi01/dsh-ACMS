import { codexTokenFields } from '../../packages/codex-runtime/lib/turn-usage.js';
import { assert } from './util.js';

function usageAttempt(attempt) {
  const usage = attempt.meteredUsage;
  const pending = attempt.cleanupPending || ['preparing', 'running', 'cancelling', 'reconciling'].includes(attempt.status);
  return { id: attempt.id, taskId: attempt.taskId, goalId: attempt.goalId, kind: attempt.kind ?? null,
    status: attempt.status, startedAt: attempt.startedAt ?? null, finishedAt: usage?.finishedAt ?? attempt.finishedAt ?? null,
    provider: attempt.provider || null, llmProvider: attempt.llmProvider || null, model: attempt.model || null,
    reasoningEffort: attempt.reasoningEffort || null, runtime: attempt.execution?.runtime ?? null,
    state: usage ? 'reported' : attempt.preflightOnly ? 'not-executed' : pending ? 'pending' : 'unknown',
    usage: usage ? { source: usage.source, threadId: usage.threadId, turnId: usage.turnId, counts: usage.counts } : null };
}

export function attemptUsageView(store, params) {
  const goalId = params.get('goalId'), taskId = params.get('taskId');
  assert(!!goalId !== !!taskId, 'INVALID_INPUT', '请选择一个目标或任务查看执行用量。');
  const scope = taskId ? 'task' : 'goal', id = taskId ?? goalId;
  store.require(taskId ? 'tasks' : 'goals', id);
  const limit = Number(params.get('limit') ?? 30), before = Number(params.get('before') ?? Number.MAX_SAFE_INTEGER);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(before) && before >= 1,
    'INVALID_INPUT', '用量查询需要有效游标，且每页可选 1 至 100 条。');
  const page = store.attemptUsagePage(scope, id, before, limit);
  const attempts = page.slice(0, limit).map(row => usageAttempt(row.attempt));
  const coverage = { reported: 0, pending: 0, unknown: 0, 'not-executed': 0 };
  const counts = Object.fromEntries(codexTokenFields.map(field => [field, { reported: 0, sum: 0n }]));
  for (const attempt of attempts) {
    coverage[attempt.state]++;
    for (const field of codexTokenFields) {
      const amount = attempt.usage?.counts[field];
      if (!Number.isSafeInteger(amount) || amount < 0) continue;
      counts[field].reported++;
      counts[field].sum += BigInt(amount);
    }
  }
  const summary = Object.fromEntries(codexTokenFields.map(field => {
    const { reported, sum } = counts[field];
    return [field, { reported, subtotal: reported > 0 ? sum.toString() : null }];
  }));
  return { scope, id, coverage, summary, attempts, nextBefore: page.length > limit ? page[limit - 1].cursor : null };
}
