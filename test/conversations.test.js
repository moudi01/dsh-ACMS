import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { Conversations } from '../src/runtime/conversations.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { DshAdapter } from '../src/adapters/dsh.js';
import { createRoutes } from '../src/host/http.js';

function attach(f) {
  const chats = new Conversations(f.company, f.engine, f.adapter, f.dataDir);
  const stop = f.engine.stop.bind(f.engine); f.engine.stop = async () => { await chats.close(); await stop(); };
  return chats;
}
const send = (chats, conversationId, text, extra = {}) => chats.send({ conversationId, text, requestId: randomUUID(), ...extra });

test('idle conversations persist multi-turn context, deduplicate sends and never edit roles or create tasks', async t => {
  const f = await fixture(t); const chats = attach(f); await f.start();
  const agent = f.store.list('agents').find(a => a.role === 'manager');
  const before = structuredClone(agent); const chat = chats.open({ agentId: agent.id });
  const prompts = []; f.adapter.chat = async input => { prompts.push(input.prompt); input.onAccepted(); input.onText('partial'); return '明确回复'; };
  const input = { conversationId: chat.id, text: '先检查资料', requestId: randomUUID() };
  const first = chats.send(input);
  await until(() => !chats.jobs.size);
  assert.equal(chats.send(input).id, first.id); await until(() => !chats.jobs.size);
  assert.equal(prompts.length, 1);
  send(chats, chat.id, '接着说'); await until(() => !chats.jobs.size);
  assert.match(prompts[1], /先检查资料/); assert.match(prompts[1], /明确回复/);
  assert.deepEqual(f.store.require('agents', agent.id), before);
  assert.equal(f.store.list('tasks').length, 0); assert.equal(f.adapter.activeChats, 0);
  assert.equal((await chats.view(chat.id)).messages.length, 4);
});

test('same-attempt steering acknowledges executor delivery, rejects stale turns and does not replay acknowledged requests', async t => {
  const f = await fixture(t); const chats = attach(f); f.adapter.delay = 10000;
  const task = f.task(); await f.start();
  await until(() => f.adapter.calls.length === 1);
  const attempt = f.store.list('attempts')[0]; const chat = chats.open({ agentId: task.agentId, taskId: task.id });
  const receipt = Promise.withResolvers(); const calls = [];
  f.adapter.canSteer = () => true; f.adapter.steer = async (...args) => { calls.push(args); return receipt.promise; };
  const input = { conversationId: chat.id, text: '先核对现有文件', requestId: randomUUID(), mode: 'steer', expectedAttemptId: attempt.id };
  const m = chats.send(input); chats.send(input); assert.equal(calls.length, 1); assert.equal(m.status, 'sending');
  receipt.resolve('ack-1'); await until(() => !chats.deliveries.size);
  assert.equal(chats.send(input).status, 'delivered'); assert.equal(calls.length, 1);
  assert.throws(() => send(chats, chat.id, '过时消息', { mode: 'steer', expectedAttemptId: 'other-attempt' }), { code: 'CHAT_STALE' });
  assert.equal(calls[0][0].id, attempt.id);
  f.adapter.steer = async () => { throw new Error('executor closed'); };
  const failed = send(chats, chat.id, '失败消息', { mode: 'steer', expectedAttemptId: attempt.id });
  await until(() => !chats.deliveries.size); assert.equal(f.store.require('conversationMessages', failed.id).status, 'failed');
});

test('single-request runner interruption cleans up before continuation, keeps workspace and contract, avoids repairs', async t => {
  let calls = 0, workingPath;
  const f = await fixture(t, async input => {
    if (input.task.kind === 'work') { calls++; workingPath ??= input.task.workspace.path; assert.equal(input.task.workspace.path, workingPath); }
    return defaultSimulation(input);
  });
  const chats = attach(f); f.adapter.delay = 10000;
  const task = f.task({ longLived: true }); await f.start(); await until(() => f.adapter.calls.length === 1);
  workingPath = f.adapter.calls[0].task.workspace.path;
  const attempt = f.store.list('attempts')[0]; const chat = chats.open({ agentId: task.agentId, taskId: task.id });
  f.adapter.delay = 5;
  const m = send(chats, chat.id, '保留现有成果，只补充说明', { mode: 'restart', expectedAttemptId: attempt.id });
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(f.store.require('attempts', attempt.id).status, 'interrupted');
  assert.equal(f.store.require('conversationMessages', m.id).status, 'delivered');
  assert.match(f.adapter.calls[1].prompt, /保留现有成果，只补充说明/);
  assert.equal(f.adapter.calls[1].attempt.taskGeneration, attempt.taskGeneration);
  assert.equal(f.adapter.maxActive, 1); assert.equal(calls, 1);
  assert(!f.store.list('tasks').some(t => t.repairOf));
});

