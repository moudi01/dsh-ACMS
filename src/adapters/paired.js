import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { startOwnedProcess, bounded, cleanupError } from '../runtime/owned-process.js';
import { assert, digest, OWNER, parseResult } from '../core/util.js';
import { parsePairedResult } from './paired-result.mjs';
import { ThreadStore } from '../../packages/codex-runtime/lib/store.js';
import { executionIdentity, ExecutionReceipt, assertNoUnknownRuns, readExecution } from '../runtime/execution-receipt.js';
import { environmentFailure, fileIdentity, programIdentity } from '../runtime/preflight.js';

const PROTOCOL = 'acms.runner.v1';
const LIMIT_KEYS = ['totalMs', 'idleMs', 'cleanupMs'];

export class PairedRuntimes {
  constructor(company, dataDir, options = {}) { this.company = company; this.store = company.store; this.dataDir = dataDir; this.running = new Map(); this.receipts = new Set(); this.spawn = options.spawn; this.ownedProcess = options.ownedProcess ?? startOwnedProcess; this.cleanupMs = options.cleanupMs ?? 5000; }
  list() { return this.store?.list('externalModels') ?? []; }
  limits(model) {
    const companyMs = this.company.policy().turnTimeoutMs;
    const declared = model.limits;
    const runnerMs = model.runtime === 'codex-app-server' ? companyMs : declared?.totalMs ?? null;
    const idleMs = model.runtime === 'codex-app-server' ? null : declared?.idleMs ?? null;
    return { companyMs, runnerMs, idleMs, runnerCleanupMs: declared?.cleanupMs ?? null,
      hostCleanupMs: this.cleanupMs, disposeMs: model.runtime === 'codex-app-server' ? this.cleanupMs + 1000 : this.cleanupMs,
      runnerSource: model.runtime === 'codex-app-server' ? 'acms' : declared ? 'declared' : 'unknown',
      effectiveTotalMs: Math.min(companyMs, runnerMs ?? companyMs),
      effectiveLimitKnown: runnerMs !== null,
      earliestKnownTimeoutMs: Math.min(companyMs, runnerMs ?? companyMs, idleMs ?? companyMs) };
  }
  async inspectEntry(id) {
    const model = this.store?.get('externalModels', id);
    if (!model) return { entry: 'unknown', failures: [] };
    const executable = await programIdentity(model.command, this.dataDir);
    const first = model.args?.[0];
    const script = first && path.isAbsolute(first) && /\.[cm]?js$/i.test(first) ? first : null;
    const scriptIdentity = script ? await fileIdentity(script) : null;
    const failures = [];
    if (!executable) failures.push(environmentFailure('program', '配对执行程序', true));
    if (script && !scriptIdentity) failures.push(environmentFailure('program', '配对启动脚本', true));
    return { entry: failures.length ? 'missing' : 'available', entryVersion: digest([executable, scriptIdentity]),
      limits: this.limits(model), failures };
  }
  async pending() {
    const invitations = this.store.list('modelInvites').filter(i => i.status === 'pending' && Date.parse(i.expiresAt) > Date.now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const i of invitations) {
      try { const stat = await fs.lstat(i.responseFile); if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) return { id: i.id, expiresAt: i.expiresAt, responseFile: i.responseFile }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return null;
  }
  async invite() {
    const id = randomUUID(); const token = randomBytes(24).toString('hex'); const directory = path.join(this.dataDir, 'pairing', id);
    await fs.mkdir(directory, { recursive: true }); const responseFile = path.join(directory, 'response.json');
    const invitation = { id, tokenHash: digest(token), responseFile, expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(), status: 'pending' };
    this.store.transaction(() => { this.store.put('modelInvites', invitation); this.store.event('model.invited', id, {}, OWNER); });
    const prompt = `请把你的本机 agent 运行环境配对给 ACMS，让 ACMS 能自动启动你使用的模型执行任务。请准备真实可运行的适配入口，不要伪造模型回答，不要启动检测或业务任务，不要安装/删除其他插件。
1. 确认本机已安装的 CLI/SDK、将由 runner 显式指定的模型 ID 与思考深度。CLI 默认配置不代表当前聊天实际模型；优先使用所有者指定值，未指定时说明配置值并请所有者选择。仅用本机只读状态命令核对登录方式；无法确认时标为未验证，不复制密钥，不向 ACMS 提交环境变量或认证文件。登记不等于连通性或账户额度验证。
2. 创建一个本机 runner，使用下述 JSON 协议，包装你实际使用的 CLI/SDK。把 runner 保存在 ${directory} 下，使用已有运行时的绝对可执行文件路径。不要依赖当前对话保持打开。
3. runner 从 stdin 读取一个 JSON 请求后执行，stdout 只返回一个 JSON 对象，日志写 stderr；任务未结束前不要退出，不可在后台遗留模型子进程。取消时 ACMS 会终止整个进程树。请求：{protocol:"${PROTOCOL}",requestId,mode:"probe"|"task",model,reasoningEffort,prompt,cwd,contextKey,retainContext,sandbox:"read-only"|"workspace-write",approvalPolicy:"never"}。
4. task 在 cwd 隔离工作目录执行 prompt，并返回 prompt 指定的结果对象。遵守 sandbox，不能通过绕过审批来实现无人值守。只有 runtime 支持时才声明上下文续接，并使用 contextKey 隔离任务与审查；retainContext=false 时创建新上下文。不继承这个配对对话。probe 是可选能力：仅在能确认工具和文件写入均被运行时禁用时声明 probeSupported=true，之后由用户手动触发真实模型调用并仅回复 OK。若不能确认，声明 probeSupported=false 和 probeReason，runner 收到 probe 必须在启动模型前返回失败；仍可登记可用的 task 入口。只读沙箱或提示词约束不能冒充禁用全部工具。
5. 最终响应：{protocol:"${PROTOCOL}",requestId,model,reasoningEffort,executed:true,output: ...}。probe 的 output 为模型的真实文本；task 的 output 是 ACMS 任务结果对象。失败响应 {protocol,requestId,model,error:"简短原因"} 并以非零状态退出。
6. 将以下回执 JSON 写入 ${responseFile}（UTF-8），替换示例值，保留 inviteId/token。command 是已有可执行文件的绝对路径；args 是固定参数数组（例如 runner 文件路径），不要提供 shell 命令字符串。reasoningEffort 未知时填 null，不得猜测。单请求 runner 可在 limits 中登记自身实际的 totalMs、idleMs、cleanupMs（毫秒），未知字段省略。无法满足协议时向用户说明原因，不生成成功回执。
Codex CLI 可选择原生会话协议以支持执行中即时消息：若已核对本机 CLI 支持 app-server，在回执中增加 runtime:"codex-app-server"，command/args 直接启动真实 Codex app-server（例如 Node 绝对路径 + [Codex CLI 绝对路径,"app-server"]），不创建单请求 JSON runner；此时上述 runner stdin/stdout 协议不适用，由 ACMS 管理 initialize、thread/start、turn/start、turn/steer 和进程清理。模型与思考深度仍须由所有者确认并在回执显式填写。probeSupported 必须为 false，不做模型调用或工具禁用能力推断。旧版单请求 runner 继续使用默认协议，实时干预需要中断并续接。
${JSON.stringify({ protocol: PROTOCOL, inviteId: id, token, name: '你的 agent 名称', model: '所有者选定的模型 ID', command: '运行时绝对路径', args: [path.join(directory, 'runner.mjs')], persistent: false, reasoningEffort: null, probeSupported: false, probeReason: '尚未验证运行时可禁用全部工具' }, null, 2)}
完成后请让用户回到 DSH → ACMS → 模型列表，点击“读取配对结果”检查配置并确认添加。此回执只登记运行环境，模型检测必须由用户点击触发。`;
    return { id, prompt, expiresAt: invitation.expiresAt, responseFile };
  }
  async inspect(id) {
    const invite = this.store.require('modelInvites', id);
    assert(invite.status === 'pending' && Date.parse(invite.expiresAt) > Date.now(), 'INVITE_EXPIRED', '配对邀请已使用或过期，请重新生成');
    let raw; try { const stat = await fs.lstat(invite.responseFile); assert(!stat.isSymbolicLink() && stat.isFile() && stat.size <= 65536, 'PAIRING_FILE', '配对回执必须是小于 64 KiB 的普通文件'); raw = await fs.readFile(invite.responseFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') throw Object.assign(new Error('尚未收到配对结果，请先把 prompt 交给目标 agent 完成配置'), { code: 'PAIRING_PENDING' }); throw e; }
    const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
    assert(input.protocol === PROTOCOL && input.inviteId === id && digest(input.token) === invite.tokenHash, 'PAIRING_TOKEN', '配对回执与本次邀请不匹配');
    for (const key of ['name', 'model', 'command']) assert(typeof input[key] === 'string' && input[key].trim().length && input[key].length <= 4096, 'PAIRING_INPUT', `缺少有效字段 ${key}`);
    assert(path.isAbsolute(input.command), 'PAIRING_COMMAND', '执行文件必须使用绝对路径');
    const command = await fs.realpath(input.command); assert((await fs.stat(command)).isFile(), 'PAIRING_COMMAND', '执行文件不存在');
    assert(process.platform !== 'win32' || /\.exe$/i.test(command), 'PAIRING_COMMAND', 'Windows 请使用 exe 运行时配合参数启动 runner，不接受 bat/cmd 或 shell 命令拼接');
    assert(Array.isArray(input.args) && input.args.length <= 40 && input.args.every(a => typeof a === 'string' && a.length <= 4096), 'PAIRING_INPUT', 'args 必须是固定参数数组');
    assert(typeof input.persistent === 'boolean' && (input.reasoningEffort == null || typeof input.reasoningEffort === 'string' && input.reasoningEffort.length <= 80), 'PAIRING_INPUT', '请声明上下文能力及实际思考深度');
    assert(input.probeSupported === undefined || typeof input.probeSupported === 'boolean', 'PAIRING_INPUT', 'probeSupported 必须是布尔值');
    assert(input.probeSupported !== false || typeof input.probeReason === 'string' && input.probeReason.trim().length > 0 && input.probeReason.length <= 500, 'PAIRING_INPUT', '请说明不支持无工具检测的原因');
    const model = { id: `paired:${id}`, name: input.name.trim(), model: input.model.trim(), command, args: input.args, persistent: input.persistent, reasoningEffort: input.reasoningEffort || null, ...(input.probeSupported === undefined ? {} : { probeSupported: input.probeSupported, probeReason: input.probeSupported ? null : input.probeReason.trim() }) };
    if (input.limits !== undefined) {
      assert(input.limits && typeof input.limits === 'object' && !Array.isArray(input.limits) &&
        Object.entries(input.limits).every(([key, ms]) => LIMIT_KEYS.includes(key) && Number.isSafeInteger(ms) && ms > 0 && ms <= 2147483647),
      'PAIRING_INPUT', 'limits 只接受已知的 totalMs、idleMs、cleanupMs 正整数');
      model.limits = input.limits;
    }
    assert(input.runtime === undefined || input.runtime === 'codex-app-server', 'PAIRING_INPUT', '未知运行协议');
    if (input.runtime === 'codex-app-server') {
      assert(input.args.includes('app-server') && input.probeSupported === false, 'PAIRING_INPUT', 'Codex 会话入口必须为 app-server，且不得声明无工具检测能力');
      model.runtime = input.runtime;
    }
    return { ...model, fingerprint: digest(model) };
  }
  async accept(id, fingerprint) {
    const model = await this.inspect(id); assert(model.fingerprint === fingerprint, 'PAIRING_CHANGED', '回执已变化，请重新读取并核对后添加');
    this.store.transaction(() => {
      const invite = this.store.require('modelInvites', id); assert(invite.status === 'pending', 'INVITE_EXPIRED', '邀请已使用');
      this.store.put('externalModels', model); this.store.put('modelInvites', { ...invite, status: 'accepted' }); this.store.event('model.paired', model.id, { model: model.model }, OWNER);
    });
    return model;
  }
  forget(id) {
    const inUse = this.store.list('agents').some(a => a.provider === id && a.status !== 'retired');
    assert(!inUse && ![...this.running.values()].some(r => r.modelId === id), 'MODEL_IN_USE', '请先为使用此模型的角色选择其他模型，并等待执行完成');
    this.store.transaction(() => { this.store.remove('externalModels', id); this.store.event('model.unpaired', id, {}, OWNER); });
    return { id };
  }
  execution(modelId, input) { return executionIdentity(this.store.require('externalModels', modelId), input); }
  readProgress(attempt) { return readExecution(this.dataDir, attempt); }
  async run(modelId, input, signal) {
    signal?.throwIfAborted();
    input = { ...input, attemptId: input.attemptId ?? randomUUID(), contextKey: input.contextKey ?? randomUUID(), generation: input.generation ?? 0, kind: input.kind ?? (input.mode === 'probe' ? 'probe' : 'chat') };
    const ref = this.execution(modelId, input);
    if (input.execution && digest(input.execution) !== digest(ref)) throw cleanupError('执行配置在持久化身份后发生变化');
    let receipt;
    try { assertNoUnknownRuns(this.dataDir, modelId, this.receipts); receipt = new ExecutionReceipt(this.dataDir, ref); }
    catch (error) { throw cleanupError(`执行台账拒绝重复或未知执行：${error.message}`, error); }
    this.receipts.add(ref.runKey);
    let response, failure;
    try {
      receipt.update({ status: 'running' });
      response = await this.runRunner(modelId, { ...input, execution: ref }, signal);
      return response;
    } catch (error) { failure = error; throw error; }
    finally {
      try { receipt.finish(response, failure); }
      catch (error) { failure = cleanupError(`无法发布可靠清理回执：${error.message}`, error); throw failure; }
      finally {
        this.receipts.delete(ref.runKey);
        if (failure?.cleanupUncertain && ![...this.running.values()].some(r => r.attemptId === input.attemptId)) {
          this.running.set(ref.runKey, { modelId, attemptId: input.attemptId, cleanupUncertain: true, cleanupError: failure.message });
        }
      }
    }
  }
  async runRunner(modelId, input, signal) {
    signal?.throwIfAborted(); const model = this.store.require('externalModels', modelId); const requestId = randomUUID();
    const held = [...this.running.values()].find(r => r.cleanupUncertain && r.modelId === modelId);
    if (held) throw cleanupError(held.cleanupError || '此执行器仍有未确认清理的执行，需先核对进程容器');
    assert(input.mode !== 'probe' || model.probeSupported !== false, 'PAIRED_PROBE_UNSUPPORTED', `此运行环境暂不支持无工具检测：${model.probeReason}`);
    if (model.runtime === 'codex-app-server') return this.runCodex(model, input, signal);
    const request = { ...input, protocol: PROTOCOL, requestId, model: model.model, reasoningEffort: model.reasoningEffort, approvalPolicy: 'never', sandbox: input.mode === 'probe' ? 'read-only' : 'workspace-write', retainContext: input.mode === 'task' && model.persistent && !input.freshContext };
    await fs.mkdir(input.cwd, { recursive: true }); signal?.throwIfAborted();
    const run = { modelId, attemptId: input.attemptId }; this.running.set(requestId, run);
    let timer, child, failure, stdout = '', bytes = 0;
    const aborted = Promise.withResolvers(); aborted.promise.catch(() => {});
    const stop = error => { failure ??= error; aborted.reject(failure); };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new Error('执行已取消'));
    try {
      child = run.child = await this.ownedProcess({ argv: [model.command, ...model.args], cwd: input.cwd,
        env: { ELECTRON_RUN_AS_NODE: '1' }, runMs: input.mode === 'probe' ? 40000 : this.company.policy().turnTimeoutMs }, { cleanupMs: this.cleanupMs, signal });
      timer = setTimeout(() => stop(new Error('执行器超时')), input.mode === 'probe' ? 40000 : this.company.policy().turnTimeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', b => { bytes += Buffer.byteLength(b); if (bytes > 2097152) stop(new Error('执行器响应超过 2 MiB')); else stdout += b; });
      child.stdout.on('error', stop); child.stderr.on('error', stop); child.stderr.resume();
      child.stdin.on('error', stop);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else child.stdin.end(JSON.stringify(request), () => { if (!failure && !signal?.aborted) input.onAccepted?.(); });
      const outcome = await Promise.race([child.done, aborted.promise]);
      if (failure) throw failure;
      if (outcome.cleanup?.reason) throw new Error(outcome.cleanup.reason);
      const result = parsePairedResult({ code: outcome.exitCode, stdout }, { requestId, model: model.model });
      assert(!result.error && result.executed === true, 'PAIRED_RUN_FAILED', '外部执行器未确认真实模型调用完成');
      assert(input.mode !== 'probe' || typeof result.output === 'string' && result.output.trim(), 'PAIRED_PROTOCOL', '检测未返回实际模型文本');
      return { ...result, output: input.mode === 'task' ? parseResult(result.output) : result.output };
    } catch (error) { if (error.cleanupUncertain) { run.cleanupUncertain = true; run.cleanupError = error.message; } throw error; }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { if (child) await bounded(child.cleanup(), this.cleanupMs, 'runner cleanup deadline exceeded'); }
      catch (error) { run.cleanupUncertain = true; run.cleanupError = error.message; throw error.cleanupUncertain ? error : cleanupError(error.message, error); }
      finally { if (!run.cleanupUncertain) this.running.delete(requestId); }
    }
  }
  canSteer(attemptId) { return !!attemptId && [...this.running.values()].some(r => r.attemptId === attemptId && r.handle?.canSteer()); }
  async steer(attemptId, text, signal) {
    const run = [...this.running.values()].find(r => r.attemptId === attemptId);
    assert(run?.handle?.canSteer(), 'CHAT_STALE', '原执行已结束或尚未接受消息');
    return run.handle.steer(text, signal);
  }
  taskMessages(attemptId) { return [...(this.running.get(attemptId)?.messages.values() ?? [])]; }
  async runCodex(model, input, signal) {
    const { startCodexRun } = await import('../../packages/codex-runtime/lib/index.js');
    signal ??= new AbortController().signal;
    await fs.mkdir(input.cwd, { recursive: true }); signal?.throwIfAborted();
    const runId = input.attemptId ?? randomUUID();
    const key = input.execution.threadKey;
    let store;
    try {
      store = new ThreadStore(path.join(this.dataDir, 'codex-chat-threads.json'), key);
      if (store.summary.status && store.summary.status !== 'idle') throw new Error('Previous Codex session is not reliably settled');
    } catch (error) { store?.quarantine(error.message); throw cleanupError(error.message, error); }
    const run = { modelId: model.id, attemptId: input.attemptId, messages: new Map() }; this.running.set(runId, run);
    try {
      store.update({ attemptId: input.attemptId, executionIdentity: input.execution, status: 'starting', terminalResult: null, lastSnippet: '', toolCalls: 0, turnTokenUsage: null });
      run.handle = await startCodexRun({ prompt: [{ type: 'text', text: input.prompt }], signal }, {
        argv: [model.command, ...model.args], cwd: input.cwd, model: model.model, reasoningEffort: model.reasoningEffort,
        permissionMode: 'acms-workspace', store, spawn: spec => this.ownedProcess({ ...spec, runMs: this.company.policy().turnTimeoutMs }, { spawn: this.spawn, cleanupMs: this.cleanupMs, signal }), env: { ELECTRON_RUN_AS_NODE: '1' },
        disposeGraceMs: 5000, startupTimeoutMs: 60000, turnTimeoutMs: this.company.policy().turnTimeoutMs,
        onAccepted: input.onAccepted,
        onNotification: (method, p) => {
          if (method === 'item/agentMessage/delta') { const item = run.messages.get(p.itemId) ?? { id: p.itemId, text: '' }; item.text = (item.text + p.delta).slice(-65536); run.messages.set(item.id, item); }
          if (method === 'item/completed' && p.item?.type === 'agentMessage') run.messages.set(p.item.id, { id: p.item.id, text: (p.item.text ?? '').slice(0,65536) });
          while (run.messages.size > 20) run.messages.delete(run.messages.keys().next().value);
        },
        onError: () => {},
      });
      const result = await run.handle.result;
      assert(result.stopReason === 'completed', 'PAIRED_RUN_FAILED', result.diagnostic || 'Codex 执行未完成');
      return { executed: true, reasoningEffort: model.reasoningEffort, output: parseResult(result.structured ?? result.output?.filter(b => b.type === 'text').map(b => b.text).join('\n')) };
    } catch (error) { if (error.cleanupUncertain) { run.cleanupUncertain = true; run.cleanupError = error.message; store.quarantine(error.message); } throw error; }
    finally {
      try {
        if (run.handle) await bounded(run.handle.dispose(), this.cleanupMs + 1000, 'Codex cleanup deadline exceeded');
        else if (!run.cleanupUncertain) await store.close('failed');
      } catch (error) { run.cleanupUncertain = true; run.cleanupError = error.message; store.quarantine(error.message); throw cleanupError(error.message, error); }
      finally { if (!run.cleanupUncertain) this.running.delete(runId); }
    }
  }
}
