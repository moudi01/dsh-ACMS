import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assert, digest, OWNER } from '../core/util.js';
import { inside } from '../runtime/workspaces.js';

async function read(root, relative, optional = false) {
  const filename = path.join(root, relative);
  try {
    const actual = await fs.realpath(filename);
    assert(inside(root, actual), 'IMPORT_PATH', 'Import file escapes the selected snapshot');
    assert((await fs.stat(actual)).size <= 20 * 1024 * 1024, 'IMPORT_SIZE', 'Import JSON exceeds 20 MiB');
    return JSON.parse(await fs.readFile(actual, 'utf8'));
  } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
}
export async function inspectPaperclip(directory) {
  const root = await fs.realpath(directory); const index = await read(root, 'board/index.json');
  assert(Array.isArray(index) && index.length <= 1000, 'IMPORT_FORMAT', 'Expected bridge board/index.json with at most 1000 issues');
  const [agents, live, local, threads] = await Promise.all([read(root, 'board/agents.json', true), read(root, 'state/live.json', true), read(root, 'state/state.json', true), read(root, 'state/codex-threads.json', true)]);
  const issues = [];
  for (const entry of index) {
    assert(/^[A-Za-z0-9_-]+$/.test(entry.identifier), 'IMPORT_FORMAT', 'Invalid issue identifier');
    const detail = await read(root, `board/issues/${entry.identifier}.json`);
    issues.push({ ...detail, ...live?.issues?.[entry.identifier], ...local?.updates?.[entry.identifier], identifier: entry.identifier,
      parentIdentifier: entry.parentIdentifier, documents: detail.documents ?? [], comments: [...(detail.comments ?? []), ...(local?.comments?.[entry.identifier] ?? [])] });
  }
  assert(new Set(issues.map(i => i.identifier)).size === issues.length, 'IMPORT_FORMAT', 'Duplicate issue identifiers');
  const active = (live?.agentStatus ?? []).filter(a => ['running', 'working', 'busy'].includes(a.status)).map(a => a.name);
  for (const [key, entry] of Object.entries(threads ?? {})) {
    const summary = entry.summaryFile ? await read(root, path.join('state', entry.summaryFile), true) : null;
    if (summary && ['running', 'starting', 'stopping'].includes(summary.status)) active.push(key);
    if (entry.summaryFile) {
      const lock = path.join(root, 'state', entry.summaryFile.replace(/\.summary\.json$/, '.lock'));
      try { await fs.access(lock); active.push(`${key}:lock`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  const source = { issues, agents: agents ?? [], dispatches: local?.dispatches ?? [] };
  const fingerprint = digest(source);
  return { root, fingerprint, source, preview: { fingerprint, tasks: issues.length, agents: source.agents.length, documents: issues.reduce((n, i) => n + i.documents.length, 0), comments: issues.reduce((n, i) => n + i.comments.length, 0), historicalDone: issues.filter(i => i.status === 'done').length, activeExecutors: [...new Set(active)], unresolvedDispatches: source.dispatches.filter(d => !d.status || !['completed', 'cancelled', 'failed'].includes(d.status)).length,
    items: issues.map(i => ({ identifier: i.identifier, title: i.title, oldStatus: i.status, importedStatus: ['done', 'cancelled', 'canceled'].includes(i.status) ? 'archived' : 'paused' })) } };
}
export function importPaperclip(company, inspected, options) {
  assert(options.confirmedStopped === true && typeof options.stopEvidence === 'string' && options.stopEvidence.trim().length >= 10, 'IMPORT_STOP_REQUIRED', 'Pause all old executors and record the stop evidence first');
  assert(options.fingerprint === inspected.fingerprint, 'IMPORT_CHANGED', 'Source changed after preview; inspect it again');
  assert(!inspected.preview.activeExecutors.length, 'IMPORT_ACTIVE', 'Old provider state still reports active execution or a lock');
  const store = company.store; const key = `paperclip:${digest(inspected.root.toLowerCase())}`;
  const previous = store.get('migrations', key);
  if (previous) { assert(previous.fingerprint === inspected.fingerprint, 'IMPORT_EXISTS', 'This source was already imported; incremental overwrite is intentionally not supported'); return previous; }
  assert(!store.list('attempts').some(a => ['preparing', 'running', 'reconciling'].includes(a.status) || a.cleanupPending), 'IMPORT_TARGET_BUSY', 'Pause ACMS executions before migration');
  store.require('projects', options.projectId);
  return store.transaction(() => {
    assert(store.list('migrations').length === 0, 'MIGRATION_COMPLETED', '旧看板迁移已完成，一次性迁移功能已关闭');
    const goal = company.createGoal({ projectId: options.projectId, plan: false, title: options.title ?? 'Paperclip 迁移任务', description: '只读导入旧看板；经核对后逐项恢复。', acceptance: '沿用任务说明，并按 ACMS 独立审查流程验收新增交付。' }, OWNER);
    const agentMap = new Map(); const taskMap = new Map();
    for (const old of inspected.source.agents) {
      const agent = company.saveAgent({ name: old.name, role: 'worker', description: [old.title, old.instructions].filter(Boolean).join('\n'), provider: 'auto', temporary: false }, OWNER);
      store.put('agents', { ...agent, legacy: { id: old.id, role: old.role, provider: old.dispatchProvider, model: old.dispatchModel ?? old.model } }); agentMap.set(old.id, agent.id);
    }
    for (const old of inspected.source.issues) {
      const task = company.createTask({ goalId: goal.id, title: `${old.identifier} · ${old.title}`, description: old.description || old.title, acceptance: '核对迁移文档中的交付要求；提交实际交付物、项目检查及独立审查证据。', agentId: agentMap.get(old.assigneeAgentId) ?? 'manager' }, OWNER);
      const archived = ['done', 'cancelled', 'canceled'].includes(old.status);
      store.put('tasks', { ...task, status: archived ? 'archived' : 'paused', legacy: { source: 'paperclip', identifier: old.identifier, id: old.id, status: old.status, assigneeName: old.assigneeName, completionAccepted: old.status === 'done', documents: old.documents, comments: old.comments, attachments: old.attachments ?? [] } });
      taskMap.set(old.identifier, task.id);
    }
    for (const old of inspected.source.issues) {
      const taskId = taskMap.get(old.identifier); const task = store.require('tasks', taskId);
      const dependencies = (old.blockedBy ?? []).map(d => taskMap.get(typeof d === 'string' ? d : d.identifier)).filter(Boolean);
      // Reuse cycle and scope validation even for historical rows.
      if (task.status === 'archived') store.put('tasks', { ...task, status: 'paused' });
      company.dependencies({ id: taskId, dependencies }, OWNER);
      store.put('tasks', { ...store.require('tasks', taskId), status: task.status, parentId: taskMap.get(old.parentIdentifier) ?? null });
    }
    const result = store.put('migrations', { id: key, fingerprint: inspected.fingerprint, goalId: goal.id, tasks: taskMap.size, agents: agentMap.size, source: inspected.root, stopEvidence: options.stopEvidence, legacyCompletionPolicy: 'Historical done records are archived and satisfy imported dependencies; no ACMS verification is fabricated.' });
    store.event('migration.paperclip.imported', key, { goalId: goal.id, tasks: taskMap.size, fingerprint: inspected.fingerprint }, OWNER); return result;
  });
}
