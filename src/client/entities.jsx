import React from 'react';
import { ActionButton } from './components.jsx';
import { entityDeletionReason, entityTasks } from '../core/entity-actions.js';

export const entityLabels = { project: '项目', goal: '目标', agent: '角色', task: '任务' };
const fields = { name: '名称', title: '标题', description: '说明', acceptance: '验收标准', repoRoot: '项目目录', checks: '验收检查', autoMerge: '自动合并', priority: '优先级', agentId: '负责人', longLived: '保留人员', role: '角色权限', provider: '执行环境', model: '模型', reasoningEffort: '思考深度', temporary: '临时人员', mode: '副本方式' };
const display = value => typeof value === 'string' ? value || '（空）' : JSON.stringify(value);
export function ChangeHistory({ kind, id, data }) {
  const changes = (data.changes ?? []).filter(c => c.entityKind === kind && c.entityId === id).slice().reverse();
  return <section className="acms-change-history"><h3>变更与通知</h3><p className="acms-sectionnote">变更进入负责人的通知队列，在下一轮执行时随任务说明送达；“已送达”表示已交给执行器，不代表已完成处理。</p>{!changes.length && <p className="acms-muted">暂无编辑记录。</p>}{changes.map(c => <details key={c.id}><summary>{new Date(c.at).toLocaleString('zh-CN', { hour12: false })} · {c.changes.map(d => fields[d.field] ?? d.field).join('、')}</summary>{c.changes.map(d => <div className="acms-change-diff" key={d.field}><b>{fields[d.field] ?? d.field}</b><p>修改前：{display(d.before)}</p><p>修改后：{display(d.after)}</p></div>)}<ul>{(data.notifications ?? []).filter(n => n.changeId === c.id).map(n => <li key={n.id}>{data.agents.find(a => a.id === n.agentId)?.name ?? '历史角色'}：{n.status === 'delivered' ? '已随执行送达' : '等待下一轮执行送达'}</li>)}</ul></details>)}</section>;
}
export function EntityDrawer({ kind, entity, data, close, navigate, open, chat }) {
  const tasks = entityTasks(kind, entity, data); const goals = data.goals.filter(g => kind === 'project' && g.projectId === entity.id);
  const project = kind === 'goal' ? data.projects.find(p => p.id === entity.projectId) : null;
  return <div className="acms-drawer-shade" onClick={e => { if (e.target === e.currentTarget) close(); }}><aside className="acms-drawer" aria-label={`${entityLabels[kind]}详情`}><header><span>{entityLabels[kind]}详情</span><button aria-label="关闭详情" onClick={close}>×</button></header><h2>{entity.title ?? entity.name}</h2>{project && <button className="text" onClick={() => navigate('project', project.id)}>所属项目：{project.name}</button>}<p className="acms-preserve">{entity.description}</p>{entity.repoRoot && <p><code>{entity.repoRoot}</code></p>}{entity.acceptance && <section><h3>验收标准</h3><p className="acms-preserve">{entity.acceptance}</p></section>}<div className="acms-actions wrap"><button onClick={() => open(kind === 'goal' ? 'goalEdit' : kind, entity)}>编辑{entityLabels[kind]}</button><ActionButton className="danger" reason={entityDeletionReason(kind, entity, data)} onClick={() => open('deleteEntity', { ...entity, entityKind: kind })}>删除{entityLabels[kind]}</ActionButton></div>
    {kind === 'agent' && chat && <button className="primary" onClick={() => chat(entity.id)}>与智能体对话</button>}
    {goals.length > 0 && <section><h3>所属目标</h3>{goals.map(g => <button className="acms-entity-link" key={g.id} onClick={() => navigate('goal', g.id)}>{g.title} →</button>)}</section>}
    <section><h3>关联任务（{tasks.length}）</h3>{tasks.map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}{!tasks.length && <p>暂无关联任务。</p>}</section><ChangeHistory kind={kind} id={entity.id} data={data} /></aside></div>;
}
export function EntityTrash({ data, act, busy }) {
  return <section className="acms-panel"><h2>项目、目标与角色回收站</h2><p>恢复项目或目标时，关联的未完成任务保持暂停。删除记录不影响源文件。</p>{!(data.entityTrash ?? []).length && <p>回收站为空。</p>}{(data.entityTrash ?? []).map(e => <div className="acms-trash-row" key={e.id}><div><b>{entityLabels[e.entityKind]} · {e.title ?? e.name}</b><p>{e.entityKind !== 'agent' ? '含本次删除的下级记录' : '历史执行记录保留'}</p></div><ActionButton reason={busy ? '正在保存，请稍候' : ''} onClick={() => act(`${e.entityKind}.restore`, { id: e.id, expectedRevision: e.revision }, '已恢复；未完成任务保持暂停')}>恢复{entityLabels[e.entityKind]}</ActionButton></div>)}</section>;
}