test('queued task messages preserve pause and human material gates across restart', async t => {
  const f = await fixture(t); const chats = attach(f); const task = f.task(); f.command('company.pause', { afterCurrent: true }); await f.start();
  f.engine.block(task, 'human', 'Missing required material', 'Provide the material');
  const chat = chats.open({ agentId: task.agentId, taskId: task.id }); const m = send(chats, chat.id, '等材料齐备后再送审', { mode: 'queue' });
  chats.recover(); await f.engine.tick();
  assert.equal(f.store.require('conversationMessages', m.id).status, 'queued');
  assert.equal(f.store.require('tasks', task.id).status, 'blocked'); assert.equal(f.store.list('attempts').length, 0);
  assert.equal(f.company.policy().paused, true);
  const other = f.store.list('agents').find(a => a.id !== task.agentId);
  assert.throws(() => chats.open({ agentId: other.id, taskId: task.id }), { code: 'CHAT_SCOPE' });
});

test('chat reserves execution capacity, cancellation preserves partial reply, and uncertain sends are not replayed on recovery', async t => {
  const f = await fixture(t); const chats = attach(f); await f.start();
  const agent = f.store.list('agents').find(a => a.role === 'manager'); const chat = chats.open({ agentId: agent.id });
  f.adapter.chat = async input => { input.onAccepted(); input.onText('部分回复'); return new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })); };
  send(chats, chat.id, '长回复'); await until(() => f.store.list('conversationMessages').some(m => m.text === '部分回复'));
  assert.equal(f.adapter.activeChats, 1); chats.stop(chat.id); await until(() => !chats.jobs.size);
  assert.equal(f.adapter.activeChats, 0); const reply = (await chats.view(chat.id)).messages.find(m => m.role === 'assistant');
  assert.equal(reply.status, 'interrupted'); assert.equal(reply.text, '部分回复');
  f.store.transaction(() => f.store.put('conversationMessages', { id: 'uncertain', conversationId: chat.id, role: 'user', status: 'sending', text: 'ambiguous' }));
  chats.recover(); assert.equal(f.store.require('conversationMessages', 'uncertain').status, 'interrupted'); assert.equal(chats.jobs.size, 0);
});

test('conversation API supports history without embedding transcripts in global snapshot', async t => {
  const f = await fixture(t); const chats = attach(f); await f.start();
  const route = createRoutes({ ...f, conversations: chats }).find(r => r.path.endsWith('/conversation'));
  assert.deepEqual(route.methods, ['GET', 'POST']);
  const agent = f.store.list('agents')[0];
  const response = await route.fetch(new Request('http://localhost/api/acms/conversation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'open', agentId: agent.id }) }));
  const chat = await response.json();
  const history = await route.fetch(new Request(`http://localhost/api/acms/conversation?id=${chat.id}`));
  assert.deepEqual((await history.json()).messages, []);
  assert.equal(f.company.snapshot().conversationMessages, undefined);
});

test('chat and model probes share the integration slot until cleanup is confirmed', async t => {
  const f = await fixture(t);
  const route = { provider: 'paired:fixture', model: 'fixture' };
  let chatsStarted = 0, routesSelected = 0, probesStarted = 0;
  const adapter = new DshAdapter({}, f.company, f.dataDir, {
    paired: { run: async () => { probesStarted++; return {}; } },
  });
  adapter.choose = async () => { routesSelected++; return { name: route.provider, model: route.model, capabilities: {} }; };
  adapter.chat = async () => { chatsStarted++; return 'fixture reply'; };
  f.engine.adapter = f.adapter = adapter;
  const chats = attach(f);
  const chat = chats.open({ agentId: 'manager' });
  f.command('policy.update', { patch: { maxConcurrent: 1, controlSlots: 0 } });
  const task = f.task();
  const integrationId = 'integration-held';
  f.store.transaction(() => {
    f.store.put('tasks', { ...task, status: 'reconciling', stopRequested: 'cancelled', activeIntegrationId: integrationId });
    f.store.put('integrations', { id: integrationId, taskId: task.id, generation: task.generation, phase: 'reconciling', commandId: 'held-command' });
  });
  await f.start();
  const held = send(chats, chat.id, 'Wait for the integration slot');
  await until(() => !chats.jobs.size);
  assert.equal(f.store.require('conversationMessages', held.id).status, 'failed');
  await assert.rejects(adapter.probeModel(route), { code: 'ACTIVE_LIMIT' });
  assert.deepEqual([chatsStarted, routesSelected, probesStarted], [0, 0, 0]);

  const dir = path.join(f.dataDir, 'integration-receipts');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'held-command.json'), JSON.stringify({ confirmed: true, exitCode: 1 }));
  await until(() => f.store.require('tasks', task.id).status === 'cancelled');
  assert.equal((await adapter.probeModel(route)).status, 'available');
  const delivered = send(chats, chat.id, 'The slot is free');
  await until(() => !chats.jobs.size);
  assert.equal(f.store.require('conversationMessages', delivered.id).status, 'delivered');
  assert.deepEqual([chatsStarted, routesSelected, probesStarted], [1, 1, 1]);
});
