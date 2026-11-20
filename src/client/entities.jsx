import React, { useState } from 'react';
import { api } from './api.js';
import { ActionButton, CollapsibleText, Field } from './components.jsx';
import { entityDeletionReason, entityTasks } from '../core/entity-actions.js';
import { goalContractCapacityMessage, OPTIONAL_COST_WAIT } from '../core/task-actions.js';
import { optionalDependentScope } from '../core/hierarchy.js';
import { canExtendGoalRuntime, goalRuntimeLimit, goalRuntimeSpent } from '../core/runtime-budget.js';

export const entityLabels = { project: '项目', goal: '目标', agent: '角色', task: '任务' };
const fields = { name: '名称', title: '标题', description: '说明', acceptance: '验收标准', repoRoot: '项目目录', deliveryRepository: '裸交付仓库', checks: '验收检查', autoMerge: '自动合并', priority: '优先级', agentId: '负责人', longLived: '保留人员', role: '角色权限', provider: '执行环境', model: '模型', reasoningEffort: '思考深度', temporary: '临时人员', mode: '副本方式' };
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

const mergeLabels = { previewed: '等待所有者确认', queued: '已确认，等待执行', preparing: '正在核对分支创建条件',
  applying: '正在创建交付分支', reconciling: '等待核对 Git 结果', applied: '已创建交付分支', rejected: '已拒绝', cancelled: '已撤回', failed: '创建交付分支失败' };
const bareMergeLabels = { preparing: '正在核对裸仓库和目标分支', applying: '正在更新目标分支', applied: '已更新目标分支', failed: '目标分支更新失败' };
const mergeChanges = { A: '新增', M: '修改', D: '删除', T: '类型变更' };

const ownerDeliveryDecision = { approve: '批准交付', reject: '拒绝交付', revise: '退回修改' };

