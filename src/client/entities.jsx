import React, { useState } from 'react';
import { api } from './api.js';
import { ActionButton, CollapsibleText, Field } from './components.jsx';
import { entityDeletionReason, entityTasks } from '../core/entity-actions.js';
import { goalContractCapacityMessage } from '../core/task-actions.js';
import { canExtendGoalRuntime, goalRuntimeLimit, goalRuntimeSpent } from '../core/runtime-budget.js';

export const entityLabels = { project: '项目', goal: '目标', agent: '角色', task: '任务' };
const fields = { name: '名称', title: '标题', description: '说明', acceptance: '验收标准', repoRoot: '项目目录', checks: '验收检查', autoMerge: '自动合并', priority: '优先级', agentId: '负责人', longLived: '保留人员', role: '角色权限', provider: '执行环境', model: '模型', reasoningEffort: '思考深度', temporary: '临时人员', mode: '副本方式' };
const display = value => typeof value === 'string' ? value || '（空）' : JSON.stringify(value);
export function ChangeHistory({ kind, id, data }) {
  const changes = (data.changes ?? []).filter(c => c.entityKind === kind && c.entityId === id).slice().reverse();
  return <section className="acms-change-history"><h3>变更与通知</h3><p className="acms-sectionnote">变更进入负责人的通知队列，在下一轮执行时随任务说明送达；“已送达”表示已交给执行器，不代表已完成处理。</p>{!changes.length && <p className="acms-muted">暂无编辑记录。</p>}{changes.map(c => <details key={c.id}><summary>{new Date(c.at).toLocaleString('zh-CN', { hour12: false })} · {c.changes.map(d => fields[d.field] ?? d.field).join('、')}</summary>{c.changes.map(d => <div className="acms-change-diff" key={d.field}><b>{fields[d.field] ?? d.field}</b><p>修改前：{display(d.before)}</p><p>修改后：{display(d.after)}</p></div>)}<ul>{(data.notifications ?? []).filter(n => n.changeId === c.id).map(n => <li key={n.id}>{data.agents.find(a => a.id === n.agentId)?.name ?? '历史角色'}：{n.status === 'delivered' ? '已随执行送达' : '等待下一轮执行送达'}</li>)}</ul></details>)}</section>;
}
const reviewLabels = { ready: '待执行', running: '进行中', preparing: '准备中', blocked: '已阻塞', paused: '已暂停', succeeded: '已结束', failed: '失败', cancelled: '已取消', integrating: '集成中', reconciling: '待核对', stopping: '停止中' };
function CandidateDownload({ goal }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const download = async () => {
    const selection = { goalId: goal.id, version: goal.finalComposition.version, deliveryHash: goal.finalComposition.deliveryHash };
    setLoading(true);
    setStatus(null);
    try {
      const archive = await api.candidateArchive(selection);
      const file = await api.downloadCandidateArchive(selection, archive);
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = archive.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus({ message: `已获取 ${archive.files} 个文件。解压 source/ 到空目录即可得到该版本。` });
    } catch (error) { setStatus({ error: error.message }); }
    finally { setLoading(false); }
  };
  return <div className="acms-actions">
    <ActionButton reason={loading ? '正在准备候选归档…' : ''} onClick={download}>{loading ? '正在准备 ZIP…' : '下载候选 ZIP'}</ActionButton>
    {status?.error && <p role="alert">{status.error}</p>}
    {status?.message && <p role="status">{status.message}</p>}
  </div>;
}

const mergeLabels = { previewed: '等待所有者确认', queued: '已确认，等待执行', preparing: '正在核对合入条件',
  applying: '正在更新目标分支', reconciling: '等待核对 Git 结果', applied: '已合入', rejected: '已拒绝', cancelled: '已撤回', failed: '合入失败' };
const mergeChanges = { A: '新增', M: '修改', D: '删除', T: '类型变更' };

