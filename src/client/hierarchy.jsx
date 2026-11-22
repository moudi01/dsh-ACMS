import React, { useLayoutEffect, useRef, useState } from 'react';
import { goalSummary, taskAncestors, visibleTask } from '../core/hierarchy.js';
import { CollapsibleText } from './components.jsx';
import { activeViewTasks, childrenIndex, compareActivity, goalVisibleInActiveView, hasOpenDescendant, isCompleted, orderByActivity, taskParentId } from './display.js';
import { api } from './api.js';

const statuses = { ready: '待执行', blocked: '阻塞', running: '执行中', paused: '暂停', cancelled: '取消', succeeded: '完成', planning: '规划中', active: '进行中', empty: '暂无任务', archived: '归档', reviewing: '审查中', failed: '失败' };
const MAX_GOALS = 6; const MAX_TASKS = 8;

// Disclosure state lives outside React state so an ordinary data refresh keeps
// whatever the user opened. Keys include the object id, so one project's state
// can never leak into another.
const detailsOpen = new Map();
const listOpen = new Map();
const branchOpen = new Map();

function useBump() { const [, set] = useState(0); return () => set(value => value + 1); }

export function useDashboardPage(section, parent, cursor, embedded = null, enabled = true) {
  const request = useRef(null);
  const [page, setPage] = useState(null);
  const key = JSON.stringify([section, parent]);
  const embeddedRef = useRef(embedded);
  embeddedRef.current = embedded;
  const publish = (current, value, after) => {
    if (current.signal.aborted) return;
    const previous = current.page;
    const keepOlder = !value.reset && (after || previous?.loadedOlder && value.next);
    const items = !keepOlder ? value.items : after ?
      [...new Map([...previous.items, ...value.items].map(row => [row.id, row])).values()] :
      [...new Map([...value.items, ...previous.items.filter(row => !value.items.some(item => item.id === row.id))].map(row => [row.id, row])).values()];
    current.page = { ...value, items, key, loading: false, error: '', loadedOlder: !!keepOlder,
      next: !after && keepOlder ? previous.next : value.next };
    setPage(current.page);
  };
  const load = async (current, after) => {
    if (!current || current.loading || current.signal.aborted) return;
    current.loading = true;
    if (!after) current.queued = false;
    const previous = current.page;
    if (previous) setPage({ ...previous, loading: true, error: '' });
    try {
      const value = !after && embeddedRef.current ? embeddedRef.current :
        await api.dashboard(section, { parent, after, signal: current.signal });
      publish(current, value, after);
    } catch (error) {
      if (!current.signal.aborted) {
        current.page = { ...previous, key, items: previous?.items ?? [], loading: false, error: error.message, retryAfter: after };
        setPage(current.page);
      }
    } finally {
      current.loading = false;
      if (current.queued && !current.page?.error) void load(current, null);
    }
  };
  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    request.current = { signal: controller.signal, loading: false, queued: false, page: null };
    return () => controller.abort();
  }, [enabled, key]);
  useLayoutEffect(() => {
    if (!enabled) return;
    request.current.queued = true;
    if (!request.current.page?.retryAfter) void load(request.current, null);
  }, [enabled, key, cursor, embedded]);

  const current = page?.key === key ? page : embedded ?? { items: [], total: 0, next: null, loading: true, error: '' };
  return { ...current, more: () => load(request.current, current.error ? current.retryAfter : current.next) };
}

export function DashboardMore({ page, label }) {
  return <>{page.loading && <p role="status" className="acms-muted">正在读取{label}…</p>}
    {page.error && <p role="alert">{page.error}</p>}
    {!page.loading && (page.error || page.next) && <button type="button" className="text acms-more" onClick={page.more}>
      {page.error ? `重试读取${label}` : `查看更多${label}`}
    </button>}</>;
}

export function DashboardHierarchy({ data, navigate, select, open, onGoal }) {
  const page = useDashboardPage('projects', null, data.cursor, data.projects);
  return <div className="acms-project-tree" aria-label="项目目标层级">
    {page.items.map(project => <DashboardProject key={project.id} project={project} navigate={navigate} select={select}
      open={open} onGoal={onGoal} cursor={data.cursor} />)}
    <DashboardMore page={page} label="项目" />
  </div>;
}

