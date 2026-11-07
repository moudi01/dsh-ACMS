// Explicit protocol fixture. No model is called and its text is not model evidence.
import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const [protocol, calls, behavior] = process.argv.slice(2);
const timer = setTimeout(() => process.exit(98), 8000);
const mark = () => appendFileSync(calls, JSON.stringify({ event: 'fixture-invoked', pid: process.pid }) + '\n');
const output = () => { writeFileSync('recovered.txt', 'Protocol fixture delivery, not model output\n'); return { outcome: 'completed', summary: 'Protocol fixture only', artifacts: [{ path: 'recovered.txt' }] }; };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (protocol === 'runner') {
  let text = ''; for await (const b of process.stdin) text += b;
  const r = JSON.parse(text); mark();
  if (r.approvalPolicy !== 'never' || r.sandbox !== 'workspace-write') throw new Error('Permission policy changed');
  if (behavior !== 'hold') { send({ protocol: r.protocol, requestId: r.requestId, model: r.model, executed: true, output: output() }); clearTimeout(timer); }
} else {
  const notice = (method, params) => send({ jsonrpc: '2.0', method, params });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line), p = r.params, reply = result => send({ jsonrpc: '2.0', id: r.id, result });
    if (r.method === 'initialize') reply({});
    if (r.method === 'thread/start' || r.method === 'thread/resume') {
      if (p.approvalPolicy !== 'never' || p.sandbox !== 'workspace-write') throw new Error('Permission policy changed');
      reply({ thread: { id: 'fixture-thread', ephemeral: false }, model: p.model });
    }
    if (r.method === 'turn/start') {
      mark(); reply({ turn: { id: 'fixture-turn' } });
      notice('turn/started', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'inProgress' } });
      notice('item/agentMessage/delta', { threadId: 'fixture-thread', turnId: 'fixture-turn', itemId: 'fixture-message', delta: 'Protocol fixture progress' });
      if (behavior !== 'hold') {
        notice('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'fixture-message', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(output()) } });
        notice('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } });
      }
    }
    if (r.method === 'turn/interrupt') reply({});
  });
}
