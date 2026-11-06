import { promises as fs } from 'node:fs';
import { assert, OWNER } from '../core/util.js';
import { browseDirectories } from './directories.js';

export function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
async function body(request) {
  assert(request.headers.get('content-type')?.split(';')[0] === 'application/json', 'CONTENT_TYPE', 'JSON content type is required');
  const text = await request.text(); assert(text.length <= 262144, 'BODY_LIMIT', 'Request exceeds 256 KiB'); return JSON.parse(text);
}
export async function waitForEvents(store, after, signal, timeout = 20000) {
  if (store.cursor() > after || signal?.aborted) return store.page(after);
  await new Promise(resolve => {
    let timer;
    const done = () => { clearTimeout(timer); store.events.off('event', done); signal?.removeEventListener('abort', done); resolve(); };
    store.events.on('event', done); signal?.addEventListener('abort', done, { once: true }); timer = setTimeout(done, timeout);
    if (store.cursor() > after || signal?.aborted) done();
  });
  return store.page(after);
}
export function createRoutes(runtime) {
  const { company, engine, adapter, workspaces } = runtime;
  const handlers = {
    '/api/acms/conversation': async request => {
      assert(runtime.conversations, 'CHAT_UNAVAILABLE', '会话服务未加载，请等待插件更新');
      if (request.method === 'GET') { const query = new URL(request.url).searchParams; return json(await runtime.conversations.view(query.get('id'), query.get('before'))); }
      const input = await body(request);
      if (input.action === 'open') return json(runtime.conversations.open(input));
      if (input.action === 'send') return json(runtime.conversations.send(input));
      if (input.action === 'stop') return json(runtime.conversations.stop(input.conversationId));
      assert(false, 'CHAT_ACTION', '未知会话操作');
    },
    '/api/acms/state': async () => json({ ...company.snapshot(), runtime: { version: '0.1.0', supportsGracefulPause: true, running: !engine.closing, lastError: engine.lastError, activeProbes: adapter.activeProbes ?? 0, providers: adapter.providers?.() ?? [], modelCatalog: await adapter.modelCatalog?.() ?? { models: [], defaultSelection: null, warnings: [] }, dataDir: runtime.dataDir } }),
    '/api/acms/directories': async request => json(await browseDirectories(new URL(request.url).searchParams.get('path') ?? '', company.policy())),
    '/api/acms/model-details': async request => { assert(adapter.modelDetails, 'DIAGNOSTICS_UNAVAILABLE', '此执行环境未提供模型信息接口'); return json(await adapter.modelDetails(await body(request), request.signal)); },
    '/api/acms/model-check': async request => { assert(adapter.probeModel, 'DIAGNOSTICS_UNAVAILABLE', '此执行环境未提供模型检测接口'); return json(await adapter.probeModel(await body(request), request.signal)); },
    '/api/acms/pairing': async request => {
      assert(adapter.paired, 'PAIRING_UNAVAILABLE', '当前执行环境不支持外部配对');
      const input = await body(request);
      if (input.action === 'invite') return json(await adapter.paired.invite());
      if (input.action === 'pending') return json(await adapter.paired.pending());
      if (input.action === 'inspect') return json(await adapter.paired.inspect(input.id));
      if (input.action === 'accept') return json(await adapter.paired.accept(input.id, input.fingerprint));
      if (input.action === 'forget') return json(adapter.paired.forget(input.id));
      assert(false, 'PAIRING_ACTION', '未知配对操作');
    },
    '/api/acms/command': async request => {
      assert(request.method === 'POST', 'METHOD', 'POST required'); const input = await body(request);
      if (input.name === 'project.save') {
        const previous = input.args?.id ? company.store.get('projects', input.args.id) : {};
        await workspaces.validateProject({ ...previous, ...input.args, mode: input.args?.mode ?? previous?.mode ?? 'git' });
      }
      if (input.name === 'goal.createWithProject') await workspaces.validateProject({ ...input.args?.project, mode: input.args?.project?.mode ?? 'copy' });
      if (input.name === 'agent.save' && adapter.choose) {
        const previous = input.args?.id ? company.store.get('agents', input.args.id) : {};
        await adapter.choose({ ...previous, ...input.args });
        if (input.args?.reasoningEffort) await adapter.modelDetails({ ...previous, ...input.args }, request.signal);
      }
      let result = company.command(OWNER, input.requestId, input.name, input.args ?? {});
      const projectId = input.name === 'project.save' ? result.id : result?.projectId ?? (result?.goalId ? company.store.get('goals', result.goalId)?.projectId : null);
      if (projectId && company.store.get('projects', projectId)?.status !== 'deleted' && workspaces.publishProject) {
        try { await workspaces.publishProject(company.store.require('projects', projectId)); }
        catch (e) { result = { ...result, collaborationWarning: `记录已保存，但 .acms 协作文档更新失败：${e.message}` }; }
      }
      engine.kick(); return json({ ok: true, value: result });
    },
    '/api/acms/events': async request => {
      const url = new URL(request.url); const after = Number(url.searchParams.get('after') ?? 0);
      assert(Number.isSafeInteger(after) && after >= 0, 'CURSOR', 'Invalid event cursor');
      return json(await waitForEvents(company.store, after, request.signal));
    },
    '/api/acms/artifact': async request => {
      const artifactId = new URL(request.url).searchParams.get('id'); const artifact = company.store.require('artifacts', artifactId);
      const bytes = await fs.readFile(artifact.blob);
      return json({ ...artifact, content: bytes.subarray(0, 262144).toString('utf8'), truncated: bytes.length > 262144 });
    },
  };
  return Object.entries(handlers).map(([path, handler]) => ({ path, methods: path === '/api/acms/conversation' ? ['GET', 'POST'] : ['/api/acms/command', '/api/acms/model-details', '/api/acms/model-check', '/api/acms/pairing'].includes(path) ? ['POST'] : ['GET'], requestBody: 'buffered', fetch: async request => {
    try { return await handler(request); } catch (e) {
      const status = ['NOT_FOUND'].includes(e.code) ? 404 : ['CONFLICT', 'IDEMPOTENCY_CONFLICT', 'ACTIVE_LIMIT'].includes(e.code) ? 409 : ['FORBIDDEN', 'OWNER_REQUIRED', 'SCOPE_DENIED'].includes(e.code) ? 403 : 400;
      return json({ ok: false, error: { code: e.code ?? 'INVALID_REQUEST', message: e.message, details: e.details ?? {} } }, status);
    }
  } }));
}
