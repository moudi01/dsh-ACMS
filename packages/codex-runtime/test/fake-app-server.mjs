import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const mode = process.env.FAKE_MODE;
const db = process.env.FAKE_DB;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
let threadId;
let lastTurn = null;
const amount = n => ({ inputTokens: n * 4, outputTokens: n, cachedInputTokens: n * 2, reasoningOutputTokens: n, totalTokens: n * 5 });
const metering = mode?.startsWith('usage');
const usage = (id, total, last, thread = threadId) => notify('thread/tokenUsage/updated',
  { threadId: thread, turnId: id, tokenUsage: { total: amount(total), last: amount(last) } });
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
  if (request.method === 'initialize') { if (mode !== 'startup-timeout') reply({}); }
  if (request.method === 'thread/start') {
    if (request.params.ephemeral !== false) throw new Error('Expected durable thread');
    threadId = randomUUID();
    writeFileSync(db, JSON.stringify({ id: threadId }));
    reply({ model: request.params.model, thread: { id: threadId, ephemeral: false } });
  }
  if (request.method === 'thread/resume') {
    const state = JSON.parse(readFileSync(db));
    threadId = state.id;
    lastTurn = state.lastTurn ?? null;
    if (request.params.threadId !== threadId) throw new Error('Wrong resume id');
    if (metering && lastTurn && mode !== 'usage-no-baseline') usage(lastTurn.id, lastTurn.total, 1);
    reply({ model: request.params.model, thread: { id: threadId, ephemeral: false } });
  }
  if (request.method === 'turn/start') {
    const turnId = randomUUID();
    // Deliberately send notifications before the RPC response.
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    if (!metering) reply({ turn: { id: turnId } });
    if (mode === 'process-exit') return process.exit(7);
    if (mode === 'turn-timeout' || mode === 'cancel') return;
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'tool-1' } });
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'tool-1', status: 'completed' } });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: 'ACK' });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'ACK' } });
    if (metering) {
      const previous = lastTurn?.total ?? 0;
      usage(turnId, previous + 200, 200, 'foreign-thread');
      usage('different-turn', previous + 100, 100);
      usage(turnId, previous + 2, 2);
      usage(turnId, previous + 2, 2);
      usage(turnId, previous + 3, 1);
      writeFileSync(db, JSON.stringify({ id: threadId, lastTurn: { id: turnId, total: previous + 3 } }));
    } else notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 8 }, last: { totalTokens: 4 } } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: mode === 'failure' ? 'failed' : 'completed',
      ...(mode === 'failure' ? { error: { message: 'upstream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } } } : {}) } });
    if (metering) {
      usage(turnId, (lastTurn?.total ?? 0) + 4, 1);
      reply({ turn: { id: turnId } });
    }
  }
  if (request.method === 'turn/interrupt') reply({});
});
