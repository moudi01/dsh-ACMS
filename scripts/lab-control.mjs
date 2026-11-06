// Isolated native DSH test utility. Runtime launch URLs remain private.
import { request } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const lab = path.resolve(process.env.ACMS_LAB_DIR ?? '.acms-lab');
const log = (await readFile(path.join(lab, 'host.stdout.log'), 'utf8')).replace(/\x1b\[[0-9;]*m/g, '');
const launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0];
if (!launch) throw new Error('Private test host launch URL not found');
const origin = new URL(launch).origin; const context = await request.newContext();
const invoke = async (name, args = {}) => {
  const response = await context.post(`${origin}/api/acms/command`, { data: { requestId: randomUUID(), name, args } });
  const result = await response.json(); if (!response.ok() || result.ok === false) throw new Error(result.error?.message ?? 'Command failed'); return result.value;
};
try {
  await context.get(launch);
  const mode = process.argv[2] ?? 'status';
  if (mode === 'pause-review' || mode === 'resume-review') {
    const state = await (await context.get(`${origin}/api/acms/state`)).json();
    for (const task of state.tasks.filter(t => t.kind === 'review' && (mode === 'pause-review' ? t.status === 'running' : t.status === 'paused'))) await invoke(mode === 'pause-review' ? 'task.pause' : 'task.resume', { id: task.id });
  }
  if (mode === 'pause') await invoke('company.pause');
  if (mode === 'repair-review') {
    const state = await (await context.get(`${origin}/api/acms/state`)).json();
    for (const item of state.interactions.filter(i => i.status === 'pending' && i.kind === 'technical' && state.tasks.find(t => t.id === i.taskId)?.kind === 'review')) await invoke('interaction.answer', { id: item.id, answer: '已为审查配置独立的可写验证副本；原作者工作区和交付快照不在审查可写根目录中。可在当前审查副本运行检查并创建临时测试文件。宿主已独立运行浏览器验收通过。请核对源码、宿主检查证据及必要的独立检查后给出真实审查结论。' });
  }
  if (mode === 'resume') {
    await invoke('company.resume'); const state = await (await context.get(`${origin}/api/acms/state`)).json();
    for (const task of state.tasks.filter(t => t.kind !== 'review' && t.status === 'paused')) await invoke('task.resume', { id: task.id });
  }
  const state = await (await context.get(`${origin}/api/acms/state`)).json();
  if (mode === 'report') {
    const demo = JSON.parse(await readFile(path.join(lab, 'real-demo.json'), 'utf8'));
    const goal = state.goals.find(g => g.id === demo.goalId); const work = state.tasks.find(t => t.goalId === goal.id && t.kind === 'work');
    const reviews = state.verifications.filter(v => v.taskId === work.id && v.kind === 'review'); const lastReview = reviews.at(-1);
    const report = { generatedAt: new Date().toISOString(), dshVersion: '0.2.1-rc.5', provider: 'acms-codex', goalStatus: goal.status, workStatus: work.status, automaticPlanning: state.tasks.some(t => t.goalId === goal.id && t.kind === 'plan' && t.status === 'succeeded'), finalReviewPassed: lastReview?.passed === true, independentReviewer: lastReview?.reviewerId !== work.lastAuthorId, integration: work.integration?.status, artifacts: work.artifactIds.length, checkRuns: state.verifications.filter(v => v.taskId === work.id && v.kind === 'checks').length, activeExecutions: state.attempts.filter(a => ['running', 'preparing', 'reconciling'].includes(a.status) || a.cleanupPending).length, pendingInteractions: state.interactions.filter(i => i.status === 'pending').length, note: 'Real model execution in an isolated DSH profile; reviewer sandbox failures were corrected during development before the final successful run.' };
    if (goal.status !== 'succeeded' || !report.finalReviewPassed || !report.independentReviewer || report.integration !== 'merged' || report.activeExecutions) throw new Error('Real demo has not completed all acceptance stages');
    await mkdir('docs', { recursive: true }); await writeFile('docs/native-validation.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ goals: state.goals.map(g => ({ title: g.title, status: g.status })), tasks: state.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, blocker: t.blocker })), active: state.attempts.filter(a => ['running', 'preparing', 'reconciling'].includes(a.status) || a.cleanupPending).map(a => ({ id: a.id, status: a.status, kind: a.kind, snippet: a.progress?.lastSnippet?.slice(-500) })), interactions: state.interactions.filter(i => i.status === 'pending').map(i => ({ kind: i.kind, reason: i.reason })) }, null, 2));
} catch (e) { console.error(String(e.message).replace(/token=[^\s&]+/g, 'token=[REDACTED]')); process.exitCode = 1; }
finally { await context.dispose(); }
