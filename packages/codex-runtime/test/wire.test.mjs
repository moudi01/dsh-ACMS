import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { CodexAppServerWire } from '../lib/index.js';
import { ThreadStore } from '../lib/store.js';

const THREAD = 'thread-wire-test';
const TURN = 'turn-wire-test';
const CWD = path.resolve(os.tmpdir());

function answer(server, text = 'Final answer\n原样保留', phase = 'final_answer', turnId = TURN) {
  server.notify('item/completed', { threadId: THREAD, turnId, item: { id: 'answer-1', type: 'agentMessage', phase, text } });
}

function terminal(server, status = 'completed', error) {
  server.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status, ...(error ? { error } : {}) } });
}

async function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-wire-'));
  const store = new ThreadStore(path.join(dir, 'threads.json'), 'acms-task:wire-test');
  if (options.previous) store.update({ threadId: options.previous });
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const server = new JsonRpcLineTransport(outbound, inbound);
  const wire = new CodexAppServerWire(inbound, outbound, options.mode ?? 'never', 'gpt-6-astra', store, options.wire ?? {});
  const clientRequests = [];
  const clientNotifications = [];
  const interruptReceived = Promise.withResolvers();
  const signal = AbortSignal.timeout(5000);
  server.onNotification((method, params) => clientNotifications.push({ method, params }));
  server.onRequest(async (method, params) => {
    clientRequests.push({ method, params });
    if (method === 'initialize') return { userAgent: 'isolated-mock-app-server' };
    if (method === 'thread/start' || method === 'thread/resume') {
      await options.onOpening?.({ server, store, method, params });
      return { thread: { id: options.previous ?? THREAD, ephemeral: false }, model: options.returnedModel ?? 'gpt-6-astra' };
    }
    if (method === 'turn/start') {
      if (options.onTurn) await options.onTurn({ server, store, params });
      else {
        server.notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } });
        answer(server);
        terminal(server);
      }
      return { turn: { id: TURN, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') { interruptReceived.resolve(params); return {}; }
    if (method === 'turn/steer') return { turnId: options.wrongSteerReceipt ? 'wrong-turn' : TURN };
    throw new Error(`Unexpected mock request: ${method}`);
  });
  server.start();
  wire.start();
  t.after(async () => {
    wire.close();
    server.close();
    inbound.destroy();
    outbound.destroy();
    await store.close('test-complete');
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(dir).startsWith('codex-runtime-wire-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
  });
  await wire.initialize(signal);
  await wire.startThread(CWD, signal);
  return {
    wire, server, store, clientRequests, clientNotifications, signal, interruptReceived,
    run: () => wire.runTurn(['Isolated test task'], signal),
    events: () => fs.readFileSync(store.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('wire rejects a mismatched model before submitting a turn', async t => {
  await assert.rejects(harness(t, { returnedModel: 'foreign-model' }), /different model/);
});

test('wire uses initialize handshake and durable start/resume permission fields', async t => {
  for (const [mode, expected] of [
    ...['acms-workspace', 'acms-review'].map(mode => [mode, { approvalPolicy: 'never', sandbox: 'workspace-write', config: { 'features.multi_agent': false, 'sandbox_workspace_write.writable_roots': [] } }]),
    ['never', { approvalPolicy: 'never' }],
    ['approve-for-me', { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' }],
    ['dangerously-bypass-approvals-and-sandbox', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
  ]) {
    await t.test(mode, async t => {
      const h = await harness(t, { mode });
      assert.equal(h.clientRequests[0].method, 'initialize');
      assert.deepEqual(h.clientNotifications.map(n => n.method), ['initialized']);
      assert.deepEqual(h.clientRequests[1], { method: 'thread/start', params: { cwd: CWD, ephemeral: false, model: 'gpt-6-astra', ...expected } });
      assert.equal(h.store.summary.threadId, THREAD);
    });
  }
  const resumed = await harness(t, { previous: THREAD });
  assert.deepEqual(resumed.clientRequests[1], { method: 'thread/resume', params: { cwd: CWD, threadId: THREAD, model: 'gpt-6-astra', approvalPolicy: 'never' } });
  assert.equal(resumed.store.summary.resumed, true);
});

test('live steering uses exact expectedTurnId and preserves model, reasoning and sandbox', async t => {
  let accepted = false;
  const h = await harness(t, { onTurn: () => {}, wire: { reasoningEffort: 'high', onAccepted: () => { accepted = true; } } });
  await assert.rejects(h.wire.steer('too early', h.signal), /没有/);
  const result = h.run();
  while (!accepted) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.clientRequests.find(r => r.method === 'turn/start').params.effort, 'high');
  assert.equal(await h.wire.steer('Change direction', h.signal), TURN);
  assert.deepEqual(h.clientRequests.at(-1), { method: 'turn/steer', params: { threadId: THREAD, expectedTurnId: TURN, input: [{ type: 'text', text: 'Change direction', text_elements: [] }] } });
  answer(h.server); terminal(h.server); await result;
  await assert.rejects(h.wire.steer('too late', h.signal), /没有/);
});

test('steering rejects a receipt for another turn', async t => {
  const h = await harness(t, { wrongSteerReceipt: true, onTurn: () => {} }); const result = h.run();
  while (!h.wire.turnId) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(h.wire.steer('change', h.signal), /不匹配/);
  answer(h.server); terminal(h.server); await result;
});

test('notifications before turn/start response are persisted exactly once and preserve authoritative answer order', async t => {
  const h = await harness(t, {
    onTurn: ({ server }) => {
      server.notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } });
      answer(server, 'partial', 'partial_answer');
      answer(server, 'authoritative\n最终结果', 'final_answer');
      answer(server, 'later commentary must not win', 'commentary');
      terminal(server);
    },
  });
  assert.deepEqual(await h.run(), { output: [{ type: 'text', text: 'authoritative\n最终结果' }], stopReason: 'completed' });
  const events = h.events();
  assert.equal(events.filter(e => e.method === 'turn/started').length, 1);
  assert.equal(events.filter(e => e.method === 'item/completed').length, 3);
  assert.equal(events.filter(e => e.method === 'turn/completed').length, 1);
  assert.equal(events.filter(e => e.method === 'provider/turnAccepted').length, 1);
  assert.equal(h.store.summary.turns, 1);
  assert.deepEqual(h.clientRequests.find(r => r.method === 'turn/start').params.input, [{ type: 'text', text: 'Isolated test task', text_elements: [] }]);
  assert.ok(events.findIndex(e => e.method === 'turn/completed') < events.findIndex(e => e.method === 'provider/turnAccepted'));
});

test('failed terminal notifications retain structured product and HTTP transport facts', async t => {
  const cases = [
    ['bad request', 'badRequest', { stage: 'turn', category: 'product-error' }],
    ['non-steerable turn', { activeTurnNotSteerable: {} }, { stage: 'turn', category: 'product-error' }],
    ['HTTP transport', { httpConnectionFailed: { httpStatusCode: 503 } }, { stage: 'turn', category: 'transport', httpStatus: 503 }],
    ['stream transport', { responseStreamDisconnected: { httpStatusCode: 429 } }, { stage: 'turn', category: 'transport', httpStatus: 429 }],
    ['invalid HTTP status', { responseStreamConnectionFailed: { httpStatusCode: '503' } }, { stage: 'turn', category: 'transport' }],
  ];
  for (const [label, codexErrorInfo, facts] of cases) {
    await t.test(label, async t => {
      const h = await harness(t, { onTurn: ({ server }) => terminal(server, 'failed', { message: 'mock product failure', codexErrorInfo }) });
      await assert.rejects(h.run(), /Codex turn ended with status failed/);
      assert.deepEqual(h.wire.collectFailure(), facts);
      assert.equal(h.events().filter(e => e.method === 'turn/completed').length, 1);
    });
  }
});

test('turn/start response before notifications reports running and counts only once', async t => {
  const h = await harness(t, { onTurn() {} });
  h.store.update({ lastStatus: 'starting', turnTokenUsage: { totalTokens: 999 }, toolCalls: 7 });
  const result = h.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.summary.currentTurn, TURN);
  assert.equal(h.store.summary.lastStatus, 'running');
  assert.equal(h.store.summary.turnTokenUsage, null);
  assert.equal(h.store.summary.toolCalls, 0);
  h.server.notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } });
  answer(h.server);
  terminal(h.server);
  await result;
  assert.equal(h.store.summary.turns, 1);
  assert.equal(h.store.summary.lastStatus, 'completed');
});

