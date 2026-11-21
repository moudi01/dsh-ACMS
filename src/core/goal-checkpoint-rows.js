import { LIVE_ATTEMPT_STATUSES } from './entity-actions.js';
import { attemptSlot, integrationSlot } from './execution-capacity.js';
import { PENDING_INTEGRATION_PHASES } from './task-actions.js';
import { TERMINAL } from './util.js';

const marks = values => Array.from(values, () => '?').join(',');
const taskGoal = "t.collection='tasks' AND json_extract(t.body,'$.goalId')=?";
const scopedTasks = 'entities t INDEXED BY tasks_by_goal';
const notDeleted = "json_extract(t.body,'$.status')!='deleted'";
const fields = (table, columns) => columns.map(name => `json_extract(${table}.body,'$.${name}') AS "${name}"`).join(', ');
const values = states => states.map(state => "'" + state + "'").join(',');
const occupiedAttempt = column => `COALESCE(json_extract(${column},'$.legacyBatch'),0)=0 AND (
  json_extract(${column},'$.status') IN (${values(LIVE_ATTEMPT_STATUSES)}) OR json_extract(${column},'$.cleanupPending')=1)`;
const occupiedIntegration = column => `json_extract(${column},'$.phase') IN (${values(PENDING_INTEGRATION_PHASES)})`;

// Use the same predicates in the queries and partial indexes. Inactive attempt
// history then needs no record reads during a checkpoint.
export const CHECKPOINT_INDEXES = `
  CREATE INDEX IF NOT EXISTS occupied_attempts_by_goal_task
    ON entities(json_extract(body,'$.goalId'),json_extract(body,'$.taskId'))
    WHERE collection='attempts' AND ${occupiedAttempt('body')};
  CREATE INDEX IF NOT EXISTS occupied_integrations_by_goal_task
    ON entities(json_extract(body,'$.goalId'),json_extract(body,'$.taskId'))
    WHERE collection='integrations' AND ${occupiedIntegration('body')};
  CREATE INDEX IF NOT EXISTS integrations_by_goal ON entities(json_extract(body,'$.goalId')) WHERE collection='integrations';
  CREATE INDEX IF NOT EXISTS pending_interactions_by_task ON entities(json_extract(body,'$.taskId'))
    WHERE collection='interactions' AND json_extract(body,'$.status')='pending';
  CREATE INDEX IF NOT EXISTS verifications_by_task ON entities(json_extract(body,'$.taskId')) WHERE collection='verifications';
`;

const taskFields = ['kind', 'status', 'generation', 'goalContractVersion', 'artifactHash', 'deliveryHash',
  'reviewArtifactHash', 'reviewOf', 'reviewScope', 'stopRequested', 'activeAttemptId', 'activeIntegrationId', 'retryAt'];
const slotFields = ['goalId', 'taskId', 'cleanupUncertain', 'cleanupPending', 'startedAt', 'createdAt'];

