import { candidateMergePolicy } from '../core/candidate-confirmation.js';
import { goalDeliveryState } from '../core/composite-delivery.js';
import { checkpointDeliverySources, checkpointObservations, goalCheckpointRows } from '../core/goal-checkpoint-rows.js';
import { contractVersion, taskContractVersion } from '../core/goal-contract.js';
import { digest } from '../core/util.js';

const schema = 'acms-monitor-checkpoint/1';
const indexLimit = 200;
const verificationLimit = 24;

function reviewEvidence(store, goal, deliveryHash) {
  const review = store.latestGoalReviewForContract(goal.id, contractVersion(goal), { evidenceOnly: true });
  if (!review) return null;
  return { id: review.id, status: review.status, passed: review.passed ?? null, deliveryHash: review.deliveryHash ?? null,
    matchesCurrentDelivery: review.deliveryHash === deliveryHash };
}

function publicationEvidence(company, project, goal, candidate, deliveryHash) {
  const request = goal.candidateMerge;
  if (!request) return null;
  const approval = company.store.get('deliveryApprovals', request.id);
  return {
    id: request.id, status: request.status, integrationId: request.integrationId ?? null,
    candidateVersion: request.selection?.version ?? null, deliveryHash: request.selection?.deliveryHash ?? null,
    appliedCommit: request.result?.integratedCommit ?? null,
    matchesCurrentDelivery: !!candidate && request.selection?.version === candidate.version && request.selection?.deliveryHash === deliveryHash,
    matchesCurrentProjectPolicy: !!project && request.policy === candidateMergePolicy(company, project, request.targetMode),
    approvalFingerprint: request.approvalFingerprint ?? null, approvalDecision: approval?.action ?? null,
  };
}

function currentPlan(store, goal, tasks) {
  const gate = goal.planApproval;
  if (!gate) return null;
  const planner = tasks.find(task => task.id === gate.taskId);
  const planId = gate.approvedPlanId ?? planner?.planId ?? null;
  const plan = planId ? store.get('plans', planId) : null;
  return { taskId: gate.taskId ?? null, id: planId, fingerprint: plan?.fingerprint ?? null, status: plan?.approvalStatus ?? null };
}

function taskSummary({ planId, goalContractVersion, ...row }) {
  return { ...row, contractVersion: taskContractVersion({ goalContractVersion }), ...(planId ? { planId } : {}) };
}

function interactionSummary({ taskStatus, currentGeneration, taskGeneration, stopRequested, ...row }) {
  return { ...row, taskGeneration, matchesCurrentTaskState: (taskStatus === 'blocked' || taskStatus === 'paused') &&
    !stopRequested && (taskGeneration ?? currentGeneration) === currentGeneration };
}

function scheduling(engine, policy, heartbeat, checked) {
  // Sampling heartbeat never touches the scheduler lease and is not proof of process cleanup.
  const staleAfterMs = Math.max(10000, (engine?.intervalMs ?? 1000) * 5);
  const state = engine?.closing ? 'stopping' : heartbeat == null ? 'offline'
    : checked - heartbeat >= staleAfterMs ? 'stale' : 'active';
  return { state, pauseMode: policy.paused ? policy.pauseMode ?? 'immediate' : null,
    hasError: !!engine?.lastError, policyRevision: policy.revision ?? null };
}

