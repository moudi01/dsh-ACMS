import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { assert } from '../core/util.js';

const FORMAT = 'acms.collaboration.v1';
const hash = text => createHash('sha256').update(text).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const queues = new Map();
const README = `# ACMS 项目协作\n\n此目录由 ACMS 在添加项目时建立。\n\n- shared.md：所有者维护的协作说明；系统不会覆盖。说明不会扩大任务授权。\n- CURRENT.json：最新快照入口。\n- snapshots/：任务状态、父子关系、依赖、历史文档索引、阻塞及交付记录。\n- evidence/：按内容哈希保存的迁移文档和评论，保留原文，不代表重新批准。\n\n执行器收到的是隔离工作区内固定的 context.json 和相关 evidence；先定位自己的任务、父任务、依赖及最近记录，按需读证据，避免重新扫描整个项目。只读历史链接通过旧任务编号和文档 key 在索引中解析，无需连接旧 Paperclip 服务。\n\n任务交接通过 ACMS 提交交付物、摘要或阻塞，系统再更新快照；不要直接改写生成目录。交付物仍须经过检查和独立审查。\n`;

async function directory(filename) {
  try { const st = await fs.lstat(filename); assert(st.isDirectory() && !st.isSymbolicLink(), 'COLLABORATION_PATH', '协作目录不能是符号链接或普通文件'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; await fs.mkdir(filename); }
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
async function seed(filename, contents) {
  if (await regular(filename)) return;
  try { await fs.writeFile(filename, contents, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
function serialized(root, work) {
  const key = path.resolve(root).toLowerCase(); const before = queues.get(key) ?? Promise.resolve();
  const pending = before.catch(() => {}).then(work); queues.set(key, pending);
  return pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
}

export function collaborationSnapshot(company, project, goalId) {
  const store = company.store; const blobs = new Map();
  const evidence = (contents, extension) => { const file = `evidence/${hash(contents)}.${extension}`; blobs.set(file, contents); return file; };
  const tasks = store.list('tasks').filter(t => t.projectId === project.id && t.status !== 'deleted' && (!goalId || t.goalId === goalId));
  const ids = new Set(tasks.map(t => t.id));
  const attempts = store.list('attempts'); const artifacts = store.list('artifacts');
  const snapshot = {
    format: FORMAT, project: { id: project.id, name: project.name },
    goals: store.list('goals').filter(g => g.projectId === project.id && (!goalId || g.id === goalId)).map(({id,title,description,acceptance,status})=>({id,title,description,acceptance,status})),
    tasks: tasks.map(t => ({ id: t.id, identifier: t.legacy?.identifier, title: t.title, status: t.status, kind: t.kind, parentId: t.parentId, dependencies: t.dependencies,
      description: t.description, acceptance: t.acceptance, agentId: t.agentId, blocker: t.blocker, feedback: t.feedback, lastAnswer: t.lastAnswer,
      legacyStatus: t.legacy?.status, historicalCompletionAccepted: t.legacy?.completionAccepted,
      documents: (t.legacy?.documents ?? []).map(d => ({ key: d.key, title: d.title, updatedAt: d.updatedAt, path: evidence(d.body ?? '', 'md') })),
      comments: t.legacy?.comments?.length ? { count: t.legacy.comments.length, path: evidence(json(t.legacy.comments), 'json'), recent: t.legacy.comments.slice(-6) } : null,
      attempts: attempts.filter(a => a.taskId === t.id).slice(-5).map(({id,status,startedAt,finishedAt,summary,handoff})=>({id,status,startedAt,finishedAt,summary,handoff})),
      artifacts: artifacts.filter(a => a.taskId === t.id).map(({id,path,title,hash,bytes})=>({id,path,title,hash,bytes})),
    })),
    interactions: store.list('interactions').filter(i => ids.has(i.taskId) && i.status === 'pending').map(({taskId,kind,reason,question})=>({taskId,kind,reason,question})),
  };
  return { snapshot, blobs };
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
    await directory(path.join(folder, 'snapshots')); await directory(path.join(folder, 'evidence'));
    const { snapshot, blobs } = collaborationSnapshot(company, project); const text = json(snapshot); const revision = hash(text);
    for (const [file, contents] of blobs) await immutable(path.join(folder, file), contents);
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
  const { snapshot, blobs } = collaborationSnapshot(company, project, task.goalId);
  const text = json(snapshot); const revision = hash(text + notes);
  const folder = path.join(workspace.path, '.acms'); await directory(folder); await directory(path.join(folder, 'evidence'));
  const files = new Map([...blobs, ['context.json', text], ['shared.md', notes], ['README.md', README]]);
  const hashes = {};
  for (const [file, contents] of files) {
    if (file.startsWith('evidence/')) await immutable(path.join(folder, file), contents);
    else await atomic(path.join(folder, file), contents);
    hashes[file] = hash(contents);
  }
  return { ...workspace, collaboration: { revision, index: '.acms/context.json', notes: '.acms/shared.md', taskId: task.id, files: hashes } };
}

export async function verifyCollaboration(workspace) {
  if (workspace.collaboration) { await directory(path.join(workspace.path, '.acms')); await directory(path.join(workspace.path, '.acms', 'evidence')); }
  for (const [file, expected] of Object.entries(workspace.collaboration?.files ?? {})) {
    assert(/^(context\.json|shared\.md|README\.md|evidence\/[a-f0-9]{64}\.(md|json))$/.test(file), 'COLLABORATION_PATH', '无效协作文件路径');
    const filename = path.join(workspace.path, '.acms', file); await regular(filename);
    assert(hash(await fs.readFile(filename)) === expected, 'COLLABORATION_CHANGED', '执行器修改了固定协作上下文；请在普通任务文档中提交交接');
  }
}

export const isCollaborationPath = filename => filename.replaceAll('\\', '/').split('/')[0].toLowerCase() === '.acms';
