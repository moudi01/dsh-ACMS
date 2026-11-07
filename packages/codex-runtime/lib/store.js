import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); renameSync(temp, path); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function fileStem(key) {
  const encoded = encodeURIComponent(key).replace(/[.!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  // Prefix avoids Windows device names. Hash also protects case-insensitive filesystems.
  return 't-' + encoded.slice(0, 100) + '-' + createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function acquireLease(path) {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      closeSync(fd);
      return () => { if (readJson(path, {})?.token === token) unlinkSync(path); };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
      if (error.code !== 'EEXIST') throw error;
      // Never steal a live or ambiguous lease. A partially written lock may be live.
      let owner;
      try { owner = readJson(path, null); } catch {}
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probe) {
          if (probe.code === 'ESRCH') {
            // An exclusive recovery lock prevents two reapers deleting a fresh lease.
            const recovery = path + '.recover';
            let releaseRecovery;
            try {
              releaseRecovery = acquireLease(recovery);
              if (readJson(path, {})?.token === owner.token) unlinkSync(path);
            } catch (reap) { if (reap.code !== 'CODEX_THREAD_BUSY' && reap.code !== 'ENOENT') throw reap; }
            finally { releaseRecovery?.(); }
            continue;
          }
        }
      }
      const busy = new Error('codex-runtime: thread key is already running (retry after it settles)');
      busy.code = 'CODEX_THREAD_BUSY';
      throw busy;
    }
  }
  const busy = new Error('codex-runtime: thread lease is busy');
  busy.code = 'CODEX_THREAD_BUSY';
  throw busy;
}

const TOOL_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall']);

export class ThreadStore {
  constructor(stateFile, key) {
    this.stateFile = resolve(stateFile);
    this.stateDir = dirname(this.stateFile);
    this.key = key;
    this.stem = fileStem(key);
    this.eventFile = `codex-threads/${this.stem}.ndjson`;
    this.summaryFile = `codex-threads/${this.stem}.summary.json`;
    this.eventsPath = resolve(this.stateDir, this.eventFile);
    this.summaryPath = resolve(this.stateDir, this.summaryFile);
    this.lockPath = resolve(this.stateDir, `codex-threads/${this.stem}.lock`);
    this.release = acquireLease(this.lockPath);
    this.toolIds = new Set();
    try {
      const index = readJson(this.stateFile, {});
      this.summary = readJson(this.summaryPath, Object.hasOwn(index, key) ? index[key] : null) ?? {
        threadId: null, turns: 0, createdAt: new Date().toISOString(), lastSnippet: '', tokenUsage: null,
        turnTokenUsage: null, currentTurn: null, turnId: null, totalToolCalls: 0
      };
      this.summary = { ...this.summary, key, eventFile: this.eventFile, summaryFile: this.summaryFile };
      if (this.summary.cleanupPending) throw Object.assign(new Error('codex-runtime: previous process cleanup requires reconciliation'), { code: 'CODEX_THREAD_BUSY', cleanupUncertain: true });
      this.seq = this.summary.lastSeq ?? 0;
      // Recover an append that reached disk before its summary. Drop only a partial final line.
      if (existsSync(this.eventsPath)) {
        const bytes = readFileSync(this.eventsPath);
        const end = bytes.lastIndexOf(10);
        if (end + 1 !== bytes.length) writeFileSync(this.eventsPath, bytes.subarray(0, end + 1));
        const last = bytes.subarray(0, end).toString('utf8').trimEnd().split('\n').at(-1);
        if (last) this.seq = Math.max(this.seq, JSON.parse(last).seq);
      }
    } catch (error) { this.release(); throw error; }
  }
  async publish(signal) {
    let release;
    const deadline = Date.now() + 10000;
    while (!release) {
      signal?.throwIfAborted();
      try { release = acquireLease(this.stateFile + '.lock'); }
      catch (error) { if (error.code !== 'CODEX_THREAD_BUSY' || Date.now() >= deadline) throw error; await delay(20, undefined, { signal }); }
    }
    try {
      const index = readJson(this.stateFile, {});
      Object.defineProperty(index, this.key, { value: this.summary, enumerable: true, configurable: true, writable: true });
      atomicJson(this.stateFile, index);
    } finally { release(); }
  }
  update(fields) {
    Object.assign(this.summary, fields, { updatedAt: new Date().toISOString(), lastSeq: this.seq });
    atomicJson(this.summaryPath, this.summary);
  }
  record(method, params = {}) {
    const threadId = params.threadId ?? params.thread?.id ?? this.summary.threadId ?? null;
    const turnId = params.turnId ?? params.turn?.id ?? this.summary.currentTurn ?? null;
    const event = { seq: ++this.seq, at: new Date().toISOString(), key: this.key, threadId, turnId, method, params };
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
    const fields = {};
    if (method === 'turn/started') Object.assign(fields, { status: 'running', lastStatus: 'running' });
    if (method === 'turn/started' && this.summary.currentTurn !== turnId) {
      Object.assign(fields, { status: 'running', lastStatus: 'running', currentTurn: turnId, turnId, startedAt: event.at, toolCalls: 0, turnTokenUsage: null });
      fields.turns = (this.summary.turns ?? 0) + 1;
    }
    if (method === 'item/started' && TOOL_TYPES.has(params.item?.type)) {
      const id = `${turnId}:${params.item.id}`;
      if (!this.toolIds.has(id)) { this.toolIds.add(id); fields.toolCalls = (this.summary.toolCalls ?? 0) + 1; fields.totalToolCalls = (this.summary.totalToolCalls ?? 0) + 1; }
    }
    if (method === 'item/agentMessage/delta') {
      if (this.messageId !== params.itemId) { this.messageId = params.itemId; this.messageText = ''; }
      this.messageText = (this.messageText ?? '') + (params.delta ?? '');
      // Only the last 512 characters are retained in memory/the summary.
      this.messageText = this.messageText.slice(-512);
      fields.lastSnippet = this.messageText;
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') fields.lastSnippet = (params.item.text ?? '').slice(-512);
    if (method === 'thread/tokenUsage/updated') {
      fields.tokenUsage = params.tokenUsage;
      fields.turnTokenUsage = params.tokenUsage?.last;
    }
    if (method === 'turn/completed') Object.assign(fields, { lastStatus: params.turn?.status, completedAt: event.at });
    this.update(fields);
    return event;
  }
  quarantine(reason) {
    // A dead host/expired lock is not evidence that its descendants stopped.
    // Persist the hold before returning; retain this run's lease on disk.
    this.quarantined = true;
    try { this.update({ status: 'reconciling', cleanupPending: true, cleanupError: reason }); }
    catch (error) { throw Object.assign(error, { cleanupUncertain: true, code: 'PAIRED_CLEANUP_UNCONFIRMED' }); }
  }
  async close(status, extra = {}) {
    if (this.closed) return;
    if (this.quarantined) throw Object.assign(new Error(this.summary.cleanupError), { cleanupUncertain: true, code: 'PAIRED_CLEANUP_UNCONFIRMED' });
    try {
      this.record('provider/runSettled', { status, ...extra });
      this.update({ ...extra, status: 'idle', lastStatus: status, currentTurn: null });
      await this.publish();
    } finally { this.closed = true; this.release(); }
  }
}
