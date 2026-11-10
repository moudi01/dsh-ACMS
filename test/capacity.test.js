import test from 'node:test';
import assert from 'node:assert/strict';
import { executionCapacity, executionOccupancy, capacityBlockReason } from '../src/core/execution-capacity.js';

const store = data => ({ list: name => data[name] ?? [] });
const policy = value => ({ maxConcurrent: 4, controlSlots: 1, ...value });

test('纯聊天、模型检测和任务执行各占一个名额', () => {
  const tasks = [{ id: 'task_running', goalId: 'goal_1', title: 'Running task', status: 'running' }];
  const attempts = [{ id: 'attempt_running', taskId: 'task_running', goalId: 'goal_1', agentId: 'agent_1', status: 'running' }];
  const chat = executionCapacity(store({ tasks }), { activeChats: 1 }, null, policy());
  assert.equal(chat.used, 1);
  assert.equal(chat.entries.length, 1);
  assert.equal(chat.entries[0].kind, 'chat');
  assert.equal(chat.phases.chat, 1);
  assert.equal(chat.free, 3);

  const probe = executionCapacity(store({}), { activeProbes: 1 }, null, policy());
  assert.equal(probe.used, 1);
  assert.equal(probe.counts.probe, 1);
  assert.equal(probe.phases.probe, 1);

  const task = executionCapacity(store({ tasks, attempts }), {}, null, policy());
  assert.equal(task.used, 1);
  assert.equal(task.entries[0].kind, 'attempt');
  assert.equal(task.entries[0].phase, 'running');
  assert.equal(task.entries[0].goalId, 'goal_1');
});

test('区分运行中、正在停止和待清理核对', () => {
  const tasks = [
    { id: 'task_stopping', goalId: 'goal_1', title: 'Stopping task', status: 'running', stopRequested: 'paused' },
    { id: 'task_cleaning', goalId: 'goal_1', title: 'Cleaning task', status: 'reconciling' },
  ];
  const attempts = [
    { id: 'attempt_running', taskId: 'task_1', status: 'running' },
    { id: 'attempt_stopping', taskId: 'task_stopping', status: 'running' },
    { id: 'attempt_cancelling', taskId: 'task_2', status: 'cancelling' },
    { id: 'attempt_cleaning', taskId: 'task_cleaning', status: 'reconciling' },
    { id: 'attempt_cleanup_pending', taskId: 'task_3', status: 'completed', cleanupPending: true },
  ];
  const capacity = executionCapacity(store({ tasks, attempts }), {}, null, policy({ maxConcurrent: 8 }));
  assert.equal(capacity.used, 5);
  assert.equal(capacity.phases.running, 1);
  assert.equal(capacity.phases.stopping, 2);
  assert.equal(capacity.phases.cleanupPending, 2);
});

test('待清理的集成与任务占用分别计入且共用同一阶段', () => {
  const tasks = [{ id: 'task_integration', goalId: 'goal_1', title: 'Integration task', status: 'integrating' }];
  const integrations = [
    { id: 'integration_checking', taskId: 'task_integration', phase: 'checking' },
    { id: 'integration_reconciling', taskId: 'task_integration', phase: 'reconciling' },
  ];
  const capacity = executionCapacity(store({ tasks, integrations }), {}, null, policy());
  assert.equal(capacity.used, 2);
  assert.equal(capacity.counts.integration, 2);
  assert.equal(capacity.phases.integrating, 1);
  assert.equal(capacity.phases.cleanupPending, 1);
});

test('多种活动混合时总占用等于各类之和，且同一活动只计一次', () => {
  const tasks = [
    { id: 'task_running', goalId: 'goal_1', title: 'Running task', status: 'running' },
    { id: 'task_integration', goalId: 'goal_2', title: 'Integration task', status: 'integrating' },
  ];
  const attempts = [{ id: 'attempt_running', taskId: 'task_running', status: 'running' }];
  const integrations = [{ id: 'integration_1', taskId: 'task_integration', phase: 'applying' }];
  const adapter = { activeChats: 2, activeProbes: 1, activeChatDetails: new Map([['chat_a', { conversationId: 'chat_a', agentId: 'agent_1', phase: 'chat' }]]) };
  const live = new Map([['attempt_running', {}]]);
  const data = store({ tasks, attempts, integrations });
  const capacity = executionCapacity(data, adapter, live, policy({ maxConcurrent: 7, controlSlots: 1 }));
  assert.equal(capacity.used, 5);
  assert.deepEqual(capacity.counts, { attempt: 1, integration: 1, chat: 2, probe: 1 });
  assert.equal(capacity.entries.length, 5);
  assert.equal(capacity.entries.filter(entry => entry.kind === 'chat').length, 2);
  assert.equal(capacity.entries.find(entry => entry.kind === 'chat' && entry.conversationId === 'chat_a')?.agentId, 'agent_1');
  assert.equal(capacity.free, 2);
  assert.equal(capacity.ordinaryLimit, 6);
  assert.equal(executionOccupancy(data, adapter, live).used, capacity.used);
});

test('满额时给出与宿主拒绝一致的阻塞原因，未满额时不阻塞', () => {
  const adapter = { activeChats: 1, activeProbes: 1 };
  const integrations = [{ id: 'integration_1', taskId: 'task_1', phase: 'applying' }];
  const tasks = [{ id: 'task_1', goalId: 'goal_1', title: 'Task', status: 'integrating' }];
  const attempts = [{ id: 'attempt_1', taskId: 'task_2', status: 'running' }];
  const capacity = executionCapacity(store({ tasks, attempts, integrations }), adapter, null, policy());
  assert.equal(capacity.used, 4);
  assert.equal(capacity.free, 0);
  assert.match(capacityBlockReason(capacity), /执行资源已满（4\/4）/);
  assert.match(capacityBlockReason(capacity), /任务 1/);
  assert.match(capacityBlockReason(capacity), /独立对话 1/);
  assert.equal(capacityBlockReason(executionCapacity(store({}), {}, null, policy())), '');
});

test('缺少上限字段时保持未知而不是伪造空闲名额', () => {
  const capacity = executionCapacity(store({}), { activeChats: 1 }, null, { maxConcurrent: undefined });
  assert.equal(capacity.limit, null);
  assert.equal(capacity.free, null);
  assert.equal(capacityBlockReason(capacity), '');
});
