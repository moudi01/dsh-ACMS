import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, until } from './helpers.js';
import { PairedRuntimes } from '../src/adapters/paired.js';

test('paired Codex app-server supports live steer and reports actual turn receipt with cleanup', async t => {
  const f = await fixture(t); const children = [];
  const paired = new PairedRuntimes(f.company, f.dataDir, { spawn: spec => {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, windowsHide: true, stdio: 'pipe' }); children.push(child);
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (exitCode, signal) => resolve({ exitCode, signal })); });
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done, terminate: () => child.kill(), waitForExit: () => done.then(() => true) };
  } });
  const fake = path.join(f.root, 'fake-codex-chat.mjs');
  await writeFile(fake, `import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notice=(method,params)=>send({jsonrpc:'2.0',method,params});
const threadId='isolated-thread',turnId='isolated-turn';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),p=r.params,reply=result=>send({jsonrpc:'2.0',id:r.id,result});
 if(r.method==='initialize')reply({});
 if(r.method==='thread/start') { if(p.model!=='gpt-6.1-terra'||p.approvalPolicy!=='never'||p.sandbox!=='workspace-write')throw Error('wrong config'); reply({thread:{id:threadId,ephemeral:false},model:p.model}); }
 if(r.method==='turn/start') { if(p.effort!=='high')throw Error('wrong depth');reply({turn:{id:turnId}});notice('turn/started',{threadId,turn:{id:turnId,status:'inProgress'}});setTimeout(()=>notice('item/agentMessage/delta',{threadId,turnId,itemId:'progress',delta:'Working'}),100); }
 if(r.method==='turn/steer'){ if(p.expectedTurnId!==turnId||p.threadId!==threadId)throw Error('wrong turn');reply({turnId});notice('item/completed',{threadId,turnId,item:{id:'reply',type:'agentMessage',phase:'final_answer',text:JSON.stringify({outcome:'completed',summary:'方向已调整',artifacts:[]})}});notice('turn/completed',{threadId,turn:{id:turnId,status:'completed'}}); }
 if(r.method==='turn/interrupt')reply({});
});`);
  const invite = await paired.invite(); const token = /"token": "([^"]+)"/.exec(invite.prompt)[1];
  await writeFile(invite.responseFile, JSON.stringify({ protocol: 'acms.runner.v1', inviteId: invite.id, token, name: 'Isolated Codex', model: 'gpt-6.1-terra', command: process.execPath, args: [fake, 'app-server'], persistent: false, runtime: 'codex-app-server', reasoningEffort: 'high', probeSupported: false, probeReason: 'No verified probe mode' }));
  const candidate = await paired.inspect(invite.id); assert.equal(candidate.runtime, 'codex-app-server'); await paired.accept(invite.id, candidate.fingerprint);
  assert.equal(children.length, 0);
  let accepted = false;
  const run = paired.run(candidate.id, { mode: 'task', cwd: f.source, contextKey: 'test', attemptId: 'attempt-live', prompt: 'fixture', onAccepted: () => { accepted = true; } }, AbortSignal.timeout(8000));
  const outcome = run.then(value => ({ value }), error => ({ error }));
  await until(() => accepted && paired.canSteer('attempt-live'));
  assert.equal(paired.canSteer('other-attempt'), false);
  // Turn readiness and streamed text arrive independently; wait for the delayed delta.
  await until(() => paired.taskMessages('attempt-live').length > 0);
  assert.equal(paired.taskMessages('attempt-live')[0].text, 'Working');
  assert.equal(await paired.steer('attempt-live', '新的方向', AbortSignal.timeout(1000)), 'isolated-turn');
  const result = await outcome; if (result.error) throw result.error;
  assert.equal(result.value.output.summary, '方向已调整'); assert.equal(paired.running.size, 0);
  assert.equal(paired.canSteer('attempt-live'), false); assert(children.every(c => c.exitCode !== null || c.signalCode !== null));
});
