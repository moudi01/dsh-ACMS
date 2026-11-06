import React from 'react';
import { goalSummary, taskAncestors, visibleTask } from '../core/hierarchy.js';

const statuses = { ready: '待执行', blocked: '阻塞', running: '执行中', paused: '暂停', cancelled: '取消', succeeded: '完成', planning: '规划中', active: '进行中', empty: '暂无任务', archived: '归档', reviewing: '审查中', failed: '失败' };
export function TaskPath({ task, data, select, navigate }) {
  const project = data.projects.find(p => p.id === task.projectId); const goal = data.goals.find(g => g.id === task.goalId);
  return <nav className="acms-task-path" aria-label="任务归属">{navigate && project ? <button className="text" onClick={() => navigate('project', project.id)}>项目：{project.name}</button> : <span>项目：{project?.name ?? '未知项目'}</span>}{navigate && goal ? <button className="text" onClick={() => navigate('goal', goal.id)}>目标：{goal.title}</button> : <span>目标：{goal?.title ?? '未知目标'}</span>}{taskAncestors(task, data.tasks).map(parent => select ? <button type="button" className="text" key={parent.id} onClick={() => select(parent.id)}>父任务：{parent.title}</button> : <span key={parent.id}>父任务：{parent.title}</span>)}</nav>;
}
export function TaskTree({ tasks, select, createChild }) {
  const visible = tasks.filter(visibleTask); const ids = new Set(visible.map(t => t.id));
  const parent = task => task.reviewOf || task.parentId;
  const branch = (task, seen = new Set()) => {
    if (seen.has(task.id)) return null; const next = new Set([...seen, task.id]); const children = visible.filter(t => parent(t) === task.id);
    return <li key={task.id}><div className="acms-tree-task"><button type="button" onClick={() => select(task.id)}><small>{task.kind === 'review' ? '审查' : task.parentId ? '子任务' : task.kind === 'plan' ? '规划任务' : '任务'}</small><strong>{task.title}</strong><span>{statuses[task.status] ?? task.status}</span></button>{createChild && task.kind !== 'review' && <button className="text" type="button" onClick={() => createChild(task)}>＋ 子任务</button>}</div>{children.length > 0 && <ul>{children.map(t => branch(t, next))}</ul>}</li>;
  };
  return <ul className="acms-task-tree" aria-label="任务与子任务">{visible.filter(t => !ids.has(parent(t))).map(t => branch(t))}</ul>;
}
export function ProjectHierarchy({ data, select, open, onGoal, navigate, projectId = '', goalId = '', tasks = data.tasks }) {
  return <div className="acms-project-tree" aria-label="项目目标层级">{data.projects.filter(p => !projectId || p.id === projectId).map(p => {
    const goals = data.goals.filter(g => g.projectId === p.id && (!goalId || g.id === goalId));
    return <details className="acms-project-group" key={p.id} open><summary><span className="acms-level-tag">项目</span>{navigate ? <button className="text acms-entity-title" onClick={e => { e.preventDefault(); navigate('project', p.id); }}>{p.name}</button> : <strong>{p.name}</strong>}<span>{goals.length} 个目标</span></summary><p className="acms-project-directory">{p.repoRoot}</p>{open && <div className="acms-actions"><button className="text" onClick={() => open('project', p)}>编辑项目</button><button className="text" onClick={() => open('goal', { projectId: p.id })}>＋ 添加目标</button></div>}
      {!goals.length && <p className="acms-sectionnote">这个项目还没有目标。</p>}{goals.map(g => {
        const all = data.tasks.filter(t => t.goalId === g.id && visibleTask(t)); const shown = tasks.filter(t => t.goalId === g.id && visibleTask(t)); const rollup = goalSummary(g, all);
        return <details className="acms-goal-group" key={g.id} open><summary><span className="acms-level-tag">目标</span>{navigate ? <button className="text acms-entity-title" onClick={e => { e.preventDefault(); navigate('goal', g.id); }}>{g.title}</button> : <strong>{g.title}</strong>}<span>{statuses[rollup.status] ?? rollup.status} · {rollup.done}/{rollup.total} 项完成</span></summary><p>{g.description}</p><div className="acms-actions">{open && <button className="text" onClick={() => open('goalEdit', g)}>编辑目标</button>}{onGoal && <button className="text" onClick={() => onGoal(p.id, g.id)}>查看此目标的任务 →</button>}{open && !['succeeded', 'cancelled', 'archived'].includes(g.status) && <button className="text" onClick={() => open('task', { goalId: g.id, projectId: p.id })}>＋ 添加任务</button>}</div>
          {!all.length ? <p className="acms-empty-goal">目标保留，当前没有任务；已删除任务仅在回收站显示。</p> : <TaskTree tasks={shown} select={select} createChild={open && !['succeeded', 'cancelled', 'archived'].includes(g.status) ? task => open('task', { goalId: g.id, projectId: p.id, parentId: task.id }) : null} />}
        </details>;
      })}</details>;
  })}</div>;
}