function CandidateMerge({ goal, approvals, deliveryRepository, act, busy }) {
  const [branch, setBranch] = useState('');
  const [mode, setMode] = useState(goal.candidateMerge?.targetMode ?? 'new');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const request = goal.candidateMerge;
  const gated = !!goal.deliveryApproval;
  const selectedMode = deliveryRepository ? mode : 'new';
  const bare = selectedMode === 'bare';
  const bareRequest = request?.targetMode === 'bare';
  const heading = gated ? '人工交付审批' : deliveryRepository || bareRequest ? '交付 Git 候选' : '创建 Git 交付分支';
  const selected = goal.finalComposition;
  const returned = !!selected && goal.deliveryApproval?.returnedVersions?.includes(selected.version);
  const name = branch.trim();
  const basisRef = name.startsWith('refs/') ? name : `refs/heads/${name}`;
  const active = ['queued', 'preparing', 'applying', 'reconciling'].includes(request?.status);
  const current = request && selected && ['version', 'deliveryHash', 'contractVersion', 'reviewId'].every(key => request.selection[key] === selected[key]);
  const decision = (action, args, notice) => act(`goal.candidate_merge.${action}`, { id: goal.id, previewId: request.id, ...args }, notice);
  const approvalArgs = () => ({ targetRef: request.targetRef, basisRef: request.basisRef, basisHead: request.basisHead,
    version: request.selection.version, deliveryHash: request.selection.deliveryHash,
    ...(bareRequest ? { targetMode: 'bare', targetRoot: request.targetRoot } : {}),
    ...(gated ? { approvalFingerprint: request.approvalFingerprint, reason: reason.trim() } : {}) });
  const decideApproval = async (action, notice) => {
    try { if (await decision(action, approvalArgs(), notice)) setReason(''); } catch {}
  };
  const preview = async () => {
    setLoading(true);
    setError('');
    setReason('');
    try {
      await api.candidateMergePreview({ goalId: goal.id, version: selected.version, deliveryHash: selected.deliveryHash, basisRef, targetMode: selectedMode });
    } catch (error) { setError(error.message); }
    finally { setLoading(false); }
  };
  const busyReason = busy || loading ? '正在保存，请稍候。' : '';
  const confirmReason = !current ? '验收版本已变化，请重新预览。' :
    (bareRequest !== bare || (name && basisRef !== request.basisRef)) ? '交付方式或分支已变化，请重新预览。' : '';
  const approvalReason = busyReason || confirmReason || (!reason.trim() ? '请填写交付审批理由。' : '');
  return <section aria-label={heading} className="acms-review-state">
    <h4>{heading}</h4>
    {returned && <p role="status">此版本已退回。请编辑需修改的交付任务并重新执行，完成新版本的联合检查和模板要求的审查后再审批。</p>}
    {gated && !selected && !request && <p>等待完整候选通过联合检查和模板要求的审查。</p>}
    {selected && !active && !returned && <>
      {deliveryRepository && <Field label="候选交付方式"><select value={mode} onChange={event => setMode(event.target.value)}>
        <option value="new">在源仓库创建新交付分支</option><option value="bare">更新裸交付仓库中的现有分支</option>
      </select></Field>}
      {bare && <p>裸交付仓库 <code>{deliveryRepository.targetRoot}</code></p>}
      <Field label={bare ? '目标 Git 分支' : '基准 Git 分支'} hint={bare ? '输入裸交付仓库中已有的本地分支。' : '输入现有的本地分支。确认后，ACMS 会基于它当前的 HEAD 创建新的交付分支。'}><input value={branch} onChange={event => setBranch(event.target.value)} placeholder="例如 refs/heads/main" /></Field>
      <ActionButton reason={busyReason || (!name ? '请填写分支。' : '')} onClick={preview}>{bare ? '预览目标分支更新' : '预览交付分支'}</ActionButton>
    </>}
    {error && <p role="alert">{error}</p>}
    {request && <>
      <p role="status">{request.status === 'returned' ? '已退回修改' : gated && request.status === 'previewed' ? '等待所有者批准交付' :
        request.result?.proof === 'target-tree' ? '目标分支已包含此候选' : (bareRequest && bareMergeLabels[request.status]) || mergeLabels[request.status]}{active && request.stopRequested && ' · 已请求撤回'}</p>
      {request.reason && <p className="acms-sectionnote">{request.reason}</p>}
      <dl className="acms-definition">
        {bareRequest ? <><dt>裸交付仓库</dt><dd><code>{request.targetRoot}</code></dd></> : <><dt>基准分支</dt><dd><code>{request.basisRef}</code></dd></>}
        <dt>{bareRequest ? '目标 HEAD' : '基准 HEAD'}</dt><dd><code>{request.basisHead}</code></dd>
        <dt>{bareRequest ? '目标分支' : '新交付分支'}</dt><dd><code>{request.targetRef}</code></dd>
        <dt>候选版本</dt><dd><code>{request.selection.version}</code></dd>
        <dt>交付合同</dt><dd>v{request.selection.contractVersion}</dd>
        <dt>最终审查</dt><dd>{request.selection.reviewId ? <>已通过 · <code>{request.selection.reviewId}</code></> : '模板无需最终审查'}</dd>
        {request.result && <><dt>交付提交</dt><dd><code>{request.result.integratedCommit}</code></dd></>}
      </dl>
      <details><summary>提交变更（{request.summary.total} 项）</summary>
        {request.summary.items.length > 0 && <ul>{request.summary.items.map(item => <li key={`${item.change}/${item.path}`}>{mergeChanges[item.change] ?? item.change} <code>{item.path}</code></li>)}</ul>}
        {request.summary.total > request.summary.items.length && <p>预览显示前 {request.summary.items.length} 项。</p>}
      </details>
      <details><summary>联合检查证据（{request.checks.length} 项）</summary><dl className="acms-definition">
        {request.checks.map(check => <React.Fragment key={check.id}><dt>{check.id}</dt><dd>退出码 {check.code} · 证据 <code>{check.logHash || check.checkVersion}</code></dd></React.Fragment>)}
      </dl></details>
      {gated && request.status === 'previewed' && <Field label="交付审批理由"><textarea value={reason} maxLength={1000} rows={3}
        onChange={event => setReason(event.target.value)} /></Field>}
      <div className="acms-actions">
        {gated && request.status === 'previewed' && <>
          <ActionButton className="primary" reason={approvalReason} onClick={() => decideApproval('approve', '已批准交付，等待 Git 核对')}>批准交付</ActionButton>
          <ActionButton className="danger" reason={approvalReason} onClick={() => decideApproval('reject', '已拒绝此交付预览')}>拒绝交付</ActionButton>
          <ActionButton reason={approvalReason} onClick={() => decideApproval('revise', '已退回该候选，等待交付任务修订')}>退回修改</ActionButton>
        </>}
        {!gated && request.status === 'previewed' && <>
          <ActionButton reason={busyReason || confirmReason} onClick={() => decision('confirm', approvalArgs(),
            bareRequest ? '已确认更新目标分支，等待 Git 核对' : '已确认创建交付分支，等待 Git 核对').catch(() => {})}>{bareRequest ? '确认更新目标分支' : '确认创建交付分支'}</ActionButton>
          <ActionButton reason={busyReason} onClick={() => decision('reject', {}, '已拒绝该交付分支预览').catch(() => {})}>拒绝预览</ActionButton>
        </>}
        {active && <ActionButton reason={busyReason || (request.stopRequested ? '正在核对撤回结果。' : '')}
          onClick={() => decision('withdraw', {}, '已请求撤回确认').catch(() => {})}>撤回确认</ActionButton>}
        {request.status === 'reconciling' && <ActionButton reason={busyReason}
          onClick={() => decision('reconcile', {}, '已请求重新核对 Git 结果').catch(() => {})}>重新核对交付结果</ActionButton>}
      </div>
    </>}
    {gated && approvals.length > 0 && <details open><summary>所有者交付决定（{approvals.length}）</summary>{approvals.map(record => <div key={record.id} className="acms-change-diff">
      <p><b>{ownerDeliveryDecision[record.action]}</b> · 所有者 · {new Date(record.at).toLocaleString('zh-CN')}</p>
      <p className="acms-preserve">{record.reason}</p>
      <p><code>{record.subject.targetRef}</code> · HEAD <code>{record.subject.basisHead}</code></p>
      <p>候选 <code>{record.subject.selection.version}</code> · 合同 v{record.subject.selection.contractVersion}</p>
    </div>)}</details>}
  </section>;
}

