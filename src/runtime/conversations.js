import path from 'node:path';
import { promises as fs } from 'node:fs';
import { assert, id, now, OWNER, SYSTEM, digest } from '../core/util.js';
import { executionOccupancy } from '../core/execution-capacity.js';

const LIVE = ['preparing', 'running', 'cancelling', 'reconciling'];
const PENDING = ['queued', 'sending', 'restarting', 'streaming'];
const limitText = value => String(value ?? '').slice(0, 65536);

/** Owner conversations are separate from role definitions and business task contracts. */
export class Conversations {
  constructor(company, engine, adapter, dataDir) {
    this.company = company; this.store = company.store; this.engine = engine; this.adapter = adapter; this.dataDir = dataDir;
    this.jobs = new Map(); this.deliveries = new Map(); this.quarantined = new Set(); this.closing = false;
    engine.conversations = this;
  }
  recover() {
    for (const m of this.store.list('conversationMessages').filter(m => m.role === 'user' && m.cleanupPending)) {
      if (!this.quarantined.has(m.id)) { this.quarantined.add(m.id); this.adapter.activeChats = (this.adapter.activeChats ?? 0) + 1; }
    }
    this.store.transaction(() => {
      for (const m of this.store.list('conversationMessages').filter(m => PENDING.includes(m.status) && !(m.taskId && m.status === 'queued'))) {
        this.save({ ...m, status: 'interrupted', error: '服务已重启，未确认完成；请核对后重新发送。' });
      }
    });
  }
  save(message) {
    const saved = this.store.put('conversationMessages', message);
    this.store.event('conversation.message', saved.id, { conversationId: saved.conversationId, status: saved.status }, SYSTEM);
    return saved;
  }
  update(messageId, patch) { return this.store.transaction(() => this.save({ ...this.store.require('conversationMessages', messageId), ...patch })); }
  open({ agentId, taskId = null }) {
    const agent = this.store.require('agents', agentId); assert(agent.status !== 'deleted', 'ENTITY_DELETED', '角色已删除');
    if (taskId) {
      const task = this.store.require('tasks', taskId);
      assert(task.status !== 'deleted' && task.agentId === agentId, 'CHAT_SCOPE', '请选择这个智能体负责的任务');
    }
    const key = `conversation_${digest([agentId, taskId])}`;
    return this.store.get('conversations', key) ?? this.store.transaction(() => {
      const chat = this.store.put('conversations', { id: key, agentId, taskId });
      this.store.event('conversation.opened', key, { agentId, taskId }, OWNER); return chat;
    });
  }
  current(chat) {
    return this.store.list('attempts').filter(a => a.agentId === chat.agentId && a.taskId === chat.taskId && LIVE.includes(a.status)).at(-1);
  }
  async view(conversationId, before) {
    const chat = this.store.require('conversations', conversationId);
    const active = this.current(chat);
    if (active) await this.collect(active);
    const all = this.store.list('conversationMessages').filter(m => m.conversationId === conversationId);
    const cut = before ? all.findIndex(m => m.id === before) : all.length;
    const end = cut < 0 ? all.length : cut; const messages = all.slice(Math.max(0, end - 80), end);
    const task = chat.taskId && this.store.get('tasks', chat.taskId);
    return { conversation: chat, messages, hasMore: end > 80, activeAttemptId: active?.id ?? null,
      taskStatus: task?.status ?? null, mode: !chat.taskId ? 'chat' : active ? this.adapter.canSteer?.(active) ? 'steer' : 'restart' : 'queued',
      busy: this.jobs.has(chat.id), paused: this.company.policy().paused,
      agentAvailable: this.store.get('agents', chat.agentId)?.status === 'available' };
  }
  send({ conversationId, text, requestId, mode = 'chat', expectedAttemptId = null }) {
    assert(typeof text === 'string' && text.trim() && text.length <= 12000, 'CHAT_TEXT', '请输入 1 至 12000 字的消息');
    const chat = this.store.require('conversations', conversationId);
    const agent = this.store.require('agents', chat.agentId);
    assert(agent.status === 'available', 'AGENT_RETIRED', '角色不可用，请先恢复角色');
    const result = this.store.command(OWNER, requestId, 'conversation.send', { conversationId, text, mode, expectedAttemptId }, () => {
      const active = this.current(chat);
      if (chat.taskId) {
        const task = this.store.require('tasks', chat.taskId);
        assert(task.agentId === chat.agentId && task.status !== 'deleted', 'CHAT_SCOPE', '任务负责人已变化，请重新打开会话');
        assert(!['succeeded', 'cancelled', 'archived', 'failed'].includes(task.status), 'CHAT_TASK_CLOSED', '任务已结束，请切换到独立对话');
        assert((active?.id ?? null) === expectedAttemptId, 'CHAT_STALE', '执行轮次已变化，请刷新后发送');
        assert(!active || active.status === 'running', 'CHAT_TRANSITION', '执行正在准备或清理，请稍候');
        assert(!active || mode === 'queue' || !task.stopRequested && !this.engine.live.get(active.id)?.controller.signal.aborted, 'CHAT_TRANSITION', '当前执行正在停止；可把消息留到下一轮');
        assert(!active || ['steer', 'restart', 'queue'].includes(mode), 'CHAT_MODE', '请选择即时干预或中断续接');
        assert(!active || mode !== 'steer' || this.adapter.canSteer?.(active), 'CHAT_NO_STEER', '这个执行器需要使用中断并续接');
        if (active && mode === 'restart') assert(!this.company.policy().paused, 'CHAT_PAUSED', '调度已暂停，不能自动续接；可先保留消息到下一轮');
        const pending = this.store.list('conversationMessages').filter(m => m.conversationId === chat.id && ['queued', 'restarting', 'sending'].includes(m.status));
        assert(pending.length < 20 && pending.reduce((n,m) => n + m.text.length, 0) + text.length <= 24000, 'CHAT_BACKLOG', '待处理消息较多，请等待送达后再发送');
      } else assert(mode === 'chat', 'CHAT_MODE', '独立对话不操作业务执行');
      return this.save({ id: id('message'), conversationId, agentId: chat.agentId, taskId: chat.taskId, role: 'user', text: text.trim(),
        status: active && mode !== 'queue' ? mode === 'restart' ? 'restarting' : 'sending' : 'queued', mode, targetAttemptId: active?.id ?? null });
    });
    const message = this.store.require('conversationMessages', result.id);
    if (message.status === 'sending' && !this.deliveries.has(message.id)) {
      const job = this.deliver(message).finally(() => this.deliveries.delete(message.id)); this.deliveries.set(message.id, job);
    } else if (message.status === 'restarting') {
      const live = this.engine.live.get(message.targetAttemptId);
      if (live && !live.controller.signal.aborted) live.controller.abort(Object.assign(new Error('Owner changed direction through conversation'), { code: 'OWNER_STEER' }));
      else if (!live) this.update(message.id, { status: 'failed', error: '原执行已结束，未中断或续接其他轮次。' });
    } else if (!chat.taskId && message.status === 'queued') this.pump(chat);
    return this.store.require('conversationMessages', message.id);
  }
  async deliver(message) {
    try {
      const a = this.store.require('attempts', message.targetAttemptId);
      assert(a.status === 'running' && this.engine.live.has(a.id), 'CHAT_STALE', '原执行已结束，未向新轮次转发');
      const receipt = await this.adapter.steer(a, `公司所有者的即时消息（${message.id}）：\n${message.text}\n请按新方向继续当前任务；不得扩大权限或跳过独立验收。`, AbortSignal.timeout(15000));
      this.update(message.id, { status: 'delivered', attemptId: a.id, deliveredAt: now(), receipt: String(receipt ?? '') });
    } catch (error) { this.update(message.id, { status: 'failed', error: limitText(error.message) }); }
  }
  messagesFor(task, agentId) {
    const messages = this.store.list('conversationMessages').filter(m => m.taskId === task.id && m.agentId === agentId && m.role === 'user' && ['queued', 'restarting', 'delivered'].includes(m.status));
    let budget = 32000; const pending = messages.filter(m => m.status !== 'delivered');
    budget -= pending.reduce((n,m) => n + m.text.length, 0);
    const history = [];
    for (const m of messages.filter(m => m.status === 'delivered').slice(-10).reverse()) { if (m.text.length > budget) break; history.unshift(m); budget -= m.text.length; }
    return [...history, ...pending];
  }
  accepted(attempt) {
    this.store.transaction(() => {
      for (const messageId of attempt.conversationMessageIds ?? []) {
        const m = this.store.require('conversationMessages', messageId);
        if (['queued', 'restarting'].includes(m.status)) this.save({ ...m, status: 'delivered', attemptId: attempt.id, deliveredAt: now() });
      }
    });
  }
  async collect(attempt) {
    const chat = this.store.list('conversations').find(c => c.agentId === attempt.agentId && c.taskId === attempt.taskId); if (!chat) return;
    for (const item of await this.adapter.taskMessages?.(attempt) ?? []) this.record(chat, attempt, item.id, item.text);
  }
  record(chat, attempt, key, text) {
    if (!text?.trim()) return;
    const messageId = `message_${digest([chat.id, attempt.id, key])}`;
    if (this.store.get('conversationMessages', messageId)?.text === limitText(text)) return;
    this.store.transaction(() => this.save({ id: messageId, conversationId: chat.id, agentId: chat.agentId, taskId: chat.taskId,
      role: 'assistant', text: limitText(text), status: 'completed', attemptId: attempt.id }));
  }
  finished(attempt, output) {
    const chat = this.store.list('conversations').find(c => c.agentId === attempt.agentId && c.taskId === attempt.taskId);
    if (chat && output?.summary) this.record(chat, attempt, 'result', output.summary);
  }
  pump(chat) {
    if (this.closing || this.jobs.has(chat.id)) return;
    const message = this.store.list('conversationMessages').find(m => m.conversationId === chat.id && m.role === 'user' && m.status === 'queued');
    if (!message) return;
    const controller = new AbortController();
    const job = { controller }; this.jobs.set(chat.id, job);
    job.promise = this.answer(chat, message, controller).finally(() => { this.jobs.delete(chat.id); this.engine.kick(); this.pump(chat); });
  }
  async answer(chat, message, controller) {
    let reply, jobCounted = false, cleanupPending = false; const timer = setTimeout(() => controller.abort(new Error('独立对话等待超时，请稍后重试')), 180000);
    try {
      assert(executionOccupancy(this.store, this.adapter).used < this.company.policy().maxConcurrent,
        'CHAT_CAPACITY', '执行资源已满，消息未发送；请稍后重试');
      this.adapter.activeChats = (this.adapter.activeChats ?? 0) + 1;
      jobCounted = true;
      this.update(message.id, { status: 'sending' });
      reply = this.store.transaction(() => this.save({ id: id('message'), conversationId: chat.id, agentId: chat.agentId, taskId: null,
        role: 'assistant', text: '', status: 'streaming', replyTo: message.id }));
      const agent = this.store.require('agents', chat.agentId);
      const candidates = this.store.list('conversationMessages').filter(m => m.conversationId === chat.id && (m.status === 'completed' || m.id === message.id || m.role === 'user' && m.status === 'delivered')).slice(-24);
      let remaining = 32000; const history = [];
      for (const m of candidates.reverse()) { if (remaining <= 0) break; const text = m.text.slice(-remaining); history.unshift({ role: m.role, text }); remaining -= text.length; }
      const tasks = this.store.list('tasks').filter(t => t.agentId === agent.id && t.status !== 'deleted').map(t => ({ id: t.id, title: t.title, status: t.status, summary: t.summary?.slice(0,1500) })).slice(-20);
      const prompt = `你是 ${agent.name}。职责：${agent.description}\n这是公司所有者的独立对话。直接回答问题；不得派工、修改任务/角色、授予权限或把聊天回复当成交付验收。若需要业务操作，说明应在任务界面执行。以下任务记录仅供说明现状：${JSON.stringify(tasks)}\n会话记录：${JSON.stringify(history.map(m => ({ role:m.role, text:m.text })))}\n请用自然语言回复，不输出推理过程。`;
      const cwd = path.join(this.dataDir, 'conversations', chat.id); await fs.mkdir(cwd, { recursive:true });
      let lastWrite = 0;
      const text = await this.adapter.chat({ agent, prompt, cwd, contextKey: chat.id, signal: controller.signal,
        onAccepted: () => this.update(message.id, { status:'delivered', deliveredAt:now() }),
        onText: value => { if (Date.now()-lastWrite > 150) { this.update(reply.id,{text:limitText(value)}); lastWrite=Date.now(); } } });
      controller.signal.throwIfAborted(); assert(text?.trim(), 'CHAT_EMPTY', '模型没有返回回复');
      this.update(message.id, { status:'delivered', deliveredAt: this.store.require('conversationMessages', message.id).deliveredAt ?? now() });
      this.update(reply.id, { status:'completed', text:limitText(text) });
    } catch(error) {
      cleanupPending = error.cleanupUncertain === true;
      if (cleanupPending) this.quarantined.add(message.id);
      const patch = { status:controller.signal.aborted ? 'interrupted' : 'failed', cleanupPending, error:limitText(error.message) };
      this.update(message.id, patch); if(reply) this.update(reply.id,patch);
    } finally { clearTimeout(timer); if(jobCounted && !cleanupPending) this.adapter.activeChats--; }
  }
  stop(conversationId) {
    this.store.require('conversations', conversationId); this.jobs.get(conversationId)?.controller.abort(new Error('所有者停止了本次回复'));
    this.store.transaction(() => { for(const m of this.store.list('conversationMessages').filter(m=>m.conversationId===conversationId && m.status==='queued' && !m.taskId)) this.save({...m,status:'interrupted',error:'所有者停止了待回复消息'}); });
    return { stopped:true };
  }
  async close() { this.closing=true; for(const j of this.jobs.values()) j.controller.abort(new Error('服务正在关闭')); await Promise.allSettled([...this.jobs.values()].map(j=>j.promise)); await Promise.allSettled([...this.deliveries.values()]); }
}
