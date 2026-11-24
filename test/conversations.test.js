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
import { digest } from '../src/core/util.js';

function attach(f) {
  const chats = new Conversations(f.company, f.engine, f.adapter, f.dataDir);
  const stop = f.engine.stop.bind(f.engine); f.engine.stop = async () => { await chats.close(); await stop(); };
  return chats;
}
const send = (chats, conversationId, text, extra = {}) => chats.send({ conversationId, text, requestId: randomUUID(), ...extra });
function promptPart(prompt, prefix) {
  const line = prompt.split('\n').find(item => item.startsWith(prefix));
  return JSON.parse(line.slice(line.indexOf('：') + 1));
}

function historyRow(f, chat, fields) {
  return f.store.put('conversationMessages', { conversationId: chat.id, agentId: chat.agentId, taskId: chat.taskId,
    role: 'assistant', status: 'completed', ...fields });
}

function legacyPromptBytes(agent, chat, rows, tasks, current) {
  const candidates = rows.filter(m => m.conversationId === chat.id && (m.status === 'completed' || m.role === 'user' && m.status === 'delivered'));
  let remaining = 32000;
  const history = [];
  for (const m of [...candidates, current].slice(-24).reverse()) {
    if (remaining <= 0) break;
    const text = m.text.slice(-remaining);
    history.unshift({ role: m.role, text });
    remaining -= text.length;
  }
  const related = tasks.filter(t => t.agentId === agent.id && t.status !== 'deleted')
    .map(t => ({ id: t.id, title: t.title, status: t.status, summary: t.summary?.slice(0, 1500) })).slice(-20);
  return Buffer.byteLength(`你是 ${agent.name}。职责：${agent.description}\n这是公司所有者的独立对话。直接回答问题；不得派工、修改任务/角色、授予权限或把聊天回复当成交付验收。若需要业务操作，说明应在任务界面执行。以下任务记录仅供说明现状：${JSON.stringify(related)}\n会话记录：${JSON.stringify(history)}\n请用自然语言回复，不输出推理过程。`);
}

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