function GoalReviewState({ goal, approvals, deliveryRepository, taskCount, taskLimit, act, busy }) {
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
    {goal.deliveryMode === 'git-composite' && (goal.finalComposition || goal.candidateMerge || goal.deliveryApproval) &&
      <CandidateMerge goal={goal} approvals={approvals} deliveryRepository={deliveryRepository} act={act} busy={busy} />}
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
const usageLabels = { inputTokens: '输入', cachedInputTokens: '缓存命中输入', cacheWriteInputTokens: '写入缓存的输入',
  outputTokens: '输出', reasoningOutputTokens: '推理输出', totalTokens: '供应商报告合计' };
const usageState = { reported: '已报告', pending: '等待终态或核对', unknown: '未知', 'not-executed': '前置检查未通过' };

function UsageTotals({ report, coverageLabel, title }) {
  return <>
    <p>{coverageLabel} · {Object.entries(report.coverage).map(([state, count]) => `${usageState[state]} ${count}`).join(' · ')}</p>
    <h4>{title}</h4>
    <dl className="acms-definition">
      {Object.entries(report.summary).map(([field, row]) => <React.Fragment key={field}><dt>{usageLabels[field]}</dt>
        <dd>{row.subtotal ?? '未知'}{row.subtotal !== null && ` · ${row.reported} 次报告`}</dd></React.Fragment>)}
    </dl>
  </>;
}

function GoalAttemptUsage({ goalId, tasks }) {
  const [result, setResult] = useState(null);
  const [taskId, setTaskId] = useState('');
  const [groupBy, setGroupBy] = useState('route');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scope = taskId ? { taskId } : { goalId };
  const load = async (by = groupBy, cursors = {}) => {
    setLoading(true); setError('');
    try { setResult({ summary: await api.usageSummary(scope, by, cursors), cursors }); }
    catch (e) { setResult(null); setError(e.message); }
    finally { setLoading(false); }
  };
  const summary = result?.summary, report = summary?.attemptPage;
  const scopeLabel = taskId ? '任务' : '目标';
  return <section className="acms-review-state" aria-label="模型执行用量">
    <h3>模型执行用量</h3>
    <p className="acms-sectionnote">此处仅统计 ACMS 任务执行报告的 token。服务账单和订阅额度有独立口径。</p>
    <Field label="用量范围"><select value={taskId} disabled={loading} onChange={event => {
      setTaskId(event.target.value); setResult(null); setError('');
    }}><option value="">整个目标</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></Field>
    <div className="acms-actions wrap">
      <ActionButton reason={loading ? '正在读取…' : ''} onClick={() => load()}>{result ? '查看最新用量' : '查看执行用量'}</ActionButton>
    </div>
    {error && <p role="alert">{error}</p>}
    {result && <Field label="用量分组"><select value={groupBy} disabled={loading} onChange={event => {
      const by = event.target.value;
      setGroupBy(by); load(by, { attemptBefore: result.cursors.attemptBefore });
    }}><option value="route">路由与模型</option><option value="date">UTC 日期</option></select></Field>}
    {summary && <>
      <UsageTotals report={summary} coverageLabel={`${scopeLabel}全部保留记录`} title={`完整${scopeLabel} token 小计`} />
      <h4>{summary.groupBy === 'date' ? '按 UTC 日期' : '按路由与模型'}</h4>
      {summary.groupBy === 'date' && <p className="acms-sectionnote">按每次执行开始的 UTC 日期归组。</p>}
      {summary.groups.map(group => <details key={group.key} className="acms-run"><summary>
        {summary.groupBy === 'date' ? group.dateUtc ?? '日期未知' :
          [group.provider ?? '路由未知', group.llmProvider, group.model ?? '模型未知', group.reasoningEffort].filter(Boolean).join(' · ')}
      </summary><UsageTotals report={group} coverageLabel="分组覆盖" title="分组 token 小计" /></details>)}
      {summary.nextAfter !== null && <ActionButton reason={loading ? '正在读取…' : ''} onClick={() => load(groupBy, { ...result.cursors, after: summary.nextAfter })}>查看下一组用量</ActionButton>}
    </>}
    {report && (report.attempts.length ? <>
      <UsageTotals report={report} coverageLabel="本页逐次记录" title="本页 token 小计" />
      {report.nextBefore && <ActionButton reason={loading ? '正在读取…' : ''} onClick={() =>
        load(groupBy, { ...result.cursors, attemptBefore: report.nextBefore })}>查看更早记录</ActionButton>}
      <p className="acms-sectionnote">缓存和推理按供应商字段单列，合计沿用供应商报告值。</p>
      {report.attempts.map(item => <details key={item.id} className="acms-run"><summary>
        {tasks.find(task => task.id === item.taskId)?.title ?? item.taskId} · {usageState[item.state]} · {item.model ?? '模型未知'}
      </summary>
        <p>{item.startedAt ? new Date(item.startedAt).toLocaleString('zh-CN') : '时间未知'} · {item.kind ?? '类型未知'} · <code>{item.id}</code></p>
        <p>{item.provider ?? '路由未知'}{item.llmProvider && ` / ${item.llmProvider}`} · 思考深度 {item.reasoningEffort ?? '未知'}</p>
        {item.usage && <><p>来源 {item.usage.source}</p><dl className="acms-definition">
          {Object.entries(item.usage.counts).map(([field, count]) => <React.Fragment key={field}><dt>{usageLabels[field]}</dt><dd>{count ?? '未知'}</dd></React.Fragment>)}
        </dl></>}
      </details>)}
    </> : <p>本页暂无执行记录。</p>)}
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
function usdFromMicros(value) {
  const digits = String(value).padStart(7, '0');
  const fraction = digits.slice(-6).replace(/0+$/, '').padEnd(2, '0');
  return `US$${digits.slice(0, -6)}.${fraction}`;
}

const forecastReasons = {
  'no-approved-estimate': '当前没有已通过预算核验的计划估算。',
  'contract-changed': '目标合同或规划版本已变化。',
  'quote-stale': '原估算来源已变化或当前无法核对。',
  'cost-contract-breach': '执行器的实际费用已超过承诺上界。',
  'awaiting-cost-receipt': '部分执行已清理，实际费用仍待回执。原预留计入已覆盖小计。',
  'execution-cleanup-pending': '部分执行的清理尚未核对，原预留计入已覆盖小计。',
  'work-changed': '部分已批准任务被移除或其版本、分派、依赖已变化。',
  'unpriced-work': '有待完成的任务未纳入这版计划估算。',
  'unverified-cost': '部分执行缺少可核对的归属和费用预留。',
  'retry-or-progress-unknown': '部分任务重试或执行进度所需的剩余费用未知。',
  'dispatch-cost-unverified': '部分待执行任务的当前分派或执行上界无法核对。',
  'phase-remaining-unknown': '验收或返工的剩余计划预留无法分拆。',
};

function plannedReserve(phase) {
  if (!phase) return '未知';
  if (phase.state === 'finished') return '已结束';
  if (phase.state === 'unknown') return phase.plannedMicros === null ? '未知' :
    `剩余未知 · 原计划 ${usdFromMicros(phase.plannedMicros)}`;
  return usdFromMicros(phase.remainingMicros);
}

function GoalCostForecast({ goalId, budgetRevision }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const settled = report?.completionBasis === 'settled';
  const headroomLabel = report?.status === 'over-limit' ?
    (settled ? '实际超出授权' : '预计超出授权') : (settled ? '结算后预算余裕' : '预计预算余裕');
  const load = async () => {
    setLoading(true); setError('');
    try { setReport(await api.costForecast(goalId)); }
    catch (e) { setReport(null); setError(e.message); }
    finally { setLoading(false); }
  };
  return <section aria-label="预计完工成本">
    <h4>预计完工成本</h4>
    <ActionButton reason={loading ? '正在读取费用估算…' : ''} onClick={load}>{report ? '刷新完工估算' : '查看完工估算'}</ActionButton>
    {error && <p role="alert">{error}</p>}
    {report?.enabled && <div aria-live="polite">
      <p className="acms-sectionnote">快照 <time dateTime={report.asOf}>{new Date(report.asOf).toLocaleString('zh-CN')}</time>
        {budgetRevision > report.ledger.revision && ' · 账本已更新，可刷新估算'}</p>
      {report.status === 'closed' ? <p>目标已结束，费用仍可在上方账本查看。</p> : <>
        <dl className="acms-definition">
          <dt>{settled ? '完工实际费用' : '完工预估'}</dt>
          <dd>{report.completionMicros === null ? '未知' : usdFromMicros(report.completionMicros)}</dd>
          {report.headroomMicros !== null && <>
            <dt>{headroomLabel}</dt>
            <dd>{usdFromMicros(report.headroomMicros.replace(/^-/, ''))}</dd>
          </>}
          <dt>已报告结算</dt><dd>{report.ledger.reportedAttempts ? usdFromMicros(report.ledger.settledMicros) : '尚无费用回执'}</dd>
          <dt>执行预留上界</dt><dd>{usdFromMicros(report.ledger.reservedMicros)} · {report.ledger.reservedAttempts} 次待结算</dd>
          <dt>未开始任务估算小计</dt><dd>{report.unstartedMicros === null ? '未知' : usdFromMicros(report.unstartedMicros)} · 已覆盖 {report.coverage.unstarted} 项</dd>
          <dt>剩余验收计划预留</dt><dd>{plannedReserve(report.acceptance)}</dd>
          <dt>剩余返工计划预留</dt><dd>{plannedReserve(report.rework)}</dd>
          {report.completionMicros === null && <><dt>已覆盖金额小计</dt><dd>{usdFromMicros(report.coveredMicros)}</dd></>}
        </dl>
        {report.plan && <p>已批准 {report.coverage.selected} 项 · 已交付 {report.coverage.delivered} 项 · 执行预留已覆盖 {report.coverage.reserved} 项
          {report.coverage.deferred > 0 && ` · 已确认延期 ${report.coverage.deferred} 项`}
          {report.coverage.unknown > 0 && ` · 批准范围内费用未知 ${report.coverage.unknown} 项`}
          {report.coverage.outsidePlan > 0 && ` · 未纳入估算 ${report.coverage.outsidePlan} 项`}</p>}
        {report.reasons.length > 0 && <ul>{report.reasons.map(reason => <li key={reason}>{forecastReasons[reason]}</li>)}</ul>}
        {!settled && <p className="acms-sectionnote">估算使用快照时的执行预留和已批准范围。当前计划之外的重试或变更需要重新核算。</p>}
      </>}
    </div>}
  </section>;
}

function OptionalCostDecision({ goal, tasks, act, busy }) {
  const [chosen, setChosen] = useState('');
  const [reason, setReason] = useState('');
  const review = goal.costBudgetDeferralRequest;
  const checking = ['queued', 'checking'].includes(review?.status);
  const waiting = tasks.filter(task => task.status === 'blocked' && task.blocker?.kind === 'cost-budget' &&
    task.costBudgetHold?.code === OPTIONAL_COST_WAIT);
  const seed = waiting.find(task => task.id === chosen) ?? waiting[0];
  const scope = seed ? optionalDependentScope(tasks, seed.id) : [];
  const completed = tasks.filter(task => task.status === 'deferred' && task.costBudgetDeferral);
  if (!waiting.length && !completed.length && !review) return null;
  const unavailable = busy || checking ? '正在核对当前报价，请稍候' : goal.executionControl ? '请先恢复目标。' :
    goal.costBudget.reservedAttempts ? '仍有费用待结算，先保留可恢复的等待。' :
    seed?.costBudgetHold.reasonCode !== 'shortfall' ? '费用覆盖尚未核实。' : !reason.trim() ? '请填写延期理由。' : '';
  return <section aria-label="可选任务预算调整">
    <h4>可选任务预算调整</h4>
    {checking && <p role="status">正在核对当前报价与可延期范围。</p>}
    {review?.status === 'not-applied' && <p role="status">{review.result}</p>}
    {!!waiting.length && <p>{waiting.length} 项可选任务等待费用核对或余量。余额释放后会重新核对。</p>}
    {seed && <form onSubmit={async event => {
      event.preventDefault();
      try {
        const saved = await act('goal.cost_budget.defer_optional', { id: goal.id, taskId: seed.id, taskIds: scope,
          holdAttemptId: seed.costBudgetHold.attemptId, planFingerprint: seed.costBudgetHold.planFingerprint,
          reason: reason.trim() }, '已请求按当前报价核对延期');
        if (saved) setReason('');
      } catch { /* The owner command displays its error. */ }
    }}>
      <Field label="选择等待余量的任务"><select value={seed.id} onChange={event => { setChosen(event.target.value); setReason(''); }}>
        {waiting.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select></Field>
      <p>本次延期范围 · {scope.map(id => tasks.find(task => task.id === id)?.title ?? id).join('、')}</p>
      <p className="acms-sectionnote">上次核对的单次费用上界 {usdFromMicros(seed.costBudgetHold.bound.upperMicros)}。确认会先核对最新报价，再决定是否延期。</p>
      <Field label="延期理由"><textarea rows={2} value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></Field>
      <ActionButton type="submit" reason={unavailable}>确认可选项本轮延期</ActionButton>
      <ActionButton type="button" reason={busy || checking ? '正在核对当前报价，请稍候' : goal.executionControl ? '请先恢复目标。' : ''}
        onClick={() => act('task.resume', { id: seed.id }, '已请求按当前额度重新核价')}>重新核对报价</ActionButton>
    </form>}
    {completed.map(task => <p key={task.id}>{task.title} · 本轮延期 · {task.costBudgetDeferral.reason}</p>)}
  </section>;
}

function GoalCostBudget({ goal, tasks, act, busy }) {
  const [additional, setAdditional] = useState('');
  const budget = goal.costBudget;
  if (!budget) return null;
  const holds = [...new Set(tasks.filter(task => task.status === 'blocked' && task.costBudgetHold).map(task => task.costBudgetHold.reason))];
  return <section className="acms-review-state" aria-label="目标金额上限">
    <h3>目标金额上限</h3>
    <dl className="acms-definition">
      <dt>授权上限</dt><dd>{usdFromMicros(budget.limitMicros)}</dd>
      <dt>已报告费用</dt><dd>{budget.reportedAttempts ? `${usdFromMicros(budget.settledMicros)} · ${budget.reportedAttempts} 次结算` : '尚无费用回执'}</dd>
      <dt>已预留上界</dt><dd>{usdFromMicros(budget.reservedMicros)} · {budget.reservedAttempts} 次待结算</dd>
      <dt>可派发余额</dt><dd>{usdFromMicros(budget.availableMicros)}</dd>
    </dl>
    {budget.awaitingReceiptAttempts > 0 && <p>{budget.awaitingReceiptAttempts} 次已清理执行的费用仍未知，预留继续保留。</p>}
    {budget.breach && <p role="alert">执行器报告的费用超过预留上界，后续派发已停。请核对费用回执。</p>}
    {holds.map(reason => <p key={reason}>{reason}</p>)}
    <OptionalCostDecision goal={goal} tasks={tasks} act={act} busy={busy} />
    <GoalCostForecast goalId={goal.id} budgetRevision={budget.revision} />
    {!budget.breach && !['cancelled', 'archived', 'deleted'].includes(goal.status) && <form className="acms-actions wrap" onSubmit={async event => {
      event.preventDefault();
      try {
        await act('goal.cost_budget.extend', { id: goal.id, additionalCostUsd: additional }, '已追加目标金额上限');
        setAdditional('');
      } catch { /* The owner command displays its error. */ }
    }}>
      <Field label="追加金额（美元）"><input inputMode="decimal" value={additional} onChange={event => setAdditional(event.target.value)} /></Field>
      <ActionButton type="submit" reason={busy ? '正在保存，请稍候' : !additional.trim() ? '请输入追加金额' : ''}>追加金额上限</ActionButton>
    </form>}
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
const planLabels = { pending: '等待批准', approved: '已批准', rejected: '已拒绝', returned: '已退回修改', superseded: '已失效' };

function PlanDecisionHistory({ plan }) {
  return <>{[plan.ownerDecision, plan.revisionRequest].filter(Boolean).map(decision => <div key={decision.action}>
    <p><b>{decision.action === 'approve' ? '批准派工' : decision.action === 'reject' ? '拒绝' : '退回重新规划'}</b> · {new Date(decision.at).toLocaleString('zh-CN')}</p>
    <p className="acms-preserve">{decision.reason}</p>
  </div>)}{plan.supersededReason && <p>{plan.supersededReason}</p>}</>;
}

function PlanCostDetails({ goal, plan }) {
  const cost = plan.costPlan, budget = goal.costBudget;
  if (!goal.planApproval.costPlanning) return null;
  if (!cost) return <p>此旧提案尚无可信费用估算。请退回重新规划。</p>;
  const estimate = cost.estimate;
  return <section aria-label="计划费用估算">
    <h4>计划费用估算</h4>
    <dl className="acms-definition">
      <dt>提交时可派发余额</dt><dd>{usdFromMicros(cost.submitted.availableMicros)} · 已预留 {usdFromMicros(cost.submitted.reservedMicros)}</dd>
      <dt>当前可派发余额</dt><dd>{usdFromMicros(budget.availableMicros)}</dd>
      <dt>最低交付估算</dt><dd>{cost.minimumMicros === null ? '未知' : usdFromMicros(cost.minimumMicros)}</dd>
      <dt>含可选任务估算</dt><dd>{cost.fullMicros === null ? '未知' : usdFromMicros(cost.fullMicros)}</dd>
      {estimate && <>
        <dt>估算来源</dt><dd>{estimate.executorId} · {estimate.quoteId}</dd>
        <dt>验收计划预留</dt><dd>{usdFromMicros(estimate.acceptance.micros)} · {estimate.acceptance.basis}</dd>
        <dt>返工计划预留</dt><dd>{usdFromMicros(estimate.rework.micros)} · {estimate.rework.basis}</dd>
      </>}
    </dl>
    {cost.reason && <p>{cost.reason}</p>}
    {estimate && <p className="acms-sectionnote">计划估算用于范围决策。实际派发仍逐次预留，费用以可信回执结算。</p>}
  </section>;
}

function PlanProposal({ goal, task, plan, data, act, busy }) {
  const [reason, setReason] = useState('');
  const attempt = data.attempts.find(item => item.id === plan.attemptId);
  const decisionReason = busy ? '正在保存，请稍候' : goal.executionControl ? '请先恢复目标。' :
    goal.contractChange?.status === 'pending' ? '请先处理当前目标合同变更。' :
    attempt?.cleanupPending || attempt?.cleanupUncertain ? '请等待规划执行完成清理或核对。' :
    task.status !== 'blocked' ? '请先恢复规划任务。' : !reason.trim() ? '请先填写决定理由。' : '';
  const budget = goal.costBudget, cost = plan.costPlan;
  const budgetReason = !goal.planApproval.costPlanning ? '' : !cost?.estimate ? '先退回提案并补齐可信估算。' :
    budget.breach || BigInt(budget.availableMicros) < BigInt(cost.selectedMicros) ? '当前余额不足以批准此计划版本。' : '';
  const badge = plan.costRelease?.kind === 'automatic' ? '已按金额核验派工' :
    goal.planApproval.costPlanning && plan.approvalStatus === 'pending' && cost?.status !== 'fits' ? '等待预算决定' : planLabels[plan.approvalStatus];
  const canDecide = ['pending', 'rejected'].includes(plan.approvalStatus) && !['cancelled', 'archived', 'deleted', 'succeeded'].includes(goal.status);
  const decide = async (action, message) => {
    try {
      const result = await act('plan.approval.decide', { planId: plan.id, fingerprint: plan.fingerprint,
        generation: plan.generation, goalContractVersion: plan.goalContractVersion, action, reason: reason.trim() }, message);
      if (result) setReason('');
    } catch { /* The owner command displays its error. */ }
  };
  return <>
    <p role="status"><span className="acms-tag">{badge}</span> · 规划第 {plan.generation} 代 · 合同 v{plan.goalContractVersion}</p>
    <dl className="acms-definition">
      <dt>提案版本</dt><dd><code title={plan.fingerprint}>{plan.fingerprint.slice(0, 16)}</code></dd>
      <dt>负责人</dt><dd>{data.agents.find(agent => agent.id === plan.managerId)?.name ?? plan.managerId}</dd>
      <dt>交付范围</dt><dd className="acms-preserve">{plan.scope.minimumOutcome}</dd>
      {!!plan.scope?.nonGoals?.length && <><dt>范围之外</dt><dd>{plan.scope.nonGoals.join('、')}</dd></>}
      <dt>取舍与依据</dt><dd className="acms-preserve">{plan.rationale || plan.summary}</dd>
    </dl>
    <PlanCostDetails goal={goal} plan={plan} />
    <details open={plan.approvalStatus === 'pending'}><summary>拟派发任务（{plan.proposalTasks.length}）</summary>
      {plan.proposalTasks.map(node => {
        const intent = cost?.intent.nodes.find(item => item.key === node.key);
        const estimate = cost?.estimate?.tasks.find(item => item.key === node.key)?.estimate;
        return <div key={node.key} className="acms-change-diff">
          <b>{node.title}</b>
          {node.description !== node.title && <p className="acms-preserve">{node.description}</p>}
          <p className="acms-preserve">验收要求 · {node.acceptance ?? plan.goalAcceptance}</p>
          <p>前置任务 · {node.dependencies.map(key => plan.proposalTasks.find(item => item.key === key)?.title ?? key).join('、') || '无'}</p>
          {node.assignee && <p>拟执行人员 · {data.agents.find(agent => agent.id === node.assignee)?.name ?? node.assignee}</p>}
          {intent && <p>{intent.importance === 'required' ? '必做' : intent.importance === 'optional' ? '可选' : '分类待补充'}
            {estimate && !cost.selectedKeys.includes(node.key) && ' · 已延期'}
            {estimate ? ` · 估算 ${usdFromMicros(estimate.micros)} · ${estimate.route.model} · ${estimate.basis}` : ' · 估算未知'}</p>}
          {intent?.modelBasis && <p className="acms-preserve">选模依据 · {intent.modelBasis}</p>}
        </div>;
      })}
    </details>
    <PlanDecisionHistory plan={plan} />
    {canDecide && <>
      <Field label="计划审批理由"><textarea rows={3} value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} /></Field>
      {plan.approvalStatus === 'pending' && <p className="acms-sectionnote">批准后按此版本和依赖派工。拒绝后等待所有者决定是否重新规划。</p>}
      <div className="acms-actions wrap">
        {plan.approvalStatus === 'pending' && <>
          <ActionButton className="primary" reason={decisionReason || budgetReason} onClick={() => decide('approve', '已批准此计划并派工')}>批准计划并派工</ActionButton>
          <ActionButton className="danger" reason={decisionReason} onClick={() => decide('reject', '已拒绝此计划')}>拒绝此计划</ActionButton>
        </>}
        <ActionButton reason={decisionReason} onClick={() => decide('revise', '已安排负责人重新规划')}>{plan.approvalStatus === 'rejected' ? '重新规划' : '退回修改'}</ActionButton>
      </div>
    </>}
  </>;
}

function GoalPlanApproval({ goal, data, act, busy }) {
  const rootTask = data.tasks.find(task => task.id === goal.planApproval.taskId);
  const plans = (data.plans ?? []).filter(plan => plan.taskId === goal.planApproval.taskId && plan.approvalStatus)
    .sort((a, b) => b.generation - a.generation);
  const current = plans.find(plan => plan.id === goal.planApproval.approvedPlanId || plan.generation === rootTask?.generation);
  const history = plans.filter(plan => plan.id !== current?.id);
  return <section className="acms-review-state" aria-label="计划审批">
    <h3>计划审批</h3>
    {current && rootTask ? <PlanProposal key={current.id} goal={goal} task={rootTask} plan={current} data={data} act={act} busy={busy} /> :
      <p role="status">{rootTask ? `等待负责人提交计划 · ${reviewLabels[rootTask.status] ?? rootTask.status}` : '当前规划任务不在可查看范围内。'}</p>}
    {!!history.length && <details><summary>历史提案（{history.length}）</summary>{history.map(plan => <div key={plan.id}>
      <p>第 {plan.generation} 代 · 合同 v{plan.goalContractVersion} · {planLabels[plan.approvalStatus]} · <code>{plan.fingerprint.slice(0, 16)}</code></p>
      <PlanDecisionHistory plan={plan} />
    </div>)}</details>}
  </section>;
}

export function EntityDrawer({ kind, entity, data, close, navigate, open, chat, act, busy, runtimeNow }) {
  const tasks = entityTasks(kind, entity, data); const goals = data.goals.filter(g => kind === 'project' && g.projectId === entity.id);
  const project = kind === 'goal' ? data.projects.find(p => p.id === entity.projectId) : null;
  return <div className="acms-drawer-shade" onClick={e => { if (e.target === e.currentTarget) close(); }}><aside className="acms-drawer" aria-label={`${entityLabels[kind]}详情`}><header><span>{entityLabels[kind]}详情</span><button aria-label="关闭详情" onClick={close}>×</button></header><h2>{entity.title ?? entity.name}</h2>{kind === 'goal' && <p className="acms-sectionnote">优先级：{Number.isInteger(entity.priority) ? entity.priority : 50}（0–100；只影响后续跨目标派发顺序）</p>}{project && <button className="text" onClick={() => navigate('project', project.id)}>所属项目：{project.name}</button>}<CollapsibleText text={entity.description} lines={3} label="说明" />{entity.repoRoot && <p><code>{entity.repoRoot}</code></p>}{entity.acceptance && <section><h3>验收标准</h3><CollapsibleText text={entity.acceptance} lines={3} label="验收标准" /></section>}<div className="acms-actions wrap"><button onClick={() => open(kind === 'goal' ? 'goalEdit' : kind, entity)}>编辑{entityLabels[kind]}</button><ActionButton className="danger" reason={entityDeletionReason(kind, entity, data)} onClick={() => open('deleteEntity', { ...entity, entityKind: kind })}>删除{entityLabels[kind]}</ActionButton></div>
    {kind === 'agent' && chat && <button className="primary" onClick={() => chat(entity.id)}>与智能体对话</button>}
    {kind === 'goal' && entity.planApproval && act && <GoalPlanApproval goal={entity} data={data} act={act} busy={busy} />}
    {kind === 'goal' && act && <><GoalControls goal={entity} companyPaused={data.policy.paused} act={act} open={open} busy={busy} /><GoalRuntimeBudget goal={entity} data={data} open={open} busy={busy} runtimeNow={runtimeNow} /><GoalCostBudget key={entity.id} goal={entity} tasks={tasks} act={act} busy={busy} /><GoalAttemptUsage key={entity.id} goalId={entity.id} tasks={tasks} /><GoalReviewState goal={entity} approvals={(data.deliveryApprovals ?? []).filter(record => record.goalId === entity.id).reverse()} deliveryRepository={project?.deliveryRepository} taskCount={tasks.length} taskLimit={data.policy.maxTasksPerGoal} act={act} busy={busy} /></>}
    {goals.length > 0 && <section><h3>所属目标</h3>{goals.map(g => <button className="acms-entity-link" key={g.id} onClick={() => navigate('goal', g.id)}>{g.title} →</button>)}</section>}
    <section><h3>关联任务（{tasks.length}）</h3>{tasks.slice(0, 8).map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}{tasks.length > 8 && <details><summary>显示其余 {tasks.length - 8} 项</summary>{tasks.slice(8).map(t => <button className="acms-entity-link" key={t.id} onClick={() => navigate('task', t.id)}>{t.title} →</button>)}</details>}{!tasks.length && <p>暂无关联任务。</p>}</section><ChangeHistory kind={kind} id={entity.id} data={data} /></aside></div>;
}
export function EntityTrash({ data, act, busy }) {
  return <section className="acms-panel"><h2>项目、目标与角色回收站</h2><p>恢复项目或目标时，关联的未完成任务保持暂停。删除记录不影响源文件。</p>{!(data.entityTrash ?? []).length && <p>回收站为空。</p>}{(data.entityTrash ?? []).map(e => <div className="acms-trash-row" key={e.id}><div><b>{entityLabels[e.entityKind]} · {e.title ?? e.name}</b><p>{e.entityKind !== 'agent' ? '含本次删除的下级记录' : '历史执行记录保留'}</p></div><ActionButton reason={busy ? '正在保存，请稍候' : ''} onClick={() => act(`${e.entityKind}.restore`, { id: e.id, expectedRevision: e.revision }, '已恢复；未完成任务保持暂停')}>恢复{entityLabels[e.entityKind]}</ActionButton></div>)}</section>;
}
