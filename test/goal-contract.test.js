import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { Store } from '../src/core/store.js';
import { Company } from '../src/core/domain.js';
import { Engine } from '../src/runtime/engine.js';
import { OWNER } from '../src/core/util.js';
import { defaultSimulation } from '../src/adapters/simulated.js';

const assessment = (reason, reuse = [], followUps = []) => ({ reason, reuse, followUps });
const completed = (f, goalId) => until(() => f.store.require('goals', goalId).status === 'succeeded');
const contractTasks = (f, goalId) => f.store.list('tasks').filter(task => task.goalId === goalId && task.origin?.kind === 'goal-contract');

test('in-memory legacy delivery keeps its title-only approval and requires one assessment after an acceptance edit', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const company = new Company(store);
  const command = (name, args, requestId = randomUUID()) => company.command(OWNER, requestId, name, args);
  const project = command('project.save', { name: 'Fixture', repoRoot: process.cwd(), mode: 'copy' });
  const template = command('workflow.publish', { name: 'Direct', phases: [{ id: 'execute', name: 'Execute' }] });
  const goal = command('goal.create', { title: 'Goal', description: 'Deliver', acceptance: 'Deliver one file', projectId: project.id, templateId: template.id, plan: false });
  const task = command('task.create', { goalId: goal.id, title: 'Deliver' });
  store.transaction(() => {
    store.put('tasks', { ...task, status: 'succeeded', goalContractVersion: undefined, artifactHash: 'legacy-artifact' });
    store.put('goals', { ...goal, status: 'succeeded', contractVersion: undefined });
  });
  const oldHash = company.deliveryHash(goal.id);
  const oldTask = store.require('tasks', task.id);
  command('goal.edit', { id: goal.id, patch: { title: 'Renamed' } });
  assert.equal(company.deliveryHash(goal.id), oldHash);
  assert.equal(store.require('goals', goal.id).status, 'succeeded');

  const edit = { id: goal.id, patch: { acceptance: 'Verify the contents of the file' } };
  const updated = command('goal.edit', edit, 'same-edit');
  assert.equal(updated.status, 'active');
  assert.equal(updated.contractVersion, 2);
  assert.equal(updated.completedContractVersion, 1);
  assert.equal(updated.completedDeliveryHash, oldHash);
  assert.notEqual(company.deliveryHash(goal.id), oldHash);
  assert.deepEqual(store.require('tasks', task.id), oldTask);
  assert.deepEqual(command('goal.edit', edit, 'same-edit'), updated);
  assert.equal(command('goal.edit', edit).contractChange.coordinationTaskId, updated.contractChange.coordinationTaskId);
  assert.equal(contractTasks({ store }, goal.id).length, 1);
  assert.throws(() => command('review.request', { goalId: goal.id }), { code: 'CONTRACT_PENDING' });

  const engine = new Engine(company, {}, {});
  engine.epoch = store.acquireLease(engine.owner);
  const coordination = store.require('tasks', updated.contractChange.coordinationTaskId);
  const attempt = engine.claim(coordination, store.require('agents', coordination.agentId));
  const signal = new AbortController().signal;
  await assert.rejects(engine.accept(attempt, { outcome: 'coordinated', summary: 'No evidence' }, signal), { code: 'INVALID_CONTRACT_ASSESSMENT' });
  assert.equal(store.require('goals', goal.id).status, 'active');
  await engine.accept(attempt, { outcome: 'coordinated', contractAssessment: assessment('Existing file already contains the required evidence', [task.id]) }, signal);
  assert.equal(store.require('goals', goal.id).completedContractVersion, 2);
  assert.equal(store.list('tasks').filter(row => row.kind === 'review').length, 0);
  assert.deepEqual(store.require('tasks', task.id), oldTask);
});