test('independent chat includes the referenced task and relevant prior turns while retaining full records on demand', async t => {
  const f = await fixture(t);
  const chats = attach(f);
  const agent = f.store.require('agents', 'manager');
  const chat = chats.open({ agentId: agent.id });
  const tasks = Array.from({ length: 24 }, (_, index) => f.task({ title: `文档任务 ${index}`, agentId: agent.id }));
  const target = tasks[0];
  const unrelated = tasks[1];
  const large = '中🚀"\\\u0001'.repeat(350);
  const summary = large + '当前任务摘要确认';
  const other = f.task({ title: '其它角色的材料' });
  const taskChat = chats.open({ agentId: agent.id, taskId: target.id });
  const otherChat = chats.open({ agentId: other.agentId });
  f.store.transaction(() => {
    for (const task of tasks) f.store.put('tasks', { ...task, summary: task.id === target.id ? summary : large + '重复附带的工作摘要' });
    for (let index = 0; index < 85; index++) {
      const turn = index === 45 ? { id: 'related-question', role: 'user', status: 'delivered', text: `请查 ${target.id}` } :
        index === 46 ? { id: 'related-answer', replyTo: 'related-question', text: '答案记录在第二份材料。' } :
        index === 84 ? { id: 'latest-owner', role: 'user', status: 'delivered', text: large + '先前最新确认' } :
        { id: `history-${index}`, text: large + `历史消息 ${index}` };
      historyRow(f, chat, turn);
    }
    historyRow(f, taskChat, { id: 'task-thread', text: '隔离任务对话' });
    historyRow(f, otherChat, { id: 'another-chat', text: '其它角色的会话' });
    historyRow(f, chat, { id: 'invalid-scope', taskId: target.id, text: '错误范围的会话消息' });
    historyRow(f, chat, { id: 'interrupted', status: 'interrupted', text: '未完成消息' });
  });
  f.command('company.pause', { afterCurrent: true });
  await f.start();
  const prompts = [];
  f.adapter.chat = async input => { prompts.push(input.prompt); input.onAccepted(); return '模拟完成'; };
  const routes = new Map(createRoutes({ ...f, conversations: chats }).map(route => [route.path, route]));
  const get = async (route, query) => {
    const response = await routes.get(route).fetch(new Request(`http://localhost${route}?${query}`));
    assert.equal(response.status, 200);
    return response.json();
  };
  const detail = await get('/api/acms/panel-context', `taskId=${target.id}`);
  assert.equal(detail.tasks.find(task => task.id === target.id).summary, summary);
  const newest = await get('/api/acms/conversation', `id=${chat.id}`);
  assert.equal(newest.hasMore, true);
  const older = await get('/api/acms/conversation', `id=${chat.id}&before=${newest.messages[0].id}`);
  assert.match(older.messages[0].text, /历史消息 0/);
  assert.equal(prompts.length, 0);

  const previous = f.store.list('conversationMessages');
  const input = { conversationId: chat.id, requestId: randomUUID(), text: `现在核对「${target.title}」，也提到了 ${other.id}。` };
  const ownerMessage = chats.send(input);
  await until(() => !chats.jobs.size);
  assert.equal(chats.send(input).id, ownerMessage.id);
  assert.equal(prompts.length, 1);
  const [prompt] = prompts;
  const history = promptPart(prompt, '此前会话');
  const taskContext = promptPart(prompt, '所负责任务');
  assert.deepEqual(taskContext.map(task => task.id), [target.id]);
  assert.equal(taskContext[0].summary.endsWith('当前任务摘要确认'), true);
  assert.ok(history.some(row => row.id === 'related-question'));
  assert.ok(history.some(row => row.id === 'related-answer'));
  assert.ok(history.some(row => row.id === 'latest-owner' && row.text.endsWith('先前最新确认')));
  assert.equal(promptPart(prompt, '当前所有者消息'), input.text);
  assert.equal(prompt.includes(unrelated.id), false);
  assert.doesNotMatch(prompt, /隔离任务对话|其它角色的会话|错误范围的会话消息|未完成消息|重复附带的工作摘要/);
  const receipt = f.store.require('conversationMessages', ownerMessage.id).promptContext;
  assert.equal(receipt.version, 1);
  assert.equal(receipt.promptSha256, digest(prompt));
  assert.equal(receipt.promptUtf8Bytes, Buffer.byteLength(prompt));
  assert.equal(receipt.history.available, 85);
  assert.equal(receipt.history.considered, 64);
  assert.equal(receipt.history.omitted, 85 - history.length);
  assert.equal(receipt.tasks.available, 24);
  assert.equal(receipt.tasks.referenced, 1);
  assert.equal(receipt.tasks.omitted, 23);
  assert.deepEqual(receipt.tasks.included, [{ id: target.id, revision: f.store.require('tasks', target.id).revision, truncated: true }]);
  assert.ok(receipt.history.included.some(row => row.id === 'latest-owner' && row.truncated));
  assert.equal(receipt.history.utf8Bytes, Buffer.byteLength(JSON.stringify(history)));
  assert.equal(receipt.tasks.utf8Bytes, Buffer.byteLength(JSON.stringify(taskContext)));
  assert.ok(receipt.history.utf8Bytes <= 8 * 1024);
  assert.ok(receipt.tasks.utf8Bytes <= 4 * 1024);
  assert.ok(history.every(row => row.text.isWellFormed()));
  const before = legacyPromptBytes(agent, chat, previous, f.store.list('tasks'), { role: 'user', text: input.text });
  assert.ok(receipt.promptUtf8Bytes < before / 5);
  t.diagnostic(`Offline prompt UTF-8 bytes on the fixed long-history fixture: ${before} before, ${receipt.promptUtf8Bytes} after. One simulated call per send; retries and reads added zero calls.`);
});