function DashboardProject({ project, cursor, navigate, select, open, onGoal }) {
  const [shown, setShown] = useState(() => detailsOpen.get(`project:${project.id}`) === true);
  return <details className="acms-project-group" open={shown} onToggle={event => {
    if (event.target !== event.currentTarget) return;
    detailsOpen.set(`project:${project.id}`, event.currentTarget.open);
    setShown(event.currentTarget.open);
  }}>
    <summary><span className="acms-level-tag">项目</span>
      <button className="text acms-entity-title" onClick={event => { event.preventDefault(); navigate('project', project.id); }}>{project.name}</button>
      <span>{project.activeGoals} 个目标 · {project.activeTasks} 项任务</span>
    </summary>
    {shown && <DashboardProjectContents project={project} cursor={cursor} navigate={navigate} select={select} open={open} onGoal={onGoal} />}
  </details>;
}

function DashboardProjectContents({ project, cursor, navigate, select, open, onGoal }) {
  const page = useDashboardPage('goals', project.id, cursor);
  return <>
    <p className="acms-project-directory">{project.repoRoot}</p>
    <div className="acms-actions">
      <button className="text" onClick={() => open('project', project)}>编辑项目</button>
      <button className="text" onClick={() => open('goal', { projectId: project.id })}>＋ 添加目标</button>
    </div>
    {!page.loading && !page.error && !page.total && <p className="acms-sectionnote">这个项目当前没有进行中的目标；已完成目标在“已完成”列表中查看。</p>}
    {page.items.map(goal => <DashboardGoal key={goal.id} goal={goal} navigate={navigate} select={select} open={open} onGoal={onGoal} cursor={cursor} />)}
    <DashboardMore page={page} label="目标" />
  </>;
}

function DashboardGoal({ goal, cursor, navigate, select, open, onGoal }) {
  const [shown, setShown] = useState(() => detailsOpen.get(`goal:${goal.id}`) === true);
  const { taskSummary: rollup } = goal;
  return <details className="acms-goal-group" open={shown} onToggle={event => {
    if (event.target !== event.currentTarget) return;
    detailsOpen.set(`goal:${goal.id}`, event.currentTarget.open);
    setShown(event.currentTarget.open);
  }}>
    <summary><span className="acms-level-tag">目标</span>
      <button className="text acms-entity-title" onClick={event => { event.preventDefault(); navigate('goal', goal.id); }}>{goal.title}</button>
      <span>{statuses[rollup.status] ?? rollup.status} · {rollup.done}/{rollup.total} 项完成{goal.activeTasks ? ` · 显示 ${goal.activeTasks} 项` : ''}</span>
      {isCompleted(goal) && goal.openTasks > 0 && <em className="acms-tag">已完成 · 含未完成后代</em>}
      {goal.contractChange?.status === 'pending' && <em className="acms-tag">合同 v{goal.contractVersion} 待确认</em>}
      {goal.reviewSummary?.status === 'cancelled' && <em className="acms-tag">最终审查已取消</em>}
    </summary>
    {shown && <DashboardGoalContents goal={goal} cursor={cursor} select={select} open={open} onGoal={onGoal} />}
  </details>;
}

function DashboardGoalContents({ goal, cursor, select, open, onGoal }) {
  const page = useDashboardPage('tasks', goal.id, cursor);
  const canAdd = !['succeeded', 'cancelled', 'archived'].includes(goal.status);
  return <>
    {page.about && <CollapsibleText text={page.about} lines={2} label="说明" />}
    <div className="acms-actions">
      <button className="text" onClick={() => open('goalEdit', goal)}>编辑目标</button>
      <button className="text" onClick={() => onGoal(goal.projectId, goal.id)}>查看此目标的任务 →</button>
      {canAdd && <button className="text" onClick={() => open('task', { goalId: goal.id, projectId: goal.projectId })}>＋ 添加任务</button>}
    </div>
    {!page.loading && !page.error && <TaskTree tasks={page.items} select={select} listKey={goal.id}
      createChild={canAdd ? task => open('task', { goalId: goal.id, projectId: goal.projectId, parentId: task.id }) : null}
      emptyNote={isCompleted(goal) ? '目标已完成，交付物保留在产物与验收中。' : '目标保留，当前没有进行中的任务（暂无任务）；已完成任务在“已完成”列表中查看。'} />}
    <DashboardMore page={page} label="任务" />
  </>;
}

