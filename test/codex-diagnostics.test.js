import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { codexDiagnostics } from '../src/adapters/codex-diagnostics.js';
import { fixture } from './helpers.js';

test('external diagnostics use actual app-server protocol with an ephemeral read-only thread and clean up', async t => {
  const f = await fixture(t); const requests = []; let terminated = false; let waited = false;
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough(); const done = Promise.withResolvers();
  stdin.on('data', bytes => { for (const line of bytes.toString().split('\n').filter(Boolean)) {
    const frame = JSON.parse(line); requests.push(frame); if (!frame.id) continue;
    let result;
    if (frame.method === 'initialize') result = {};
    else if (frame.method === 'config/read') result = { config: { model_reasoning_effort: 'xhigh' } };
    else if (frame.method === 'model/list') result = { data: [{ model: 'gpt-6-astra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] }] };
    else if (frame.method === 'thread/start') { assert.equal(frame.params.ephemeral, true); assert.equal(frame.params.sandbox, 'read-only'); assert.equal(frame.params.approvalPolicy, 'never'); result = { model: 'gpt-6-astra', reasoningEffort: 'xhigh', thread: { id: 'probe-thread' } }; }
    else if (frame.method === 'turn/start') { result = { turn: { id: 'probe-turn' } }; queueMicrotask(() => stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'probe-thread', turn: { id: 'probe-turn', status: 'completed' } } }) + '\n')); }
    else throw new Error(`Unexpected diagnostic method ${frame.method}`);
    queueMicrotask(() => stdout.write(JSON.stringify({ id: frame.id, result }) + '\n'));
  } });
  const ctx = { get: () => ({ spawn: spec => { assert.equal(spec.cwd.endsWith('diagnostics'), true); return { stdin, stdout, stderr, done: done.promise, terminate() { terminated = true; done.resolve({ exitCode: 0 }); }, async waitForExit() { waited = true; } }; } }) };
  const result = await codexDiagnostics(ctx, {}, 'gpt-6-astra', f.dataDir, { probe: true, signal: AbortSignal.timeout(2000) });
  assert.equal(result.reasoning.effective, 'xhigh'); assert.equal(result.reasoning.source, '服务实际返回'); assert(terminated && waited);
  assert.equal(requests.filter(r => r.method === 'turn/start').length, 1); assert(!requests.some(r => r.method === 'thread/resume'));
});
