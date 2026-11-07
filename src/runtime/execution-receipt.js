// Host-owned receipts, not model-authored files. A dead PID/lease never proves
// descendant cleanup. Readers are read-only and never reap a receipt lock.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../core/util.js';
import { atomicJson, fileStem } from '../../packages/codex-runtime/lib/store.js';

export function executionIdentity(model, input) {
  const identity = {
    provider: model.id, model: model.model, attemptId: input.attemptId,
    contextKey: input.contextKey, generation: input.generation, kind: input.kind,
    persistent: model.persistent === true && !input.freshContext && input.mode === 'task',
    runtime: model.runtime ?? 'runner',
  };
  if (!validIdentity(identity)) throw new Error('Incomplete execution identity');
  const runKey = `acms-run:${digest(identity)}`;
  const threadKey = identity.persistent
    ? `acms-context:${digest([identity.provider, identity.model, identity.contextKey, identity.generation, identity.kind])}` : runKey;
  return { version: 1, ...identity, runKey, threadKey };
}

function validIdentity(i) {
  return i && ['provider', 'model', 'attemptId', 'contextKey', 'kind'].every(k => typeof i[k] === 'string' && i[k].length > 0)
    && Number.isSafeInteger(i.generation) && i.generation >= 0 && typeof i.persistent === 'boolean'
    && ['runner', 'codex-app-server'].includes(i.runtime);
}
export function validExecution(ref) {
  if (!validIdentity(ref) || ref.version !== 1) return false;
  const expected = executionIdentity({ id: ref.provider, model: ref.model, persistent: ref.persistent, runtime: ref.runtime }, { ...ref, mode: 'task' });
  return ref.runKey === expected.runKey && ref.threadKey === expected.threadKey && digest(ref) === digest(expected);
}
export function receiptPaths(dataDir, ref) {
  const file = path.join(dataDir, 'paired-runs', `${digest(ref.runKey)}.json`);
  return { file, lock: `${file}.lock` };
}
export const unknownExecution = (reason, code = 'RECOVERY_UNKNOWN') => ({ status: 'unknown', code, reason, actions: ['refresh-receipt', 'inspect-execution'] });
const read = file => JSON.parse(readFileSync(file, 'utf8'));

export class ExecutionReceipt {
  constructor(dataDir, ref) {
    if (!validExecution(ref)) throw new Error('Invalid execution reference');
    this.ref = ref; this.paths = receiptPaths(dataDir, ref);
    mkdirSync(path.dirname(this.paths.file), { recursive: true });
    if (existsSync(this.paths.file)) throw new Error('Execution already has a receipt; reconcile instead of invoking the model again');
    // This lock is intentionally never stolen, including after host death.
    const fd = openSync(this.paths.lock, 'wx');
    try {
      writeFileSync(fd, JSON.stringify({ runKey: ref.runKey, pid: process.pid }));
      if (existsSync(this.paths.file)) throw new Error('Execution already has a receipt; reconcile instead of invoking the model again');
      this.value = { version: 1, identity: ref, status: 'starting', cleanupConfirmed: false, startedAt: new Date().toISOString() };
      this.update({});
    } finally { closeSync(fd); }
  }
  update(fields) {
    this.value = { ...this.value, ...fields, updatedAt: new Date().toISOString() };
    atomicJson(this.paths.file, this.value);
  }
  finish(response, error) {
    if (error?.cleanupUncertain) {
      this.update({ status: 'reconciling', cleanupConfirmed: false, reason: error.message });
      return; // keep lock and resource hold
    }
    this.update({ status: response ? 'completed' : 'stopped', cleanupConfirmed: true,
      finishedAt: new Date().toISOString(), response: response ?? null,
      reason: error?.message ?? '执行已结束，且自有进程树清理已确认' });
    unlinkSync(this.paths.lock); // publish the terminal receipt before unlocking
  }
}

