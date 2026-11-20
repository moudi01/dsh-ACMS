import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { stableActor } from '../src/core/agent-identity.js';
import { executionOccupancy } from '../src/core/execution-capacity.js';
import { OWNER, SYSTEM } from '../src/core/util.js';
import { createRoutes } from '../src/host/http.js';
import { fixture, until, taskWaitDiagnostics } from './helpers.js';

const allowProjectApproval = (f, planApproval = true) => f.command('project.save', { id: f.project.id, planApproval });
const goalArgs = f => ({ projectId: f.project.id, templateId: f.template.id, title: 'Build sample module',
  description: 'Build and document a sample module', acceptance: 'Module and examples both exist' });
const newGoal = (f, args = {}) => f.command('goal.create', { ...goalArgs(f), ...args });
const tasksOf = (f, goal) => f.store.list('tasks').filter(task => task.goalId === goal.id);
const planner = (f, goal) => f.store.require('tasks', goal.planApproval.taskId);
const planArgs = (plan, action, reason = 'Checked exact scope and dependencies') => ({
  planId: plan.id, fingerprint: plan.fingerprint, generation: plan.generation, goalContractVersion: plan.goalContractVersion, action, reason,
});
const propose = async input => input.task.kind === 'plan' ? { ...await defaultSimulation(input),
  minimumOutcome: 'A module with example usage', nonGoals: ['Publishing'], rationale: 'Build in two steps to verify dependencies',
} : defaultSimulation(input);