function CandidateMerge({ goal, act, busy }) {
  const [branch, setBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = goal.candidateMerge;
  const selected = goal.finalComposition;
  const name = branch.trim();
  const targetRef = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  const active = ['queued', 'preparing', 'applying', 'reconciling'].includes(request?.status);
  const current = request && selected && ['version', 'deliveryHash', 'contractVersion', 'reviewId'].every(key => request.selection[key] === selected[key]);
  const decision = (action, args, notice) => act(`goal.candidate_merge.${action}`, { id: goal.id, previewId: request.id, ...args }, notice);
  const preview = async () => {
    setLoading(true);
    setError('');
    try {
      await api.candidateMergePreview({ goalId: goal.id, version: selected.version, deliveryHash: selected.deliveryHash, targetRef });
    } catch (error) { setError(error.message); }
    finally { setLoading(false); }
  };
  const busyReason = busy || loading ? '正在保存，请稍候。' : '';
  const confirmReason = !current ? '验收版本已变化，请重新预览。' : name && targetRef !== request.targetRef ? '所选分支已变化，请重新预览。' : '';
  return <section aria-label="确认合入 Git 候选" className="acms-review-state">
    <h4>合入 Git 候选</h4>
    {selected && !active && <>
      <Field label="目标 Git 分支" hint="输入源项目目录已检出的本地分支。预览与拒绝均保留源项目现状。"><input value={branch} onChange={event => setBranch(event.target.value)} placeholder="例如 refs/heads/main" /></Field>
      <ActionButton reason={busyReason || (!name ? '请填写目标分支。' : '')} onClick={preview}>预览合入</ActionButton>
    </>}
    {error && <p role="alert">{error}</p>}
    {request && <>
      <p role="status">{mergeLabels[request.status]}{active && request.stopRequested && ' · 已请求撤回'}</p>
      {request.reason && <p className="acms-sectionnote">{request.reason}</p>}
      <dl className="acms-definition">
        <dt>目标分支</dt><dd><code>{request.targetRef}</code></dd>
        <dt>预览 HEAD</dt><dd><code>{request.targetHead}</code></dd>
        <dt>候选版本</dt><dd><code>{request.selection.version}</code></dd>
        <dt>交付合同</dt><dd>v{request.selection.contractVersion}</dd>
        <dt>最终审查</dt><dd>{request.selection.reviewId ? <>已通过 · <code>{request.selection.reviewId}</code></> : '模板无需最终审查'}</dd>
        {request.result && <><dt>合入提交</dt><dd><code>{request.result.integratedCommit}</code></dd></>}
      </dl>
      <details><summary>提交变更（{request.summary.total} 项）</summary>
        {request.summary.items.length > 0 && <ul>{request.summary.items.map(item => <li key={`${item.change}/${item.path}`}>{mergeChanges[item.change] ?? item.change} <code>{item.path}</code></li>)}</ul>}
        {request.summary.total > request.summary.items.length && <p>预览显示前 {request.summary.items.length} 项。</p>}
      </details>
      <details><summary>联合检查证据（{request.checks.length} 项）</summary><dl className="acms-definition">
        {request.checks.map(check => <React.Fragment key={check.id}><dt>{check.id}</dt><dd>退出码 {check.code} · 证据 <code>{check.logHash || check.checkVersion}</code></dd></React.Fragment>)}
      </dl></details>
      <div className="acms-actions">
        {request.status === 'previewed' && <>
          <ActionButton reason={busyReason || confirmReason} onClick={() => decision('confirm', {
            targetRef: request.targetRef, targetHead: request.targetHead, version: request.selection.version, deliveryHash: request.selection.deliveryHash,
          }, '已确认合入，等待 Git 核对').catch(() => {})}>确认合入 {request.targetRef}</ActionButton>
          <ActionButton reason={busyReason} onClick={() => decision('reject', {}, '已拒绝该合入预览').catch(() => {})}>拒绝合入</ActionButton>
        </>}
        {active && <ActionButton reason={busyReason || (request.stopRequested ? '正在核对撤回结果。' : '')}
          onClick={() => decision('withdraw', {}, '已请求撤回确认').catch(() => {})}>撤回确认</ActionButton>}
        {request.status === 'reconciling' && <ActionButton reason={busyReason}
          onClick={() => decision('reconcile', {}, '已请求重新核对 Git 结果').catch(() => {})}>重新核对合入结果</ActionButton>}
      </div>
    </>}
  </section>;
}

function GoalReviewState({ goal, taskCount, taskLimit, act, busy }) {
  const review = goal.reviewSummary;
  const pending = goal.contractChange?.status === 'pending';
  const copyCandidate = goal.deliveryMode === 'copy-composite';
  const composite = copyCandidate || goal.deliveryMode === 'git-composite';
  const candidateLabel = copyCandidate ? '完整目录候选' : '完整 Git 候选';
  const waitingForComposition = composite && !goal.compositionVerified;
  const recheck = goal.compositionRecheck;
  const active = review && ['ready', 'running', 'preparing', 'blocked', 'paused', 'integrating', 'reconciling', 'stopping'].includes(review.status);
  let capacity = '';
  if (!pending && !active && goal.status === 'active') {
    if (goal.completionPending === 'TASK_LIMIT' && taskCount >= taskLimit) {
      capacity = `最终审查等待任务名额（已用 ${taskCount} 项，上限 ${taskLimit} 项）。请在「公司设置 → 编辑边界」调高「每个目标任务上限」。`;
    } else if (goal.completionPending === 'AGENT_LIMIT') {
      capacity = '最终审查等待独立审查员。请在「组织管理」分配可用审查员，或在「公司设置 → 编辑边界」调高「临时人员上限」。';
    }
  }
  const reason = busy ? '正在保存，请稍候' : goal.status === 'cancelled' ? '目标已取消。' : goal.executionControl ? '请先恢复目标。' : pending ? '请先确认当前目标合同。' : waitingForComposition ? candidateLabel + '尚未通过联合检查。' : active ? '已有进行中的最终审查，请等待结论。' : capacity || (!(goal.taskSummary?.done > 0) ? '目标还没有已交付成果，不能发起最终审查。' : '');
  return <section className="acms-review-state" aria-label="最终审查状态"><h3>最终审查</h3>
    <p>当前合同 v{goal.contractVersion ?? 1}{goal.completedContractVersion && <> · 最近完成 v{goal.completedContractVersion}</>}</p>
    {goal.compositionVerified && <details><summary>{candidateLabel}已通过联合检查</summary><dl className="acms-definition">
      <dt>{copyCandidate ? '候选内容指纹' : '候选提交'}</dt><dd><code>{copyCandidate ? goal.composition.contentHash : goal.composition.bundle.commit}</code></dd>
      <dt>固定基线</dt><dd><code>{copyCandidate ? goal.composition.baseHash : goal.composition.baseCommit}</code></dd>
      {!copyCandidate && <><dt>本机交付包</dt><dd><code>{goal.composition.bundle.path}</code></dd></>}</dl></details>}
    {goal.finalComposition && <CandidateDownload key={`${goal.id}/${goal.finalComposition.deliveryHash}/${goal.finalComposition.reviewId}`} goal={goal} />}
    {goal.deliveryMode === 'git-composite' && (goal.finalComposition || goal.candidateMerge) && <CandidateMerge goal={goal} act={act} busy={busy} />}
    {waitingForComposition && <p className="acms-sectionnote">{recheck?.reason || candidateLabel + (recheck ? '正在等待重新核验。' : '尚未通过联合检查。请查看任务的集成状态。')}</p>}
    {composite && !pending && !goal.executionControl && goal.status !== 'cancelled' &&
      goal.taskSummary?.done > 0 && goal.taskSummary.done === goal.taskSummary.total && (!recheck || recheck.status === 'failed') &&
      <ActionButton reason={busy ? '正在保存，请稍候' : ''} onClick={() => act('goal.composition.recheck', { id: goal.id }, '已排队重新联合检查')}>重新联合检查</ActionButton>}
    {pending && <p className="acms-sectionnote">新要求待确认，普通任务暂不派发。{goal.contractChange.coordinationTaskId ? '等待负责人确认新合同。' : taskCount >= taskLimit ? goalContractCapacityMessage(taskCount, taskLimit) : '等待调度器安排合同确认。'}历史结论适用于当时的合同版本。</p>}
    {capacity && <p role="status" className="acms-sectionnote">{capacity}交付成果已保留，名额恢复后将自动排队。</p>}
    {!review ? !capacity && !waitingForComposition && <p className="acms-sectionnote">当前交付还没有最终审查任务{goal.reviewHistory?.length ? '（历史审查见下方）' : ''}。{!pending && (goal.status === 'succeeded' && goal.templateSnapshot?.finalReview === false ? '按模板配置未审查。' : '可以基于当前交付发起一次。')}</p> : <><p><span className="acms-tag">{reviewLabels[review.status] ?? review.status}</span>{review.status === 'succeeded' ? (review.passed ? ' 已通过' : ' 未通过（失败证据已保留）') : ''}</p>
      {review.status === 'cancelled' && <><p className="acms-sectionnote">审查已取消：{review.cancelReason || '未填写原因'}（{review.cancelledBy === 'owner' ? '所有者' : review.cancelledBy ?? '未知'}，{review.cancelledAt ? new Date(review.cancelledAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}）。取消不会重开已交付任务，也不会自动重建审查。</p><p className="acms-sectionnote">可以基于当前交付重新发起一次最终审查；交付物变化时会重新核对，不会复用旧结论。</p></>}
      {review.status === 'failed' && <p className="acms-sectionnote">审查执行失败，失败证据已保留；可重新发起。</p>}</>}
    <ActionButton reason={reason} onClick={() => act('review.request', { goalId: goal.id }, '已发起目标最终审查')}>{review?.status === 'cancelled' || review?.status === 'failed' ? '重新发起最终审查' : '发起最终审查'}</ActionButton>
    {goal.reviewHistory?.length > 0 && <details className="acms-review-history"><summary>历史审查（{goal.reviewHistory.length}）</summary>{goal.reviewHistory.map(item => <div className="acms-review-history-row" key={item.id}><span className="acms-tag">{reviewLabels[item.status] ?? item.status}</span>{item.status === 'succeeded' ? (item.passed ? ' 通过' : ' 未通过') : ''}{item.status === 'cancelled' ? ` 取消：${item.cancelReason || '未填写原因'}` : ''}<small>合同 v{item.goalContractVersion ?? 1} · {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}</small></div>)}</details>}
  </section>;
}
function GoalRuntimeBudget({ goal, data, open, busy, runtimeNow }) {
  return <section className="acms-review-state" aria-label="目标执行额度">
    <h3>目标执行额度</h3>
    <dl className="acms-definition">
      <dt>累计已用</dt><dd>{(goalRuntimeSpent(goal, data.attempts, runtimeNow) / 60000).toFixed(2)} 分钟</dd>
      <dt>当前累计额度</dt><dd>{(goalRuntimeLimit(goal, data.policy) / 60000).toFixed(2)} 分钟</dd>
    </dl>
    {canExtendGoalRuntime(goal) && <ActionButton reason={busy ? '正在保存，请稍候' : ''} onClick={() => open('goalRuntime', goal)}>追加目标执行额度</ActionButton>}
  </section>;
}
function GoalControls({ goal, companyPaused, act, open, busy }) {
  const control = goal.controlSummary ?? goal.executionControl;
  const phase = control?.phase ?? control?.state ?? (goal.status === 'cancelled' ? 'cancelled' : 'open');
  const labels = { open: '可调度', paused: '已暂停', draining: '等待当前执行结束', stopping: '正在停止', reconciling: '等待清理核对', cancelled: '已取消' };
  const closed = goal.status === 'cancelled' || goal.status === 'archived' || goal.legacyBatch;
  const args = { id: goal.id, expectedRevision: goal.revision };
  const busyReason = busy ? '正在保存，请稍候' : '';
  return <section className="acms-review-state" aria-label="目标执行控制">
    <h3>目标执行控制</h3>
    <p role="status"><span className="acms-tag">{labels[phase]}</span>{control?.active > 0 && <> · {control.active} 项执行尚未结束</>}</p>
    <p className="acms-sectionnote">仅影响此目标的规划、执行、协调、审查与集成。{companyPaused && '公司当前暂停，恢复此目标后仍等待公司调度恢复。'}</p>
    {control?.state === 'cancelled' && <p>历史交付和审查记录已保留。后续工作可创建新目标。</p>}
    {control?.state === 'paused' && <p>{control.mode === 'after-current' ? '已获准的执行可以结束，模型结果会在恢复后入库。' : '已请求停止在途执行，等待进程清理后保留任务检查点。'}</p>}
    {!closed && <div className="acms-actions wrap">
      {(!control || control.mode === 'after-current') && <ActionButton reason={busyReason} onClick={() => act('goal.pause', args, '已请求立即暂停此目标')}>立即暂停目标</ActionButton>}
      {!control && <ActionButton reason={busyReason} onClick={() => act('goal.pause', { ...args, afterCurrent: true }, '已暂停此目标的新增派发')}>当前执行结束后暂停</ActionButton>}
      {control?.state === 'paused' && <ActionButton reason={busyReason} onClick={() => act('goal.resume', args, '已解除此目标的暂停')}>恢复目标</ActionButton>}
      <ActionButton className="danger" reason={busyReason} onClick={() => open('goalCancel', goal)}>取消目标</ActionButton>
    </div>}
  </section>;
}
export function EntityDrawer({ kind, entity, data, close, navigate, open, chat, act, busy, runtimeNow }) {
  const tasks = entityTasks(kind, entity, data); const goals = data.goals.filter(g => kind === 'project' && g.projectId === entity.id);
  const project = kind === 'goal' ? data.projects.find(p => p.id === entity.projectId) : null;
  return <div className="acms-drawer-shade" onClick={e => { if (e.target === e.currentTarget) close(); }}><aside className="acms-drawer" aria-label={`${entityLabels[kind]}详情`}><header><span>{entityLabels[kind]}详情</span><button aria-label="关闭详情" onClick={close}>×</button></header><h2>{entity.title ?? entity.name}</h2>{kind === 'goal' && <p className="acms-sectionnote">优先级：{Number.isInteger(entity.priority) ? entity.priority : 50}（0–100；只影响后续跨目标派发顺序）</p>}{project && <button className="text" onClick={() => navigate('project', project.id)}>所属项目：{project.name}</button>}<CollapsibleText text={entity.description} lines={3} label="说明" />{entity.repoRoot && <p><code>{entity.repoRoot}</code></p>}{entity.acceptance && <section><h3>验收标准</h3><CollapsibleText text={entity.acceptance} lines={3} label="验收标准" /></section>}<div className="acms-actions wrap"><button onClick={() => open(kind === 'goal' ? 'goalEdit' : kind, entity)}>编辑{entityLabels[kind]}</button><ActionButton className="danger" reason={entityDeletionReason(kind, entity, data)} onClick={() => open('deleteEntity', { ...entity, entityKind: kind })}>删除{entityLabels[kind]}</ActionButton></div>
    {kind === 'agent' && chat && <button className="primary" onClick={() => chat(entity.id)}>与智能体对话</button>}
    {kind === 'goal' && act && <><GoalControls goal={entity} companyPaused={data.policy.paused} act={act} open={open} busy={busy} /><GoalRuntimeBudget goal={entity} data={data} open={open} busy={busy} runtimeNow={runtimeNow} /><GoalReviewState goal={entity} taskCount={tasks.length} taskLimit={data.policy.maxTasksPerGoal} act={act} busy={busy} /></>}
    {goals.length > 0 && <section><h3>所属目标</h3>{goals.map(g => <button className="acms-entity-link" key={g.id} onClick={() => navigate('goal', g.id)}>{g.title} →</button>)}</section>}
    <section><h3>关联任务（{tasks.length}）</h3>{tasks.slice(0, 8).map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}{tasks.length > 8 && <details><summary>显示其余 {tasks.length - 8} 项</summary>{tasks.slice(8).map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}</details>}{!tasks.length && <p>暂无关联任务。</p>}</section><ChangeHistory kind={kind} id={entity.id} data={data} /></aside></div>;
}
export function EntityTrash({ data, act, busy }) {
  return <section className="acms-panel"><h2>项目、目标与角色回收站</h2><p>恢复项目或目标时，关联的未完成任务保持暂停。删除记录不影响源文件。</p>{!(data.entityTrash ?? []).length && <p>回收站为空。</p>}{(data.entityTrash ?? []).map(e => <div className="acms-trash-row" key={e.id}><div><b>{entityLabels[e.entityKind]} · {e.title ?? e.name}</b><p>{e.entityKind !== 'agent' ? '含本次删除的下级记录' : '历史执行记录保留'}</p></div><ActionButton reason={busy ? '正在保存，请稍候' : ''} onClick={() => act(`${e.entityKind}.restore`, { id: e.id, expectedRevision: e.revision }, '已恢复；未完成任务保持暂停')}>恢复{entityLabels[e.entityKind]}</ActionButton></div>)}</section>;
}
