import { codexTokenFields } from '../../packages/codex-runtime/lib/turn-usage.js';
import { assert, digest } from './util.js';

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

function usageScope(store, params) {
  const goalId = params.get('goalId'), taskId = params.get('taskId');
  assert(!!goalId !== !!taskId, 'INVALID_INPUT', '请选择一个目标或任务查看执行用量。');
  const scope = taskId ? 'task' : 'goal', id = taskId ?? goalId;
  store.require(taskId ? 'tasks' : 'goals', id);
  return { scope, id };
}

export function attemptUsageView(store, params) {
  const { scope, id } = usageScope(store, params);
  const limit = Number(params.get('limit') ?? 30), before = Number(params.get('before') ?? Number.MAX_SAFE_INTEGER);
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && Number.isSafeInteger(before) && before >= 1,
    'INVALID_INPUT', '用量查询需要有效游标，且每页可选 1 至 100 条。');
  const page = store.attemptUsagePage(scope, id, before, limit).map(({ cursor, attempt }) => ({ cursor, view: usageAttempt(attempt) }));
  return summarizeAttemptPage(scope, id, page, limit);
}

function summarizeAttemptPage(scope, id, page, limit) {
  const attempts = page.slice(0, limit).map(row => row.view);
  const totals = usageTotals();
  for (const attempt of attempts) addUsage(totals, attempt);
  return { scope, id, ...summarizeUsage(totals), attempts, nextBefore: page.length > limit ? page[limit - 1].cursor : null };
}

function usageTotals() {
  return { coverage: { reported: 0, pending: 0, unknown: 0, 'not-executed': 0 },
    counts: Object.fromEntries(codexTokenFields.map(field => [field, { reported: 0, sum: 0n }])) };
}

function addUsage({ coverage, counts }, attempt) {
  coverage[attempt.state]++;
  for (const field of codexTokenFields) {
    const amount = attempt.usage?.counts[field];
    if (!Number.isSafeInteger(amount) || amount < 0) continue;
    counts[field].reported++;
    counts[field].sum += BigInt(amount);
  }
}

function summarizeUsage({ coverage, counts }) {
  const summary = Object.fromEntries(codexTokenFields.map(field => {
    const { reported, sum } = counts[field];
    return [field, { reported, subtotal: reported > 0 ? sum.toString() : null }];
  }));
  return { coverage, summary };
}

const utcDayPattern = /^\d{4}-\d{2}-\d{2}$/;
const routeKeyPattern = /^[01]:[a-f0-9]{64}$/;
const summaryAttemptLimit = 30;

function utcStartDay(startedAt) {
  if (typeof startedAt !== 'string') return null;
  const localDay = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(startedAt)?.[1];
  if (!localDay) return null;
  const midnight = Date.parse(localDay + 'T00:00:00Z'), instant = Date.parse(startedAt);
  if (!Number.isFinite(midnight) || !Number.isFinite(instant) || new Date(midnight).toISOString().slice(0, 10) !== localDay) return null;
  const utcDay = new Date(instant).toISOString().split('T')[0];
  return utcDayPattern.test(utcDay) ? utcDay : null;
}

function usageGroup(groupBy, attempt, view) {
  if (groupBy === 'date') {
    const dateUtc = utcStartDay(attempt.startedAt);
    return { key: dateUtc ?? '', dateUtc };
  }
  // A paired attempt reserves both IDs before its runner accepts the turn.
  // Only a metered receipt or accepted result can attribute that route.
  const paired = view.provider?.startsWith('paired:') || !!attempt.execution;
  const hasRoute = !attempt.preflightOnly && !!(view.usage || attempt.resultAccepted === true || (!paired && attempt.childId));
  const provider = hasRoute && view.provider !== 'auto' ? view.provider : null;
  const route = { provider, llmProvider: hasRoute ? view.llmProvider : null,
    model: hasRoute ? view.model : null, reasoningEffort: hasRoute ? view.reasoningEffort : null };
  const dimensions = Object.values(route);
  const prefix = dimensions.some(Boolean) ? '0:' : '1:';
  return { key: prefix + digest(dimensions), ...route };
}

const compareKeys = (a, b) => a < b ? -1 : a === b ? 0 : 1;

export function attemptUsageSummary(store, params) {
  const { scope, id } = usageScope(store, params);
  const groupBy = params.get('groupBy') ?? 'route';
  const limit = Number(params.get('limit') ?? 20), after = params.get('after');
  assert(['route', 'date'].includes(groupBy) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    'INVALID_INPUT', '用量汇总可按路由或 UTC 日期分组，每页可选 1 至 100 组。');
  assert(after === null || (groupBy === 'date' ? utcDayPattern : routeKeyPattern).test(after),
    'INVALID_INPUT', '请使用当前用量分组返回的下一页游标。');
  const attemptBefore = params.has('attemptBefore') ? Number(params.get('attemptBefore')) : null;
  assert(attemptBefore === null || Number.isSafeInteger(attemptBefore) && attemptBefore >= 1,
    'INVALID_INPUT', '逐次用量需要有效游标。');
  const compare = groupBy === 'date' ? (a, b) => compareKeys(b, a) : compareKeys;
  const totals = usageTotals();
  const groups = new Map(), attemptPage = [];
  let cutoff = null;
  // Read the complete totals and both pages from the same SQLite snapshot.
  // Keep at most one extra group and attempt to determine the next cursors.
  for (const { cursor, attempt } of store.attemptUsageRows(scope, id)) {
    const view = usageAttempt(attempt);
    if (attemptBefore !== null && cursor < attemptBefore && attemptPage.length <= summaryAttemptLimit) attemptPage.push({ cursor, view });
    addUsage(totals, view);
    const group = usageGroup(groupBy, attempt, view);
    if ((after !== null && compare(group.key, after) <= 0) || (cutoff !== null && compare(group.key, cutoff) > 0)) continue;
    let record = groups.get(group.key);
    if (!record) {
      if (cutoff !== null) groups.delete(cutoff);
      record = { group, totals: usageTotals() };
      groups.set(group.key, record);
      if (groups.size > limit) cutoff = [...groups.keys()].reduce((last, key) => compare(key, last) > 0 ? key : last);
    }
    addUsage(record.totals, view);
  }
  const page = [...groups.keys()].sort(compare).slice(0, limit).map(key => groups.get(key));
  return { scope, id, groupBy, ...(groupBy === 'date' ? { dateBasis: 'started-at-utc' } : {}), ...summarizeUsage(totals),
    groups: page.map(({ group, totals }) => ({ ...group, ...summarizeUsage(totals) })),
    ...(attemptBefore === null ? {} : { attemptPage: summarizeAttemptPage(scope, id, attemptPage, summaryAttemptLimit) }),
    nextAfter: groups.size > limit ? page.at(-1).group.key : null };
}
