import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.js';

test('manager creates a zero-grant worker, assigns its returned ID, and work completes', async t => {
 const f=await fixture(t);const actor={kind:'agent',id:'manager',goalId:f.goal.id};
 const worker=f.command('agent.save',{name:'Delegated worker',role:'worker',provider:'simulation',temporary:true,grants:[]},actor);
 const task=f.command('task.create',{goalId:f.goal.id,agentId:worker.id,title:'Actually delegated work'},actor);
 assert.equal(task.agentId,worker.id);assert.deepEqual(worker.grants,[]);
 const audit=f.store.page(0,200).entries;
 assert(audit.some(e=>e.type==='agent.saved'&&e.entityId===worker.id&&e.actor==='manager'));
 assert(audit.some(e=>e.type==='task.created'&&e.entityId===task.id&&e.actor==='manager'));
 await f.start();await until(()=>f.store.require('tasks',task.id).status==='succeeded');
 assert(f.store.list('attempts').some(a=>a.agentId===worker.id&&a.status==='completed'));
 assert(f.store.list('verifications').some(v=>v.taskId===task.id&&v.kind==='checks'&&v.passed));
});

test('worker cannot create agents, assign or edit tasks, or change company policy', async t => {
 const f=await fixture(t);const manager={kind:'agent',id:'manager',goalId:f.goal.id};
 const worker=f.command('agent.save',{name:'Restricted worker',role:'worker',grants:[]},manager);
 const task=f.task();const actor={kind:'agent',id:worker.id,goalId:f.goal.id};
 for(const [name,args] of [
  ['agent.save',{name:'Unauthorized manager',role:'manager'}],
  ['task.create',{goalId:f.goal.id,title:'Unauthorized assignment'}],
  ['task.edit',{id:task.id,patch:{agentId:'manager'}}],
  ['policy.update',{patch:{maxConcurrent:8}}]
 ])assert.throws(()=>f.command(name,args,actor),{code:'FORBIDDEN'},name);
 assert.equal(f.store.list('tasks').length,1);
});

test('manager cannot bypass worker grant ceiling, company policy, or another goal scope', async t => {
 const f=await fixture(t);const actor={kind:'agent',id:'manager',goalId:f.goal.id};
 assert.throws(()=>f.command('agent.save',{name:'Overpowered worker',role:'worker',grants:['agent.save']},actor),{code:'GRANT_DENIED'});
 assert.throws(()=>f.command('policy.update',{patch:{maxConcurrent:8}},actor),{code:'FORBIDDEN'});
 const other=f.command('goal.create',{projectId:f.project.id,title:'Other goal',description:'Fixture',acceptance:'Fixture',plan:false});
 assert.throws(()=>f.command('task.create',{goalId:other.id,title:'Cross-goal assignment'},actor),{code:'SCOPE_DENIED'});
});

test('ordinary commands reject client-chosen IDs and unresolved batch-only references', async t => {
 const f=await fixture(t);const actor={kind:'agent',id:'manager',goalId:f.goal.id};
 assert.throws(()=>f.command('agent.save',{id:'new-client-chosen-id',name:'Worker',role:'worker'},actor),{code:'NOT_FOUND'});
 const worker=f.command('agent.save',{name:'Batch-created worker',role:'worker',grants:[]},actor);
 assert(worker.id.startsWith('agent_'));
 assert.throws(()=>f.command('task.create',{goalId:f.goal.id,title:'Refer to prior batch result',agentId:'$actions[0].id'},actor),{code:'NOT_FOUND'});
 assert.equal(f.store.list('tasks').length,0);
});

test('restricted manager must not grant another manager permissions it does not hold', async t => {
 const f=await fixture(t);
 const restricted=f.command('agent.save',{name:'Role creation only',role:'manager',grants:['agent.save']});
 const actor={kind:'agent',id:restricted.id,goalId:f.goal.id};
 let created,error;
 try{created=f.command('agent.save',{name:'Expanded manager',role:'manager'},actor);}catch(e){error=e.code;}
 console.log('Delegation escalation evidence',JSON.stringify({issuerGrants:restricted.grants,createdGrants:created?.grants,error:error??null}));
 assert(error||created.grants.every(g=>restricted.grants.includes(g)),'A restricted manager indirectly obtained additional management powers');
});
