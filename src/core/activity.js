/**
 * Human-readable business activity derived from the persistent event stream
 * (issue #18).
 *
 * The event log is the source of truth for "who did what"; this module only
 * projects already-committed events into short owner-facing sentences. It
 * never invents an actor or a state change: when the stored event does not
 * carry enough information (for example legacy `project.saved` bodies without
 * the `created` flag), the wording degrades to a neutral statement instead of
 * guessing.
 *
 * Progress pings, heartbeats, readiness recalculation, per-command audit rows
 * and raw model output stay out of the allow-list so they never flood the feed.
 * Sensitive fields are redacted before any detail is rendered.
 */

const ROLE_LABEL = Object.freeze({ manager: '负责人', worker: '执行者', reviewer: '审查者' });
const STATUS_LABEL = Object.freeze({
  planning: '规划中', active: '进行中', paused: '已暂停', cancelled: '已取消', succeeded: '已完成',
  archived: '已归档', ready: '待执行', blocked: '已阻塞', preparing: '准备中', running: '执行中',
  reviewing: '待审查', integrating: '集成中', reconciling: '待核对', stopping: '停止中', failed: '失败',
  deleted: '已删除', available: '可分配', retired: '已释放',
});
const FIELD_LABEL = Object.freeze({
  title: '标题', description: '说明', acceptance: '验收标准', priority: '优先级', dependencies: '依赖',
  name: '名称', repoRoot: '目录', mode: '副本方式', checks: '检查', preparation: '依赖准备', autoMerge: '自动集成',
});
const BLOCK_KIND = Object.freeze({
  human: '需要补充材料', execution: '执行失败', review: '审查环境异常', integration: '集成冲突',
  environment: '执行环境缺项', capacity: '执行资源不足', coordination: '协调未决',
});
const CATEGORY_LABEL = Object.freeze({
  create: '创建', change: '变更', block: '阻塞', recover: '恢复', review: '审查', result: '完成', control: '控制', system: '系统',
});

/**
 * Event types worth showing as business activity. Anything else (for example
 * `attempt.progress`, `task.readiness`, `command.accepted` or `notifications.delivered`)
 * is deliberately excluded from the feed.
 */
export const ACTIVITY_EVENT_TYPES = Object.freeze([
  'company.created', 'company.paused', 'company.resumed', 'policy.changed',
  'project.saved', 'project.deleted', 'project.restored',
  'goal.created', 'goal.status.changed', 'goal.succeeded', 'goal.reopened', 'goal.paused', 'goal.resumed',
  'goal.cancelled', 'goal.contract.changed', 'goal.contract.assessed', 'goal.runtime.extended',
  'goal.timebox.warning', 'goal.timebox.blocked', 'goal.submitted', 'goal.deleted', 'goal.restored',
  'task.created', 'task.changed', 'task.dependencies', 'task.blocked', 'task.paused.requested',
  'task.cancelled.requested', 'task.resumed', 'task.retry.scheduled', 'task.stop.completed', 'task.succeeded',
  'task.restored', 'task.deleted', 'task.purged', 'task.host.resumed', 'task.integration.resumed',
  'task.environment.blocked', 'task.environment.recovered', 'task.environment.recheck.requested',
  'task.budget.released', 'task.recovery.requested',
  'integration.failed', 'integration.reconciling',
  'interaction.answered',
  'review.queued', 'review.requested', 'review.request.reused', 'review.decided', 'review.rework.requested',
  'review.rework.limit', 'review.rework.blocked', 'review.rework.gate',
  'coordination.created', 'coordination.decided', 'coordination.applied', 'coordination.evidence.refreshed',
  'blocker.coordinated', 'plan.accepted', 'management.batch.committed', 'management.continued',
  'attempt.failed', 'attempt.finished', 'attempt.result.recovered',
  'agent.saved', 'agent.released', 'agent.deleted', 'agent.restored',
  'template.published',
  'model.preferences.changed', 'model.paired', 'model.invited', 'model.unpaired',
  'agentCredential.created', 'agentCredential.scope.changed', 'agentCredential.revoked',
  'legacy.exported',
]);

const ACTIVITY_SET = new Set(ACTIVITY_EVENT_TYPES);
export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

