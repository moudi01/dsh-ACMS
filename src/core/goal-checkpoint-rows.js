import { LIVE_ATTEMPT_STATUSES } from './entity-actions.js';
import { attemptSlot, integrationSlot } from './execution-capacity.js';
import { usesComposition } from './composite-delivery.js';
import { deliveredWork } from './goal-contract.js';
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
const gitCommit = expression => `length(${expression}) IN (40,64) AND ${expression} NOT GLOB '*[^0-9a-f]*'`;
const automaticMergeReceipt = column => `json_extract(${column},'$.phase')='completed'
  AND json_extract(${column},'$.result.status')='merged' AND ${gitCommit(`json_extract(${column},'$.result.integratedCommit')`)}
  AND json_extract(${column},'$.candidateMergeId') IS NULL AND json_extract(${column},'$.compositionRecheckId') IS NULL`;

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
  CREATE INDEX IF NOT EXISTS automatic_merges_by_goal_task
    ON entities(json_extract(body,'$.goalId'),json_extract(body,'$.taskId'))
    WHERE collection='integrations' AND ${automaticMergeReceipt('body')};
  CREATE INDEX IF NOT EXISTS pending_interactions_by_task ON entities(json_extract(body,'$.taskId'))
    WHERE collection='interactions' AND json_extract(body,'$.status')='pending';
  CREATE INDEX IF NOT EXISTS verifications_by_task ON entities(json_extract(body,'$.taskId')) WHERE collection='verifications';