// Protect all entry points after a host restart (including probes/chat), not
// just the engine's task slot. Current live executions may run concurrently.
export function assertNoUnknownRuns(dataDir, provider, liveKeys = new Set()) {
  const directory = path.join(dataDir, 'paired-runs');
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter(n => n.endsWith('.json'))) {
    const value = read(path.join(directory, name));
    if (!validExecution(value.identity)) throw new Error('配对回执身份损坏，需检查执行台账');
    if (value.identity.provider !== provider || liveKeys.has(value.identity.runKey)) continue;
    const ref = value.identity;
    const fact = readExecution(dataDir, { id: ref.attemptId, provider: ref.provider, model: ref.model, contextKey: ref.contextKey, taskGeneration: ref.generation, kind: ref.kind, execution: ref });
    if (name !== path.basename(receiptPaths(dataDir, ref).file) || !['completed', 'stopped'].includes(fact.status)) {
      throw new Error(`此前执行尚未完成可信清理：${value.identity.attemptId}；${value.reason ?? value.status}`);
    }
  }
  // A crash can leave a lock before the first JSON write.
  for (const name of readdirSync(directory).filter(n => n.endsWith('.json.lock'))) {
    if (!existsSync(path.join(directory, name.slice(0, -5)))) throw new Error('发现无回执的执行锁，需核对启动是否发生');
  }
}

export function readExecution(dataDir, attempt) {
  const ref = attempt.execution;
  if (!validExecution(ref)) return unknownExecution('缺少或损坏的执行身份；旧版本运行不能通过 contextKey 推测结果', 'RECOVERY_IDENTITY');
  if (ref.provider !== attempt.provider || ref.model !== attempt.model || ref.attemptId !== attempt.id
    || ref.contextKey !== attempt.contextKey || ref.generation !== attempt.taskGeneration || ref.kind !== attempt.kind) {
    return unknownExecution('执行身份与任务记录不匹配（provider/model/attempt/context/generation/kind）', 'RECOVERY_IDENTITY');
  }
  const paths = receiptPaths(dataDir, ref);
  try {
    const value = read(paths.file);
    if (value.version !== 1 || digest(value.identity) !== digest(ref)) return unknownExecution('回执身份与本次执行不匹配', 'RECOVERY_IDENTITY');
    // access errors and malformed locks remain uncertainty. Never inspect a
    // lock owner PID and infer that the model's descendants have stopped.
    let locked;
    try { readFileSync(paths.lock); locked = true; } catch (error) { if (error.code !== 'ENOENT') throw error; locked = false; }
    if (locked || value.cleanupConfirmed !== true || !['completed', 'stopped'].includes(value.status)) {
      let progress = {};
      if (ref.runtime === 'codex-app-server') {
        const summary = read(path.join(dataDir, 'codex-threads', `${fileStem(ref.threadKey)}.summary.json`));
        if (summary.key !== ref.threadKey || digest(summary.executionIdentity) !== digest(ref) || (summary.model && summary.model !== ref.model)) return unknownExecution('Codex 进度身份与本次执行不匹配', 'RECOVERY_IDENTITY');
        const { threadId, turnId, lastSnippet, toolCalls, turnTokenUsage, updatedAt } = summary;
        progress = { threadId, turnId, lastSnippet, toolCalls, tokenUsage: turnTokenUsage, updatedAt };
      }
      return { ...unknownExecution(value.reason ?? (locked ? '执行锁仍存在；运行状态和进程树退出尚未确认' : '未收到已结束且清理完成的回执'), 'RECOVERY_PENDING'), ...progress };
    }
    if (!Number.isFinite(Date.parse(value.finishedAt))) return unknownExecution('结束回执缺少有效完成时间', 'RECOVERY_CORRUPT');
    if (value.status === 'completed') {
      const output = value.response?.output;
      const complete = ref.kind === 'probe' ? typeof output === 'string' && output.trim().length > 0 : output && typeof output === 'object' && !Array.isArray(output);
      if (value.response?.executed !== true || !complete) return unknownExecution('完成回执没有完整结果，不能据此重新调用模型', 'RECOVERY_CORRUPT');
      return { status: 'completed', cleanupConfirmed: true, finishedAt: value.finishedAt, result: value.response.output, reason: '身份匹配的完成回执与进程树清理已核实；恢复结果，无需模型调用', actions: [] };
    }
    if (value.response != null) return unknownExecution('停止回执含有冲突的完成结果', 'RECOVERY_CORRUPT');
    return { status: 'stopped', cleanupConfirmed: true, reason: value.reason, actions: ['retry'] };
  } catch (error) {
    return unknownExecution(`无法读取可靠执行状态：${error.code ?? error.name}；${error.message}`, error.code === 'ENOENT' ? 'RECOVERY_MISSING' : 'RECOVERY_CORRUPT');
  }
}
