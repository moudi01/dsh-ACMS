import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { asBusyError, assert, digest, now } from "./util.js";
import { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_EVENT_TYPES, ACTIVITY_MAX_LIMIT } from "./activity.js";
import { assertWorktreeRestoreReady } from "./restore-safety.js";
import { CHECKPOINT_INDEXES } from "./goal-checkpoint-rows.js";
import { LIVE_ATTEMPT_STATUSES } from "./entity-actions.js";
import { PANEL_EVIDENCE_INDEXES } from "./panel-evidence.js";
import { DASHBOARD_INDEXES } from "./panel-dashboard.js";

export const SCHEMA_VERSION = "2";
const attemptUsageFields = { task: "$.taskId", goal: "$.goalId" };
const panelAttemptHolds = "(json_extract(body,'$.cleanupPending')=1 OR json_extract(body,'$.cleanupUncertain')=1)";

/**
 * Events that count as effective business activity for issue #17 ordering.
 * Progress pings, heartbeats, notifications and other polling-adjacent writes
 * stay out so they can never bump a project, goal or task to the top.
 */
export const EFFECTIVE_ACTIVITY_EVENTS = [
  "project.saved", "goal.created", "goal.status.changed", "goal.succeeded", "goal.reopened", "goal.runtime.extended",
  "goal.contract.changed", "goal.contract.assessed",
  "goal.paused", "goal.resumed", "goal.cancelled",
  "goal.delivery_approval.decided",
  "goal.cost_budget.optional_deferred",
  "task.created", "task.changed", "task.dependencies", "task.blocked", "task.resumed", "task.retry.scheduled",
  "task.stop.completed", "task.succeeded", "task.restored", "task.deleted", "task.purged",
  "attempt.claimed", "attempt.starting", "attempt.finished", "attempt.failed", "attempt.recovery", "attempt.result.recovered",
  "review.queued", "review.requested", "review.decided", "review.rework.requested", "review.rework.limit", "review.rework.gate",
  "coordination.created", "coordination.decided", "coordination.applied", "blocker.coordinated", "task.integration.resumed",
  "integration.started", "integration.checking", "integration.applying", "integration.completed", "integration.stopped", "integration.reconciling", "integration.failed",
  "interaction.answered",
];

