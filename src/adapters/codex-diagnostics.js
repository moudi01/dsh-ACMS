import { createRequire } from 'node:module';
import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { assert } from '../core/util.js';

/** A separate, bounded app-server session; it never resumes a company task. */
export async function codexDiagnostics(ctx, config, model, dataDir, { probe = false, signal } = {}) {
  const packagePath = createRequire(import.meta.url).resolve('@openai/codex/package.json');
  const bin = config.codexBin ?? path.resolve(path.dirname(packagePath), JSON.parse(readFileSync(packagePath, 'utf8')).bin.codex);
  const cwd = path.join(dataDir, 'diagnostics'); await fs.mkdir(cwd, { recursive: true });
  const subprocess = ctx.get?.('subprocess'); assert(subprocess, 'DIAGNOSTICS_UNAVAILABLE', '外部执行器未提供进程服务');
  const child = subprocess.spawn({ argv: [process.execPath, bin, 'app-server', '--stdio'], cwd, env: config.env ?? {}, graceMs: 1000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } });
  const rpc = new JsonRpcLineTransport(child.stdout, child.stdin);
  child.stderr?.resume();
  const completed = Promise.withResolvers(); completed.promise.catch(() => {}); let threadId;
  rpc.onRequest(async () => { throw new Error('Connectivity diagnostics do not permit tools, approvals, or user-input requests'); });
  rpc.onNotification((method, params) => { if (method === 'turn/completed' && params.threadId === threadId) completed.resolve(params.turn); });
  const abort = () => { rpc.close(); completed.reject(signal.reason); child.terminate(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted(); rpc.start();
    await rpc.request('initialize', { clientInfo: { name: 'acms-diagnostics', version: '0.1.0' }, capabilities: { experimentalApi: false } }, signal); rpc.notify('initialized'); await rpc.flush();
    const [listing, settings] = await Promise.all([
      rpc.request('model/list', { includeHidden: true, limit: 100 }, signal),
      rpc.request('config/read', { includeLayers: false, cwd }, signal),
    ]);
    const entry = listing.data?.find(m => m.model === model || m.id === model);
    const configured = config.reasoningEffort ?? settings.config?.model_reasoning_effort;
    const reasoning = { efforts: entry?.supportedReasoningEfforts?.map(e => ({ id: e.reasoningEffort, name: e.reasoningEffort })) ?? [], effective: configured ?? entry?.defaultReasoningEffort ?? null, source: configured ? '外部执行器配置' : entry?.defaultReasoningEffort ? '模型默认' : '未公开', selectable: false };
    if (!probe) return { reasoning };
    const thread = await rpc.request('thread/start', { model, cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: 'This is a connectivity check. Reply with exactly OK. Do not use tools, inspect files, or perform any other work.', config: { 'features.multi_agent': false, mcp_servers: {}, web_search: 'disabled' } }, signal);
    threadId = thread.thread.id;
    assert(thread.model === model, 'MODEL_ROUTE_MISMATCH', '外部服务返回的模型与选择不一致');
    reasoning.effective = thread.reasoningEffort ?? reasoning.effective; reasoning.source = thread.reasoningEffort ? '服务实际返回' : reasoning.source;
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Reply OK only.', text_elements: [] }] }, signal);
    const turn = await Promise.race([completed.promise, child.done.then(() => { throw new Error('External model process exited before completing the check'); })]);
    assert(turn?.status === 'completed', 'MODEL_PROBE_FAILED', turn?.error?.message ?? '外部模型检测未正常完成');
    return { reasoning };
  } finally {
    signal?.removeEventListener('abort', abort); rpc.close(); child.stdin?.end(); child.terminate();
    await child.waitForExit(); await child.done.catch(() => {});
  }
}