test('replacement plan covers affected dependencies and a new final review uses only current deliverables', async t => {
  let upstream, downstream, independent;
  const f = await fixture(t, async input => {
    if (input.task.origin?.kind !== 'goal-contract') return defaultSimulation(input);
    const contract = JSON.parse(input.prompt.split('CONTRACT:\n')[1]);
    assert.deepEqual(contract.goalContractChange.priorDeliverables.find(item => item.id === downstream.id).dependencies, [upstream.id]);
    return { outcome: 'planned', rationale: 'One task can update both dependent deliverables',
      tasks: [{ key: 'fix', title: 'Update both deliverables', description: 'Apply the revised acceptance', acceptance: 'Both requirements are satisfied' }],
      contractAssessment: assessment('Retain the independent deliverable and replace the two affected outputs', [independent.id],
        [{ taskId: upstream.id, followUp: 'fix' }, { taskId: downstream.id, followUp: 'fix' }]) };
  });
  const goal = f.command('goal.create', { title: 'Reviewed goal', description: 'Deliver three files', acceptance: 'Original acceptance', projectId: f.project.id, plan: false });
  upstream = f.task({ goalId: goal.id, title: 'Upstream' });
  downstream = f.task({ goalId: goal.id, title: 'Dependent', dependencies: [upstream.id] });
  independent = f.task({ goalId: goal.id, title: 'Independent' });
  await f.start();
  await completed(f, goal.id);
  const firstReview = f.company.latestGoalReview(goal.id);
  const oldEvidence = f.store.list('verifications').find(row => row.kind === 'goal-review' && row.taskId === goal.id);
  const oldIndependent = f.store.require('tasks', independent.id);
  f.command('goal.edit', { id: goal.id, patch: { title: 'Renamed reviewed goal' } });
  assert.deepEqual(f.company.latestGoalReview(goal.id), firstReview);
  assert.equal(f.store.require('goals', goal.id).status, 'succeeded');
  f.command('goal.edit', { id: goal.id, patch: { acceptance: 'Revised acceptance' } });
  assert.equal(f.store.require('goals', goal.id).status, 'active');
  await completed(f, goal.id);
  const updated = f.store.require('goals', goal.id);
  const nextReview = f.company.latestGoalReview(goal.id);
  const replacementId = updated.contractChange.decision.followUps[0].followUpTaskId;
  assert.equal(updated.completedContractVersion, 2);
  assert.deepEqual(updated.supersededTaskIds, [upstream.id, downstream.id]);
  assert.deepEqual(nextReview.reviewTargets.map(row => row.id).sort(), [independent.id, replacementId].sort());
  assert.equal(nextReview.goalContractVersion, 2);
  assert.notEqual(nextReview.deliveryHash, firstReview.deliveryHash);
  assert.deepEqual(f.store.require('verifications', oldEvidence.id), oldEvidence);
  assert.deepEqual(f.store.require('tasks', independent.id), oldIndependent);
  assert.equal(f.adapter.calls.filter(call => call.task.kind === 'work').length, 4);
  assert.equal(f.adapter.calls.filter(call => call.task.kind === 'review').length, 2);

  const currentApproval = f.store.list('verifications').find(row => row.kind === 'goal-review' && row.artifactHash === nextReview.deliveryHash);
  const author = f.command('agent.save', { name: 'Author for the renewed delivery', role: 'worker' });
  f.command('task.edit', { id: upstream.id, patch: { agentId: author.id, acceptance: 'Deliver the newly requested upstream output' } });
  await completed(f, goal.id);
  const renewedReview = f.company.latestGoalReview(goal.id);
  const renewed = f.store.require('tasks', upstream.id);
  assert.equal(renewed.deliveryGeneration, 2);
  assert.equal(renewed.goalContractVersion, 2);
  assert.equal(renewed.artifactHash, firstReview.reviewTargets.find(row => row.id === upstream.id).artifactHash);
  assert.notEqual(renewedReview.id, nextReview.id);
  assert.notEqual(renewedReview.deliveryHash, nextReview.deliveryHash);
  assert.deepEqual(renewedReview.reviewTargets.map(row => row.id).sort(), [upstream.id, independent.id, replacementId].sort());
  assert.deepEqual(f.store.require('verifications', currentApproval.id), currentApproval);
  assert.deepEqual(f.store.require('goals', goal.id).supersededTaskIds, [downstream.id]);
  assert.equal(f.adapter.calls.filter(call => call.task.id === upstream.id).length, 2);
});