function slots(store, goalId, live) {
  const { db } = store;
  const select = (collection, stateKey, occupies) => {
    const predicate = `s.collection='${collection}' AND ${occupies('s.body')}`;
    const projection = `s.id, ${fields('s', [...slotFields, stateKey])}`;
    const occupied = `entities s INDEXED BY occupied_${collection}_by_goal_task`;
    const direct = db.prepare(`SELECT ${projection} FROM ${occupied} WHERE json_extract(s.body,'$.goalId')=? AND ${predicate}`)
      .all(goalId);
    const legacy = db.prepare(`SELECT ${projection} FROM ${scopedTasks} CROSS JOIN ${occupied}
      WHERE ${taskGoal} AND json_extract(s.body,'$.taskId')=+t.id
        AND json_extract(s.body,'$.goalId') IS NULL AND ${predicate}`).all(goalId);
    return [...direct, ...legacy];
  };
  // A terminal row still owns its slot while the engine is disposing a live activation.
  const attempts = select('attempts', 'status', occupiedAttempt);
  const known = new Set(attempts.map(attempt => attempt.id));
  for (const id of live?.keys() ?? []) {
    if (known.has(id)) continue;
    const attempt = store.get('attempts', id);
    if (attempt && !attempt.legacyBatch && (attempt.goalId ?? store.get('tasks', attempt.taskId)?.goalId) === goalId) attempts.push(attempt);
  }
  const integrations = select('integrations', 'phase', occupiedIntegration);
  const tasks = new Map();
  const task = id => {
    if (id && !tasks.has(id)) tasks.set(id, store.get('tasks', id));
    return tasks.get(id);
  };
  const compact = ({ kind, phase, id, taskId, status }, record) => ({
    kind, phase, id, taskId: taskId ?? null, status, recordedAt: record.startedAt ?? record.createdAt ?? null,
  });
  return [
    ...attempts.map(record => compact(attemptSlot(record, task(record.taskId)), record)),
    ...integrations.map(record => compact(integrationSlot(record, task(record.taskId)), record)),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

export function goalCheckpointRows(store, goalId, live, verificationLimit) {
  const { db } = store;
  const taskCounts = db.prepare(`SELECT json_extract(t.body,'$.status') AS status, COUNT(*) AS count FROM ${scopedTasks}
    WHERE ${taskGoal} GROUP BY status`).all(goalId);
  const tasks = db.prepare(`SELECT t.id, t.revision, ${fields('t', taskFields)},
      json_extract(t.body,'$.blocker.kind') AS blockerKind, json_extract(t.body,'$.blocker.planId') AS planId,
      json_extract(t.body,'$.costBudgetHold.code') AS costHoldCode
    FROM ${scopedTasks} WHERE ${taskGoal} AND json_extract(t.body,'$.status') NOT IN (${marks(TERMINAL)}) ORDER BY t.id`)
    .all(goalId, ...TERMINAL);
  // Unary + removes TEXT affinity from the task ID so SQLite can seek the JSON expression index.
  const interactions = db.prepare(`SELECT i.id, i.revision AS expectedRevision, ${fields('i', ['kind', 'taskId', 'taskGeneration', 'createdAt'])},
      json_extract(t.body,'$.status') AS taskStatus, json_extract(t.body,'$.generation') AS currentGeneration,
      json_extract(t.body,'$.stopRequested') AS stopRequested
    FROM ${scopedTasks} CROSS JOIN entities i INDEXED BY pending_interactions_by_task
    WHERE ${taskGoal} AND ${notDeleted} AND i.collection='interactions' AND json_extract(i.body,'$.taskId')=+t.id
      AND json_extract(i.body,'$.status')='pending' ORDER BY i.id`).all(goalId);
  const verifications = db.prepare(`WITH subjects AS (
      SELECT t.id FROM ${scopedTasks} WHERE ${taskGoal} AND ${notDeleted}
      UNION ALL SELECT ?
    ) SELECT v.id, ${fields('v', ['taskId', 'attemptId', 'kind', 'passed', 'artifactHash', 'goalContractVersion', 'taskGeneration', 'createdAt'])}
    FROM subjects s CROSS JOIN entities v INDEXED BY verifications_by_task
    WHERE v.collection='verifications' AND json_extract(v.body,'$.taskId')=s.id
      AND (s.id!=? OR json_extract(v.body,'$.kind')='goal-review')
    ORDER BY v.rowid DESC LIMIT ?`).all(goalId, goalId, goalId, verificationLimit + 1);
  const automaticMerges = db.prepare(`SELECT t.id AS taskId, ${fields('t', ['artifactHash', 'goalContractVersion'])},
      json_extract(t.body,'$.integration.integrationId') AS integrationId, json_extract(t.body,'$.integration.integratedCommit') AS appliedCommit
    FROM ${scopedTasks} WHERE ${taskGoal} AND json_extract(t.body,'$.status')='succeeded'
      AND json_extract(t.body,'$.integration.status')='merged' ORDER BY t.rowid DESC LIMIT ?`).all(goalId, verificationLimit + 1);
  const publications = db.prepare(`SELECT s.id AS integrationId, ${fields('s', ['candidateMergeId', 'candidateVersion', 'finishedAt'])},
      json_extract(s.body,'$.result.integratedCommit') AS appliedCommit
    FROM entities s INDEXED BY integrations_by_goal WHERE s.collection='integrations' AND json_extract(s.body,'$.goalId')=?
      AND json_extract(s.body,'$.phase')='completed' AND json_extract(s.body,'$.candidateMergeId') IS NOT NULL
      AND json_extract(s.body,'$.result.integratedCommit') IS NOT NULL
    ORDER BY s.rowid DESC LIMIT ?`).all(goalId, verificationLimit + 1);
  return { taskCounts, tasks, interactions, verifications, automaticMerges, publications, slots: slots(store, goalId, live) };
}

export function checkpointObservations(store, goalId, canReadEvents) {
  return {
    cursor: store.cursor(),
    latestEvent: canReadEvents ? store.db.prepare(`SELECT seq, at, type, entity_id AS entityId
      FROM events WHERE goal_id=? ORDER BY seq DESC LIMIT 1`).get(goalId) ?? null : null,
    heartbeat: store.db.prepare("SELECT heartbeat FROM leases WHERE resource='scheduler'").get()?.heartbeat ?? null,
  };
}
