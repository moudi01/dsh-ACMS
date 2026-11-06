import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { createRoutes } from '../src/host/http.js';
import { run } from '../src/runtime/workspaces.js';
import { promptFor } from '../src/runtime/prompt.js';
import { defaultSimulation } from '../src/adapters/simulated.js';
import { verifyCollaboration } from '../src/runtime/collaboration.js';

test('adding a project through the UI route creates .acms and preserves owner notes on later saves', async t => {
  const f = await fixture(t); const source = path.join(f.root, 'new-project'); await mkdir(source);
  const route = createRoutes(f).find(r => r.path.endsWith('/command'));
  const command = async (name,args) => (await route.fetch(new Request('http://dsh/api/acms/command', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),name,args})}))).json();
  const saved = await command('project.save', { name: 'New', repoRoot: source, mode:'copy',checks:[] });
  assert.equal(saved.ok,true); assert(!saved.value.collaborationWarning);
  const marker = JSON.parse(await readFile(path.join(source,'.acms/project.json'),'utf8')); assert.equal(marker.projectId,saved.value.id);
  await writeFile(path.join(source,'.acms/shared.md'),'Owner handoff, preserve exactly.');
  await command('project.save', {...saved.value,name:'Renamed',expectedRevision:saved.value.revision});
  assert.equal(await readFile(path.join(source,'.acms/shared.md'),'utf8'),'Owner handoff, preserve exactly.');
  assert.equal((await command('agent.save',{name:'Another worker',role:'worker'})).ok,true);
});

test('task handoff reaches an existing Git workspace without committing source notes; context is excluded from delivery changes', async t => {
  const f = await fixture(t);
  const git = async args => { const r = await run('git',args,f.source); assert.equal(r.code,0,r.stderr); return r.stdout; };
  await git(['init']); await git(['add','README.md']); await git(['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','baseline']);
  f.command('project.save',{...f.project,mode:'git',expectedRevision:f.project.revision});
  const parent = f.task({title:'Parent scope'}); const task = f.task({title:'Continue',parentId:parent.id});
  f.store.transaction(()=> f.store.put('attempts',{id:'checkpoint',taskId:parent.id,status:'blocked',summary:'Only inspect existing assets.',handoff:'Latest checkpoint; do not repeat the inventory.'}));
  let workspace = await f.workspaces.prepare(task,{});
  await writeFile(path.join(workspace.path,'ongoing.md'),'Existing unfinished work');
  await writeFile(path.join(f.source,'.acms/shared.md'),'Use the approved scope and previous checkpoint.');
  workspace = await f.workspaces.prepare({...task,workspace},{});
  const context = JSON.parse(await readFile(path.join(workspace.path,workspace.collaboration.index),'utf8'));
  const previous = context.tasks.find(t=>t.id===parent.id).attempts[0];
  assert.equal(previous.summary,'Only inspect existing assets.');
  assert.match(previous.handoff,/Latest checkpoint/);
  assert.match(await readFile(path.join(workspace.path,'.acms/shared.md'),'utf8'),/approved scope/);
  assert.equal(await readFile(path.join(workspace.path,'ongoing.md'),'utf8'),'Existing unfinished work');
  assert.deepEqual((await f.workspaces.captureChanges({...task,workspace})).map(c=>c.path),['ongoing.md']);
  assert.match(promptFor(f.company,{...task,workspace},{agentId:'manager',id:'test-attempt'}),/\.acms\/context.json/);
  await verifyCollaboration(workspace);
  await writeFile(path.join(workspace.path,'.acms/context.json'),'tampered');
  await assert.rejects(verifyCollaboration(workspace),{code:'COLLABORATION_CHANGED'});
});

test('review uses the author context revision; uncommitted .acms does not block safe Git integration', async t => {
  let originalRevision;
  const f = await fixture(t,async input=>{
    if(input.task.kind==='work') { originalRevision=input.task.workspace.collaboration.revision; await writeFile(path.join(f.source,'.acms/shared.md'),'New owner note after the author began.'); }
    else { assert.equal(input.task.workspace.collaboration.revision,originalRevision); assert(!String(await readFile(path.join(input.task.workspace.path,'.acms/shared.md'))).includes('New owner note')); }
    return defaultSimulation(input);
  });
  for(const args of [['init'],['add','README.md'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','baseline']]) { const r=await run('git',args,f.source); assert.equal(r.code,0,r.stderr); }
  f.command('project.save',{...f.project,mode:'git',autoMerge:true,expectedRevision:f.project.revision});
  const task=f.task(); await f.start(); await until(()=>f.store.require('tasks',task.id).status==='succeeded',15000);
  assert.match(await readFile(path.join(f.source,'deliverable.md'),'utf8'),/./);
  const tracked=await run('git',['ls-files','.acms'],f.source); assert.equal(tracked.stdout.trim(),'');
});

test('collaboration refuses a redirected .acms directory before writing outside the project', async t => {
  const f=await fixture(t); const outside=path.join(f.root,'outside'); await mkdir(outside);
  await symlink(outside,path.join(f.source,'.acms'),'junction');
  await assert.rejects(f.workspaces.publishProject(f.project),{code:'COLLABORATION_PATH'});
  assert.deepEqual(await readdir(outside),[]);
});

test('blocked handoff is retained and exported without declaring the task complete', async t => {
  const f=await fixture(t,async()=>({outcome:'blocked',kind:'human',reason:'Missing new material',question:'Supply the new source.',reversibleDefault:'Saved a draft in task-documents/draft.md; no new approval.'}));
  const task=f.task(); await f.start(); await until(()=>f.store.require('tasks',task.id).status==='blocked' && f.engine.live.size===0);
  const pointer=JSON.parse(await readFile(path.join(f.source,'.acms/CURRENT.json'),'utf8'));
  const snapshot=JSON.parse(await readFile(path.join(f.source,'.acms',pointer.path),'utf8'));
  assert.match(snapshot.tasks.find(t=>t.id===task.id).attempts[0].handoff,/Saved a draft/);
  assert.equal(f.store.list('artifacts').length,0); assert.notEqual(f.store.require('tasks',task.id).status,'succeeded');
});