test('separate replacements keep their own historical inputs and wait for current upstream work', async t => {
  const f = await fixture(t);
  const upstream = f.task({ title: 'Original upstream' });
  const downstream = f.task({ title: 'Original downstream', dependencies: [upstream.id] });
  await f.start();
  await completed(f, f.goal.id);
  f.command('company.pause', { afterCurrent: true });
  const goal = f.command('goal.edit', { id: f.goal.id, patch: { acceptance: 'Revised dependency output' } });
  const upstreamReplacement = f.task({ title: 'Replace upstream', dependencies: [upstream.id] });
  const downstreamReplacement = f.task({ title: 'Replace downstream', dependencies: [downstream.id, upstream.id] });
  f.command('task.pause', { id: upstreamReplacement.id });
  f.engine.refreshReadiness();
  const coordinator = f.store.require('tasks', goal.contractChange.coordinationTaskId);
  const attempt = f.engine.claim(coordinator, f.store.require('agents', coordinator.agentId));
  const output = { outcome: 'coordinated', contractAssessment: assessment('Update both dependency outputs separately', [], [
    { taskId: upstream.id, followUp: upstreamReplacement.id },
    { taskId: downstream.id, followUp: downstreamReplacement.id },
  ]) };
  const signal = new AbortController().signal;
  await assert.rejects(f.engine.accept(attempt, output, signal), { code: 'INVALID_CONTRACT_ASSESSMENT' });
  assert.equal(f.store.require('goals', goal.id).contractChange.status, 'pending');
  f.command('task.dependencies', { id: downstreamReplacement.id, dependencies: [downstream.id] });
  await assert.rejects(f.engine.accept(attempt, output, signal), { code: 'INVALID_CONTRACT_ASSESSMENT' });
  f.command('task.dependencies', { id: downstreamReplacement.id, dependencies: [downstream.id, upstreamReplacement.id] });
  await f.engine.accept(attempt, output, signal);
  // This direct result fixture has no adapter activation to dispose.
  f.store.transaction(() => f.store.put('attempts', { ...f.store.require('attempts', attempt.id), cleanupPending: false }));
  f.command('company.resume');
  await f.engine.tick();
  assert.equal(f.store.require('tasks', downstreamReplacement.id).status, 'blocked');
  assert.equal(f.store.require('tasks', upstreamReplacement.id).status, 'paused');
  assert(!f.adapter.calls.some(call => call.task.id === downstreamReplacement.id || call.task.id === upstreamReplacement.id));

  f.command('task.resume', { id: upstreamReplacement.id });
  await completed(f, goal.id);
  const input = f.adapter.calls.find(call => call.task.id === downstreamReplacement.id);
  const contract = JSON.parse(input.prompt.split('CONTRACT:\n')[1]);
  const paths = contract.inputArtifacts.map(item => item.path);
  const blob = taskId => f.store.list('artifacts').find(item => item.taskId === taskId).blob;
  assert(paths.includes(blob(upstreamReplacement.id)));
  assert(paths.includes(blob(downstream.id)));
  assert(!paths.includes(blob(upstream.id)));
});

test('queued and running goal reviews cannot approve a later contract', async t => {
  let releaseReview;
  const f = await fixture(t, async input => {
    if (input.task.kind === 'review') {
      await new Promise(resolve => { releaseReview = resolve; });
      return { outcome: 'reviewed', decision: 'approve' };
    }
    return defaultSimulation(input);
  });
  const task = f.task();
  await f.start();
  await completed(f, task.goalId);
  const review = f.command('review.request', { goalId: task.goalId });
  await until(() => releaseReview);
  const oldAttempt = f.store.list('attempts').find(row => row.taskId === review.id);
  f.command('company.pause', { afterCurrent: true });
  const queued = f.command('review.request', { id: task.id });
  f.command('goal.edit', { id: task.goalId, patch: { description: 'A materially different scope' } });
  assert.equal(f.store.require('tasks', queued.id).status, 'cancelled');
  assert(!f.store.list('attempts').some(row => row.taskId === queued.id));
  releaseReview();
  await until(() => f.store.require('tasks', review.id).status === 'cancelled');
  await assert.rejects(f.engine.accept(oldAttempt, { outcome: 'reviewed', decision: 'approve' }, new AbortController().signal), { code: 'STALE_RESULT' });
  assert.equal(f.store.list('verifications').filter(row => row.kind === 'goal-review').length, 0);
  assert.equal(f.company.latestGoalReview(task.goalId), null);
  assert.equal(f.store.require('goals', task.goalId).status, 'active');
  const superseded = contractTasks(f, task.goalId)[0];
  f.command('goal.edit', { id: task.goalId, patch: { description: 'Newer scope' } });
  assert.equal(f.store.require('tasks', superseded.id).status, 'cancelled');
  await f.engine.stop();
  await f.engine.start();
  assert.deepEqual(contractTasks(f, task.goalId).map(row => row.goalContractVersion), [2, 3]);
  assert.equal(f.store.require('goals', task.goalId).contractChange.status, 'pending');
});

