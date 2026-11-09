import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { Store } from '../core/store.js';
import { Company } from '../core/domain.js';
import { Engine } from '../runtime/engine.js';
import { Conversations } from '../runtime/conversations.js';
import { WorkspaceManager } from '../runtime/workspaces.js';
import { DshAdapter } from '../adapters/dsh.js';
import { createRoutes } from './http.js';
import { createAgentApi } from "./agent-api.js";
import { assert } from '../core/util.js';

export const name = 'acms';
export const inject = ['connection', 'agents', 'subagents', 'tools'];
export async function apply(ctx, config = {}) {
  const dataDir = path.resolve(config.dataDir ?? process.env.ACMS_DATA_DIR ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'acms'));
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'company.db')); const company = new Company(store);
  // Legacy export/isolation runs inside Engine.start after the scheduler lease
  // is held; unconfirmed old processes block startup instead of being released.
  const workspaces = new WorkspaceManager(dataDir, company); const adapter = new DshAdapter(ctx, company, dataDir); const engine = new Engine(company, adapter, workspaces);
  const conversations = new Conversations(company, engine, adapter, dataDir);
  const runtime = { dataDir, company, workspaces, adapter, engine, conversations };
  const agentApi = createAgentApi(runtime, { dataDir });
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    try { await agentApi.close(); } catch { }
    try { await conversations.close(); } catch { }
    try { await engine.stop(); } catch { }
    try { store.close(); } catch { }
  }
  ctx.effect(() => dispose, "ACMS lifecycle");
  try {
    await engine.start();
    await agentApi.start();
    for (const route of createRoutes(runtime)) ctx.connection.fetch.register(route);
  } catch (error) {
    await dispose();
    throw error;
  }
  const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
  ctx.tools.register({ name: 'acms_status', description: 'Read ACMS company goals, tasks, pending interactions and available execution providers. Task success requires artifact verification and independent review.', parameters: { type: 'object', additionalProperties: false, properties: {} }, output, isConcurrencySafe: () => true,
    execute: async () => JSON.stringify({ ...company.snapshot(), providers: adapter.providers() }) });
  ctx.tools.register({ name: 'acms_manage', description: 'Manage ACMS from an authorized ACMS agent. Identity is derived from the live activation, never from arguments. Owner-only boundaries and new top-level goals must be changed in the ACMS panel.', parameters: { type: 'object', additionalProperties: false, required: ['requestId', 'command', 'args'], properties: { requestId: { type: 'string' }, command: { type: 'string' }, args: { type: 'object' } } }, output, isConcurrencySafe: () => true,
    execute: async (input, exec) => {
      const attempt = store.list('attempts').find(a => a.childId === exec.agent?.id && a.status === 'running');
      assert(attempt, 'UNAUTHORIZED', 'This session is not an active ACMS assignment');
      engine.currentAttemptTask(attempt);
      assert(attempt.grants.includes(input.command), 'FORBIDDEN', 'Command exceeds this execution’s captured grants');
      return JSON.stringify(company.command({ kind: 'agent', id: attempt.agentId, goalId: attempt.goalId, grants: attempt.grants }, input.requestId, input.command, input.args));
    } });
  ctx.logger?.info?.(`ACMS ready. Data: ${dataDir}. Native panel and task engine registered.`);
  ctx.logger?.info?.(`ACMS agent API listening at ${agentApi.baseUrl}`);
}