const SENSITIVE_KEY = /(token|secret|password|credential|authorization|cookie|api[-_]?key|^prompt$|^messages?$|chain[-_]?of[-_]?thought|^thoughts?$|^reasoningContent$|^analysis$|^privateKey$)/i;
const MAX_STRING = 500;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;
const MAX_BUDGET = 6000;

/**
 * Credentials can appear inside otherwise free-form event text (block reasons,
 * execution errors, summaries), so key-name filtering alone is not enough.
 * Redact recognizable credential shapes from every displayed string.
 */
export function redactActivityText(value) {
  if (typeof value !== 'string') return value;
  // Quoted JSON keys/values may be plain (`"token":"..."`) or escaped through
  // another serialization layer (`\"token\":\"...\"`). The quoted value pattern
  // consumes escaped quotes and separators so a secret containing `,` or `}`
  // cannot leak its suffix.
  return value
    .replace(/(\\?["'])(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential|authorization|api[-_]?key)\1\s*:\s*(\\?"(?:[^"\\]|\\.)*\\?"|\\?'(?:[^'\\]|\\.)*\\?'|[^\n,;}]+)/gi, (_match, quote, key) => `${quote}${key}${quote}: [已隐藏]`)
    // Unclosed/truncated JSON values cannot match a closing quote; redact the
    // rest of the line rather than leaving the visible secret tail.
    .replace(/(\\?["'])(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential|authorization|api[-_]?key)\1\s*:\s*\\?"[^\n]*/gi, (_match, quote, key) => `${quote}${key}${quote}: [已隐藏]`)
    .replace(/\bAuthorization\s*[:=]\s*(?:(?:Basic|Bearer)\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, 'Authorization: [已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [已隐藏]')
    .replace(/\b(acms_ag_|ghp_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|credential|authorization|api[-_]?key)\b(\s*[:=]\s*)[^\n;}]+/gi, (_match, key, separator) => `${key}${separator}[已隐藏]`);
}

/** Redact secrets and bound every value before it reaches the panel. */
export function sanitizeActivityData(value) {
  const seen = new WeakSet();
  const budget = { remaining: MAX_BUDGET };
  const walk = (current, depth) => {
    if (current === null || current === undefined) return current ?? null;
    if (typeof current === 'string') {
      // Redact the complete value before bounding it: a truncated JSON string
      // may lose its closing quote and defeat the credential pattern.
      const bounded = redactActivityText(current);
      budget.remaining -= bounded.length;
      return bounded.length > MAX_STRING ? `${bounded.slice(0, MAX_STRING)}…` : bounded;
    }
    if (typeof current === 'number' || typeof current === 'boolean') return current;
    if (depth >= MAX_DEPTH) return '[省略]';
    if (Array.isArray(current)) return current.slice(0, MAX_ITEMS).map(item => walk(item, depth + 1));
    if (typeof current !== 'object') return String(current);
    if (seen.has(current)) return '[循环]';
    seen.add(current);
    const output = {};
    for (const [key, item] of Object.entries(current).slice(0, 50)) {
      if (budget.remaining <= 0) { output['…'] = '内容过长已省略'; break; }
      output[key] = SENSITIVE_KEY.test(key) ? '[已隐藏]' : walk(item, depth + 1);
    }
    return output;
  };
  return walk(value, 0);
}

/** Build lookup maps from a company snapshot. Trash records remain resolvable. */
export function activityContext(data = {}) {
  const map = (...lists) => new Map(lists.flat().filter(Boolean).filter(item => item.id).map(item => [item.id, item]));
  const entityTrash = data.entityTrash ?? [];
  return {
    projects: map(data.projects ?? [], entityTrash.filter(item => item.entityKind === 'project')),
    goals: map(data.goals ?? [], entityTrash.filter(item => item.entityKind === 'goal')),
    tasks: map(data.tasks ?? [], data.trash ?? []),
    agents: map(data.agents ?? [], entityTrash.filter(item => item.entityKind === 'agent')),
    attempts: map(data.attempts ?? []),
    interactions: map(data.interactions ?? []),
    templates: map(data.templates ?? []),
  };
}

const titleOf = (item, fallback) => item?.title ?? item?.name ?? fallback;
const statusLabel = status => STATUS_LABEL[status] ?? status ?? '未知';
const shortReason = value => (typeof value === 'string' && value.trim() ? redactActivityText(value.trim()).slice(0, MAX_STRING) : null);
const list = (value, limit = 4) => Array.isArray(value) ? value.slice(0, limit) : [];

function goalOf(event, context, task) {
  const goalId = task?.goalId ?? event.goalId ?? event.data?.goalId ?? event.data?.sourceGoalId;
  return (goalId && context.goals.get(goalId)) || null;
}
function projectOf(event, context, goal) {
  const projectId = goal?.projectId ?? event.data?.projectId;
  if (projectId && context.projects.get(projectId)) return context.projects.get(projectId);
  if (event.entityId?.startsWith('project_')) return context.projects.get(event.entityId) ?? null;
  return null;
}
function taskOf(event, context) {
  if (event.data?.taskId && context.tasks.get(event.data.taskId)) return context.tasks.get(event.data.taskId);
  if (event.entityId?.startsWith('task_')) return context.tasks.get(event.entityId) ?? null;
  if (event.entityId?.startsWith('attempt_')) return context.tasks.get(context.attempts.get(event.entityId)?.taskId) ?? null;
  if (event.entityId?.startsWith('interaction_')) return context.tasks.get(context.interactions.get(event.entityId)?.taskId) ?? null;
  return null;
}
function reviewSourceOf(event, context) {
  const sourceId = event.data?.sourceTaskId ?? event.data?.taskId;
  if (sourceId && context.tasks.get(sourceId)) return context.tasks.get(sourceId);
  const review = event.entityId?.startsWith('task_') ? context.tasks.get(event.entityId) : null;
  if (review?.reviewOf && context.tasks.get(review.reviewOf)) return context.tasks.get(review.reviewOf);
  return null;
}
function goalScopeOf(event, context) {
  if (event.data?.scope === 'goal') return true;
  const review = event.entityId?.startsWith('task_') ? context.tasks.get(event.entityId) : null;
  return review?.reviewScope === 'goal';
}
function actorOf(event, context) {
  const kind = event.actor?.kind ?? 'system';
  const actorId = event.actor?.id ?? 'system';
  if (kind === 'owner') return { kind, id: actorId, label: '所有者' };
  if (kind === 'user-agent') {
    const behalf = event.onBehalfOf;
    const who = behalf?.kind === 'owner' ? '所有者' : behalf?.id ?? behalf?.kind ?? null;
    return { kind, id: actorId, label: who ? `外部智能体（代表${who}）` : '外部智能体' };
  }
  if (kind === 'system') return { kind, id: actorId, label: '调度器' };
  // The role/name stored on the event is the historical fact. The current agent
  // record is only a display fallback and is explicitly marked when the event
  // predates role snapshots; it must never rewrite earlier attribution.
  const storedRole = event.data?.actorRole ?? null;
  const storedName = event.data?.actorName ?? null;
  const agent = context.agents.get(actorId);
  const name = storedName ?? agent?.name ?? null;
  if (!storedRole) {
    if (!name) return { kind: 'agent', id: actorId, name: null, role: null, label: '未知智能体' };
    return { kind: 'agent', id: actorId, name, role: null, label: `智能体 · ${name}（历史角色未记录）` };
  }
  return { kind: 'agent', id: actorId, name, role: storedRole, label: `${ROLE_LABEL[storedRole] ?? '智能体'} · ${name ?? actorId}` };
}
function executorOf(event, context) {
  const id = event.data?.executorId ?? null;
  if (id) return `${ROLE_LABEL[event.data?.executorRole] ?? '智能体'} · ${event.data?.executorName ?? id}`;
  if (!event.entityId?.startsWith('attempt_')) return null;
  const attempt = context.attempts.get(event.entityId);
  if (!attempt?.agentId) return null;
  const agent = context.agents.get(attempt.agentId);
  return `${ROLE_LABEL[attempt.role] ?? '智能体'} · ${agent?.name ?? attempt.agentId}`;
}
function subjectOf(event, context, { task, goal, project }) {
  const type = event.type;
  if (type.startsWith('project.')) return project ? { kind: 'project', id: project.id, title: project.name } : null;
  if (type.startsWith('goal.')) return goal ? { kind: 'goal', id: goal.id, title: goal.title } : null;
  if (type.startsWith('agent.')) {
    const agent = context.agents.get(event.entityId);
    return agent ? { kind: 'agent', id: agent.id, title: agent.name } : null;
  }
  if (type.startsWith('template.')) {
    const template = context.templates.get(event.entityId);
    return template ? { kind: 'template', id: template.id, title: template.name } : null;
  }
  if (type.startsWith('company.') || type === 'policy.changed') return { kind: 'company', id: 'company', title: '公司设置' };
  if (type.startsWith('model.') || type.startsWith('agentCredential.')) return { kind: 'company', id: 'company', title: '外部接入与模型' };
  if (type.startsWith('review.') || type.startsWith('coordination.') || type === 'blocker.coordinated') {
    if (type.startsWith('review.') && goalScopeOf(event, context) && goal) return { kind: 'goal', id: goal.id, title: goal.title };
    const source = reviewSourceOf(event, context);
    if (source) return { kind: 'task', id: source.id, title: source.title };
  }
  if (task) return { kind: 'task', id: task.id, title: task.title };
  if (goal) return { kind: 'goal', id: goal.id, title: goal.title };
  return null;
}

function categoryOf(type) {
  if (/(\.blocked|\.environment\.blocked|blocker\.coordinated|timebox\.blocked|integration\.failed|\.failed)$/.test(type)) return 'block';
  if (type.startsWith('review.') || type === 'plan.accepted' || type === 'coordination.decided') return 'review';
  if (/(\.succeeded|\.completed|\.finished|\.decided|\.applied)$/.test(type) || type === 'coordination.applied') return 'result';
  if (/(\.resumed|\.recovered|\.restored|result\.recovered|recheck\.requested|evidence\.refreshed)$/.test(type)) return 'recover';
  if (/(\.deleted|\.purged|\.cancelled|\.paused|\.stopped|\.stopping|timebox\.warning|timebox\.blocked)$/.test(type)) return 'control';
  if (/(\.created|\.published|\.paired|\.invited|\.saved|\.submitted)$/.test(type)) return 'create';
  if (/^(company|policy|model|agentCredential|legacy)\./.test(type)) return 'system';
  return 'change';
}

/** Describe one event entry. Returns null for events that are not business activity. */
export function describeActivity(event, context = activityContext()) {
  if (!event || !ACTIVITY_SET.has(event.type)) return null;
  const task = taskOf(event, context);
  const goal = goalOf(event, context, task);
  const project = projectOf(event, context, goal);
  const actor = actorOf(event, context);
  const subject = subjectOf(event, context, { task, goal, project });
  const executor = executorOf(event, context);
  const review = event.entityId?.startsWith('task_') ? context.tasks.get(event.entityId) : null;
  const goalScope = goalScopeOf(event, context);
  const source = reviewSourceOf(event, context);
  const reviewTitle = task?.title ?? review?.title ?? '任务';
  const sourceTitle = source?.title ?? reviewTitle;
  const goalTitle = titleOf(goal, '目标');
  const projectName = titleOf(project, '项目');
  let action = '';
  let reason = null;

  switch (event.type) {
    case 'company.created': action = '初始化了公司'; break;
    case 'company.paused': action = '暂停了公司调度'; break;
    case 'company.resumed': action = '恢复了公司调度'; break;
    case 'policy.changed': action = '更新了公司与资源边界'; break;
    case 'project.saved': action = event.data?.created === true ? `创建了项目「${projectName}」` : event.data?.created === false ? `更新了项目「${projectName}」` : `保存了项目「${projectName}」`; break;
    case 'project.deleted': action = `移除了项目「${projectName}」`; break;
    case 'project.restored': action = `恢复了项目「${projectName}」`; break;
    case 'goal.created': action = `创建了目标「${goalTitle}」`; break;
    case 'goal.status.changed': action = `将目标「${goalTitle}」从${statusLabel(event.data?.from)}改为${statusLabel(event.data?.status)}`; break;
    case 'goal.succeeded': action = event.data?.contractVersion ? `目标「${goalTitle}」完成（交付版本 ${event.data.contractVersion}）` : `目标「${goalTitle}」完成`; break;
    case 'goal.reopened': action = `目标「${goalTitle}」重新打开`; reason = shortReason(event.data?.reason); break;
    case 'goal.paused': action = event.data?.mode === 'after-current' ? `将在当前执行结束后暂停目标「${goalTitle}」` : `暂停了目标「${goalTitle}」`; reason = shortReason(event.data?.reason); break;
    case 'goal.resumed': action = `恢复了目标「${goalTitle}」`; break;
    case 'goal.cancelled': action = `取消了目标「${goalTitle}」`; reason = shortReason(event.data?.reason); break;
    case 'goal.contract.changed': action = `修改了目标「${goalTitle}」的验收合同（版本 ${event.data?.contractVersion ?? '?'}）`; break;
    case 'goal.contract.assessed': action = `处理了目标「${goalTitle}」的合同版本 ${event.data?.contractVersion ?? '?'}`; break;
    case 'goal.runtime.extended': action = `为目标「${goalTitle}」追加了 ${Math.round((event.data?.additionalRuntimeMs ?? 0) / 60000)} 分钟执行时间`; break;
    case 'goal.timebox.warning': action = `目标「${goalTitle}」触发时间盒预警`; reason = `已用 ${Math.round((event.data?.usedMs ?? 0) / 60000)} 分钟，准备收尾`; break;
    case 'goal.timebox.blocked': action = `目标「${goalTitle}」达到时间盒上限`; reason = shortReason(event.data?.message) ?? '等待负责人收尾或追加授权'; break;
    case 'goal.submitted': action = `外部智能体代表所有者提交了目标「${goalTitle}」`; break;
    case 'goal.deleted': action = `移除了目标「${goalTitle}」`; break;
    case 'goal.restored': action = `恢复了目标「${goalTitle}」`; break;
    case 'task.created': action = `创建了任务「${task?.title ?? event.data?.title ?? '任务'}」`; break;
    case 'task.changed': {
      const fields = list(event.data?.fields).map(field => FIELD_LABEL[field] ?? field).join('、');
      action = fields ? `更新了任务「${task?.title ?? reviewTitle}」的${fields}` : `更新了任务「${reviewTitle}」`;
      break;
    }
    case 'task.dependencies': action = `调整了任务「${reviewTitle}」的依赖（${list(event.data?.dependencies, 20).length} 项）`; break;
    case 'task.blocked': action = `任务「${reviewTitle}」已阻塞`; reason = `${BLOCK_KIND[event.data?.kind] ?? '需要处理'}：${shortReason(event.data?.reason) ?? '等待负责人处理'}`; break;
    case 'task.paused.requested': action = `请求暂停任务「${reviewTitle}」`; reason = shortReason(event.data?.reason); break;
    case 'task.cancelled.requested': action = `请求取消任务「${reviewTitle}」`; reason = shortReason(event.data?.reason); break;
    case 'task.resumed': action = `恢复了任务「${reviewTitle}」`; break;
    case 'task.retry.scheduled': action = `安排了任务「${reviewTitle}」的自动重试`; break;
    case 'task.stop.completed': action = `停止了任务「${reviewTitle}」的在途执行`; break;
    case 'task.succeeded': action = `任务「${reviewTitle}」完成交付`; break;
    case 'task.restored': action = `恢复了任务「${reviewTitle}」`; break;
    case 'task.deleted': action = `将任务「${reviewTitle}」移入回收站`; break;
    case 'task.purged': action = `彻底删除了任务「${reviewTitle}」`; break;
    case 'task.host.resumed': action = `宿主恢复后继续任务「${reviewTitle}」`; break;
    case 'task.integration.resumed': action = `继续任务「${reviewTitle}」的集成`; break;
    case 'task.environment.blocked': action = `任务「${reviewTitle}」因执行环境缺项阻塞`; reason = `${list(event.data?.fingerprints, 3).length} 项环境缺项待恢复`; break;
    case 'task.environment.recovered': action = `任务「${reviewTitle}」执行环境已恢复`; break;
    case 'task.environment.recheck.requested': action = `请求重新检查任务「${reviewTitle}」的执行环境`; break;
    case 'task.budget.released': action = `释放了任务「${reviewTitle}」的预算占位`; break;
    case 'task.recovery.requested': action = `请求核对任务「${reviewTitle}」的恢复状态`; break;
    case 'integration.failed': action = `任务「${reviewTitle}」集成失败`; reason = shortReason(event.data?.reason); break;
    case 'integration.reconciling': action = `任务「${reviewTitle}」的集成等待核对`; reason = shortReason(event.data?.reason); break;
    case 'interaction.answered': {
      const question = context.interactions.get(event.entityId)?.question;
      action = `回复了任务「${reviewTitle}」的待处理问题`;
      reason = shortReason(question) ? `问题：${question}` : null;
      break;
    }
    case 'review.queued': action = `调度器安排了目标「${goalTitle}」的最终审查`; break;
    case 'review.requested': action = goalScope ? `提交了目标「${goalTitle}」的最终审查` : `提交了任务「${sourceTitle}」的独立审查`; break;
    case 'review.request.reused': action = `复用了任务「${sourceTitle}」的审查请求`; break;
    case 'review.decided': {
      const approved = (event.decision ?? event.data?.decision) === 'approve';
      const target = goalScope ? `目标「${goalTitle}」交付` : `任务「${sourceTitle}」`;
      action = `审查${approved ? '通过' : '退回'}：${target}`;
      reason = shortReason(review?.summary);
      break;
    }
    case 'review.rework.requested': action = `要求任务「${sourceTitle}」返工（第 ${event.data?.reworks ?? '?'} 轮）`; break;
    case 'review.rework.limit': action = `任务「${sourceTitle}」返工次数达到上限`; break;
    case 'review.rework.blocked': action = `任务「${sourceTitle}」返工等待负责人处理`; break;
    case 'review.rework.gate': action = `创建了任务「${sourceTitle}」的返工门禁`; break;
    case 'coordination.created': action = `调度器创建了任务「${sourceTitle}」的协调任务`; break;
    case 'coordination.decided': action = `负责人提交了任务「${sourceTitle}」的协调决定`; break;
    case 'coordination.applied': action = `应用了任务「${sourceTitle}」的协调决定`; break;
    case 'coordination.evidence.refreshed': action = `刷新了任务「${sourceTitle}」的阻塞证据`; break;
    case 'blocker.coordinated': action = `将任务「${reviewTitle}」的阻塞交给负责人协调`; reason = `${BLOCK_KIND[event.data?.blockerKind] ?? '阻塞'}：${shortReason(event.data?.reason) ?? '等待负责人处理'}`; break;
    case 'plan.accepted': action = `负责人提交了执行计划（${list(event.data?.tasks, 20).length} 项任务）`; break;
    case 'management.batch.committed': action = `负责人提交了 ${event.data?.actionCount ?? '?'} 项管理动作`; break;
    case 'management.continued': action = `负责人继续了管理批次（第 ${event.data?.turn ?? '?'} 轮）`; break;
    case 'attempt.failed': action = `任务「${reviewTitle}」执行失败`; reason = shortReason(event.data?.message) ?? shortReason(event.data?.code); break;
    case 'attempt.finished': action = `任务「${reviewTitle}」的一次执行结束`; reason = event.data?.status ? `状态：${statusLabel(event.data.status)}` : null; break;
    case 'attempt.result.recovered': action = `恢复了任务「${reviewTitle}」的已完成回执`; break;
    case 'agent.saved': {
      const agent = context.agents.get(event.entityId);
      action = event.data?.created === true ? `创建了角色「${agent?.name ?? '未知角色'}」`
        : event.data?.created === false ? `更新了角色「${agent?.name ?? '未知角色'}」`
          : `保存了角色「${agent?.name ?? '未知角色'}」`;
      break;
    }
    case 'agent.released': action = `释放了临时角色「${context.agents.get(event.entityId)?.name ?? '未知角色'}」`; reason = shortReason(event.data?.reason); break;
    case 'agent.deleted': action = `移除了角色「${context.agents.get(event.entityId)?.name ?? '未知角色'}」`; break;
    case 'agent.restored': action = `恢复了角色「${context.agents.get(event.entityId)?.name ?? '未知角色'}」`; break;
    case 'template.published': action = `发布了目标模板「${context.templates.get(event.entityId)?.name ?? '未知模板'}」第 ${event.data?.version ?? '?'} 版`; break;
    case 'model.preferences.changed': action = event.data?.cleared ? '清除了模型偏好' : '更新了模型偏好'; break;
    case 'model.paired': action = '登记了外部模型'; break;
    case 'model.invited': action = '生成了外部模型配对邀请'; break;
    case 'model.unpaired': action = '移除了外部模型'; break;
    case 'agentCredential.created': action = `签发了外部接入凭据「${event.data?.name ?? '未命名'}」`; break;
    case 'agentCredential.scope.changed': action = '调整了外部接入凭据范围'; break;
    case 'agentCredential.revoked': action = '撤销了外部接入凭据'; break;
    case 'legacy.exported': action = '导出了旧版任务归档'; break;
    default: action = `记录了${event.type}事件`; break;
  }

  const evidence = {};
  for (const key of ['artifactHash', 'deliveryHash']) if (typeof event.data?.[key] === 'string') evidence[key] = event.data[key];
  if (typeof event.data?.integration?.integratedCommit === 'string') evidence.integratedCommit = event.data.integration.integratedCommit;
  if (typeof event.data?.reviewTaskId === 'string') evidence.reviewTaskId = event.data.reviewTaskId;
  if (typeof event.data?.coordinationTaskId === 'string') evidence.coordinationTaskId = event.data.coordinationTaskId;
  const deliverySource = Array.isArray(event.data?.delivery) ? event.data.delivery : [];
  const delivery = deliverySource.map(item => ({
    id: typeof item?.id === 'string' ? item.id : null,
    title: redactActivityText(item?.title ?? '交付任务'),
    artifactHash: typeof item?.artifactHash === 'string' ? item.artifactHash : null,
    artifactIds: Array.isArray(item?.artifactIds) ? item.artifactIds : [],
    generation: item?.generation ?? item?.deliveryGeneration ?? null,
    contractVersion: item?.contractVersion ?? null,
  }));
  const deliveryTotal = deliverySource.length;
  const rawReview = event.data?.review && typeof event.data.review === 'object' ? event.data.review : null;
  let deliveryReview = null; let deliveryReviewStale = false;
  if (rawReview) {
    const reviewTask = rawReview.taskId ? context.tasks.get(rawReview.taskId) : null;
    const reviewHash = typeof rawReview.deliveryHash === 'string' ? rawReview.deliveryHash : (typeof rawReview.artifactHash === 'string' ? rawReview.artifactHash : null);
    const eventHash = typeof event.data?.deliveryHash === 'string' ? event.data.deliveryHash : null;
    const hashMatches = !!eventHash && reviewHash === eventHash;
    const statusOk = !reviewTask || (reviewTask.status === 'succeeded' && reviewTask.passed === true);
    if (rawReview.passed === true && hashMatches && statusOk) {
      deliveryReview = {
        taskId: typeof rawReview.taskId === 'string' ? rawReview.taskId : null,
        passed: true,
        artifactHash: reviewHash,
      };
    } else deliveryReviewStale = true;
  }

  const category = categoryOf(event.type);
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    category,
    categoryLabel: CATEGORY_LABEL[category] ?? '变更',
    actor: { ...actor, ...(actor.name ? { name: redactActivityText(actor.name) } : {}), label: redactActivityText(actor.label) },
    executor: executor && executor !== actor.label ? redactActivityText(executor) : null,
    subject: subject ? { ...subject, title: redactActivityText(subject.title ?? '') } : null,
    goal: goal ? { id: goal.id, title: redactActivityText(goal.title ?? '') } : null,
    project: project ? { id: project.id, title: redactActivityText(project.name ?? '') } : null,
    delivery,
    deliveryTotal,
    deliveryReview,
    deliveryReviewStale,
    action: redactActivityText(action),
    reason: reason ? redactActivityText(reason).slice(0, MAX_STRING) : null,
    evidence,
    reviewTaskId: event.type.startsWith('review.') && review && review.id !== source?.id ? review.id : null,
    details: sanitizeActivityData({ ...(event.data ?? {}), ...(event.decision !== undefined ? { decision: event.decision } : {}) }),
  };
}