test('interrupt sends the active IDs and an interrupted terminal turn rejects without losing its thread', async t => {
  const h = await harness(t, { onTurn: ({ server }) => server.notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } }) });
  const running = h.run();
  const rejected = assert.rejects(running, /Codex turn ended with status interrupted/);
  await new Promise(resolve => setImmediate(resolve));
  h.wire.interrupt();
  assert.deepEqual(await h.interruptReceived.promise, { threadId: THREAD, turnId: TURN });
  terminal(h.server, 'interrupted');
  await rejected;
  assert.deepEqual(h.wire.collectFailure(), { stage: 'turn', category: 'unknown' });
  assert.equal(h.store.summary.threadId, THREAD);
  assert.equal(h.store.summary.lastStatus, 'interrupted');
});

test('unattended requests use protocol denials during a provisional turn and retain the latest diagnostic', async t => {
  const responses = [];
  const h = await harness(t, {
    mode: 'approve-for-me',
    onTurn: async ({ server }) => {
      server.notify('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } });
      for (const [method, extra] of [
        ['item/commandExecution/requestApproval', { availableDecisions: ['accept', 'cancel', 'decline'] }],
        ['item/fileChange/requestApproval', { availableDecisions: ['accept', 'decline'] }],
        ['item/permissions/requestApproval', { permissions: { network: { enabled: true } } }],
        ['item/tool/requestUserInput', { questions: [{ id: 'q', question: 'interactive?' }] }],
        ['mcpServer/elicitation/request', { turnId: null }],
      ]) {
        responses.push(await server.request(method, { threadId: THREAD, turnId: TURN, ...extra }));
      }
      answer(server);
      terminal(server);
    },
  });
  assert.equal((await h.run()).stopReason, 'completed');
  assert.deepEqual(responses, [{ decision: 'cancel' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }, { answers: {} }, { action: 'decline', content: null, _meta: null }]);
  assert.match(h.wire.collectDiagnostic(), /MCP elicitation; decision: declined/);
  assert.equal(h.events().filter(e => e.method === 'provider/serverRequest').length, 5);
});

test('foreign-thread notifications after opening do not alter this thread or its durable events', async t => {
  const h = await harness(t, {
    onTurn: ({ server }) => {
      server.notify('turn/started', { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'inProgress' } });
      server.notify('item/agentMessage/delta', { threadId: 'foreign-thread', turnId: 'foreign-turn', itemId: 'foreign-message', delta: 'FOREIGN' });
      server.notify('thread/tokenUsage/updated', { threadId: 'foreign-thread', tokenUsage: { total: { totalTokens: 999 } } });
      server.notify('turn/completed', { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'failed' } });
      answer(server, 'owned answer');
      terminal(server);
    },
  });
  assert.equal((await h.run()).output[0].text, 'owned answer');
  assert.equal(h.store.summary.lastSnippet, 'owned answer');
  assert.equal(h.store.summary.tokenUsage, null);
  assert.ok(h.events().every(e => e.threadId !== 'foreign-thread'));
});

test('foreign-thread notifications during thread opening must not enter the owned event store', async t => {
  const h = await harness(t, {
    onOpening: ({ server }) => {
      server.notify('thread/started', { thread: { id: THREAD, ephemeral: false } });
      server.notify('item/agentMessage/delta', { threadId: 'foreign-thread', turnId: 'foreign-turn', itemId: 'foreign-message', delta: 'FOREIGN' });
    },
  });
  assert.ok(h.events().every(e => e.threadId !== 'foreign-thread'));
  assert.equal(h.store.summary.lastSnippet, '');
  assert.equal(h.events().filter(e => e.method === 'thread/started' && e.threadId === THREAD).length, 1);
});

test('rejected foreign-thread server requests must not be recorded under this thread key', async t => {
  const h = await harness(t);
  await assert.rejects(h.server.request('item/commandExecution/requestApproval', { threadId: 'foreign-thread', turnId: 'foreign-turn', availableDecisions: ['decline'] }), /another thread/);
  assert.ok(h.events().every(e => e.threadId !== 'foreign-thread'));
});