test('a planner waiting for model metadata cannot start on an obsolete contract', async t => {
  let plannerPreparing;
  const f = await fixture(t, async input => input.task.origin?.kind === 'goal-contract'
    ? { outcome: 'coordinated', contractAssessment: assessment('Use the existing plan task with the revised requirements') }
    : defaultSimulation(input));
  f.adapter.modelContext = async () => {
    if (!plannerPreparing) await new Promise(resolve => { plannerPreparing = resolve; });
  };
  const goal = f.command('goal.create', { title: 'Plan', description: 'Initial work', acceptance: 'Initial acceptance', projectId: f.project.id, templateId: f.template.id });
  await f.start();
  await until(() => plannerPreparing);
  f.command('goal.edit', { id: goal.id, patch: { acceptance: 'Updated acceptance' } });
  plannerPreparing();
  await completed(f, goal.id);
  const planners = f.adapter.calls.filter(call => call.task.kind === 'plan');
  assert.equal(planners.length, 1);
  assert.equal(planners[0].attempt.goalContractVersion, 2);
  assert.equal(planners[0].task.acceptance, 'Updated acceptance');
  assert.equal(f.store.list('plans')[0].goalContractVersion, 2);
  assert.equal(f.adapter.calls.filter(call => call.task.kind === 'review').length, 0);
});

test('old work finishing checks cannot publish evidence after the goal contract changes', async t => {
  let releaseChecks;
  const f = await fixture(t, async input => input.task.origin?.kind === 'goal-contract'
    ? { outcome: 'coordinated', contractAssessment: assessment('The unfinished task can fulfill the revised acceptance') }
    : defaultSimulation(input));
  const collect = f.workspaces.collect.bind(f.workspaces);
  f.workspaces.collect = async (task, ...args) => {
    if (task.goalContractVersion === 1) await new Promise(resolve => { releaseChecks = resolve; });
    return collect(task, ...args);
  };
  const task = f.task({ acceptance: undefined });
  await f.start();
  await until(() => releaseChecks);
  f.command('goal.edit', { id: task.goalId, patch: { acceptance: 'Verify the revised contents' } });
  releaseChecks();
  await completed(f, task.goalId);
  const verified = f.store.list('verifications').filter(row => row.taskId === task.id);
  assert.deepEqual(verified.map(row => [row.goalContractVersion, row.taskGeneration]), [[2, 2]]);
  assert.equal(f.store.require('tasks', task.id).acceptance, 'Verify the revised contents');
  assert.equal(contractTasks(f, task.goalId).length, 1);
});

test('recovery holds an old generation until cleanup is confirmed and never accepts its result', async t => {
  const f = await fixture(t);
  f.engine.epoch = f.store.acquireLease(f.engine.owner);
  const task = f.task();
  const attempt = f.engine.claim(task, f.store.require('agents', task.agentId));
  f.store.transaction(() => f.store.put('attempts', { ...attempt, provider: 'paired:fixture', status: 'running' }));
  f.command('goal.edit', { id: task.goalId, patch: { description: 'New scope' } });
  let cleanupConfirmed = false;
  f.adapter.reconcile = async () => ({ status: 'completed', cleanupConfirmed, result: { outcome: 'completed' } });
  await f.engine.recover(task.id);
  assert.equal(f.store.require('tasks', task.id).status, 'stopping');
  assert.equal(f.store.require('attempts', attempt.id).cleanupPending, true);
  cleanupConfirmed = true;
  await f.engine.recover(task.id);
  assert.equal(f.store.require('tasks', task.id).status, 'ready');
  assert.equal(f.store.require('attempts', attempt.id).resultAccepted, false);
  assert.equal(f.store.list('verifications').length, 0);
  assert.equal(f.store.require('goals', task.goalId).contractChange.status, 'pending');
});