function ScopedGoalDescription({ goal, cursor }) {
  const page = useDashboardPage('goal-description', goal.id, cursor);
  return <>
    {page.about && <CollapsibleText text={page.about} lines={2} label="说明" />}
    <DashboardMore page={page} label="目标说明" />
  </>;
}

export function TaskPath({ task, data, select, navigate }) {
  const project = data.projects.find(p => p.id === task.projectId); const goal = data.goals.find(g => g.id === task.goalId);
  return <nav className="acms-task-path" aria-label="任务归属">{navigate && project ? <button className="text" onClick={() => navigate('project', project.id)}>项目：{project.name}</button> : <span>项目：{project?.name ?? '未知项目'}</span>}{navigate && goal ? <button className="text" onClick={() => navigate('goal', goal.id)}>目标：{goal.title}</button> : <span>目标：{goal?.title ?? '未知目标'}</span>}{taskAncestors(task, [...data.tasks, ...(data.knownTasks ?? [])]).map(parent => select ? <button type="button" className="text" key={parent.id} onClick={() => select(parent.id)}>父任务：{parent.title}</button> : <span key={parent.id}>父任务：{parent.title}</span>)}</nav>;
}

function TaskTree({ tasks, known = [], select, createChild, listKey, emptyNote }) {
  const bump = useBump();
  const index = childrenIndex(tasks); const ids = new Set(tasks.map(task => task.id));
  const knownById = new Map(known.map(task => [task.id, task]));
  const expanded = id => branchOpen.get(id) === true;
  const toggle = id => { branchOpen.set(id, !expanded(id)); bump(); };
  const branch = (task, seen = new Set()) => {
    if (seen.has(task.id)) return null; const next = new Set([...seen, task.id]); const children = index.get(task.id) ?? []; const open = expanded(task.id);
    const childShowAll = listOpen.get(`children:${task.id}`) === true; const shownChildren = childShowAll ? children : children.slice(0, MAX_TASKS);
    const parentId = taskParentId(task);
    const parent = !ids.has(parentId) ? knownById.get(parentId) : null;
    return <li key={task.id}>
      <div className="acms-tree-task">
        {children.length > 0
          ? <button type="button" className="acms-twisty" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}“${task.title}”的子任务`} onClick={() => toggle(task.id)}>{open ? '▾' : '▸'}</button>
          : <span className="acms-twisty-space" aria-hidden="true" />}
        <button type="button" className="acms-task-title" onClick={() => select(task.id)}><small>{task.kind === 'review' ? '审查' : task.parentId ? '子任务' : task.kind === 'plan' ? '规划任务' : '任务'}</small><strong>{task.title}</strong><span>{statuses[task.status] ?? task.status}</span></button>
        {isCompleted(task) && hasOpenDescendant(task, index) && <em className="acms-tag">已完成 · 含未完成后代</em>}
        {children.length > 0 && <small className="acms-muted">{children.length} 项子任务</small>}
        {parent && <button type="button" className="text" onClick={() => select(parent.id)}>父任务：{parent.title}（不在本页）</button>}
        {createChild && task.kind !== 'review' && <button className="text" type="button" onClick={() => createChild(task)}>＋ 子任务</button>}
      </div>
      {children.length > 0 && open && <ul>{shownChildren.map(child => branch(child, next))}{children.length > MAX_TASKS && <li className="acms-list-more"><button type="button" className="text acms-more" aria-expanded={childShowAll} onClick={() => { listOpen.set(`children:${task.id}`, !childShowAll); bump(); }}>{childShowAll ? `收起子任务列表（共 ${children.length} 项）` : `显示其余 ${children.length - MAX_TASKS} 项子任务`}</button></li>}</ul>}
    </li>;
  };
  const roots = tasks.filter(task => !ids.has(taskParentId(task))).sort(compareActivity);
  const showAll = listOpen.get(`tasks:${listKey}`) === true;
  const shown = showAll ? roots : roots.slice(0, MAX_TASKS);
  return <>
    {!roots.length ? <p className="acms-empty-goal">{emptyNote ?? '当前没有需要显示的任务。'}</p> : <ul className="acms-task-tree" aria-label="任务与子任务">{shown.map(task => branch(task))}</ul>}
    {roots.length > MAX_TASKS && <button type="button" className="text acms-more" aria-expanded={showAll} onClick={() => { listOpen.set(`tasks:${listKey}`, !showAll); bump(); }}>{showAll ? `收起任务列表（共 ${roots.length} 项）` : `显示全部 ${roots.length} 项任务`}</button>}
    {roots.length > MAX_TASKS && !showAll && <p className="acms-sectionnote">当前显示 {shown.length} / {roots.length} 项；展开后代可查看子任务。</p>}
  </>;
}

export function CompletedGoals({ data, navigate, onGoal, query: initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery); const [status, setStatus] = useState('');
  const goals = orderByActivity(data.goals.filter(goal => isCompleted(goal) && (!status || goal.status === status) && `${goal.title} ${goal.description ?? ''}`.toLowerCase().includes(query.toLowerCase())));
  return <section className="acms-panel acms-completed" aria-label="已完成目标">
    <div className="acms-sectionhead"><h2>已完成目标</h2><span className="acms-count">{goals.length}</span></div>
    <div className="acms-toolbar"><input aria-label="搜索已完成目标" placeholder="搜索已完成目标…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="筛选目标完成状态" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部完成状态</option><option value="succeeded">完成</option><option value="archived">归档</option><option value="cancelled">取消</option></select></div>
    {!goals.length ? <p className="acms-sectionnote">没有匹配的已完成目标。完成或归档的目标会出现在这里，历史任务与产物仍可查看。</p> : <div className="acms-completed-list">{goals.map(goal => {
      const project = data.projects.find(item => item.id === goal.projectId); const tasks = data.tasks.filter(task => task.goalId === goal.id && task.status !== 'deleted');
      return <div className="acms-completed-row" key={goal.id}>
        <div><button className="text" onClick={() => navigate?.('goal', goal.id)}>{goal.title}</button><small>{project?.name ?? '未知项目'} · {tasks.length} 项任务</small></div>
        <Badge status={goal.status} />
        <time className="acms-muted">{goal.activityAt ? new Date(goal.activityAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</time>
        {onGoal && <button className="text" onClick={() => onGoal(goal.projectId, goal.id, { completed: true })}>查看任务 ↗</button>}
      </div>;
    })}</div>}
  </section>;
}

function Badge({ status }) { return <span className="acms-badge" data-status={status}>{statuses[status] ?? status}</span>; }

export function ProjectHierarchy({ data, select, open, onGoal, navigate, projectId = '', goalId = '', tasks = data.tasks }) {
  const bump = useBump();
  // Current view = every unfinished task plus completed ancestors needed to
  // discover it. Completed branches with open descendants stay expandable.
  const scopedTasks = activeViewTasks(tasks.filter(visibleTask));
  const projects = orderByActivity(data.projects.filter(p => (!projectId || p.id === projectId) && p.status !== 'deleted'));
  const goalsOf = project => orderByActivity(data.goals.filter(g => g.projectId === project.id && (!goalId || g.id === goalId) && goalVisibleInActiveView(g, scopedTasks)));
  const toggleDetails = (key, value) => { detailsOpen.set(key, value); bump(); };
  const toggleList = (key, value) => { listOpen.set(key, value); bump(); };
  return <div className="acms-project-tree" aria-label="项目目标层级">{projects.map(project => {
    const goals = goalsOf(project); const key = `project:${project.id}`; const isOpen = detailsOpen.get(key) === true;
    const listKey = `project-goals:${project.id}`; const showAll = listOpen.get(listKey) === true; const shownGoals = showAll ? goals : goals.slice(0, MAX_GOALS);
    return <details className="acms-project-group" key={project.id} open={isOpen} onToggle={event => toggleDetails(key, event.currentTarget.open)}>
      <summary><span className="acms-level-tag">项目</span>{navigate ? <button className="text acms-entity-title" onClick={event => { event.preventDefault(); navigate('project', project.id); }}>{project.name}</button> : <strong>{project.name}</strong>}<span>{goals.length} 个目标 · {scopedTasks.filter(task => task.projectId === project.id).length} 项任务</span></summary>
      <p className="acms-project-directory">{project.repoRoot}</p>
      {open && <div className="acms-actions"><button className="text" onClick={() => open('project', project)}>编辑项目</button><button className="text" onClick={() => open('goal', { projectId: project.id })}>＋ 添加目标</button></div>}
      {!goals.length && <p className="acms-sectionnote">这个项目当前没有进行中的目标；已完成目标在“已完成”列表中查看。</p>}
      {shownGoals.map(goal => {
        const goalKey = `goal:${goal.id}`; const goalOpen = detailsOpen.get(goalKey) === true;
        const goalTasks = scopedTasks.filter(task => task.goalId === goal.id);
        const all = data.tasks.filter(task => task.goalId === goal.id && task.status !== 'deleted');
        const rollup = goalSummary(goal, all);
        const openDescendants = goalTasks.filter(task => !isCompleted(task)).length;
        return <details className="acms-goal-group" key={goal.id} open={goalOpen} onToggle={event => toggleDetails(goalKey, event.currentTarget.open)}>
          <summary><span className="acms-level-tag">目标</span>{navigate ? <button className="text acms-entity-title" onClick={event => { event.preventDefault(); navigate('goal', goal.id); }}>{goal.title}</button> : <strong>{goal.title}</strong>}<span>{statuses[rollup.status] ?? rollup.status} · {rollup.done}/{rollup.total} 项完成{goalTasks.length ? ` · 显示 ${goalTasks.length} 项` : ''}</span>{isCompleted(goal) && openDescendants > 0 && <em className="acms-tag">已完成 · 含未完成后代</em>}{goal.contractChange?.status === 'pending' && <em className="acms-tag">合同 v{goal.contractVersion} 待确认</em>}{goal.reviewSummary?.status === 'cancelled' && <em className="acms-tag">最终审查已取消</em>}</summary>
          {data.dashboardView ? goalOpen && <ScopedGoalDescription goal={goal} cursor={data.cursor} /> :
            <CollapsibleText text={goal.description} lines={2} label="说明" />}
          <div className="acms-actions">{open && <button className="text" onClick={() => open('goalEdit', goal)}>编辑目标</button>}{onGoal && <button className="text" onClick={() => onGoal(project.id, goal.id)}>查看此目标的任务 →</button>}{open && !['succeeded', 'cancelled', 'archived'].includes(goal.status) && <button className="text" onClick={() => open('task', { goalId: goal.id, projectId: project.id })}>＋ 添加任务</button>}</div>
          <TaskTree tasks={goalTasks} known={data.knownTasks} select={select} listKey={goal.id} createChild={open && !['succeeded', 'cancelled', 'archived'].includes(goal.status) ? task => open('task', { goalId: goal.id, projectId: project.id, parentId: task.id }) : null} emptyNote={isCompleted(goal) ? '目标已完成，交付物保留在产物与验收中。' : '目标保留，当前没有进行中的任务（暂无任务）；已完成任务在“已完成”列表中查看。'} />
        </details>;
      })}
      {goals.length > MAX_GOALS && <button type="button" className="text acms-more" aria-expanded={showAll} onClick={() => toggleList(listKey, !showAll)}>{showAll ? `收起目标列表（共 ${goals.length} 个）` : `显示全部 ${goals.length} 个目标`}</button>}
    </details>;
  })}</div>;
}
