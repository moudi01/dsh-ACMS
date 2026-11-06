import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const labels = { queued: '等待处理', sending: '提交中', restarting: '正在停止旧轮次', delivered: '执行器已接收', streaming: '正在回复', completed: '回复完成', failed: '失败', interrupted: '已中断' };
const closed = ['succeeded', 'failed', 'cancelled', 'archived', 'deleted'];
const modes = { chat: '独立对话', steer: '执行中 · 即时干预', restart: '执行中 · 中断续接', queued: '等待下一轮' };

export function ConversationWindow({ agentId, taskId: initialTaskId, data, close }) {
  const dialog = useRef(); const [taskId, setTaskId] = useState(initialTaskId ?? '');
  const drafts = useRef(new Map());
  const agent = data.agents.find(a => a.id === agentId);
  const tasks = data.tasks.filter(t => t.agentId === agentId && t.status !== 'deleted');
  useEffect(() => { const el = dialog.current; const previous = document.activeElement; el.showModal(); return () => { el.close(); if (previous?.isConnected) previous.focus(); }; }, []);
  return <dialog ref={dialog} className="acms-conversation" aria-labelledby="acms-chat-title" onCancel={e => { e.preventDefault(); close(); }}>
    <header><div><span className="acms-eyebrow">AGENT CONVERSATION</span><h2 id="acms-chat-title">与 {agent?.name ?? '历史智能体'} 对话</h2></div><button aria-label="关闭会话" onClick={close}>×</button></header>
    <div className="acms-chat-context"><label htmlFor="acms-chat-context">会话范围</label><select id="acms-chat-context" value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">独立对话 · 不关联任务</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select><small>{agent?.model || '自动选择模型'}{agent?.reasoningEffort ? ` / ${agent.reasoningEffort}` : ''}</small></div>
    <ConversationSession key={`${agentId}:${taskId}`} agentId={agentId} taskId={taskId || null} drafts={drafts.current} />
  </dialog>;
}

