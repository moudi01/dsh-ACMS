import React from 'react';
import { ActionButton, CollapsibleText } from './components.jsx';
import { entityDeletionReason, entityTasks } from '../core/entity-actions.js';

export const entityLabels = { project: '项目', goal: '目标', agent: '角色', task: '任务' };
const fields = { name: '名称', title: '标题', description: '说明', acceptance: '验收标准', repoRoot: '项目目录', checks: '验收检查', autoMerge: '自动合并', priority: '优先级', agentId: '负责人', longLived: '保留人员', role: '角色权限', provider: '执行环境', model: '模型', reasoningEffort: '思考深度', temporary: '临时人员', mode: '副本方式' };
const display = value => typeof value === 'string' ? value || '（空）' : JSON.stringify(value);
export function ChangeHistory({ kind, id, data }) {
  const changes = (data.changes ?? []).filter(c => c.entityKind === kind && c.entityId === id).slice().reverse();
  return <section className="acms-change-history"><h3>变更与通知</h3><p className="acms-sectionnote">变更进入负责人的通知队列，在下一轮执行时随任务说明送达；“已送达”表示已交给执行器，不代表已完成处理。</p>{!changes.length && <p className="acms-muted">暂无编辑记录。</p>}{changes.map(c => <details key={c.id}><summary>{new Date(c.at).toLocaleString('zh-CN', { hour12: false })} · {c.changes.map(d => fields[d.field] ?? d.field).join('、')}</summary>{c.changes.map(d => <div className="acms-change-diff" key={d.field}><b>{fields[d.field] ?? d.field}</b><p>修改前：{display(d.before)}</p><p>修改后：{display(d.after)}</p></div>)}<ul>{(data.notifications ?? []).filter(n => n.changeId === c.id).map(n => <li key={n.id}>{data.agents.find(a => a.id === n.agentId)?.name ?? '历史角色'}：{n.status === 'delivered' ? '已随执行送达' : '等待下一轮执行送达'}</li>)}</ul></details>)}</section>;
}
const reviewLabels = { ready: '待执行', running: '进行中', preparing: '准备中', blocked: '已阻塞', paused: '已暂停', succeeded: '已结束', failed: '失败', cancelled: '已取消', integrating: '集成中', reconciling: '待核对', stopping: '停止中' };
function GoalReviewState({ goal, act, busy }) {
  const review = goal.reviewSummary;
  const pending = goal.contractChange?.status === 'pending';
  const active = review && ['ready', 'running', 'preparing', 'blocked', 'paused', 'integrating', 'reconciling', 'stopping'].includes(review.status);
  const reason = busy ? '正在保存，请稍候' : pending ? '请先确认当前目标合同。' : active ? '已有进行中的最终审查，请等待结论。' : !(goal.taskSummary?.done > 0) ? '目标还没有已交付成果，不能发起最终审查。' : '';
  return <section className="acms-review-state" aria-label="最终审查状态"><h3>最终审查</h3>
    <p>当前合同 v{goal.contractVersion ?? 1}{goal.completedContractVersion && <> · 最近完成 v{goal.completedContractVersion}</>}</p>
    {pending && <p className="acms-sectionnote">{goal.contractChange.coordinationTaskId ? '等待负责人确认新合同。' : '等待目标任务名额以安排合同确认。'}历史结论适用于当时的合同版本。</p>}
    {!review ? <p className="acms-sectionnote">当前交付还没有最终审查任务{goal.reviewHistory?.length ? '（历史审查见下方）' : ''}。{!pending && (goal.status === 'succeeded' && goal.templateSnapshot?.finalReview === false ? '按模板配置未审查。' : '可以基于当前交付发起一次。')}</p> : <><p><span className="acms-tag">{reviewLabels[review.status] ?? review.status}</span>{review.status === 'succeeded' ? (review.passed ? ' 已通过' : ' 未通过（失败证据已保留）') : ''}</p>
      {review.status === 'cancelled' && <><p className="acms-sectionnote">审查已取消：{review.cancelReason || '未填写原因'}（{review.cancelledBy === 'owner' ? '所有者' : review.cancelledBy ?? '未知'}，{review.cancelledAt ? new Date(review.cancelledAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}）。取消不会重开已交付任务，也不会自动重建审查。</p><p className="acms-sectionnote">可以基于当前交付重新发起一次最终审查；交付物变化时会重新核对，不会复用旧结论。</p></>}
      {review.status === 'failed' && <p className="acms-sectionnote">审查执行失败，失败证据已保留；可重新发起。</p>}</>}
    <ActionButton reason={reason} onClick={() => act('review.request', { goalId: goal.id }, '已发起目标最终审查')}>{review?.status === 'cancelled' || review?.status === 'failed' ? '重新发起最终审查' : '发起最终审查'}</ActionButton>
    {goal.reviewHistory?.length > 0 && <details className="acms-review-history"><summary>历史审查（{goal.reviewHistory.length}）</summary>{goal.reviewHistory.map(item => <div className="acms-review-history-row" key={item.id}><span className="acms-tag">{reviewLabels[item.status] ?? item.status}</span>{item.status === 'succeeded' ? (item.passed ? ' 通过' : ' 未通过') : ''}{item.status === 'cancelled' ? ` 取消：${item.cancelReason || '未填写原因'}` : ''}<small>合同 v{item.goalContractVersion ?? 1} · {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}</small></div>)}</details>}
  </section>;
}
export function EntityDrawer({ kind, entity, data, close, navigate, open, chat, act, busy }) {
  const tasks = entityTasks(kind, entity, data); const goals = data.goals.filter(g => kind === 'project' && g.projectId === entity.id);
  const project = kind === 'goal' ? data.projects.find(p => p.id === entity.projectId) : null;
  return <div className="acms-drawer-shade" onClick={e => { if (e.target === e.currentTarget) close(); }}><aside className="acms-drawer" aria-label={`${entityLabels[kind]}详情`}><header><span>{entityLabels[kind]}详情</span><button aria-label="关闭详情" onClick={close}>×</button></header><h2>{entity.title ?? entity.name}</h2>{project && <button className="text" onClick={() => navigate('project', project.id)}>所属项目：{project.name}</button>}<CollapsibleText text={entity.description} lines={3} label="说明" />{entity.repoRoot && <p><code>{entity.repoRoot}</code></p>}{entity.acceptance && <section><h3>验收标准</h3><CollapsibleText text={entity.acceptance} lines={3} label="验收标准" /></section>}<div className="acms-actions wrap"><button onClick={() => open(kind === 'goal' ? 'goalEdit' : kind, entity)}>编辑{entityLabels[kind]}</button><ActionButton className="danger" reason={entityDeletionReason(kind, entity, data)} onClick={() => open('deleteEntity', { ...entity, entityKind: kind })}>删除{entityLabels[kind]}</ActionButton></div>
    {kind === 'agent' && chat && <button className="primary" onClick={() => chat(entity.id)}>与智能体对话</button>}
    {kind === 'goal' && act && <GoalReviewState goal={entity} act={act} busy={busy} />}
    {goals.length > 0 && <section><h3>所属目标</h3>{goals.map(g => <button className="acms-entity-link" key={g.id} onClick={() => navigate('goal', g.id)}>{g.title} →</button>)}</section>}
    <section><h3>关联任务（{tasks.length}）</h3>{tasks.slice(0, 8).map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}{tasks.length > 8 && <details><summary>显示其余 {tasks.length - 8} 项</summary>{tasks.slice(8).map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}</details>}{!tasks.length && <p>暂无关联任务。</p>}</section><ChangeHistory kind={kind} id={entity.id} data={data} /></aside></div>;
}
export function EntityTrash({ data, act, busy }) {
  return <section className="acms-panel"><h2>项目、目标与角色回收站</h2><p>恢复项目或目标时，关联的未完成任务保持暂停。删除记录不影响源文件。</p>{!(data.entityTrash ?? []).length && <p>回收站为空。</p>}{(data.entityTrash ?? []).map(e => <div className="acms-trash-row" key={e.id}><div><b>{entityLabels[e.entityKind]} · {e.title ?? e.name}</b><p>{e.entityKind !== 'agent' ? '含本次删除的下级记录' : '历史执行记录保留'}</p></div><ActionButton reason={busy ? '正在保存，请稍候' : ''} onClick={() => act(`${e.entityKind}.restore`, { id: e.id, expectedRevision: e.revision }, '已恢复；未完成任务保持暂停')}>恢复{entityLabels[e.entityKind]}</ActionButton></div>)}</section>;
}
