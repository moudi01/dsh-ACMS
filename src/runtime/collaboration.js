import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { assert } from '../core/util.js';
import { contractVersion, deliveryGeneration, taskContractVersion } from '../core/goal-contract.js';

const FORMAT = 'acms.collaboration.v1';
const HANDOFF = 'acms.task-handoff.v1';
const LEGACY_HISTORY = 'task-history.json';
const STARTER_BYTES = 16 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const queues = new Map();
const README = `# ACMS 项目协作\n\n此目录由 ACMS 在添加项目时建立。\n\n- shared.md：所有者维护的协作说明；系统不会覆盖。说明不会扩大任务授权。\n- CURRENT.json：最新快照入口。\n- snapshots/：任务状态、父子关系、依赖、阻塞及交付记录。\n\n执行器收到的是隔离工作区内固定的 context.json；先定位自己的任务、父任务、依赖及最近记录。若存在 handoff.history，只在需要时按其哈希核对并读取关联任务的历史记录，避免重新扫描整个项目。\n\n任务交接通过 ACMS 提交交付物、摘要或阻塞，系统再更新快照；不要直接改写生成目录。交付物仍须经过检查和独立审查。\n`;

async function directory(filename, create = true) {
  try { const st = await fs.lstat(filename); assert(st.isDirectory() && !st.isSymbolicLink(), 'COLLABORATION_PATH', '协作目录不能是符号链接或普通文件'); }
  catch (e) { if (!create || e.code !== 'ENOENT') throw e; await fs.mkdir(filename); }
}
async function workspaceFolder(workspace, create) {
  await directory(workspace.path, false);
  const folder = path.join(await fs.realpath(workspace.path), '.acms');
  await directory(folder, create);
  return folder;
}
async function regular(filename) {
  try { const st = await fs.lstat(filename); assert(st.isFile() && !st.isSymbolicLink(), 'COLLABORATION_PATH', '协作文件不能是链接或目录'); return st; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function atomic(filename, contents) {
  await regular(filename);
  const temporary = path.join(path.dirname(filename), `.tmp-${randomUUID()}`);
  try { await fs.writeFile(temporary, contents, { flag: 'wx' }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function immutable(filename, contents) {
  const st = await regular(filename);
  if (st) { assert(await fs.readFile(filename, 'utf8') === contents, 'COLLABORATION_CHANGED', '协作证据与其哈希不符，已停止使用该文件'); return; }
  try { await fs.writeFile(filename, contents, { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; assert(await fs.readFile(filename, 'utf8') === contents, 'COLLABORATION_CHANGED', '协作证据写入冲突'); }
}
async function publishHandoffHistory(folder, revision, contents) {
  const filename = path.join(folder, historyFilename(revision));
  if (!await regular(filename)) {
    const stage = path.join(folder, '.tmp-' + randomUUID());
    try {
      await fs.writeFile(stage, contents, { flag: 'wx', flush: true });
      try { await fs.link(stage, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await fs.rm(stage, { force: true }); }
  }
  assert(await regular(filename) && hash(await fs.readFile(filename)) === revision, 'COLLABORATION_CHANGED',
    '交接历史与固定摘要不符，请恢复原版本后继续');
}
async function seed(filename, contents) {
  if (await regular(filename)) return;
  try { await fs.writeFile(filename, contents, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
function serialized(root, work) {
  const key = path.resolve(root).toLowerCase(); const before = queues.get(key) ?? Promise.resolve();
  const pending = before.catch(() => {}).then(work); queues.set(key, pending);
  return pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
}

function byTask(rows, ids) {
  const grouped = new Map();
  for (const row of rows) {
    if (!ids.has(row.taskId)) continue;
    if (!grouped.has(row.taskId)) grouped.set(row.taskId, []);
    grouped.get(row.taskId).push(row);
  }
  return grouped;
}

function checkpoints(attempts, task) {
  const usable = attempts.filter(a => !a.preflightOnly && !a.resultDeferred && a.resultAccepted !== false &&
    !['claimed', 'preparing', 'starting', 'running', 'cancelling', 'reconciling'].includes(a.status) && (a.summary || a.handoff));
  const current = usable.findLast(a => (a.taskGeneration ?? 1) === (task.generation ?? 1) &&
    (a.goalContractVersion ?? 1) === taskContractVersion(task));
  return { current, historical: current ? null : usable.at(-1) };
}

function attemptEvidence({id,status,startedAt,finishedAt,summary,handoff,taskGeneration,goalContractVersion}) {
  return {id,status,startedAt,finishedAt,summary,handoff,taskGeneration,goalContractVersion};
}

export function collaborationSnapshot(company, project, goalId, handoff = false) {
  const store = company.store;
  const tasks = (goalId ? store.tasksForGoal(goalId) : store.list('tasks')).filter(t => t.projectId === project.id && t.status !== 'deleted');
  const ids = new Set(tasks.map(t => t.id));
  const attempts = byTask(store.list('attempts'), ids); const artifacts = byTask(store.list('artifacts'), ids);
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const goals = (goalId ? [store.get('goals', goalId)] : store.list('goals')).filter(g => g?.projectId === project.id);
  assert(!handoff || goals.length === 1, 'COLLABORATION_PROJECT', '任务交接与当前目标的项目归属不符');
  const snapshot = {
    format: FORMAT, project: { id: project.id, name: project.name },
    goals: goals.map(({id,title,description,acceptance,status})=>({id,title,description,acceptance,status})),
    tasks: tasks.map(t => {
      const history = attempts.get(t.id) ?? [];
      const eligible = handoff ? history.filter(a => a.finishedAt || a.summary || a.handoff) : history;
      const recent = eligible.slice(-5);
      const checkpoint = handoff ? checkpoints(eligible, t) : {};
      const latest = checkpoint.current ?? checkpoint.historical;
      if (latest && !recent.includes(latest)) recent.unshift(latest);
      return {
        id: t.id, title: t.title, status: t.status, kind: t.kind, parentId: t.parentId, dependencies: t.dependencies,
        description: t.description, acceptance: t.acceptance, agentId: t.agentId, blocker: t.blocker, feedback: t.feedback, lastAnswer: t.lastAnswer,
        attempts: handoff ? recent.map(attemptEvidence) : recent.map(({id,status,startedAt,finishedAt,summary,handoff})=>({id,status,startedAt,finishedAt,summary,handoff})),
        artifacts: (artifacts.get(t.id) ?? []).map(({id,path,title,hash,bytes,attemptId})=>({id,path,title,hash,bytes,
          ...(handoff ? { attemptId, selectedForDelivery: t.artifactIds?.includes(id) === true } : {})})),
        ...(handoff ? { taskGeneration: t.generation, goalContractVersion: taskContractVersion(t),
          deliveryGeneration: t.artifactHash ? deliveryGeneration(t) : null, artifactHash: t.artifactHash ?? null,
          repairOf: t.repairOf ?? null, checkpointAttemptId: checkpoint.current?.id ?? null,
          historicalCheckpointId: checkpoint.historical?.id ?? null } : {}),
      };
    }),
    interactions: store.list('interactions').filter(i => ids.has(i.taskId) && i.status === 'pending' && (!handoff ||
      ((!i.goalId || i.goalId === goalId) && (i.taskGeneration === undefined || i.taskGeneration === taskMap.get(i.taskId).generation))))
      .map(({id,taskId,kind,reason,question})=>({...(handoff ? { id } : {}),taskId,kind,reason,question})),
  };
  return { snapshot, ...(handoff ? { goalContractVersion: contractVersion(goals[0]) } : {}) };
}

function focusedTasks(task, rows) {
  const index = new Map(rows.map(record => [record.id, record]));
  const related = new Map();
  const unavailable = new Set();
  const add = id => {
    const record = index.get(id);
    if (record) related.set(id, record);
    else unavailable.add(id);
    return record;
  };
  add(task.id);
  const ancestors = new Set([task.id]);
  let parent = task.parentId;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = add(parent)?.parentId;
  }
  const pending = [...(task.dependencies ?? []), ...(task.repairOf ? [task.repairOf] : [])];
  const seen = new Set([task.id]);
  for (const id of pending) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = add(id);
    if (record) pending.push(...(record.dependencies ?? []));
  }
  return { related, unavailable };
}

function excerpt(text, length) {
  return typeof text === 'string' && text.length > length ? text.slice(0, length).toWellFormed() + '…' : text;
}

const historyFilename = revision => 'task-history-' + revision + '.json';

function compactHandoff(task, snapshot, goalVersion) {
  const { related, unavailable } = focusedTasks(task, snapshot.tasks);
  const history = json(snapshot);
  const revision = hash(history);
  const historyRef = { path: '.acms/' + historyFilename(revision), sha256: revision, bytes: Buffer.byteLength(history) };
  const omissions = { tasks: snapshot.tasks.length, attempts: 0, artifacts: 0, interactions: snapshot.interactions.length };
  for (const row of snapshot.tasks) {
    omissions.attempts += row.attempts.length;
    omissions.artifacts += row.artifacts.length;
  }
  const handoff = { format: HANDOFF, taskId: task.id, taskGeneration: task.generation, goalContractVersion: goalVersion,
    history: historyRef, unavailableInputs: [...unavailable].slice(0, 12), unavailableCount: unavailable.size, omitted: omissions };
  const { id, title, status } = snapshot.goals[0];
  const context = { format: FORMAT, project: snapshot.project, goals: [{ id, title: excerpt(title, 300), status }], handoff,
    tasks: [], interactions: [] };
  const add = (list, record) => {
    list.push(record);
    if (Buffer.byteLength(json(context)) <= STARTER_BYTES) return true;
    list.pop();
    return false;
  };
  const selected = [];
  for (const row of related.values()) {
    if (selected.length === 12) break;
    const { id, title, status, kind, parentId, taskGeneration, goalContractVersion, deliveryGeneration, artifactHash, repairOf } = row;
    const dependencies = row.dependencies ?? [];
    const value = { id, title: excerpt(title, 300), status, kind, parentId, dependencies: dependencies.slice(0, 12),
      dependencyCount: dependencies.length, taskGeneration, goalContractVersion, deliveryGeneration, artifactHash, repairOf,
      ...(row.historicalCheckpointId ? { historicalCheckpointId: row.historicalCheckpointId } : {}),
      ...(row.blocker ? { blocker: { kind: row.blocker.kind, reason: excerpt(row.blocker.reason, 400) } } : {}),
      attempts: [], artifacts: [] };
    if (add(context.tasks, value)) { selected.push([row, value]); omissions.tasks--; }
  }
  for (const [row, value] of selected) {
    const pending = snapshot.interactions.filter(item => item.taskId === row.id).at(-1);
    if (pending) {
      const { id, taskId, kind, reason, question } = pending;
      if (add(context.interactions, { id, taskId, kind, reason: excerpt(reason, 320), question: excerpt(question, 640) })) omissions.interactions--;
    }
    const latest = row.attempts.find(a => a.id === row.checkpointAttemptId);
    if (latest && add(value.attempts, { ...latest, summary: excerpt(latest.summary, 640), handoff: excerpt(latest.handoff, 640) })) omissions.attempts--;
  }
  for (const [row, value] of selected) {
    for (const { id, path, title, hash, bytes, attemptId, selectedForDelivery } of row.artifacts.slice(-4)) {
      if (add(value.artifacts, { id, path: excerpt(path, 300), title: excerpt(title, 180), hash, bytes, attemptId, selectedForDelivery })) omissions.artifacts--;
    }
  }
  const text = json(context);
  return { text, history, metadata: { format: HANDOFF, bytes: Buffer.byteLength(text), history: historyRef, omitted: omissions } };
}

export async function publishCollaboration(company, project) {
  const root = await fs.realpath(project.repoRoot);
  return serialized(root, async () => {
    const folder = path.join(root, '.acms'); await directory(folder);
    const marker = path.join(folder, 'project.json'); const existing = await regular(marker);
    if (existing) { const value = JSON.parse(await fs.readFile(marker, 'utf8')); assert(value.format === FORMAT && value.projectId === project.id, 'COLLABORATION_PROJECT', '.acms 已属于其他项目，不能覆盖'); }
    else { assert(!await regular(path.join(folder, 'CURRENT.json')), 'COLLABORATION_PROJECT', '.acms 中已有未归属的快照入口，不能覆盖'); await immutable(marker, json({ format: FORMAT, projectId: project.id })); }
    await seed(path.join(folder, 'README.md'), README);
    await seed(path.join(folder, 'shared.md'), '# 项目协作说明\n\n供所有者维护长期约定、交接补充和只读材料位置。实际授权以 ACMS 任务合同及已批准范围为准。\n');
    await directory(path.join(folder, 'snapshots'));
    const { snapshot } = collaborationSnapshot(company, project); const text = json(snapshot); const revision = hash(text);
    await immutable(path.join(folder, 'snapshots', `${revision}.json`), text);
    const pointer = json({ format: FORMAT, projectId: project.id, revision, path: `snapshots/${revision}.json` });
    const current = path.join(folder, 'CURRENT.json');
    if (!await regular(current) || await fs.readFile(current, 'utf8') !== pointer) await atomic(current, pointer);
    return { path: folder, revision };
  });
}

export async function syncCollaboration(company, project, task, workspace) {
  const published = await publishCollaboration(company, project);
  const notesPath = path.join(published.path, 'shared.md'); const st = await regular(notesPath);
  assert(st?.size <= 262144, 'COLLABORATION_SIZE', 'shared.md 不得超过 256 KiB；大型证据请放入独立任务文档');
  const notes = await fs.readFile(notesPath, 'utf8');
  const shouldCompact = ['work', 'repair'].includes(task.kind);
  const { snapshot, goalContractVersion } = company.store.readSnapshot(() => collaborationSnapshot(company, project, task.goalId, shouldCompact));
  const compact = shouldCompact ? compactHandoff(task, snapshot, goalContractVersion) : null;
  const text = compact?.text ?? json(snapshot); const revision = hash(text + notes);
  const folder = await workspaceFolder(workspace, true);
  const hashes = {};
  if (compact) {
    const { sha256 } = compact.metadata.history;
    await publishHandoffHistory(folder, sha256, compact.history);
    hashes[historyFilename(sha256)] = sha256;
  }
  const files = new Map([['shared.md', notes], ['README.md', README], ['context.json', text]]);
  for (const [file, contents] of files) {
    const filename = path.join(folder, file);
    if (!await regular(filename) || await fs.readFile(filename, 'utf8') !== contents) await atomic(filename, contents);
    hashes[file] = hash(contents);
  }
  return { ...workspace, collaboration: { revision, index: '.acms/context.json', notes: '.acms/shared.md', taskId: task.id, files: hashes,
    ...(compact ? { handoff: compact.metadata } : {}) } };
}

export async function verifyCollaboration(workspace) {
  const files = Object.entries(workspace.collaboration?.files ?? {});
  if (!files.length) return;
  const folder = await workspaceFolder(workspace, false);
  for (const [file, expected] of files) {
    assert(/^[a-f0-9]{64}$/.test(expected) && (['context.json', 'shared.md', 'README.md', LEGACY_HISTORY].includes(file) ||
      file === historyFilename(expected)), 'COLLABORATION_PATH', '无效协作文件路径或摘要');
    const filename = path.join(folder, file);
    assert(await regular(filename) && hash(await fs.readFile(filename)) === expected,
      'COLLABORATION_CHANGED', '固定协作上下文缺失或已修改，请恢复原版本');
  }
}

export const isCollaborationPath = filename => filename.replaceAll('\\', '/').split('/')[0].toLowerCase() === '.acms';
