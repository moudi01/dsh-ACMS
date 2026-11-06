import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const mode = process.env.FAKE_MODE;
const db = process.env.FAKE_DB;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
let threadId;
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
    threadId = JSON.parse(readFileSync(db)).id;
    if (request.params.threadId !== threadId) throw new Error('Wrong resume id');
    reply({ model: request.params.model, thread: { id: threadId, ephemeral: false } });
  }
  if (request.method === 'turn/start') {
    const turnId = randomUUID();
    // Deliberately send notifications before the RPC response.
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    reply({ turn: { id: turnId } });
    if (mode === 'process-exit') return process.exit(7);
    if (mode === 'turn-timeout' || mode === 'cancel') return;
    notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'tool-1' } });
    notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'tool-1', status: 'completed' } });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: 'ACK' });
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'ACK' } });
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 8 }, last: { totalTokens: 4 } } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: mode === 'failure' ? 'failed' : 'completed',
      ...(mode === 'failure' ? { error: { message: 'upstream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } } } : {}) } });
  }
  if (request.method === 'turn/interrupt') reply({});
});
