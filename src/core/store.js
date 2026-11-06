import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import { assert, digest, now } from './util.js';

export class Store {
  constructor(filename) {
    this.filename = filename;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.events = new EventEmitter(); this.events.setMaxListeners(100);
    this.inTransaction = false; this.pending = [];
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (
        collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(collection,id));
      CREATE INDEX IF NOT EXISTS entities_status ON entities(collection,json_extract(body,'$.status'));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, entity_id TEXT, actor TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL, epoch INTEGER NOT NULL, heartbeat INTEGER NOT NULL);
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema');
    assert(!version || version.value === '1', 'SCHEMA_VERSION', 'This ACMS version cannot open the database schema');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('schema', '1');
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true; this.pending = [];
    let result, events;
    try {
      result = fn(); assert(!result?.then, 'ASYNC_TRANSACTION', 'No async work is allowed inside a transaction');
      this.db.exec('COMMIT'); events = this.pending;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; this.pending = []; }
    for (const event of events) this.events.emit('event', event);
    return result;
  }
  get(collection, entityId) {
    const row = this.db.prepare('SELECT body,revision FROM entities WHERE collection=? AND id=?').get(collection, entityId);
    return row ? { ...JSON.parse(row.body), revision: row.revision } : null;
  }
  require(collection, entityId) { const value = this.get(collection, entityId); assert(value, 'NOT_FOUND', `${collection}/${entityId} not found`); return value; }
  list(collection) { return this.db.prepare('SELECT body,revision FROM entities WHERE collection=? ORDER BY rowid').all(collection).map(r => ({ ...JSON.parse(r.body), revision: r.revision })); }
  put(collection, entity, expectedRevision) {
    const old = this.get(collection, entity.id);
    if (expectedRevision !== undefined) assert((old?.revision ?? 0) === expectedRevision, 'CONFLICT', 'This record changed; refresh and retry', { collection, id: entity.id });
    const saved = { ...entity, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? entity.createdAt ?? now(), updatedAt: now() };
    this.db.prepare('INSERT INTO entities VALUES (?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(collection, saved.id, saved.revision, JSON.stringify(saved));
    return saved;
  }
  remove(collection, entityId, expectedRevision) {
    const old = this.require(collection, entityId);
    if (expectedRevision !== undefined) assert(old.revision === expectedRevision, 'CONFLICT', '记录已变化，请刷新后重试');
    this.db.prepare('DELETE FROM entities WHERE collection=? AND id=?').run(collection, entityId);
  }
  event(type, entityId, body, actor) {
    assert(this.inTransaction, 'TRANSACTION_REQUIRED', 'Events and domain state must commit together');
    const at = now(); const principal = actor?.id ?? 'system';
    const r = this.db.prepare('INSERT INTO events(at,type,entity_id,actor,body) VALUES (?,?,?,?,?)').run(at, type, entityId, principal, JSON.stringify(body));
    const event = { seq: Number(r.lastInsertRowid), at, type, entityId, actor: principal, ...body };
    this.pending.push(event); return event;
  }
  page(after = 0, limit = 200) {
    const entries = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(r => ({ seq: r.seq, at: r.at, type: r.type, entityId: r.entity_id, actor: r.actor, ...JSON.parse(r.body) }));
    return { entries, nextCursor: entries.at(-1)?.seq ?? after, latestCursor: this.cursor() };
  }
  cursor() { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n); }
  command(actor, requestId, name, args, fn) {
    assert(typeof requestId === 'string' && requestId.length >= 8 && requestId.length <= 200, 'IDEMPOTENCY_REQUIRED', 'A stable request ID is required');
    const fingerprint = digest({ actor, name, args });
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM commands WHERE id=?').get(requestId);
      if (previous) { assert(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', 'Request ID reused with different input'); return JSON.parse(previous.result); }
      const result = fn();
      this.event('command.accepted', result?.id ?? null, { command: name, requestId }, actor);
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(requestId, fingerprint, JSON.stringify(result ?? null), now());
      return result;
    });
  }
  acquireLease(owner, pid = process.pid) {
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM leases WHERE resource=?').get('scheduler');
      if (old && old.owner !== owner) {
        let live = true; try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
        assert(!live, 'ENGINE_BUSY', 'Another ACMS scheduler may still be running', { pid: old.pid });
      }
      const epoch = (old?.epoch ?? 0) + 1;
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES (?,?,?,?,?)').run('scheduler', owner, pid, epoch, Date.now());
      return epoch;
    });
  }
  ownsLease(owner, epoch) { const row = this.db.prepare('SELECT owner,epoch FROM leases WHERE resource=?').get('scheduler'); return row?.owner === owner && row.epoch === epoch; }
  heartbeat(owner) { this.db.prepare('UPDATE leases SET heartbeat=? WHERE resource=? AND owner=?').run(Date.now(), 'scheduler', owner); }
  releaseLease(owner) { this.db.prepare('DELETE FROM leases WHERE resource=? AND owner=?').run('scheduler', owner); }
  close() { this.events.removeAllListeners(); this.db.close(); }
}