test('independent chat keeps the full current message and the completed replies of earlier queued questions', async t => {
  const f = await fixture(t);
  const chats = attach(f);
  const chat = chats.open({ agentId: 'manager' });
  const captured = [];
  const gate = Promise.withResolvers();
  f.adapter.chat = async ({ prompt, onAccepted }) => {
    captured.push(prompt);
    onAccepted();
    if (captured.length === 1) await gate.promise;
    return `轮次 ${captured.length} 回复`;
  };
  await f.start();
  const latest = '当前指令：' + '中🚀"\\\u0001'.repeat(1996) + '，最后一句';
  const first = send(chats, chat.id, '先做一个回复');
  await until(() => captured.length === 1);
  const second = send(chats, chat.id, '第二条留言');
  const newest = send(chats, chat.id, latest);
  gate.resolve();
  await until(() => !chats.jobs.size);
  assert.equal(captured.length, 3);
  assert.equal(captured[0].includes('第二条留言'), false);
  assert.equal(captured[1].includes('当前指令'), false);
  assert.equal(promptPart(captured[2], '当前所有者消息'), latest);
  const history = promptPart(captured[2], '此前会话');
  const secondReply = f.store.list('conversationMessages').find(m => m.replyTo === second.id);
  assert.ok(history.some(row => row.id === first.id));
  assert.ok(history.some(row => row.id === second.id));
  assert.ok(history.some(row => row.id === secondReply.id && row.text === '轮次 2 回复'));
  assert.equal(history.some(row => row.id === newest.id), false);
  assert.ok(f.store.require('conversationMessages', newest.id).promptContext.history.utf8Bytes <= 8 * 1024);
});

test('a long queue preserves the preceding owner message and its reply in turn order', async t => {
  const f = await fixture(t);
  const chats = attach(f);
  const chat = chats.open({ agentId: 'manager' });
  const gate = Promise.withResolvers();
  const prompts = [];
  f.adapter.chat = async ({ prompt, onAccepted }) => {
    prompts.push(prompt);
    const turn = prompts.length;
    onAccepted();
    if (turn === 1) await gate.promise;
    return `第 ${turn} 轮回复`;
  };
  await f.start();
  send(chats, chat.id, '请先答复第一条');
  await until(() => prompts.length === 1);
  let queued;
  try {
    queued = Array.from({ length: 65 }, (_, index) => send(chats, chat.id, `追加提问 ${index + 1}`));
  } finally { gate.resolve(); }
  await until(() => !chats.jobs.size, 20000);
  assert.equal(prompts.length, 66);
  const previous = queued.at(-2);
  const reply = f.store.list('conversationMessages').find(row => row.replyTo === previous.id);
  const history = promptPart(prompts.at(-1), '此前会话');
  const preceding = history.findIndex(row => row.id === previous.id);
  const following = history.findIndex(row => row.id === reply.id);
  assert.equal(history[preceding]?.text, '追加提问 64');
  assert.equal(history[following]?.text, '第 65 轮回复');
  assert.equal(following, preceding + 1);
  assert.equal(following, history.length - 1);
  const receipt = f.store.require('conversationMessages', queued.at(-1).id).promptContext.history;
  assert.equal(receipt.available, 130);
  assert.ok(receipt.considered >= 64 && receipt.considered <= 65);
  assert.equal(receipt.omitted, 130 - history.length);
  assert.deepEqual(receipt.included.map(row => row.id), history.map(row => row.id));
});