export function monitorCheckpoint(runtime, credential, goal, ifVersion) {
  const { company, engine } = runtime;
  const store = company.store;
  const checked = Date.now();
  const canReadEvents = (credential.scope?.commands ?? []).includes('events.read');
  const { cursor, latestEvent, heartbeat } = checkpointObservations(store, goal.id, canReadEvents);
  const rows = goalCheckpointRows(store, goal.id, engine?.live, verificationLimit);
  const project = store.get('projects', goal.projectId);
  const { hash: deliveryHash, candidate } = goalDeliveryState(store, goal, { ...checkpointDeliverySources(store, goal), project });
  const control = goal.executionControl;
  const snapshot = {
    goal: {
      id: goal.id, projectId: goal.projectId, status: goal.status, revision: goal.revision,
      contract: {
        version: contractVersion(goal),
        fingerprint: digest([goal.title, goal.description, goal.acceptance, goal.constraints ?? []]),
        changeStatus: goal.contractChange?.status ?? null, coordinationTaskId: goal.contractChange?.coordinationTaskId ?? null,
        templateId: goal.templateId ?? 'base', templateVersion: goal.templateSnapshot?.version ?? null,
      },
      control: control ? { id: control.id, state: control.state, mode: control.mode, requestedAt: control.requestedAt } : null,
      completionPending: goal.completionPending ?? null,
    },
    access: { eventsRead: canReadEvents, projectStatus: project?.status ?? null, projectRevision: project?.revision ?? null },
    scheduling: scheduling(engine, company.policy(), heartbeat, checked),
    taskCounts: Object.fromEntries(rows.taskCounts.map(row => [row.status, row.count])),
    nonTerminalTasks: rows.tasks.map(taskSummary),
    slots: rows.slots,
    pendingInteractions: rows.interactions.map(interactionSummary),
    plan: currentPlan(store, goal, rows.tasks),
    delivery: {
      hash: deliveryHash,
      completedHash: goal.completedDeliveryHash ?? null, completedContractVersion: goal.completedContractVersion ?? null,
      candidate: goal.composition ? { version: goal.composition.version, contentHash: goal.composition.contentHash,
        checkContract: goal.composition.checkContract ?? null, recordedPassed: goal.composition.passed === true,
        matchesRecordedVerification: !!candidate } : null,
      compositionCheck: goal.compositionRecheck ? { id: goal.compositionRecheck.id, status: goal.compositionRecheck.status,
        integrationId: goal.compositionRecheck.integrationId ?? null } : null,
      finalReview: reviewEvidence(store, goal, deliveryHash),
      publication: publicationEvidence(company, project, goal, candidate, deliveryHash),
      recentPublications: rows.publications.slice(0, verificationLimit),
      hasOlderPublications: rows.publications.length > verificationLimit,
      recentAutomaticMerges: rows.automaticMerges.slice(0, verificationLimit),
      hasOlderAutomaticMerges: rows.automaticMerges.length > verificationLimit,
      recentVerifications: rows.verifications.slice(0, verificationLimit).map(row => ({ ...row, passed: row.passed === 1 })),
      hasOlderVerifications: rows.verifications.length > verificationLimit,
    },
  };
  // A goal's semantic version excludes advancing clocks, unrelated events and runtime instance IDs.
  // Include every live index entry in the version, even if the wire view has to omit some of them.
  const version = digest([schema, snapshot]);
  const observed = { checkedAt: new Date(checked).toISOString(), cursor, latestEvent,
    schedulerHeartbeatAt: heartbeat == null ? null : new Date(heartbeat).toISOString() };
  const goalId = encodeURIComponent(goal.id);
  const links = { goal: '/goals/' + goalId, tasks: '/tasks?goalId=' + goalId, blockers: '/blockers?goalId=' + goalId,
    reviews: '/reviews?goalId=' + goalId, ...(canReadEvents ? { events: '/events?goalId=' + goalId + '&after=' + cursor } : {}) };
  if (version === ifVersion) return { schema, goalId: goal.id, version, unchanged: true, observed };
  const index = entries => ({ total: entries.length, omitted: Math.max(0, entries.length - indexLimit), entries: entries.slice(0, indexLimit) });
  return { schema, goalId: goal.id, version, unchanged: false, observed, links, snapshot: {
    ...snapshot, nonTerminalTasks: index(snapshot.nonTerminalTasks), pendingInteractions: index(snapshot.pendingInteractions),
  } };
}
