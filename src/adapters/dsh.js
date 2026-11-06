import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assert, parseResult, digest, OWNER } from '../core/util.js';
import { inside } from '../runtime/workspaces.js';
import { PairedRuntimes } from './paired.js';

export class DshAdapter {
  constructor(ctx, company, dataDir, options = {}) { this.ctx = ctx; this.company = company; this.dataDir = dataDir; this.parent = null; this.creatingParent = null; this.activations = new Map(); this.metadata = new Map(); this.diagnostics = new Map(); this.activeProbes = 0; this.paired = options.paired ?? new PairedRuntimes(company, dataDir, { spawn: spec => ctx.subprocess.spawn(spec) }); }
  providers() {
    const native = [...this.ctx.subagents.providers.values()].filter(p => typeof p.prepareContinuable === 'function' && p.capabilities.agentOptions).map(p => ({ name: p.name, model: null, capabilities: p.capabilities, persistent: false, local: true, origin: 'internal', inheritsParentContext: p.inheritsParentContext === true }));
    return [...native, ...this.paired.list().map(p => ({ name: p.id, displayName: p.name, model: p.model, capabilities: {}, persistent: p.persistent, local: false, origin: 'external', inheritsParentContext: false, reasoningEffort: p.reasoningEffort, probeSupported: p.probeSupported, probeReason: p.probeReason }))];
  }
  healthKey(route) { return digest([route.provider, route.llmProvider || '', route.model, route.reasoningEffort || '']); }
  healthFor(route) {
    const result = this.company.store?.get('modelHealth', this.healthKey(route));
    return result && Date.now() - Date.parse(result.checkedAt) < 10 * 60000 ? result : { status: 'untested', reason: result ? '上次检测已过期，请重新检测' : '尚未执行实际连通性检测' };
  }
  defaultModel() { return this.ctx.get?.('agentDefaultModel')?.currentSelection() ?? {}; }
  ordered(providers) {
    const order = ['spawn', 'fork'];
    return providers.slice().sort((a, b) => (order.indexOf(a.name) < 0 ? 100 : order.indexOf(a.name)) - (order.indexOf(b.name) < 0 ? 100 : order.indexOf(b.name)));
  }
  async modelCatalog() {
    // Use DSH's live registries; provider aliases are not model identities.
    const policy = this.company.policy(); const defaults = this.defaultModel();
    const providers = this.ordered(this.providers().filter(p => !policy.allowedProviders.length || policy.allowedProviders.includes(p.name)));
    const llm = this.ctx.get?.('llm'); const native = []; const warnings = [];
    if (llm && providers.some(p => p.capabilities.agentOptions)) {
      const registrations = llm.listProviders();
      const results = await Promise.allSettled(registrations.map(p => llm.listModels(p.id)));
      results.forEach((r, i) => { if (r.status === 'fulfilled') native.push(...r.value); else warnings.push(`无法读取 ${registrations[i].name} 的模型列表`); });
      if (defaults.model && registrations.some(p => p.id === defaults.provider) && !native.some(m => m.id === defaults.model && m.provider === defaults.provider)) native.unshift({ id: defaults.model, provider: defaults.provider });
      native.sort((a, b) => Number(b.provider === defaults.provider && b.id === defaults.model) - Number(a.provider === defaults.provider && a.id === defaults.model) || Number(b.provider === defaults.provider) - Number(a.provider === defaults.provider));
    }
    const models = new Map();
    const add = (model, p, llmProvider = '') => {
      if (!model || (policy.allowedModels.length && !policy.allowedModels.includes(model))) return;
      const entry = models.get(model) ?? { id: model, routes: [] };
      const info = native.find(m => m.id === model && m.provider === llmProvider);
      const savedDepth = defaults.model === model && defaults.provider === llmProvider ? defaults.reasoningEffort : null;
      const reasoning = p.origin === 'external' ? { effective: p.reasoningEffort, source: '配对 agent 声明', selectable: false, efforts: [] } : { effective: savedDepth ?? info?.reasoning?.defaultEffort ?? null, configured: savedDepth ?? info?.reasoning?.defaultEffort ?? null, efforts: info?.reasoning?.efforts ?? [], selectable: !!info?.reasoning?.efforts?.length, source: savedDepth ? 'DSH 默认配置' : 'DSH 模型列表' };
      const route = { provider: p.name, llmProvider, displayName: p.displayName || llm.listProviders().find(x => x.id === llmProvider)?.name || llmProvider, reasoning, persistent: p.persistent, origin: p.origin, inheritsParentContext: p.inheritsParentContext, probeSupported: p.probeSupported, probeReason: p.probeReason, health: this.healthFor({ provider: p.name, llmProvider, model }) };
      if (!entry.routes.some(r => r.provider === p.name && r.llmProvider === llmProvider)) entry.routes.push(route);
      models.set(model, entry);
    };
    for (const p of providers) {
      if (p.capabilities.agentOptions) for (const m of native) add(m.id, p, m.provider);
      else add(p.model, p);
    }
    const first = [...models.values()].flatMap(m => m.routes.filter(r => r.health.status !== 'unavailable').map(r => ({ model: m.id, ...r })))[0];
    return { models: [...models.values()], defaultSelection: first ?? null, warnings };
  }
  diagnostic(work, signal, timeoutMs = 45000) {
    const id = randomUUID(); const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`模型检测超时（${timeoutMs / 1000} 秒）`)), timeoutMs);
    const abort = () => controller.abort(signal.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const promise = Promise.resolve().then(() => work(controller.signal)).finally(() => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.diagnostics.delete(id); });
    this.diagnostics.set(id, { controller, promise }); return promise;
  }
  async modelDetails(input, signal) {
    const provider = await this.choose(input, { ignoreHealth: true }); input = { ...input, provider: provider.name, llmProvider: provider.llmProvider ?? '', model: provider.model }; const key = this.healthKey(input);
    const cached = this.metadata.get(key);
    let details = cached && Date.now() - cached.at < 60000 ? cached.value : null;
    if (!details) {
      details = await this.diagnostic(async checkSignal => {
        if (provider.capabilities.agentOptions) {
          const info = await this.ctx.get('llm').resolveModelInfo(provider.llmProvider, provider.model, checkSignal);
          const defaultSelection = this.defaultModel(); const same = defaultSelection.provider === provider.llmProvider && defaultSelection.model === provider.model;
          return { reasoning: { efforts: info.reasoning?.efforts ?? [], effective: (same ? defaultSelection.reasoningEffort : null) ?? info.reasoning?.defaultEffort ?? null, source: same && defaultSelection.reasoningEffort ? 'DSH 默认配置' : info.reasoning?.defaultEffort ? '模型通道配置' : '服务默认（未公开）', selectable: !!info.reasoning?.efforts?.length } };
        }
        return { reasoning: { effective: provider.reasoningEffort ?? null, source: '配对 agent 声明', selectable: false, efforts: [] } };
      }, signal, 20000);
      this.metadata.set(key, { at: Date.now(), value: details });
    }
    const selected = input.reasoningEffort || details.reasoning.effective;
    if (input.reasoningEffort) assert(details.reasoning.selectable && details.reasoning.efforts.some(e => e.id === input.reasoningEffort), 'REASONING_UNSUPPORTED', '所选执行方式不支持这个思考深度');
    return { ...details, reasoning: { ...details.reasoning, configured: details.reasoning.effective, effective: selected, source: input.reasoningEffort ? '角色指定' : details.reasoning.source }, health: this.healthFor(input), provider: provider.name, model: provider.model };
  }
  async probeModel(input, signal) {
    assert(!this.activeProbes, 'MODEL_CHECK_BUSY', '已有模型检测正在进行，请稍候');
    const active = this.company.store?.list('attempts').filter(a => ['preparing', 'running', 'cancelling', 'reconciling'].includes(a.status) || a.cleanupPending).length ?? 0;
    assert(active + (this.activeChats ?? 0) < this.company.policy().maxConcurrent, 'ACTIVE_LIMIT', '执行资源已满，请等待任务结束后再检测');
    this.activeProbes++;
    let result; const started = Date.now();
    try {
      const provider = await this.choose(input, { ignoreHealth: true });
      input = { ...input, provider: provider.name, llmProvider: provider.llmProvider ?? '', model: provider.model };
      result = await this.diagnostic(async checkSignal => {
        if (!provider.capabilities.agentOptions) {
          const response = await this.paired.run(provider.name, { mode: 'probe', cwd: path.join(this.dataDir, 'diagnostics', randomUUID()), prompt: 'Reply OK only.', contextKey: null }, checkSignal);
          return { reasoning: { effective: response.reasoningEffort ?? null, source: '执行器实际返回', selectable: false, efforts: [] } };
        }
        const details = await this.modelDetails(input, checkSignal); let finished = false;
        for await (const chunk of this.ctx.get('llm').stream({ provider: provider.llmProvider, model: provider.model, ...(details.reasoning.effective ? { reasoningEffort: details.reasoning.effective } : {}), messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK only. This is a connectivity check.' }] }], tools: [], maxTokens: 64, signal: checkSignal })) {
          if (chunk.type === 'finish') { assert(!['error', 'content-filter'].includes(chunk.reason), 'MODEL_PROBE_FAILED', '模型请求未正常结束'); finished = true; }
        }
        assert(finished, 'MODEL_PROBE_FAILED', '模型连接结束但没有返回完成标记'); return details;
      }, signal);
      result = { ...result, status: 'available', reason: '实际模型请求已成功完成' };
    } catch (e) {
      if (signal?.aborted || this.closing || e.code === 'PAIRED_PROBE_UNSUPPORTED') throw e;
      result = { status: 'unavailable', reason: diagnosticMessage(e), code: String(e.code ?? 'MODEL_CHECK_FAILED') };
    } finally { this.activeProbes--; }
    result = { ...result, id: this.healthKey(input), checkedAt: new Date().toISOString(), latencyMs: Date.now() - started };
    if (this.company.store) this.company.store.transaction(() => { this.company.store.put('modelHealth', result); this.company.store.event('model.checked', result.id, { status: result.status }, OWNER); });
    return result;
  }
  async root() {
    if (this.parent) return this.parent;
    if (!this.creatingParent) this.creatingParent = this.ctx.agents.create({ sessionId: `acms-root-${randomUUID()}`, meta: { cwd: this.dataDir }, agentOptions: {} }).then(handle => { this.parent = handle; return handle; });
    return this.creatingParent;
  }
  async choose(agent, { ignoreHealth = false } = {}) {
    const all = this.providers(); const policy = this.company.policy();
    const allowed = this.ordered(all.filter(p => !policy.allowedProviders.length || policy.allowedProviders.includes(p.name)));
    const automatic = !agent.provider || agent.provider === 'auto';
    const catalog = await this.modelCatalog();
    const preferred = automatic ? (agent.model ? catalog.models.find(m => m.id === agent.model)?.routes.find(r => ignoreHealth || r.health.status !== 'unavailable') : catalog.defaultSelection) : null;
    if (automatic && agent.model && !preferred && catalog.models.some(m => m.id === agent.model)) assert(false, 'MODEL_UNAVAILABLE', '该模型的执行配置最近均检测失败，请重新检测或选择其他模型');
    const selected = automatic ? allowed.find(p => p.name === preferred?.provider) ?? allowed[0] : allowed.find(p => p.name === agent.provider);
    assert(selected, 'NO_PROVIDER', '当前执行配置已移除或未配对，请从 DSH 模型列表选择，或先配对外部 agent');
    const model = agent.model || (selected.capabilities.agentOptions ? (preferred?.model ?? this.defaultModel().model) : selected.model);
    assert(!policy.allowedModels.length || policy.allowedModels.includes(model), 'MODEL_DENIED', 'Model is unknown or outside the owner policy');
    if (!selected.capabilities.agentOptions) {
      if (!ignoreHealth) assert(this.healthFor({ ...agent, provider: selected.name, model }).status !== 'unavailable', 'MODEL_UNAVAILABLE', '该模型最近连通性检测失败，请重新检测或改用其他模型');
      assert(!agent.model || selected.model === agent.model, 'MODEL_ROUTE_MISMATCH', '所选模型与执行器配置不一致，请重新选择模型');
      assert(!agent.reasoningEffort, 'REASONING_UNSUPPORTED', '外部执行器使用其自身配置的思考深度，请在模型详情中查看');
      return { ...selected, model };
    }
    const routes = catalog.models.find(m => m.id === model)?.routes.filter(r => r.provider === selected.name) ?? [];
    const route = agent.llmProvider ? routes.find(r => r.llmProvider === agent.llmProvider) : routes[0];
    assert(route, 'MODEL_UNAVAILABLE', '所选模型当前没有可用的 DSH 模型通道，请刷新后重新选择');
    if (!ignoreHealth) assert(this.healthFor({ ...agent, provider: selected.name, llmProvider: route.llmProvider, model }).status !== 'unavailable', 'MODEL_UNAVAILABLE', '该模型最近连通性检测失败，请重新检测或改用其他模型');
    return { ...selected, model, llmProvider: route.llmProvider };
  }
  async start({ task, attempt, agent, prompt, signal, onAccepted }) {
    const provider = await this.choose(agent);
    if (provider.origin === 'external') {
      const result = this.paired.run(provider.name, { mode: 'task', attemptId: attempt.id, cwd: task.workspace.path, contextKey: attempt.contextKey, prompt, onAccepted }, signal).then(r => {
        if (this.company.store) this.company.store.transaction(() => { const saved = this.company.store.get('attempts', attempt.id); if (saved) this.company.store.put('attempts', { ...saved, reasoningEffort: r.reasoningEffort ?? null }); });
        return r.output;
      });
      return { accepted: false, childId: attempt.id, parentId: null, provider: provider.name, model: provider.model, reasoningEffort: provider.reasoningEffort, result, dispose: () => result.catch(error => { if (error.cleanupUncertain) throw error; }) };
    }
    const parentHandle = await this.root(); signal.throwIfAborted();
    const reasoning = provider.capabilities.agentOptions ? await this.modelDetails(agent, signal) : null;
    const activation = await this.ctx.subagents.startActivation({ provider: provider.name, label: attempt.contextKey,
      request: { parent: parentHandle.agent, cwd: task.workspace.path, prompt: [{ type: 'text', text: prompt }],
        ...(provider.capabilities.agentOptions ? { agentOptions: { provider: provider.llmProvider, model: provider.model, ...(reasoning?.reasoning.effective ? { reasoningEffort: reasoning.reasoning.effective } : {}) } } : {}),
        ...(provider.capabilities.depthLimit ? { maxDepth: 1 } : {}),
      }, signal, delivery: 'caller' });
    this.activations.set(attempt.id, activation);
    let disposing;
    const dispose = () => disposing ??= Promise.resolve(activation.dispose()).finally(() => { this.activations.delete(attempt.id); signal.removeEventListener('abort', abort); });
    const abort = () => { dispose().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    const result = Promise.resolve(activation.result).then(value => {
      assert(value.stopReason === 'completed', 'PROVIDER_FAILED', value.diagnostic ?? `Provider ended with ${value.stopReason}`);
      return parseResult(value.structured ?? value.output?.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    });
    return { childId: activation.childId, parentId: parentHandle.agent.id, provider: provider.name, model: provider.model, reasoningEffort: reasoning?.reasoning.effective ?? null, result, dispose };
  }
  canSteer(attempt) {
    return this.activations.has(attempt.id) && typeof this.ctx.subagents.sendMessage === 'function' || this.paired.canSteer?.(attempt.id) === true;
  }
  async steer(attempt, text, signal) {
    signal?.throwIfAborted();
    if (attempt.provider?.startsWith('paired:')) return this.paired.steer(attempt.id, text, signal);
    const activation = this.activations.get(attempt.id);
    assert(activation && activation.childId === attempt.childId, 'CHAT_STALE', '原执行已结束或正在关闭');
    return this.ctx.subagents.sendMessage(this.parent.agent, activation.childId, [{ type: 'text', text }], { signal });
  }
  async taskMessages(attempt) {
    if (attempt.provider?.startsWith('paired:')) return this.paired.taskMessages?.(attempt.id) ?? [];
    const messages = this.ctx.agents.get(attempt.childId)?.session?.deriveMessages() ?? [];
    return messages.filter(m => m.role === 'assistant').slice(-20).map((m, i) => ({ id: m.id ?? `assistant-${i}`, text: m.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '' }));
  }
  async chat({ agent, prompt, cwd, contextKey, signal, onAccepted, onText }) {
    const provider = await this.choose(agent);
    if (provider.origin === 'external') {
      const response = await this.paired.run(provider.name, { mode: 'task', cwd, contextKey, freshContext: true, onAccepted,
        prompt: `${prompt}\nThis is a standalone conversation in a private scratch directory. Return only JSON {"outcome":"completed","summary":"your natural-language reply","artifacts":[]}. Do not alter company state.` }, signal);
      const text = response.output.summary; if (text) onText(text); return text;
    }
    const details = await this.modelDetails(agent, signal); let text = '', accepted = false, finished = false;
    for await (const chunk of this.ctx.get('llm').stream({ provider: provider.llmProvider, model: provider.model,
      ...(details.reasoning.effective ? { reasoningEffort: details.reasoning.effective } : {}),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], maxTokens: 4096, signal })) {
      if (!accepted) { onAccepted(); accepted = true; }
      if (chunk.type === 'text-delta') { text += chunk.text; onText(text); }
      if (chunk.type === 'finish') { assert(!['error', 'content-filter'].includes(chunk.reason), 'CHAT_MODEL', '模型请求未正常结束'); finished = true; }
    }
    assert(finished, 'CHAT_MODEL', '模型连接提前结束'); return text;
  }
  async reconcile(attempt) {
    const state = await this.readProgress(attempt);
    if (state?.attemptId === attempt.id && state.status === 'idle' && !state.locked) {
      if (state.lastStatus === 'completed' && state.terminalResult?.stopReason === 'completed') return { status: 'completed', finishedAt: state.completedAt ?? state.updatedAt, result: parseResult(state.terminalResult.structured ?? state.terminalResult.output?.filter(b => b.type === 'text').map(b => b.text).join('\n')) };
      if (['aborted', 'cancelled', 'error', 'failed', 'timeout'].includes(state.lastStatus)) return { status: 'stopped', reason: `Provider confirmed cleanup: ${state.lastStatus}` };
    }
    if (!attempt.childId) return { status: 'unknown', reason: 'Startup may have been accepted before the child ID was saved. Inspect the previous run before retrying.' };
    try {
      const entries = await this.ctx.subagents.listDescendants(attempt.parentId);
      const entry = entries.find(e => e.id === attempt.childId || e.sessionId === attempt.childId);
      if (entry?.status === 'running') return { status: 'unknown', reason: 'The prior child is still reported as running' };
      // An inactive child is not proof that external side effects have completed.
      return { status: 'unknown', reason: 'Previous activation requires result/side-effect reconciliation', childId: attempt.childId };
    } catch { return { status: 'unknown', reason: 'Previous DSH activation cannot be authoritatively inspected' }; }
  }
  async readProgress(attempt) {
    const provider = this.ctx.subagents.providers.get(attempt.provider);
    const stateFile = provider?.config?.stateFile;
    if (!stateFile) return null;
    try {
      const directory = path.dirname(stateFile); const index = JSON.parse(await fs.readFile(stateFile, 'utf8')); const entry = index[attempt.contextKey];
      if (!entry?.summaryFile) return null;
      const summaryPath = path.resolve(directory, entry.summaryFile); assert(inside(directory, summaryPath), 'PROGRESS_PATH', 'Provider summary escapes its state directory');
      const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
      let locked = true; try { await fs.access(summaryPath.replace(/\.summary\.json$/, '.lock')); } catch (e) { if (e.code === 'ENOENT') locked = false; }
      return { ...summary, locked };
    } catch { return null; }
  }
  async progress(attempt) {
    const s = await this.readProgress(attempt); if (!s || (s.attemptId && s.attemptId !== attempt.id)) return null;
    return { threadId: s.threadId, turnId: s.turnId, status: s.status, lastStatus: s.lastStatus, lastSnippet: s.lastSnippet, toolCalls: s.toolCalls, tokenUsage: s.turnTokenUsage, updatedAt: s.updatedAt };
  }
  async close() { this.closing = true; for (const d of this.diagnostics.values()) d.controller.abort(new Error('ACMS closing')); await Promise.allSettled([...this.diagnostics.values()].map(d => d.promise)); await Promise.allSettled([...this.activations.values()].map(a => a.dispose())); await this.parent?.dispose(); }
}
function diagnosticMessage(error) {
  const message = String(error.message ?? '');
  if (['PAIRED_RUNNER_ERROR', 'PAIRED_CLEANUP_UNCONFIRMED'].includes(error.code)) return message;
  if (/401|unauth|login|credential/i.test(message)) return '认证失败：请检查该模型的登录状态或 API 密钥（401）';
  if (/403|forbidden|permission/i.test(message)) return '访问被拒绝：当前账号或执行环境没有使用权限（403）';
  if (/404|not.found|does not exist|unsupported.*model|model.*not.*available/i.test(message)) return '模型不存在或当前服务未开放该模型（404）';
  if (/429|quota|rate.limit/i.test(message)) return '额度不足或请求频率受限（429），请稍后重试';
  if (/timeout|timed.out|超时/i.test(message)) return '检测超时：45 秒内未完成请求，请检查网络或稍后重试';
  if (/connect|network|fetch|ENOTFOUND|ECONN/i.test(message)) return '网络连接失败，请检查服务地址和网络连接';
  return ['MODEL_ROUTE_MISMATCH', 'REASONING_UNSUPPORTED', 'MODEL_UNAVAILABLE', 'DIAGNOSTICS_UNAVAILABLE', 'PAIRED_RUN_FAILED', 'PAIRED_PROTOCOL', 'NO_PROVIDER'].includes(error.code) ? error.message : '模型请求失败，请检查 DSH 中的模型配置和执行器状态';
}
