import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { asBusyError, assert, digest, now } from "./util.js";

export const SCHEMA_VERSION = "2";

/**
 * Events that count as effective business activity for issue #17 ordering.
 * Progress pings, heartbeats, notifications and other polling-adjacent writes
 * stay out so they can never bump a project, goal or task to the top.
 */
export const EFFECTIVE_ACTIVITY_EVENTS = [
  "project.saved", "goal.created", "goal.status.changed", "goal.succeeded", "goal.reopened", "goal.runtime.extended",
  "goal.contract.changed", "goal.contract.assessed",
  "goal.paused", "goal.resumed", "goal.cancelled",
  "task.created", "task.changed", "task.dependencies", "task.blocked", "task.resumed", "task.retry.scheduled",
  "task.stop.completed", "task.succeeded", "task.restored", "task.deleted", "task.purged",
  "attempt.claimed", "attempt.starting", "attempt.finished", "attempt.failed", "attempt.recovery", "attempt.result.recovered",
  "review.queued", "review.requested", "review.decided", "review.rework.requested", "review.rework.limit", "review.rework.gate",
  "coordination.created", "coordination.decided", "coordination.applied", "blocker.coordinated", "task.integration.resumed",
  "integration.started", "integration.checking", "integration.applying", "integration.completed", "integration.stopped", "integration.reconciling", "integration.failed",
  "interaction.answered",
];

export class Store {
  constructor(filename) {
    this.filename = filename;
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
    const goalId = options.goalId ?? this.goalOf(entityId, body);
    const r = this.db.prepare("INSERT INTO events(at,type,entity_id,goal_id,actor,principal_kind,on_behalf_of,body) VALUES (?,?,?,?,?,?,?,?)").run(at, type, entityId, goalId, principal, principalKind, onBehalfOf, JSON.stringify(body));
    const event = { seq: Number(r.lastInsertRowid), at, type, entityId, goalId, actor: principal, principalKind, onBehalfOf: actor?.kind === "user-agent" ? actor.onBehalfOf ?? null : null, ...body };
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
    const rows = this.db.prepare(`SELECT entity_id AS id, at, body FROM events WHERE entity_id IS NOT NULL AND type IN (${marks})`).all(...types);
    const attemptTask = new Map(this.list("attempts").map(item => [item.id, item.taskId]));
    const interactionTask = new Map(this.list("interactions").map(item => [item.id, item.taskId]));
    const byEntity = new Map();
    for (const row of rows) {
      let taskId = null;
      try { taskId = JSON.parse(row.body)?.taskId ?? null; } catch { taskId = null; }
      const target = taskId ?? attemptTask.get(row.id) ?? interactionTask.get(row.id) ?? row.id;
      const current = byEntity.get(target);
      if (!current || String(row.at) > String(current)) byEntity.set(target, row.at);
    }
    return byEntity;
  }
  page(after = 0, limit = 200) {
    const entries = this.db.prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit).map(r => ({ seq: r.seq, at: r.at, type: r.type, entityId: r.entity_id, actor: r.actor, ...JSON.parse(r.body) }));
    return { entries, nextCursor: entries.at(-1)?.seq ?? after, latestCursor: this.cursor() };
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