test('an explicitly referenced question and answer take precedence over long unrelated replies', async t => {
  const f = await fixture(t);
  const task = f.task({ agentId: 'manager', title: '文档发布决定' });
  f.command('company.pause', { afterCurrent: true });
  const chats = attach(f);
  const chat = chats.open({ agentId: 'manager' });
  const gate = Promise.withResolvers();
  const prompts = [];
  const ordinary = '核对页面排版和归档说明，记录下一次例会中应确认的时间。'.repeat(65);
  f.adapter.chat = async ({ prompt, onAccepted }) => {
    prompts.push(prompt);
    onAccepted();
    if (prompts.length === 1) return ordinary + '先前决定是按第二版发布。';
    if (prompts.length === 2) await gate.promise;
    return ordinary + '普通近况说明';
  };
  await f.start();
  const earlier = send(chats, chat.id, `讨论 ${task.id}。${ordinary}请确认发布版本。`);
  await until(() => !chats.jobs.size);
  send(chats, chat.id, ordinary + '第一条近况');
  await until(() => prompts.length === 2);
  let previous, current;
  try {
    send(chats, chat.id, ordinary + '第二条近况');
    send(chats, chat.id, ordinary + '第三条近况');
    previous = send(chats, chat.id, ordinary + '上一条所有者近况');
    current = send(chats, chat.id, `请回顾「${task.title}」的决定。`);
  } finally { gate.resolve(); }
  await until(() => !chats.jobs.size);
  const reply = f.store.list('conversationMessages').find(row => row.replyTo === earlier.id);
  const history = promptPart(prompts.at(-1), '此前会话');
  assert.ok(history.some(row => row.id === earlier.id && row.text.endsWith('请确认发布版本。')));
  assert.ok(history.some(row => row.id === reply.id && row.text.endsWith('先前决定是按第二版发布。')));
  assert.ok(history.some(row => row.id === previous.id && row.text.endsWith('上一条所有者近况')));
  assert.ok(f.store.require('conversationMessages', current.id).promptContext.history.utf8Bytes <= 8 * 1024);
});

test('quoted tasks retain exact titles across supported punctuation and ignore ambiguous or split titles', async t => {
  const f = await fixture(t);
  const titles = ['发布手册', '工作节奏', '设计记录', '数据表', '部署「附注'];
  const matching = titles.map(title => f.task({ agentId: 'manager', title }));
  const ambiguous = Array.from({ length: 2 }, () => f.task({ agentId: 'manager', title: '同名材料' }));
  const split = f.task({ agentId: 'manager', title: '分段标题' });
  f.command('company.pause', { afterCurrent: true });
  const chats = attach(f);
  const chat = chats.open({ agentId: 'manager' });
  let prompt;
  f.adapter.chat = async input => { prompt = input.prompt; return '模拟回答'; };
  await f.start();
  const background = '今天先核对已经归档的材料，周会再补充排期和测试安排。'.repeat(20);
  send(chats, chat.id, `${background}请比较「发布手册」、“工作节奏”、"设计记录"、\`数据表\`及「部署「附注」。\n` +
    '另外记录「同名材料」。「分段\n标题」这里没有完整引用。错误示例「缺少闭合。');
  await until(() => !chats.jobs.size);
  const ids = new Set(promptPart(prompt, '所负责任务').map(row => row.id));
  assert.deepEqual(ids, new Set(matching.map(task => task.id)));
  assert.ok([...ambiguous, split].every(task => !ids.has(task.id)));
});

test('unfocused chat gives brief active task status within the current role and goal scope', async t => {
  const f = await fixture(t);
  const active = f.task({ agentId: 'manager', title: '等待补充材料' });
  const completed = f.task({ agentId: 'manager', title: '已交付文件' });
  const outside = f.command('goal.create', { title: '另一个目标', projectId: f.project.id, description: '隔离', acceptance: '隔离', plan: false });
  const unrelated = f.task({ agentId: 'manager', goalId: outside.id, title: '不在当前角色范围' });
  f.store.transaction(() => {
    f.store.put('tasks', { ...active, status: 'blocked', blocker: { kind: 'human' }, summary: '旧轮次工作的详细总结' });
    f.store.put('tasks', { ...completed, status: 'succeeded', summary: '完成工作的详细总结' });
    f.store.put('agents', { ...f.store.require('agents', 'manager'), goalId: f.goal.id });
  });
  f.command('company.pause', { afterCurrent: true });
  const chats = attach(f);
  const chat = chats.open({ agentId: 'manager' });
  let prompt;
  f.adapter.chat = async input => { prompt = input.prompt; return '模拟状态说明'; };
  await f.start();
  send(chats, chat.id, `当前进展怎么样？入口提到 ${unrelated.id}。`);
  await until(() => !chats.jobs.size);
  const tasks = promptPart(prompt, '所负责任务');
  assert.deepEqual(tasks, [
    { id: active.id, title: active.title, status: 'blocked', blocker: 'human' },
    { id: completed.id, title: completed.title, status: 'succeeded' },
  ]);
  assert.doesNotMatch(prompt, /不在当前角色范围|工作的详细总结/);
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
