import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { DshAdapter } from '../src/adapters/dsh.js';
import { parsePairedResult } from '../src/adapters/paired-result.mjs';

async function pairing(f, code) {
  const paired = new PairedRuntimes(f.company, f.dataDir); const invite = await paired.invite();
  const token = JSON.parse(invite.prompt.slice(invite.prompt.indexOf('{\n  "protocol"'), invite.prompt.lastIndexOf('\n完成后'))).token;
  const runner = path.join(f.root, 'runner.mjs'); await writeFile(runner, code);
  const receipt = { protocol: 'acms.runner.v1', inviteId: invite.id, token, model: 'fixture-model', name: 'Fixture agent', command: process.execPath, args: [runner], persistent: true, reasoningEffort: 'high' };
  await writeFile(invite.responseFile, JSON.stringify(receipt));
  return { paired, invite, receipt, runner };
}
const runner = `import fs from 'node:fs/promises'; let input='';for await(const b of process.stdin)input+=b;const r=JSON.parse(input);let output='OK';if(r.mode==='task'){const c=JSON.parse(r.prompt.split('CONTRACT:\\n')[1]); if(c.task.kind==='review')output={outcome:'reviewed',decision:'approve',summary:'Fixture review',findings:['File verified']};else{await fs.writeFile('output.txt','Fixture delivery');output={outcome:'completed',summary:'Fixture execution',artifacts:[{path:'output.txt',title:'Fixture'}]};}}console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,model:r.model,reasoningEffort:'high',executed:true,output}));`;

test('pairing validates invitation, immutable preview and one-time acceptance without starting a process', async t => {
  const f = await fixture(t); const { paired, invite, receipt } = await pairing(f, runner);
  assert.equal(paired.list().length, 0); const candidate = await paired.inspect(invite.id); assert.equal(paired.running.size, 0);
  await writeFile(invite.responseFile, JSON.stringify({ ...receipt, name: 'Changed agent' }));
  await assert.rejects(paired.accept(invite.id, candidate.fingerprint), { code: 'PAIRING_CHANGED' });
  const changed = await paired.inspect(invite.id); await paired.accept(invite.id, changed.fingerprint);
  assert.equal(paired.list().length, 1); assert.equal(paired.running.size, 0);
  await assert.rejects(paired.accept(invite.id, changed.fingerprint), { code: 'INVITE_EXPIRED' });
  assert(!JSON.stringify(f.company.snapshot()).includes(receipt.token));
});
test('paired runner performs manual probe then automatic execution', async t => {
  const f = await fixture(t); const { paired, invite } = await pairing(f, runner); const candidate = await paired.inspect(invite.id); await paired.accept(invite.id, candidate.fingerprint);
  const ctx = { get: () => null, subagents: { providers: new Map() } }; const adapter = new DshAdapter(ctx, f.company, f.dataDir, { paired }); f.engine.adapter = adapter;
  const probe = await adapter.probeModel({ provider: candidate.id, model: candidate.model }); assert.equal(probe.status, 'available'); assert.equal(probe.reasoning.effective, 'high');
  const task = f.task(); await f.start(); await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  const attempts = f.store.list('attempts'); assert.equal(attempts.length, 1); assert(attempts.every(a => a.provider === candidate.id));
  assert.equal(await readFile(path.join(f.store.require('tasks', task.id).workspace.path, 'output.txt'), 'utf8'), 'Fixture delivery');
  assert.equal(paired.running.size, 0);
});

test('task-only pairing registers without a probe and rejects probes before process startup', async t => {
  const f = await fixture(t); const p = await pairing(f, runner);
  const receipt = { ...p.receipt, probeSupported: false, probeReason: 'Runtime has no verified all-tools-off mode' };
  await writeFile(p.invite.responseFile, JSON.stringify({ ...receipt, probeReason: '' }));
  await assert.rejects(p.paired.inspect(p.invite.id), { code: 'PAIRING_INPUT' });
  await writeFile(p.invite.responseFile, JSON.stringify(receipt));
  const recovered = await p.paired.pending();
  assert.equal(recovered.id, p.invite.id); assert(!JSON.stringify(recovered).includes(receipt.token));
  const candidate = await p.paired.inspect(p.invite.id); await p.paired.accept(p.invite.id, candidate.fingerprint);
  assert.equal(await p.paired.pending(), null);
  const adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired: p.paired });
  const catalog = await adapter.modelCatalog();
  assert.equal(catalog.models[0].routes[0].probeSupported, false);
  const cwd = path.join(f.root, 'probe-must-not-start');
  await assert.rejects(p.paired.run(candidate.id, { mode: 'probe', cwd }), { code: 'PAIRED_PROBE_UNSUPPORTED' });
  await assert.rejects(adapter.probeModel({ provider: candidate.id, model: candidate.model }), { code: 'PAIRED_PROBE_UNSUPPORTED' });
  await assert.rejects(readFile(cwd), { code: 'ENOENT' });
  assert.equal(p.paired.running.size, 0); assert.equal(adapter.activeProbes, 0);
  assert.equal(f.store.list('modelHealth').length, 0);
  f.engine.adapter = adapter; const task = f.task(); await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'succeeded');
  assert.equal(f.store.list('attempts').length, 1);
});
test('paired runner rejects wrong model responses and aborts the owned process', async t => {
  const f = await fixture(t); const bad = await pairing(f, `let input=''; for await(const b of process.stdin)input+=b; const r=JSON.parse(input);console.log(JSON.stringify({...r,model:'wrong-model',executed:true,output:'OK'}));`);
  const candidate = await bad.paired.inspect(bad.invite.id); await bad.paired.accept(bad.invite.id, candidate.fingerprint);
  await assert.rejects(bad.paired.run(candidate.id, { mode: 'probe', cwd: f.source }, new AbortController().signal), { code: 'PAIRED_PROTOCOL' });
  await writeFile(bad.runner, 'setInterval(()=>{},1000)'); const controller = new AbortController();
  const call = bad.paired.run(candidate.id, { mode: 'probe', cwd: f.source }, controller.signal); const rejected = assert.rejects(call);
  await until(() => bad.paired.running.size === 1); controller.abort(new Error('Fixture cancel')); await rejected; assert.equal(bad.paired.running.size, 0);
});