export class Store {
  constructor(filename, { requireWorktreeReady = false } = {}) {
    this.filename = filename;
    if (requireWorktreeReady) this.assertWorktreeRestoreReady();
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.events = new EventEmitter(); this.events.setMaxListeners(100);
    this.inTransaction = false; this.pending = [];
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (
        collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS entities_status ON entities(collection,json_extract(body,'$.status'));
      CREATE INDEX IF NOT EXISTS panel_attempt_holds ON entities(collection) WHERE collection='attempts' AND ${panelAttemptHolds};
      CREATE INDEX IF NOT EXISTS attempts_usage_by_goal ON entities(json_extract(body,'$.goalId')) WHERE collection='attempts';
      CREATE INDEX IF NOT EXISTS attempts_usage_by_task ON entities(json_extract(body,'$.taskId')) WHERE collection='attempts';
      CREATE INDEX IF NOT EXISTS tasks_by_goal ON entities(json_extract(body,'$.goalId')) WHERE collection='tasks';
      CREATE INDEX IF NOT EXISTS messages_by_conversation ON entities(json_extract(body,'$.conversationId')) WHERE collection='conversationMessages';
      CREATE INDEX IF NOT EXISTS delivered_work_by_goal ON entities(json_extract(body,'$.goalId')) WHERE collection='tasks'
        AND json_extract(body,'$.kind')='work' AND json_extract(body,'$.status')='succeeded';
      ${CHECKPOINT_INDEXES}
      ${PANEL_EVIDENCE_INDEXES}
      ${DASHBOARD_INDEXES}
      CREATE INDEX IF NOT EXISTS cost_attempts_by_goal ON entities(json_extract(body,'$.goalId')) WHERE collection='goalCostAttempts';
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, entity_id TEXT, goal_id TEXT, actor TEXT NOT NULL, principal_kind TEXT, on_behalf_of TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, epoch INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
    `);
    const version = this.db.prepare("SELECT value FROM meta WHERE key=?").get("schema");
    assert(!version || version.value === "1" || version.value === SCHEMA_VERSION, "SCHEMA_VERSION", "This ACMS version cannot open the database schema");
    const columns = this.db.prepare("PRAGMA table_info(events)").all().map(row => row.name);
    if (!columns.includes("goal_id")) this.db.exec("ALTER TABLE events ADD COLUMN goal_id TEXT");
    if (!columns.includes("principal_kind")) this.db.exec("ALTER TABLE events ADD COLUMN principal_kind TEXT");
    if (!columns.includes("on_behalf_of")) this.db.exec("ALTER TABLE events ADD COLUMN on_behalf_of TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_goal_seq ON events(goal_id, seq)");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_entity_at ON events(entity_id, at)");
    if (version && version.value === "1") this.migrateEvents();
    this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("schema", SCHEMA_VERSION);
  }

  assertWorktreeRestoreReady() {
    if (this.filename !== ':memory:') assertWorktreeRestoreReady(dirname(this.filename));
  }
  migrateEvents() {
    this.transaction(() => {
      this.db.prepare("UPDATE events SET principal_kind=? WHERE actor=? AND principal_kind IS NULL").run("owner", "owner");
      this.db.prepare("UPDATE events SET principal_kind=? WHERE actor=? AND principal_kind IS NULL").run("system", "scheduler");
      this.db.prepare("UPDATE events SET principal_kind=? WHERE principal_kind IS NULL").run("agent");
      const rows = this.db.prepare("SELECT seq, entity_id, body FROM events WHERE goal_id IS NULL").all();
      const update = this.db.prepare("UPDATE events SET goal_id=? WHERE seq=? AND goal_id IS NULL");
      for (const row of rows) {
        const goalId = this.goalOf(row.entity_id, JSON.parse(row.body));
        if (goalId) update.run(goalId, row.seq);
      }
    });
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw asBusyError(error) ?? error;
    }
    this.inTransaction = true; this.pending = [];
    let result, events;
    try {
      result = fn(); assert(!result?.then, "ASYNC_TRANSACTION", "No async work is allowed inside a transaction");
      try {
        this.db.exec("COMMIT");
      } catch (error) {
        throw asBusyError(error) ?? error;
      }
      events = this.pending;
    } catch (e) {
      this.inTransaction = false;
      try { this.db.exec("ROLLBACK"); } catch { }
      throw e;
    }
    finally { this.inTransaction = false; this.pending = []; }
    for (const event of events) this.events.emit("event", event);
    return result;
  }
  get(collection, entityId) {
    const row = this.db.prepare("SELECT body,revision FROM entities WHERE collection=? AND id=?").get(collection, entityId);
    return row ? { ...JSON.parse(row.body), revision: row.revision } : null;
  }
  require(collection, entityId) { const value = this.get(collection, entityId); assert(value, "NOT_FOUND", collection + "/" + entityId + " not found"); return value; }
  list(collection) { return this.db.prepare("SELECT body,revision FROM entities WHERE collection=? ORDER BY rowid").all(collection).map(r => ({ ...JSON.parse(r.body), revision: r.revision })); }
  readSnapshot(read) {
    if (this.inTransaction) return read();
    this.db.exec("BEGIN");
    try {
      const result = read();
      assert(!result?.then, "ASYNC_TRANSACTION", "No async work is allowed inside a transaction");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { }
      throw error;
    }
  }
  tasksForGoal(goalId) {
    return this.db.prepare("SELECT body FROM entities WHERE collection='tasks' AND json_extract(body,'$.goalId')=?")
      .all(goalId).map(({ body }) => JSON.parse(body));
  }

  independentHistory(conversationId, agentId, messageId, limit) {
    const anchor = this.db.prepare("SELECT rowid FROM entities WHERE collection='conversationMessages' AND id=?").get(messageId)?.rowid ?? 0;
    const scoped = alias => `${alias}.collection='conversationMessages'
      AND json_extract(${alias}.body,'$.conversationId')=:conversationId AND json_extract(${alias}.body,'$.taskId') IS NULL
      AND coalesce(json_extract(${alias}.body,'$.agentId'),:agentId)=:agentId`;
    const priorOwner = alias => `json_extract(${alias}.body,'$.role')='user'
      AND json_extract(${alias}.body,'$.status')='delivered' AND ${alias}.rowid<:anchor`;
    const params = { conversationId, agentId, anchor };
    const latestOwner = this.db.prepare(`SELECT message.id, message.body, message.revision,
      message.rowid AS position, message.rowid AS turnPosition FROM entities AS message
      WHERE ${scoped('message')} AND ${priorOwner('message')} ORDER BY message.rowid DESC LIMIT 1`).get(params);
    // The reply belongs after its question, even when a queue inserts later questions first.
    const scope = `FROM entities AS message LEFT JOIN entities AS question
      ON question.id=json_extract(message.body,'$.replyTo') AND ${scoped('question')} AND ${priorOwner('question')}
      WHERE ${scoped('message')} AND (${priorOwner('message')}
        OR (json_extract(message.body,'$.role')='assistant' AND json_extract(message.body,'$.status')='completed'
          AND (message.rowid<:anchor OR question.rowid IS NOT NULL)))`;
    const { count } = this.db.prepare(`SELECT count(*) AS count ${scope}`).get(params);
    const rows = this.db.prepare(`SELECT message.id, message.body, message.revision, message.rowid AS position,
      coalesce(question.rowid,message.rowid) AS turnPosition ${scope}
      ORDER BY turnPosition DESC, position DESC LIMIT :limit`).all({ ...params, limit });
    if (latestOwner && !rows.some(row => row.id === latestOwner.id)) rows.push(latestOwner);
    rows.sort((a, b) => a.turnPosition - b.turnPosition || a.position - b.position);
    return { count, latestOwnerId: latestOwner?.id, messages: rows.map(row => ({ ...JSON.parse(row.body), revision: row.revision })) };
  }

  taskContext(goalId, taskId) {
    const rows = this.db.prepare(`SELECT body,revision FROM entities INDEXED BY tasks_by_goal WHERE collection='tasks'
      AND json_extract(body,'$.goalId')=? ORDER BY rowid`).all(goalId);
    const tasks = rows.map(row => ({ ...JSON.parse(row.body), revision: row.revision }));
    const byId = new Map(tasks.map(task => [task.id, task]));
    // Preserve named legacy dependencies and ancestors even when their records
    // are outside the displayed goal. The owner commands verify current edges.
    for (const task of tasks) for (const id of [task.parentId, task.reviewOf, ...(task.dependencies ?? [])]) {
      if (!id || byId.has(id)) continue;
      const related = this.get('tasks', id);
      byId.set(id, related);
      if (related) tasks.push(related);
    }
    if (taskId) {
      const associated = [taskId, ...tasks.filter(task => task.reviewOf === taskId && task.status !== 'deleted').map(task => task.id)];
      const incoming = this.db.prepare(`WITH linked AS (SELECT value AS id FROM json_each(?))
        SELECT e.id,e.revision,json_extract(e.body,'$.title') AS title,json_extract(e.body,'$.status') AS status,
          json_extract(e.body,'$.parentId') AS parentId,json_extract(e.body,'$.reviewOf') AS reviewOf,
          json_extract(e.body,'$.dependencies') AS dependencies,json_extract(e.body,'$.goalId') AS goalId
        FROM entities e WHERE e.collection='tasks' AND json_extract(e.body,'$.goalId') IS NOT ?
        AND json_extract(e.body,'$.status') IS NOT 'deleted'
        AND (json_extract(e.body,'$.parentId') IN linked OR json_extract(e.body,'$.reviewOf') IN linked OR EXISTS (
          SELECT 1 FROM json_each(e.body,'$.dependencies') AS dep WHERE dep.value IN linked
        )) ORDER BY e.rowid`).all(JSON.stringify(associated), goalId);
      for (const row of incoming) if (!byId.has(row.id)) {
        tasks.push({ ...row, dependencies: row.dependencies ? JSON.parse(row.dependencies) : [] });
      }
    }
    return tasks;
  }

  deliveredWorkForGoal(goalId) {
    return this.db.prepare(`SELECT body FROM entities INDEXED BY delivered_work_by_goal WHERE collection='tasks' AND json_extract(body,'$.goalId')=?
      AND json_extract(body,'$.kind')='work' AND json_extract(body,'$.status')='succeeded' ORDER BY rowid`)
      .all(goalId).map(({ body }) => JSON.parse(body));
  }

  latestGoalReviewForContract(goalId, version, { evidenceOnly = false } = {}) {
    const columns = evidenceOnly ? `id, json_extract(body,'$.status') AS status, json_extract(body,'$.passed') AS passed,
      json_extract(body,'$.deliveryHash') AS deliveryHash` : 'body';
    const row = this.db.prepare(`SELECT ${columns} FROM entities INDEXED BY tasks_by_goal WHERE collection='tasks' AND json_extract(body,'$.goalId')=?
      AND json_extract(body,'$.kind')='review' AND json_extract(body,'$.reviewScope')='goal'
      AND json_extract(body,'$.status')!='deleted' AND COALESCE(json_extract(body,'$.goalContractVersion'),1)=?
      ORDER BY rowid DESC LIMIT 1`).get(goalId, version);
    if (!row) return null;
    return evidenceOnly ? { ...row, passed: row.passed === null ? null : row.passed === 1 } : JSON.parse(row.body);
  }
  *goalCostAttemptRows(goalId) {
    const rows = this.db.prepare("SELECT body FROM entities WHERE collection='goalCostAttempts' AND json_extract(body,'$.goalId')=?").iterate(goalId);
    for (const { body } of rows) yield JSON.parse(body);
  }
  panelAttempts(liveIds) {
    const activeStatuses = LIVE_ATTEMPT_STATUSES.map(() => '?').join(',');
    return this.db.prepare(`WITH recent AS (
      SELECT a.rowid FROM entities AS a WHERE a.collection='attempts' AND NOT EXISTS (
        SELECT 1 FROM entities AS t WHERE t.collection='tasks' AND t.id=json_extract(a.body,'$.taskId')
          AND json_extract(t.body,'$.status')='deleted'
      ) ORDER BY a.rowid DESC LIMIT 8
    )
    SELECT body,revision FROM entities WHERE rowid IN (
      SELECT rowid FROM recent
      UNION SELECT rowid FROM entities WHERE collection='attempts' AND json_extract(body,'$.status') IN (${activeStatuses})
      UNION SELECT rowid FROM entities WHERE collection='attempts' AND ${panelAttemptHolds}
      UNION SELECT e.rowid FROM json_each(?) AS live JOIN entities AS e ON e.collection='attempts' AND e.id=live.value
    ) ORDER BY rowid`).all(...LIVE_ATTEMPT_STATUSES, JSON.stringify(liveIds))
      .map(row => ({ ...JSON.parse(row.body), revision: row.revision }));
  }
  taskPanelActiveAttempts(taskId) {
    const activeStatuses = LIVE_ATTEMPT_STATUSES.map(() => '?').join(',');
    return this.db.prepare(`SELECT body,revision FROM entities WHERE collection='attempts' AND json_extract(body,'$.taskId')=?
      AND (json_extract(body,'$.status') IN (${activeStatuses}) OR ${panelAttemptHolds}) ORDER BY rowid DESC`)
      .all(taskId, ...LIVE_ATTEMPT_STATUSES).map(row => ({ ...JSON.parse(row.body), revision: row.revision }));
  }
  taskPanelAttemptUpdates(taskId, ids) {
    return this.db.prepare(`SELECT a.body,a.revision FROM json_each(?) AS requested JOIN entities AS a
      ON a.collection='attempts' AND a.id=requested.value WHERE json_extract(a.body,'$.taskId')=?`)
      .all(JSON.stringify(ids), taskId).map(row => ({ ...JSON.parse(row.body), revision: row.revision }));
  }
  taskPanelVerifications(taskId) {
    return this.db.prepare(`SELECT v.body, v.revision FROM entities AS v WHERE v.collection='verifications' AND (
      json_extract(v.body,'$.taskId')=? OR EXISTS (
        SELECT 1 FROM entities AS a WHERE a.collection='attempts' AND a.id=json_extract(v.body,'$.attemptId')
          AND json_extract(a.body,'$.taskId')=?
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM entities AS t WHERE t.collection='tasks' AND t.id=json_extract(v.body,'$.taskId')
        AND json_extract(t.body,'$.status')='deleted'
    ) ORDER BY v.rowid DESC LIMIT 6`).all(taskId, taskId).reverse()
      .map(row => ({ ...JSON.parse(row.body), revision: row.revision }));
  }
  attemptUsagePage(scope, entityId, before, limit) {
    const field = attemptUsageFields[scope];
    return this.db.prepare(`SELECT rowid AS cursor, body FROM entities WHERE collection='attempts' AND json_extract(body,'${field}') = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`)
      .all(entityId, before, limit + 1)
      .map(({ cursor, body }) => ({ cursor, attempt: JSON.parse(body) }));
  }
  *attemptUsageRows(scope, entityId) {
    const field = attemptUsageFields[scope];
    const rows = this.db.prepare(`SELECT rowid AS cursor, body FROM entities WHERE collection='attempts' AND json_extract(body,'${field}') = ? ORDER BY rowid DESC`).iterate(entityId);
    for (const { cursor, body } of rows) yield { cursor, attempt: JSON.parse(body) };
  }
  awaitingGoalCostReceipts(after, limit) {
    return this.db.prepare(`SELECT rowid AS cursor, body FROM entities WHERE collection='goalCostAttempts'
      AND json_extract(body,'$.status')='awaiting-receipt' AND rowid > ? ORDER BY rowid LIMIT ?`)
      .all(after, limit).map(({ cursor, body }) => ({ cursor, row: JSON.parse(body) }));
  }
  put(collection, entity, expectedRevision) {
    const old = this.get(collection, entity.id);
    if (expectedRevision !== undefined) assert((old?.revision ?? 0) === expectedRevision, "CONFLICT", "This record changed; refresh and retry", { collection, id: entity.id });
    const saved = { ...entity, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? entity.createdAt ?? now(), updatedAt: now() };
    this.db.prepare("INSERT INTO entities VALUES (?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET revision=excluded.revision,body=excluded.body").run(collection, saved.id, saved.revision, JSON.stringify(saved));
    return saved;
  }
  remove(collection, entityId, expectedRevision) {
    const old = this.require(collection, entityId);
    if (expectedRevision !== undefined) assert(old.revision === expectedRevision, "CONFLICT", "The record changed; refresh and retry");
    this.db.prepare("DELETE FROM entities WHERE collection=? AND id=?").run(collection, entityId);
  }
  touch(collection, entityId, patch) {
    const row = this.db.prepare("SELECT body FROM entities WHERE collection=? AND id=?").get(collection, entityId);
    if (!row) return null;
    const body = { ...JSON.parse(row.body), ...patch };
    this.db.prepare("UPDATE entities SET body=? WHERE collection=? AND id=?").run(JSON.stringify(body), collection, entityId);
    return body;
  }
  event(type, entityId, body, actor, options = {}) {
    assert(this.inTransaction, "TRANSACTION_REQUIRED", "Events and domain state must commit together");
    const at = now(); const principal = actor?.id ?? "system";
    const principalKind = ["owner", "agent", "system", "user-agent"].includes(actor?.kind) ? actor.kind : principal === "scheduler" ? "system" : "agent";
    const onBehalfOf = actor?.kind === "user-agent" && actor.onBehalfOf ? JSON.stringify(actor.onBehalfOf) : null;
    // Freeze the acting agent's role/name in the event itself. The live agent
    // record can be edited later; the log must answer "who did this then".
    const content = actor?.kind === "agent" ? (() => {
      const agent = this.get("agents", principal);
      return agent ? { ...body, actorRole: agent.role, actorName: agent.name } : body;
    })() : body;
    const goalId = options.goalId ?? this.goalOf(entityId, content);
    const r = this.db.prepare("INSERT INTO events(at,type,entity_id,goal_id,actor,principal_kind,on_behalf_of,body) VALUES (?,?,?,?,?,?,?,?)").run(at, type, entityId, goalId, principal, principalKind, onBehalfOf, JSON.stringify(content));
    const event = { seq: Number(r.lastInsertRowid), at, type, entityId, goalId, actor: principal, principalKind, onBehalfOf: actor?.kind === "user-agent" ? actor.onBehalfOf ?? null : null, ...content };
    this.pending.push(event); return event;
  }
  /**
   * Latest effective business activity per entity id (ISO timestamp).
   * Uses a whitelist only, so polling/progress writes never fabricate activity.
   * Attempt and interaction events are attributed to their task through the
   * event body or the owning record before aggregation.
   */
  activity(types = EFFECTIVE_ACTIVITY_EVENTS) {
    const marks = types.map(() => "?").join(",");
    const rows = this.db.prepare(`WITH effective AS (
      SELECT e.at, COALESCE(
        CASE WHEN json_valid(e.body) THEN json_extract(e.body,'$.taskId') END,
        (SELECT json_extract(a.body,'$.taskId') FROM entities AS a WHERE a.collection='attempts' AND a.id=e.entity_id),
        (SELECT json_extract(i.body,'$.taskId') FROM entities AS i WHERE i.collection='interactions' AND i.id=e.entity_id),
        e.entity_id
      ) AS target FROM events AS e WHERE e.entity_id IS NOT NULL AND e.type IN (${marks})
    ) SELECT target, MAX(at) AS at FROM effective GROUP BY target`).all(...types);
    return new Map(rows.map(({ target, at }) => [target, at]));
  }
  page(after = 0, limit = 200) {
    const entries = this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit).map(r => ({ seq: r.seq, at: r.at, type: r.type, entityId: r.entity_id, actor: r.actor, ...JSON.parse(r.body) }));
    return { entries, nextCursor: entries.at(-1)?.seq ?? after, latestCursor: this.cursor() };
  }
  /**
   * Owner-facing business activity (issue #18), read backwards from the newest
   * matching event. `before` pages older entries; `after` pages newer entries
   * (used to prepend events that arrived while the panel was open). Both modes
   * share the same allow-list and scope filters, keep a durable sequence cursor
   * and never touch or duplicate stored events.
   */
  activityPage(options = {}) {
    const limit = Math.max(1, Math.min(ACTIVITY_MAX_LIMIT, Number.isSafeInteger(options.limit) ? options.limit : ACTIVITY_DEFAULT_LIMIT));
    const latest = this.cursor();
    const ascending = Number.isSafeInteger(options.after);
    const start = ascending ? options.after : (Number.isSafeInteger(options.before) ? options.before : latest + 1);
    const upper = latest;
    const marks = ACTIVITY_EVENT_TYPES.map(() => "?").join(",");
    const select = this.db.prepare(`SELECT * FROM events WHERE seq ${ascending ? ">" : "<"} ? AND seq <= ? AND type IN (${marks}) ORDER BY seq ${ascending ? "ASC" : "DESC"} LIMIT ?`);
    const lookup = this.activityLookup();
    const matches = row => this.activityMatches(row, options, lookup);
    const chunk = Math.min(500, Math.max(100, limit * 4));
    const rows = []; let cursor = start;
    while (rows.length < limit) {
      const page = select.all(cursor, upper, ...ACTIVITY_EVENT_TYPES, chunk);
      if (!page.length) break;
      for (const row of page) {
        cursor = row.seq;
        if (!matches(row)) continue;
        rows.push(row);
        if (rows.length >= limit) break;
      }
      if (page.length < chunk) break;
    }
    const probeFrom = rows.length ? cursor : start;
    let hasMore = false; let probeCursor = probeFrom;
    for (;;) {
      const page = select.all(probeCursor, upper, ...ACTIVITY_EVENT_TYPES, chunk);
      if (!page.length) break;
      hasMore = page.some(matches);
      probeCursor = page.at(-1).seq;
      if (hasMore || page.length < chunk) break;
    }
    if (!rows.length) hasMore = false;
    return {
      entries: rows.map(row => this.eventEntry(row)),
      nextBefore: rows.at(-1)?.seq ?? start,
      nextAfter: rows.at(-1)?.seq ?? start,
      latestSeq: latest,
      hasMore,
      hasOlder: !ascending ? hasMore : undefined,
      hasNewer: ascending ? hasMore : undefined,
      direction: ascending ? "newer" : "older",
    };
  }
  activityLookup() {
    const tasks = this.list("tasks"); const goals = this.list("goals"); const projects = this.list("projects");
    return {
      tasks: new Map(tasks.map(item => [item.id, item])),
      goals: new Map(goals.map(item => [item.id, item])),
      projects: new Map(projects.map(item => [item.id, item])),
      attemptTask: new Map(this.list("attempts").map(item => [item.id, item.taskId])),
      interactionTask: new Map(this.list("interactions").map(item => [item.id, item.taskId])),
      reviewOf: new Map(tasks.filter(item => item.reviewOf).map(item => [item.id, item.reviewOf])),
      goalOfTask: new Map(tasks.map(item => [item.id, item.goalId])),
      projectOfGoal: new Map(goals.map(item => [item.id, item.projectId])),
    };
  }
  activityMatches(row, options, lookup) {
    let body = {}; try { body = JSON.parse(row.body); } catch { body = {}; }
    const entityId = row.entity_id ?? null;
    let taskId = body.taskId ?? null;
    if (!taskId && entityId?.startsWith("task_")) taskId = entityId;
    if (!taskId && entityId?.startsWith("attempt_")) taskId = lookup.attemptTask.get(entityId) ?? null;
    if (!taskId && entityId?.startsWith("interaction_")) taskId = lookup.interactionTask.get(entityId) ?? null;
    if (!taskId && body.sourceTaskId) taskId = body.sourceTaskId;
    const reviewSource = entityId?.startsWith("task_") ? lookup.reviewOf.get(entityId) ?? null : null;
    let goalId = row.goal_id ?? body.goalId ?? body.sourceGoalId ?? null;
    if (!goalId && entityId?.startsWith("goal_")) goalId = entityId;
    if (!goalId && taskId) goalId = lookup.goalOfTask.get(taskId) ?? null;
    if (!goalId && reviewSource) goalId = lookup.goalOfTask.get(reviewSource) ?? null;
    const projectId = (goalId && lookup.projectOfGoal.get(goalId)) ?? (entityId?.startsWith("project_") ? entityId : null) ?? body.projectId ?? null;
    if (options.projectId && projectId !== options.projectId) return false;
    if (options.goalId && goalId !== options.goalId && entityId !== options.goalId && body.goalId !== options.goalId) return false;
    if (options.taskId && taskId !== options.taskId && reviewSource !== options.taskId && body.sourceTaskId !== options.taskId && body.reviewTaskId !== options.taskId) return false;
    return true;
  }
  pageScoped(options = {}) {
    const after = Number(options.after ?? 0); const limit = Math.max(1, Math.min(200, Number(options.limit ?? 100)));
    const goalIds = options.goalIds instanceof Set ? options.goalIds : new Set(options.goalIds ?? []);
    const latestCursor = this.cursor(); const select = this.db.prepare("SELECT * FROM events WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?");
    const scan = Math.max(limit, 50); const entries = []; let cursor = after;
    while (entries.length < limit) {
      const rows = select.all(cursor, latestCursor, scan);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.seq;
        if (!row.goal_id || !goalIds.has(row.goal_id)) continue;
        entries.push(this.eventEntry(row));
        if (entries.length >= limit) break;
      }
      if (rows.length < scan) break;
    }
    return { entries, nextCursor: cursor, latestCursor, hasMore: cursor < latestCursor };
  }
  eventEntry(row) {
    const body = JSON.parse(row.body); const decision = body.decision ?? null; const data = { ...body }; delete data.decision;
    return { seq: row.seq, at: row.at, type: row.type, entityId: row.entity_id, goalId: row.goal_id, actor: { kind: row.principal_kind ?? "system", id: row.actor }, onBehalfOf: row.on_behalf_of ? JSON.parse(row.on_behalf_of) : null, decision, data };
  }
  goalOf(entityId, body = {}) {
    if (!entityId) return null;
    if (entityId.startsWith("goal_")) return entityId;
    if (body.goalId) return body.goalId;
    if (entityId.startsWith("task_")) return this.get("tasks", entityId)?.goalId ?? null;
    if (entityId.startsWith("attempt_")) { const attempt = this.get("attempts", entityId); return attempt ? this.get("tasks", attempt.taskId)?.goalId ?? null : null; }
    if (entityId.startsWith("interaction_")) { const interaction = this.get("interactions", entityId); return interaction ? this.get("tasks", interaction.taskId)?.goalId ?? null : null; }
    if (entityId.startsWith("artifact_")) { const artifact = this.get("artifacts", entityId); return artifact ? this.get("tasks", artifact.taskId)?.goalId ?? null : null; }
    if (entityId.startsWith("verification_")) { const verification = this.get("verifications", entityId); return verification ? this.get("tasks", verification.taskId)?.goalId ?? null : null; }
    if (body.taskId) { const task = this.get("tasks", body.taskId); if (task) return task.goalId; }
    return null;
  }
  cursor() { return Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events").get().n); }

  command(actor, requestId, name, args, fn, options = {}) {
    assert(typeof requestId === "string" && requestId.length >= 8 && requestId.length <= 200, "IDEMPOTENCY_REQUIRED", "A stable request ID is required");
    const fingerprint = digest({ actor, name, args });
    let replayed = false;
    const result = this.transaction(() => {
      if (options.precheck) {
        const checked = options.precheck();
        assert(!checked || typeof checked.then !== "function", "ASYNC_TRANSACTION", "Authorization precheck must be synchronous");
      } else assert(actor?.kind !== "user-agent", "PRECHECK_REQUIRED", "External writes require a synchronous authorization precheck");
      const previous = this.db.prepare("SELECT * FROM commands WHERE id=?").get(requestId);
      if (previous) {
        replayed = true;
        assert(previous.fingerprint === fingerprint, "IDEMPOTENCY_CONFLICT", "Request ID reused with different input");
        return JSON.parse(previous.result);
      }
      const value = fn();
      this.event("command.accepted", value?.id ?? null, { command: name, requestId }, actor);
      const persisted = typeof options.persistResult === "function" ? options.persistResult(value) : value;
      this.db.prepare("INSERT INTO commands VALUES (?,?,?,?)").run(requestId, fingerprint, JSON.stringify(persisted ?? null), now());
      return value;
    });
    return options.meta === true ? { replayed, value: result } : result;
  }
  acquireLease(owner, pid = process.pid) {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM leases WHERE resource=?").get("scheduler");
      if (old && old.owner !== owner) {
        let live = true; try { process.kill(old.pid, 0); } catch (e) { if (e.code === "ESRCH") live = false; }
        assert(!live, "ENGINE_BUSY", "Another ACMS scheduler may still be running", { pid: old.pid });
      }
      const epoch = (old?.epoch ?? 0) + 1;
      this.db.prepare("INSERT OR REPLACE INTO leases VALUES (?,?,?,?,?)").run("scheduler", owner, pid, epoch, Date.now());
      return epoch;
    });
  }
  ownsLease(owner, epoch) { const row = this.db.prepare("SELECT owner,epoch FROM leases WHERE resource=?").get("scheduler"); return row?.owner === owner && row.epoch === epoch; }
  heartbeat(owner) { this.db.prepare("UPDATE leases SET heartbeat=? WHERE resource=? AND owner=?").run(Date.now(), "scheduler", owner); }
  releaseLease(owner) { this.db.prepare("DELETE FROM leases WHERE resource=? AND owner=?").run("scheduler", owner); }
  close() { this.events.removeAllListeners(); this.db.close(); }
}