function ConversationSession({ agentId, taskId, drafts }) {
  const [view, setView] = useState(null); const [messages, setMessages] = useState([]); const [error, setError] = useState('');
  const [text, setText] = useState(drafts.get(taskId) ?? ''); const [sending, setSending] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [newMessages, setNewMessages] = useState(false); const [older, setOlder] = useState(false);
  const scroll = useRef(); const nearBottom = useRef(true); const pending = useRef(null); const active = useRef(true); const conversationId = useRef(null); const refresh = useRef(null);
  useEffect(() => {
    active.current = true; const controller = new AbortController(); let timer;
    const read = async () => {
      const next = await api.messages(conversationId.current, controller.signal);
      if (!active.current) return;
      setView(next);
      setMessages(previous => { const fresh = new Map(next.messages.map(m => [m.id, m])); return [...previous.map(m => fresh.get(m.id) ?? m), ...next.messages.filter(m => !previous.some(p => p.id === m.id))]; });
    };
    refresh.current = read;
    const poll = async () => { try { await read(); } catch(e) { if (!controller.signal.aborted) setError(e.message); } finally { if (active.current) timer = setTimeout(poll, 1000); } };
    api.conversation({ action: 'open', agentId, taskId }, controller.signal).then(chat => { if (active.current) { conversationId.current = chat.id; poll(); } }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => { active.current = false; clearTimeout(timer); controller.abort(); };
  }, [agentId, taskId]);
  const revision = messages.map(m => `${m.id}:${m.revision}`).join('|');
  useEffect(() => { if (!scroll.current) return; if (nearBottom.current) { scroll.current.scrollTop = scroll.current.scrollHeight; setNewMessages(false); } else setNewMessages(true); }, [revision]);
  const change = value => { setText(value); drafts.set(taskId, value); };
  const taskClosed = taskId && closed.includes(view?.taskStatus);
  const disabled = !view || sending || !text.trim() || !view.agentAvailable || taskClosed;
  const send = async (queue = false) => {
    if (disabled) return;
    setSending(true); setError('');
    const input = pending.current ?? { action: 'send', conversationId: conversationId.current, text: text.trim(), requestId: crypto.randomUUID(), mode: queue ? 'queue' : view.mode === 'queued' ? 'queue' : view.mode, expectedAttemptId: view.activeAttemptId };
    pending.current = input;
    try {
      await api.conversation(input);
      if (!active.current) return;
      pending.current = null; setUncertain(false); change(''); nearBottom.current = true; await refresh.current();
    } catch(e) {
      if (!active.current) return;
      if (e.code) { pending.current = null; setUncertain(false); setError(e.message); }
      else { setUncertain(true); setError('发送结果尚未确认。点击“核对并重试”会复用原请求，避免重复发送。'); }
      await refresh.current?.().catch(() => {});
    } finally { if (active.current) setSending(false); }
  };
  const loadOlder = async () => {
    try { const page = await api.messages(conversationId.current, undefined, messages[0]?.id); if (!active.current) return; nearBottom.current = false; setMessages(prev => [...page.messages.filter(m => !prev.some(p => p.id === m.id)), ...prev]); setOlder(!page.hasMore); }
    catch(e) { if (active.current) setError(e.message); }
  };
  const stop = async () => { try { await api.conversation({ action: 'stop', conversationId: conversationId.current }); await refresh.current(); } catch(e) { if (active.current) setError(e.message); } };
  return <>
    <div className="acms-chat-mode"><strong>{modes[view?.mode] ?? '连接会话…'}</strong><span>{view?.mode === 'steer' ? '消息进入当前执行；实际处理以智能体回复为准。' : view?.mode === 'restart' ? '当前执行器不支持轮内消息。中断后保留工作副本，按新方向续接。' : taskId ? '消息随下一轮任务送达，不会解除暂停或材料阻塞。' : '可讨论进展和方案；业务派工、权限和验收仍在任务界面操作。'}</span>{view?.paused && <small>公司调度已暂停</small>}</div>
    <div ref={scroll} className="acms-chat-history" role="log" aria-label="会话记录" aria-live="polite" aria-relevant="additions" onScroll={() => { const el = scroll.current; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70; if (nearBottom.current) setNewMessages(false); }}>
      {view?.hasMore && !older && <button className="text" onClick={loadOlder}>加载更早的消息</button>}
      {!messages.length && <div className="acms-chat-empty"><b>{taskId ? '直接向负责人说明新的方向' : '开始与智能体交谈'}</b><p>{taskId ? '例如：先核对已有材料，完成当前步骤后汇报。' : '例如：目前有哪些阻塞？下一步建议怎么做？'}</p><small>打开会话不会启动模型；发送消息后才会调用。</small></div>}
      {messages.map(m => <article key={m.id} className={`acms-chat-message ${m.role === 'user' ? 'owner' : 'agent'}`}><div className="acms-chat-meta"><b>{m.role === 'user' ? '你' : '智能体'}</b><time>{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span className={['failed','interrupted'].includes(m.status) ? 'failed' : ''}>{m.taskId && m.status === 'queued' ? '等待下一轮' : labels[m.status] ?? m.status}</span></div><p>{m.text || (m.status === 'streaming' ? '等待回复…' : '未收到回复')}</p>{m.error && <small className="acms-chat-error">{m.error}</small>}</article>)}
    </div>
    {newMessages && <button className="acms-chat-new" onClick={() => { nearBottom.current = true; scroll.current.scrollTop = scroll.current.scrollHeight; setNewMessages(false); }}>查看最新消息 ↓</button>}
    <div className="acms-chat-compose">
      {error && <p role="alert" className="acms-chat-error">{error}</p>}
      {taskClosed && <p>此任务已结束。可切换到独立对话继续讨论。</p>}
      {view && !view.agentAvailable && <p>角色当前不可用，请先恢复角色。</p>}
      <label htmlFor="acms-chat-input">消息</label><textarea id="acms-chat-input" value={text} maxLength={12000} rows={3} disabled={sending || uncertain || taskClosed || !view?.agentAvailable} onChange={e => change(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} placeholder={taskId ? '说明当前任务的新方向…' : '输入想讨论的问题…'} />
      <div className="acms-chat-send"><small>Ctrl + Enter 发送 · {text.length}/12000</small><div>{view?.busy && !taskId && <button onClick={stop}>停止回复</button>}{taskId && view?.activeAttemptId && !uncertain && <button disabled={disabled} onClick={() => send(true)}>留到下一轮</button>}<button className="primary" disabled={disabled || view?.mode === 'restart' && view?.paused && !uncertain} onClick={() => send()}>{sending ? '提交中…' : uncertain ? '核对并重试' : view?.mode === 'steer' ? '即时发送' : view?.mode === 'restart' ? '中断并续接' : taskId ? '留给下一轮' : '发送'}</button></div></div>
    </div>
  </>;
}