test('paired error envelopes preserve matched causes without accepting failures or leaking mismatched output', () => {
  const expected = { requestId: 'request', model: 'fixture-model' };
  const reply = { protocol: 'acms.runner.v1', ...expected, error: 'timeout; Authorization: Bearer SECRET; api_key=PRIVATE\nend' };
  for (const code of [0, 1]) assert.throws(() => parsePairedResult({ code, stdout: JSON.stringify(reply) }, expected), error => {
    assert.equal(error.code, 'PAIRED_RUNNER_ERROR'); assert.match(error.message, /timeout/); assert(!/SECRET|PRIVATE|\n/.test(error.message)); return true;
  });
  for (const invalid of [{ ...reply, requestId: 'other' }, { ...reply, model: 'wrong' }, { ...reply, protocol: 'wrong' }]) {
    assert.throws(() => parsePairedResult({ code: 1, stdout: JSON.stringify(invalid) }, expected), error => !/SECRET|PRIVATE|timeout/.test(error.message));
  }
  assert.throws(() => parsePairedResult({ code: 0, stdout: '{bad SECRET' }, expected), { code: 'PAIRED_PROTOCOL' });
  assert.throws(() => parsePairedResult({ code: 1, stdout: JSON.stringify({ ...reply, error: undefined, executed: true, output: 'OK' }) }, expected), { code: 'PAIRED_RUN_FAILED' });
});

test('paired adapter propagates the verified runner error through a real child process', async t => {
  const f = await fixture(t); const p = await pairing(f, `let raw='';for await(const b of process.stdin)raw+=b;const r=JSON.parse(raw);console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,model:r.model,error:'Codex runner timeout (total budget 1080000 ms exceeded)'}));process.exitCode=1;`);
  const candidate = await p.paired.inspect(p.invite.id); await p.paired.accept(p.invite.id, candidate.fingerprint);
  await assert.rejects(p.paired.run(candidate.id, { mode: 'probe', cwd: f.source }), error => {
    assert.equal(error.code, 'PAIRED_RUNNER_ERROR'); assert.match(error.message, /1080000/); assert(!error.message.includes('配置')); return true;
  });
  assert.equal(p.paired.running.size, 0);
  const adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired: p.paired });
  const health = await adapter.probeModel({ provider: candidate.id, model: candidate.model });
  assert.equal(health.status, 'unavailable'); assert.match(health.reason, /1080000/); assert(!health.reason.includes('45 秒'));
});

test('uncertain descendant cleanup enters reconciliation without automatic retry or repair', async t => {
  const f = await fixture(t); const p = await pairing(f, `let raw='';for await(const b of process.stdin)raw+=b;const r=JSON.parse(raw);console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,model:r.model,error:'process tree cleanup unconfirmed',executor:{childClosed:true,cleanup:{childClosed:true,treeTerminationConfirmed:false,unresolvedPid:null}}}));process.exitCode=1;`);
  const candidate = await p.paired.inspect(p.invite.id); await p.paired.accept(p.invite.id, candidate.fingerprint);
  f.engine.adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired: p.paired });
  const task = f.task(); await f.start(); await until(() => f.store.list('attempts').some(a => a.status === 'reconciling' && a.cleanupPending));
  for (let i = 0; i < 5; i++) await f.engine.tick();
  assert.equal(f.store.require('tasks', task.id).status, 'reconciling');
  assert.equal(f.store.list('attempts').length, 1); assert.equal(f.store.list('tasks').length, 1);
  assert.match(f.store.list('attempts')[0].cleanupError, /cleanup unconfirmed/);
});