async function ownerCommand(f, name, args) {
  const endpoint = '/api/acms/command';
  const route = createRoutes(f).find(item => item.path === endpoint);
  const response = await route.fetch(new Request(`http://127.0.0.1${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), name, args }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  return body.value;
}

function waitForProposal(f, goal, generation = 1) {
  const diagnostics = taskWaitDiagnostics(f, goal.planApproval.taskId);
  return until(() => {
    const root = planner(f, goal);
    const plan = f.store.get('plans', `${root.id}:g${generation}`);
    const attempt = plan && f.store.require('attempts', plan.attemptId);
    assert(!['cancelled', 'failed'].includes(root.status) && !(root.status === 'blocked' && root.blocker?.kind !== 'plan-approval'),
      JSON.stringify({ ...diagnostics(), summary: root.summary, feedback: root.feedback, error: f.engine.lastError }));
    return plan?.approvalStatus === 'pending' && attempt?.resultAccepted && !attempt.cleanupPending && plan;
  }, 45000, diagnostics);
}

test('an owner approves the exact pending plan once and downstream work is dispatched in dependency order', async t => {
  const f = await fixture(t, propose);
  f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
  allowProjectApproval(f);
  const goal = newGoal(f);
  const root = planner(f, goal);
  const manager = { kind: 'agent', id: root.agentId, goalId: goal.id };
  const held = f.task({ goalId: goal.id, title: 'Owner-added work' });
  assert.throws(() => f.command('task.create', { goalId: goal.id, title: 'Early dispatch' }, manager), { code: 'PLAN_APPROVAL_REQUIRED' });
  assert.throws(() => f.command('task.retry', { id: held.id }, manager), { code: 'PLAN_APPROVAL_REQUIRED' });
  await f.start();
  const pending = await waitForProposal(f, goal);
  assert.equal(planner(f, goal).blocker.planId, pending.id);
  await until(() => executionOccupancy(f.store, f.adapter, f.engine.live).used === 0, 45000, taskWaitDiagnostics(f, root.id));
  assert.deepEqual(pending.nodes, []);
  assert.deepEqual(pending.scope, { minimumOutcome: 'A module with example usage', nonGoals: ['Publishing'] });
  assert.deepEqual(pending.proposalTasks.map(node => [node.key, node.dependencies]), [['deliver', []], ['handoff', ['deliver']]]);
  assert.deepEqual(tasksOf(f, goal).map(task => task.id).sort(), [root.id, held.id].sort());
  assert.equal(f.engine.claim(held, f.store.require('agents', held.agentId)), null);
  const unrelated = f.task({ title: 'Work on unrelated goal' });
  f.engine.kick();
  await until(() => f.store.require('tasks', unrelated.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, unrelated.id));
  assert.deepEqual(f.adapter.calls.filter(call => call.task.goalId === goal.id).map(call => call.task.kind), ['plan']);

  const approval = planArgs(pending, 'approve');
  assert.throws(() => f.command('plan.approval.decide', approval, manager), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('plan.approval.decide', approval, SYSTEM), { code: 'OWNER_REQUIRED' });
  assert.throws(() => f.command('plan.approval.decide', { ...approval, fingerprint: 'another-version' }), { code: 'STALE_PLAN_APPROVAL' });
  const first = f.command('plan.approval.decide', approval, OWNER, 'approve-plan-once');
  assert.equal(first.approvalStatus, 'approved');
  assert.equal(f.store.require('goals', goal.id).planApproval.approvedPlanId, pending.id);
  assert.deepEqual(f.command('plan.approval.decide', approval, OWNER, 'approve-plan-once'), first);
  assert.deepEqual(f.command('plan.approval.decide', approval).nodes, first.nodes);
  assert.throws(() => f.command('plan.approval.decide', { ...approval, reason: 'Change owner audit' }), { code: 'CONFLICT' });
  const [deliver, handoff] = first.nodes.map(node => f.store.require('tasks', node.taskId));
  assert.deepEqual(handoff.dependencies, [deliver.id]);
  assert.equal(tasksOf(f, goal).length, 4);
  f.engine.kick();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, handoff.id));
  const calls = f.adapter.calls.map(call => call.task.id);
  assert(calls.indexOf(deliver.id) < calls.indexOf(handoff.id));
  const scoped = f.store.pageScoped({ goalIds: [goal.id], after: 0, limit: 200 }).entries;
  assert.equal(scoped.filter(event => event.type === 'plan.approval.proposed' && event.decision?.kind === 'manager-proposal').length, 1);
  assert.equal(scoped.filter(event => event.type === 'plan.approval.decided' && event.decision?.reason === approval.reason).length, 1);
});

test('a rejected published-template plan survives restart and only its new generation can dispatch', async t => {
  const submittedPrompts = [];
  const f = await fixture(t, async input => {
    if (input.task.kind === 'plan') submittedPrompts.push(input.prompt);
    return propose(input);
  });
  f.command('workflow.publish', { id: f.template.id, name: f.template.name, phases: f.template.phases, planApproval: true });
  const goal = newGoal(f);
  assert.equal(goal.planApproval.template, true);
  assert.equal(goal.planApproval.project, false);
  const manual = newGoal(f, { plan: false });
  assert.equal(manual.planApproval, undefined);
  f.command('workflow.publish', { id: f.template.id, name: f.template.name, phases: f.template.phases, planApproval: false });
  const automatic = newGoal(f);
  assert.equal(automatic.planApproval, undefined);
  await f.start();
  const first = await waitForProposal(f, goal);
  const rejection = planArgs(first, 'reject', 'The consumer example is missing from the proposed scope');
  assert.equal(f.command('plan.approval.decide', rejection).approvalStatus, 'rejected');
  await f.engine.stop();
  await f.engine.start();
  assert.equal(f.command('plan.approval.decide', rejection).ownerDecision.reason, rejection.reason);
  assert.throws(() => f.command('plan.approval.decide', planArgs(first, 'approve')), { code: 'STALE_PLAN_APPROVAL' });
  assert.throws(() => f.command('task.retry', { id: planner(f, goal).id }), { code: 'PLAN_APPROVAL_REQUIRED' });
  assert.equal(tasksOf(f, goal).length, 1);
  f.command('goal.pause', { id: goal.id });
  const revision = planArgs(first, 'revise', 'Include a consumer example');
  assert.throws(() => f.command('plan.approval.decide', revision), { code: 'GOAL_PAUSED' });
  f.command('goal.resume', { id: goal.id });
  const returned = f.command('plan.approval.decide', revision);
  assert.equal(returned.ownerDecision.reason, rejection.reason);
  assert.equal(returned.revisionRequest.reason, revision.reason);
  f.engine.kick();
  const second = await waitForProposal(f, goal, 2);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(submittedPrompts.some(prompt => JSON.stringify(prompt).includes(revision.reason)), true);
  assert.throws(() => f.command('plan.approval.decide', planArgs(first, 'approve')), { code: 'STALE_PLAN_APPROVAL' });
  f.command('plan.approval.decide', planArgs(second, 'approve'));
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, planner(f, goal).id));
  await until(() => f.store.require('goals', automatic.id).status === 'succeeded', 45000);
  assert(f.store.list('plans').some(plan => plan.goalId === automatic.id && plan.acceptedAt && plan.approvalStatus === undefined));
});

test('capacity and interrupted cleanup leave approval and the entire assignment mapping unchanged', async t => {
  const f = await fixture(t, propose);
  const releaseDisposal = Promise.withResolvers();
  const start = f.adapter.start.bind(f.adapter);
  f.adapter.start = async input => {
    const activation = await start(input);
    return { ...activation, dispose: async () => { await releaseDisposal.promise; await activation.dispose(); } };
  };
  allowProjectApproval(f);
  const goal = newGoal(f);
  const root = planner(f, goal);
  await f.start();
  try {
    await until(() => {
      const attempt = f.store.get('attempts', planner(f, goal).activeAttemptId);
      return !!attempt?.cleanupPending;
    }, 45000, taskWaitDiagnostics(f, root.id));
    const pending = f.store.get('plans', `${root.id}:g1`);
    assert.equal(pending.approvalStatus, 'pending');
    assert.throws(() => f.command('plan.approval.decide', planArgs(pending, 'approve')), { code: 'PLAN_CLEANUP_PENDING' });
    assert.equal(tasksOf(f, goal).length, 1);
  } finally { releaseDisposal.resolve(); }
  const pending = await waitForProposal(f, goal);
  f.command('policy.update', { patch: { maxTasksPerGoal: 2 } });
  const before = f.store.list('agents');
  assert.throws(() => f.command('plan.approval.decide', planArgs(pending, 'approve')), { code: 'TASK_LIMIT' });
  assert.equal(f.store.require('goals', goal.id).planApproval.approvedPlanId, undefined);
  assert.equal(f.store.require('plans', pending.id).approvalStatus, 'pending');
  assert.equal(tasksOf(f, goal).length, 1);
  assert.deepEqual(f.store.list('agents'), before);
  f.command('policy.update', { patch: { maxTasksPerGoal: 3 } });
  assert.equal(f.command('plan.approval.decide', planArgs(pending, 'approve')).nodes.length, 2);
});

test('updating a pending goal contract requires a new plan without separate implementation coordination', async t => {
  const coordinationWork = 'Implementation outside the new plan';
  const f = await fixture(t, async input => input.task.origin?.kind === 'goal-contract' ? {
    outcome: 'planned', summary: 'Separate follow-up', tasks: [{ key: 'extra', title: coordinationWork }],
  } : propose(input));
  allowProjectApproval(f);
  const goal = newGoal(f);
  await f.start();
  const first = await waitForProposal(f, goal);
  f.command('task.pause', { id: first.taskId });
  assert.throws(() => f.command('plan.approval.decide', planArgs(first, 'approve')), { code: 'STALE_PLAN_APPROVAL' });
  assert.equal(f.command('task.resume', { id: first.taskId }).status, 'blocked');
  assert.throws(() => f.command('task.cancel', { id: first.taskId }), { code: 'PLAN_APPROVAL_REQUIRED' });
  allowProjectApproval(f, false);
  f.command('policy.update', { patch: { maxTasksPerGoal: 1 } });
  const amended = await ownerCommand(f, 'goal.edit', { id: goal.id, patch: { acceptance: 'Add a consumer example to the updated contract' } });
  assert.equal(amended.contractChange, null);
  assert.equal(f.store.require('plans', first.id).approvalStatus, 'superseded');
  assert.throws(() => f.command('plan.approval.decide', planArgs(first, 'approve')), { code: 'STALE_PLAN_APPROVAL' });
  for (const kind of ['work', 'repair']) {
    assert.throws(() => f.company.createTask({ goalId: goal.id, kind, title: coordinationWork }, SYSTEM, { trustedOrigin: true }),
      { code: 'PLAN_APPROVAL_REQUIRED' });
  }
  f.engine.kick();
  const second = await waitForProposal(f, goal, 2);
  assert.equal(second.goalContractVersion, 2);
  assert.equal(planner(f, goal).acceptance, 'Add a consumer example to the updated contract');
  const returned = f.command('plan.approval.decide', planArgs(second, 'revise', 'Narrow scope before starting work'));
  assert.equal(returned.approvalStatus, 'returned');
  f.engine.kick();
  const third = await waitForProposal(f, goal, 3);
  f.command('policy.update', { patch: { maxTasksPerGoal: 3 } });
  const approved = await ownerCommand(f, 'plan.approval.decide', planArgs(third, 'approve'));
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, first.taskId));
  const plannedIds = approved.nodes.map(node => node.taskId);
  assert.deepEqual(f.adapter.calls.filter(call => call.task.goalId === goal.id && call.task.kind !== 'plan').map(call => call.task.id), plannedIds);
  assert.deepEqual(tasksOf(f, goal).filter(task => task.kind === 'work').map(task => task.id), plannedIds);
  assert.equal(tasksOf(f, goal).some(task => task.title === coordinationWork || task.kind === 'coordination'), false);
});

for (const kind of ['goal', 'project']) {
  test(`the owner can still decide a cleaned proposal after ${kind} trash restoration`, async t => {
    const f = await fixture(t, propose);
    allowProjectApproval(f);
    const goal = newGoal(f);
    await f.start();
    const pending = await waitForProposal(f, goal);
    const entityId = kind === 'goal' ? goal.id : f.project.id;
    const removed = await ownerCommand(f, `${kind}.delete`, { id: entityId });
    await ownerCommand(f, `${kind}.restore`, { id: entityId, expectedRevision: removed.revision });
    const restored = planner(f, goal);
    assert.equal(restored.status, 'paused');
    assert.equal(restored.activeAttemptId, null);
    const resumed = await ownerCommand(f, 'task.resume', { id: restored.id });
    assert.equal(resumed.status, 'blocked');
    assert.equal(resumed.blocker.planId, pending.id);
    if (kind === 'project') {
      const rejected = await ownerCommand(f, 'plan.approval.decide', planArgs(pending, 'reject', 'Need a narrower example'));
      assert.equal(rejected.approvalStatus, 'rejected');
      const revised = await ownerCommand(f, 'plan.approval.decide', planArgs(pending, 'revise', 'Provide a smaller example'));
      assert.equal(revised.revisionRequest.action, 'revise');
      const next = await waitForProposal(f, goal, 2);
      await ownerCommand(f, 'goal.cancel', { id: goal.id });
      assert.equal(f.store.require('plans', next.id).approvalStatus, 'superseded');
      assert.throws(() => f.command('plan.approval.decide', planArgs(next, 'approve')), { code: 'GOAL_CLOSED' });
      assert.equal(tasksOf(f, goal).filter(task => task.kind === 'work').length, 0);
    } else {
      const approved = await ownerCommand(f, 'plan.approval.decide', planArgs(pending, 'approve'));
      const repeat = await ownerCommand(f, 'plan.approval.decide', planArgs(pending, 'approve'));
      assert.deepEqual(repeat.nodes, approved.nodes);
      await until(() => f.store.require('goals', goal.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, restored.id));
      assert.equal(f.adapter.calls.filter(call => call.task.id === restored.id).length, 1);
    }
  });
}

test('a contract edit after approval uses the existing delivered-work assessment', async t => {
  let deliveredIds;
  const f = await fixture(t, input => input.task.origin?.kind === 'goal-contract' ? {
    outcome: 'coordinated', summary: 'Reuse verified deliveries',
    contractAssessment: { reason: 'The verified files already meet the latest requirement', reuse: deliveredIds, followUps: [] },
  } : propose(input));
  allowProjectApproval(f);
  const goal = newGoal(f);
  await f.start();
  const plan = await waitForProposal(f, goal);
  const approved = await ownerCommand(f, 'plan.approval.decide', planArgs(plan, 'approve'));
  deliveredIds = approved.nodes.map(node => node.taskId);
  const finished = () => f.store.require('goals', goal.id).status === 'succeeded';
  await until(finished, 45000, taskWaitDiagnostics(f, plan.taskId));
  const edited = await ownerCommand(f, 'goal.edit', { id: goal.id, patch: { acceptance: 'Keep the testable usage example' } });
  assert.equal(edited.contractChange.status, 'pending');
  assert(edited.contractChange.coordinationTaskId);
  await until(finished, 45000, taskWaitDiagnostics(f, edited.contractChange.coordinationTaskId));
  const current = f.store.require('goals', goal.id);
  assert.equal(current.contractChange.status, 'assessed');
  assert.equal(current.planApproval.approvedPlanId, plan.id);
  assert.equal(f.store.require('plans', plan.id).goalAcceptance, goal.acceptance);
  assert.equal(f.adapter.calls.filter(call => call.task.id === plan.taskId).length, 1);
});

test('approval rechecks the manager grant and preserves the existing execution budget', async t => {
  const f = await fixture(t, propose);
  allowProjectApproval(f);
  const goal = newGoal(f);
  await f.start();
  const plan = await waitForProposal(f, goal);
  const manager = f.store.require('agents', plan.managerId);
  f.command('agent.save', { id: manager.id, grants: manager.grants.filter(grant => grant !== 'task.create') });
  assert.throws(() => f.command('plan.approval.decide', planArgs(plan, 'approve')), { code: 'FORBIDDEN' });
  assert.equal(f.store.require('plans', plan.id).approvalStatus, 'pending');
  assert.equal(tasksOf(f, goal).length, 1);
  f.command('agent.save', { id: manager.id, grants: manager.grants });

  const saved = f.store.require('goals', goal.id);
  f.store.transaction(() => f.store.put('goals', { ...saved, runtimeMs: f.company.policy().maxGoalRuntimeMs }));
  const approved = f.command('plan.approval.decide', planArgs(plan, 'approve'));
  const first = approved.nodes[0].taskId;
  f.engine.kick();
  await until(() => f.store.require('tasks', first).blocker?.kind === 'budget', 45000, taskWaitDiagnostics(f, first));
  assert.equal(f.adapter.calls.some(call => call.task.id === first), false);
  f.command('goal.runtime.extend', { id: goal.id, expectedRevision: f.store.require('goals', goal.id).revision, additionalRuntimeMs: 60000 });
  f.engine.kick();
  await until(() => f.store.require('goals', goal.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, first));
});

test('planning result management actions and non-manager legacy decomposition cannot bypass the root approval', async t => {
  const f = await fixture(t, async input => input.task.kind === 'plan' ? { ...await propose(input),
    ...(input.attempt.role === 'manager' ? { actions: [{ command: 'task.create', args: { goalId: input.task.goalId, title: 'Bypass' } }] }
      : { outcome: 'decomposed' }),
  } : defaultSimulation(input));
  allowProjectApproval(f);
  f.command('policy.update', { patch: { maxAttempts: 1 } });
  const managed = newGoal(f, { title: 'Manager action bypass' });
  const legacy = newGoal(f, { title: 'Legacy worker bypass' });
  const worker = f.command('agent.save', { name: 'Worker', role: 'worker', provider: 'simulation' });
  const legacyRoot = planner(f, legacy);
  f.command('task.edit', { id: legacyRoot.id, patch: { agentId: worker.id } });
  await f.start();
  for (const goal of [managed, legacy]) {
    const root = planner(f, goal);
    const failed = await until(() => f.store.list('attempts').find(attempt => attempt.taskId === root.id && attempt.status === 'failed'),
      45000, taskWaitDiagnostics(f, root.id));
    assert.match(failed.summary, goal === managed ? /等待所有者批准/ : /Only a manager/);
    assert.equal(tasksOf(f, goal).filter(task => ['work', 'repair'].includes(task.kind)).length, 0);
  }
  assert.equal(f.store.list('plans').length, 0);
  assert.equal(f.store.list('actionBatches').length, 0);
});

test('only the owner can opt into manual work on a project requiring plan approval', async t => {
  const f = await fixture(t);
  assert.equal(f.project.planApproval, undefined);
  assert.equal(f.template.planApproval, undefined);
  assert.equal(f.goal.planApproval, undefined);
  allowProjectApproval(f);
  const { credential } = f.command('agentCredential.create', { name: 'Goal submitter', projectIds: [f.project.id], commands: ['goal.submit'] });
  const caller = stableActor(credential);
  assert.throws(() => f.command('goal.submit', { ...goalArgs(f), plan: false }, caller), { code: 'OWNER_REQUIRED' });
  const submitted = f.command('goal.submit', goalArgs(f), caller);
  assert.equal(f.store.require('goals', submitted.goalId).planApproval.taskId, submitted.planTaskId);
  const manual = newGoal(f, { plan: false });
  assert.equal(manual.planApproval, undefined);
  const work = f.task({ goalId: manual.id });
  await f.start();
  await until(() => f.store.require('tasks', work.id).status === 'succeeded', 45000, taskWaitDiagnostics(f, work.id));
});
