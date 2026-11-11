import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { activityContext, describeActivity, redactActivityText } from '../core/activity.js';

const timeOf = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '—';
};
const shortHash = value => {
  const text = String(value ?? '');
  return text.length > 18 ? `${text.slice(0, 14)}…` : text;
};
const openKind = kind => ({ task: '任务', goal: '目标', project: '项目', agent: '角色' })[kind] ?? null;

function mergeEntries(items, entries) {
  const merged = new Map(items.map(item => [item.seq, item]));
  for (const entry of entries) merged.set(entry.seq, entry);
  return [...merged.values()].sort((left, right) => right.seq - left.seq);
}

export function ActivityPage({ data, select, navigate, updated, open }) {
  const [projectId, setProjectId] = useState('');
  const [goalId, setGoalId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [items, setItems] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [latestSeq, setLatestSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const request = useRef(0); const syncing = useRef(false); const pendingSync = useRef(false); const generation = useRef(0); const stateRef = useRef({ items, latestSeq, loaded });

  const filters = useMemo(() => ({ projectId: projectId || undefined, goalId: goalId || undefined, taskId: taskId || undefined }), [projectId, goalId, taskId]);
  const filterKey = JSON.stringify(filters);
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const filterKeyRef = useRef(filterKey); filterKeyRef.current = filterKey;
  const context = useMemo(() => activityContext(data), [data]);
  const available = useMemo(() => ({
    project: new Set((data.projects ?? []).map(item => item.id)),
    goal: new Set((data.goals ?? []).map(item => item.id)),
    task: new Set((data.tasks ?? []).map(item => item.id)),
    agent: new Set((data.agents ?? []).map(item => item.id)),
  }), [data.projects, data.goals, data.tasks, data.agents]);
  const inTrash = useMemo(() => ({
    task: new Set((data.trash ?? []).map(item => item.id)),
    project: new Set((data.entityTrash ?? []).filter(item => item.entityKind === 'project').map(item => item.id)),
    goal: new Set((data.entityTrash ?? []).filter(item => item.entityKind === 'goal').map(item => item.id)),
    agent: new Set((data.entityTrash ?? []).filter(item => item.entityKind === 'agent').map(item => item.id)),
  }), [data.trash, data.entityTrash]);
  const goals = useMemo(() => (data.goals ?? []).filter(goal => !projectId || goal.projectId === projectId), [data.goals, projectId]);
  const tasks = useMemo(() => (data.tasks ?? []).filter(task => (!projectId || task.projectId === projectId) && (!goalId || task.goalId === goalId)), [data.tasks, projectId, goalId]);
  const pendingByTask = useMemo(() => new Map((data.interactions ?? []).filter(item => item.status === 'pending').map(item => [item.taskId, item])), [data.interactions]);
  const artifactsById = useMemo(() => new Map((data.artifacts ?? []).map(item => [item.id, item])), [data.artifacts]);
  const latestBlockSeq = useMemo(() => {
    const map = new Map();
    for (const entry of items) {
      if (entry.type !== 'task.blocked') continue;
      const task = entry.data?.taskId ?? entry.entityId;
      if (!map.has(task) || entry.seq > map.get(task)) map.set(task, entry.seq);
    }
    return map;
  }, [items]);
  stateRef.current = { items, latestSeq, loaded };

  const loadNewest = async () => {
    const token = ++request.current; const gen = ++generation.current; setLoading(true); setError(''); pendingSync.current = false;
    try {
      const page = await api.activity({ ...filters, limit: 50 });
      if (token !== request.current || gen !== generation.current) return;
      const merged = mergeEntries(page.entries, stateRef.current.items);
      stateRef.current = { items: merged, latestSeq: Math.max(stateRef.current.latestSeq, page.latestSeq), loaded: true };
      setItems(merged); setNextBefore(page.nextBefore); setLatestSeq(previous => Math.max(previous, page.latestSeq)); setHasMore(page.hasMore); setLoaded(true);
      // Events may have arrived while the first page was loading; synchronize
      // from the page watermark before declaring the view settled.
      syncNewer().catch(() => {});
    } catch (cause) {
      if (token !== request.current) return;
      setError(`${cause.code ? `${cause.code} · ` : ''}${cause.message}`);
    } finally {
      if (token === request.current) setLoading(false);
    }
  };
  const loadOlder = async () => {
    if (nextBefore === null) return;
    const token = request.current; setLoading(true); setError('');
    try {
      const page = await api.activity({ ...filters, before: nextBefore, limit: 50 });
      if (token !== request.current) return;
      setItems(previous => mergeEntries(previous, page.entries));
      setNextBefore(page.nextBefore); setHasMore(page.hasMore);
      // An older page must never move the newer-event watermark: it does not
      // contain the events that arrived while it was being read.
      if (page.latestSeq > latestSeq) syncNewer().catch(() => {});
    } catch (cause) {
      if (token !== request.current) return;
      setError(`${cause.code ? `${cause.code} · ` : ''}${cause.message}`);
    } finally {
      if (token === request.current) setLoading(false);
    }
  };
  const syncNewer = async () => {
    if (syncing.current) { pendingSync.current = true; return; }
    if (!stateRef.current.loaded) return;
    syncing.current = true;
    const gen = generation.current;
    try {
      for (;;) {
        const current = stateRef.current;
        const startedWith = filterKeyRef.current;
        const page = await api.activity({ ...filtersRef.current, after: current.latestSeq, limit: 50 });
        if (gen !== generation.current || filterKeyRef.current !== startedWith) break;
        if (!page.entries.length) break;
        setItems(previous => mergeEntries(previous, page.entries));
        const nextSeq = page.nextAfter ?? current.latestSeq;
        setLatestSeq(previous => Math.max(previous, nextSeq));
        stateRef.current = { ...current, latestSeq: Math.max(current.latestSeq, nextSeq) };
        if (!page.hasNewer) break;
      }
    } finally {
      syncing.current = false;
      if (pendingSync.current) { pendingSync.current = false; syncNewer().catch(() => {}); }
    }
  };
  const refreshActivity = async () => {
    if (!stateRef.current.loaded) return loadNewest();
    const gen = generation.current;
    setLoading(true); setError('');
    try {
      // Keep the existing cursor and older-page boundary. A newest-page fetch
      // would skip the middle of a burst larger than one page.
      await syncNewer();
    } catch (cause) {
      if (gen === generation.current) setError(`${cause.code ? `${cause.code} · ` : ''}${cause.message}`);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    stateRef.current = { items: [], latestSeq: 0, loaded: false };
    setItems([]); setNextBefore(null); setLatestSeq(0); setHasMore(false); setLoaded(false); setError('');
    loadNewest().catch(() => {}); /* filters changing starts a new durable cursor */
  }, [filters]);
  useEffect(() => { syncNewer().catch(() => {}); }, [updated]);

  const openSubject = subject => {
    if (!subject) return;
    if (subject.kind === 'task') select(subject.id);
    else if (['goal', 'project', 'agent'].includes(subject.kind)) navigate(subject.kind, subject.id);
  };
  const changeProject = value => { setProjectId(value); setGoalId(''); setTaskId(''); };
  const changeGoal = value => { setGoalId(value); setTaskId(''); };

  return <>
    <div className="acms-pagehead"><div><div className="acms-eyebrow">BUSINESS ACTIVITY</div><h1>动态日志</h1><p>按真实业务事件记录谁创建、阻塞、审查和完成了工作；轮询、心跳和技术流水不会进入这里。</p></div>
      <div className="acms-actions"><button type="button" onClick={() => refreshActivity().catch(() => {})} disabled={loading}>刷新动态</button></div></div>
    <div className="acms-toolbar">
      <select aria-label="筛选动态项目" value={projectId} onChange={event => changeProject(event.target.value)}><option value="">全部项目</option>{(data.projects ?? []).map(project => <option key={project.id} value={project.id}>{redactActivityText(project.name)}</option>)}</select>
      <select aria-label="筛选动态目标" value={goalId} onChange={event => changeGoal(event.target.value)}><option value="">全部目标</option>{goals.map(goal => <option key={goal.id} value={goal.id}>{redactActivityText(goal.title)}</option>)}</select>
      <select aria-label="筛选动态任务" value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">全部任务</option>{tasks.map(task => <option key={task.id} value={task.id}>{redactActivityText(task.title)}</option>)}</select>
      <span className="acms-muted">已显示 {items.length} 条</span>
    </div>
    {error && <div className="acms-alert error" role="alert">{error}</div>}
    {!loading && !items.length && !error && <div className="acms-empty"><span className="acms-empty-mark">◇</span><h3>还没有可显示的业务动态</h3><p>创建目标、分配任务或回复阻塞后，这里会按时间记录真实操作人和动作。</p></div>}
    <div className="acms-activity-list">{items.map(entry => {
      const activity = describeActivity(entry, context);
      if (!activity) return null;
      const kind = openKind(activity.subject?.kind);
      const subjectAvailable = kind && available[activity.subject.kind]?.has(activity.subject.id);
      const subjectInTrash = kind && inTrash[activity.subject.kind]?.has(activity.subject.id);
      const pending = activity.subject?.kind === 'task' && latestBlockSeq.get(activity.subject.id) === activity.seq ? pendingByTask.get(activity.subject.id) : null;
      return <article key={activity.seq} className="acms-activity-entry" data-category={activity.category}>
        <header className="acms-activity-head">
          <span className="acms-activity-actor" data-kind={activity.actor.kind}>{activity.actor.label}</span>
          <span className="acms-tag">{activity.categoryLabel}</span>
          {pending && <span className="acms-tag">待你回复</span>}
          <time dateTime={activity.at}>{timeOf(activity.at)}</time>
          <span className="acms-muted">#{activity.seq}</span>
        </header>
        <div className="acms-activity-main">
          <p className="acms-activity-action">{activity.action}{subjectAvailable && <button type="button" className="text acms-activity-open" onClick={() => openSubject(activity.subject)}>打开{kind} →</button>}{kind && !subjectAvailable && <span className="acms-muted">{subjectInTrash ? `${kind}已移入回收站，无法打开详情` : `${kind}已不可用，无法打开详情`}</span>}{pending && open && <button type="button" className="text acms-activity-open" onClick={() => open('answer', pending)}>回复待处理问题 →</button>}</p>
          {(activity.project || activity.goal) && <p className="acms-activity-path">{[activity.project?.title, activity.goal?.title].filter(Boolean).join(' › ')}</p>}
          {activity.reason && <p className="acms-activity-reason"><b>原因：</b>{activity.reason}</p>}
          {activity.executor && <p className="acms-muted">相关执行者：{activity.executor}</p>}
          {activity.delivery.length > 0 && <div className="acms-activity-delivery"><b>交付证据：</b>{activity.delivery.map(item => <span key={item.id ?? item.title} className="acms-activity-delivery-item"><span>{item.title}（版本 {item.contractVersion ?? '未知'}、代次 {item.generation ?? '未知'}）</span>{item.artifactIds.map(id => artifactsById.get(id)).filter(Boolean).map(artifact => <button type="button" key={artifact.id} className="text acms-activity-open" onClick={() => open('artifact', artifact)}>打开产物「{redactActivityText(artifact.title ?? artifact.path)}」 →</button>)}{item.artifactIds.length > 0 && !item.artifactIds.some(id => artifactsById.has(id)) && <span>历史产物不可用，仅保留哈希 {item.artifactHash ? <code title={item.artifactHash}>{shortHash(item.artifactHash)}</code> : '（未记录）'}</span>}{item.artifactIds.length === 0 && item.artifactHash && <span>未记录产物清单，仅保留哈希 <code title={item.artifactHash}>{shortHash(item.artifactHash)}</code></span>}</span>)}{activity.deliveryTotal > activity.delivery.length && <span className="acms-muted">仅显示前 {activity.delivery.length}/{activity.deliveryTotal} 项</span>}{activity.deliveryReview?.taskId && <button type="button" className="text acms-activity-open" onClick={() => select(activity.deliveryReview.taskId)}>查看当次审查记录 →</button>}{activity.deliveryReviewStale && <span>历史审查记录与当次交付不一致，未作为本次证据。</span>}</div>}
          {activity.type === 'goal.succeeded' && activity.delivery.length === 0 && <p className="acms-muted">历史事件未记录当次交付清单；只能打开当前目标查看最新证据。</p>}
          {(activity.evidence.artifactHash || activity.evidence.deliveryHash || activity.evidence.integratedCommit) && <p className="acms-activity-evidence">证据：{Object.entries(activity.evidence).map(([key, value]) => <code key={key} title={`${key}: ${value}`}>{key}={shortHash(value)}</code>)}</p>}
        </div>
        <details className="acms-activity-details"><summary>技术详情</summary><div><dl className="acms-definition"><dt>事件类型</dt><dd>{activity.type}</dd><dt>实体</dt><dd>{activity.subject?.id ?? entry.entityId ?? '—'}</dd><dt>目标</dt><dd>{activity.goal?.id ?? entry.goalId ?? '—'}</dd>{activity.type === 'goal.succeeded' && <><dt>交付清单</dt><dd>{activity.deliveryTotal ? `${activity.deliveryTotal} 项${activity.deliveryReview ? ` · 当次审查${activity.deliveryReview.passed ? '通过' : '未通过'}` : ' · 无最终审查记录'}${activity.deliveryReviewStale ? ' · 历史审查记录不一致' : ''}` : '历史事件未记录'}</dd></>}</dl><pre>{JSON.stringify(activity.details, null, 2)}</pre></div></details>
      </article>;
    })}</div>
    {hasMore && <div className="acms-actions acms-activity-more"><button type="button" onClick={() => loadOlder().catch(() => {})} disabled={loading}>{loading ? '正在加载…' : '加载更早的动态'}</button></div>}
    {loaded && !hasMore && items.length > 0 && <p className="acms-sectionnote">已经到达可读动态的起点。</p>}
  </>;
}