`;

const taskFields = ['kind', 'status', 'generation', 'goalContractVersion', 'artifactHash', 'deliveryHash',
  'reviewArtifactHash', 'reviewOf', 'reviewScope', 'stopRequested', 'activeAttemptId', 'activeIntegrationId', 'retryAt'];
const slotFields = ['goalId', 'taskId', 'cleanupUncertain', 'cleanupPending', 'startedAt', 'createdAt'];

// Preserve the truthiness of a legacy flag without returning its JSON payload.
const legacyFlag = field => `CASE json_type(t.body,'$.${field}') WHEN 'object' THEN 1 WHEN 'array' THEN 1
  ELSE json_extract(t.body,'$.${field}') END AS "${field}"`;
const compositionTaskColumns = `${fields('t', ['goalId', 'kind', 'status', 'goalContractVersion'])},
  t.body -> '$.dependencies' AS dependencies, t.body -> '$.generation' AS generationJson,
  t.body -> '$.artifactHash' AS artifactHashJson,
  json_extract(t.body,'$.workspace.compositionInput.version') AS inputVersion,
  t.body -> '$.integration.delivery.sha256' AS deliveryShaJson`;

function compositionTask(row) {
  if (!row) return null;
  const { dependencies, historicalInputs, inputVersion, deliveryShaJson, artifactHashJson, generationJson, ...task } = row;
  return {
    ...task,
    artifactHash: artifactHashJson === null ? undefined : JSON.parse(artifactHashJson),
    generation: generationJson === null ? undefined : JSON.parse(generationJson),
    dependencies: dependencies == null ? [] : JSON.parse(dependencies),
    workspace: { compositionInput: { version: inputVersion, inputs: historicalInputs == null ? [] : JSON.parse(historicalInputs) } },
    integration: { delivery: { sha256: deliveryShaJson === null ? undefined : JSON.parse(deliveryShaJson) } },
  };
}

export function checkpointDeliverySources(store, goal) {
  const checkComposition = usesComposition(goal) && goal.composition?.passed === true;
  const workColumns = fields('t', checkComposition ? ['deliveryGeneration'] : ['artifactHash', 'deliveryGeneration']);
  const rows = store.db.prepare(`SELECT t.id, ${workColumns}, ${legacyFlag('legacyBatch')}, ${legacyFlag('workflowSnapshot')}
    ${checkComposition ? ', ' + compositionTaskColumns : ''}
    FROM entities t INDEXED BY delivered_work_by_goal WHERE ${taskGoal}
      AND json_extract(t.body,'$.kind')='work' AND json_extract(t.body,'$.status')='succeeded'`).all(goal.id);
  const work = deliveredWork(store, goal, rows);
  if (!checkComposition) return { roots: work };
  // Only dependencies outside the current roots may need historical ancestry.
  const dependency = store.db.prepare(`SELECT t.id, ${workColumns}, ${compositionTaskColumns},
    t.body -> '$.workspace.compositionInput.inputs' AS historicalInputs
    FROM entities t WHERE ${taskGoal} AND t.id=?`);
  return { roots: work.map(compositionTask), loadTask: id => compositionTask(dependency.get(goal.id, id)) };
}

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
  const taskById = db.prepare(`SELECT ${fields('t', ['goalId', 'status', 'stopRequested'])}
    FROM entities t WHERE t.collection='tasks' AND t.id=?`);
  const tasks = new Map();
  const task = id => {
    if (id && !tasks.has(id)) tasks.set(id, taskById.get(id));
    return tasks.get(id);
  };
  const liveAttempt = db.prepare(`SELECT s.id, ${fields('s', [...slotFields, 'status', 'legacyBatch'])}
    FROM entities s WHERE s.collection='attempts' AND s.id=?`);
  for (const id of live?.keys() ?? []) {
    if (known.has(id)) continue;
    const attempt = liveAttempt.get(id);
    if (attempt && !attempt.legacyBatch && (attempt.goalId ?? task(attempt.taskId)?.goalId) === goalId) attempts.push(attempt);
  }
  const integrations = select('integrations', 'phase', occupiedIntegration);
  const compact = ({ kind, phase, id, taskId, status }, record) => ({
    kind, phase, id, taskId: taskId ?? null, status, recordedAt: record.startedAt ?? record.createdAt ?? null,
  });
  return [
    ...attempts.map(record => compact(attemptSlot(record, task(record.taskId)), record)),
    ...integrations.map(record => compact(integrationSlot(record, task(record.taskId)), record)),
  ].sort((a, b) => a.id.localeCompare(b.id));
}

function recentAutomaticMerges(db, goalId, limit) {
  const ledger = 'entities s INDEXED BY automatic_merges_by_goal_task';
  const applied = `s.collection='integrations' AND ${automaticMergeReceipt('s.body')}`;
  const receipt = `s.id AS integrationId, ${fields('s', ['taskId', 'artifactHash', 'goalContractVersion', 'finishedAt'])},
    json_extract(s.body,'$.result.integratedCommit') AS appliedCommit, json_extract(s.body,'$.updatedAt') AS sortDate`;
  const legacyCommit = "json_extract(t.body,'$.integration.integratedCommit')";
  const settledTask = `(json_extract(t.body,'$.status')='succeeded' OR
    (json_extract(t.body,'$.status')='deleted' AND json_extract(t.body,'$.deletion.previousStatus')='succeeded'))`;
  return db.prepare(`WITH recorded AS (
      SELECT ${receipt} FROM ${ledger} WHERE json_extract(s.body,'$.goalId')=? AND ${applied}
      UNION ALL
      SELECT ${receipt} FROM ${scopedTasks} CROSS JOIN ${ledger}
      WHERE ${taskGoal} AND json_extract(s.body,'$.goalId') IS NULL AND json_extract(s.body,'$.taskId')=+t.id AND ${applied}
    ), legacy AS (
      SELECT json_extract(t.body,'$.integration.integrationId') AS integrationId, t.id AS taskId,
        CASE WHEN ${settledTask} THEN json_extract(t.body,'$.artifactHash') END AS artifactHash,
        COALESCE(json_extract(t.body,'$.integration.goalContractVersion'),
          CASE WHEN ${settledTask} THEN COALESCE(json_extract(t.body,'$.goalContractVersion'),1) END) AS goalContractVersion,
        json_extract(t.body,'$.integration.finishedAt') AS finishedAt, ${legacyCommit} AS appliedCommit,
        json_extract(t.body,'$.updatedAt') AS sortDate
      FROM ${scopedTasks} WHERE ${taskGoal} AND json_extract(t.body,'$.integration.status')='merged' AND ${gitCommit(legacyCommit)}
    ), history AS (
      SELECT * FROM recorded
      UNION ALL
      SELECT l.* FROM legacy l
      WHERE NOT EXISTS (SELECT 1 FROM entities existing WHERE existing.collection='integrations' AND existing.id=l.integrationId)
        AND NOT EXISTS (SELECT 1 FROM recorded r WHERE r.taskId=l.taskId AND r.appliedCommit=l.appliedCommit)
    )
    SELECT integrationId, taskId, artifactHash, goalContractVersion, finishedAt, appliedCommit FROM history
    ORDER BY COALESCE(finishedAt,sortDate) DESC, taskId, integrationId LIMIT ?`).all(goalId, goalId, goalId, limit);
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
  const automaticMerges = recentAutomaticMerges(db, goalId, verificationLimit + 1);
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
