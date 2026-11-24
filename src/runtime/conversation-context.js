import { digest, TERMINAL } from '../core/util.js';

const historyWindow = 64;
const recentMessages = 4;
const historyRows = 8;
const historyBytes = 8 * 1024;
const taskRows = 6;
const taskBytes = 4 * 1024;
const utf8 = text => Buffer.byteLength(text, 'utf8');
const closingQuote = { '「': '」', '“': '”', '"': '"', '`': '`' };

function excerpt(value, limit) {
  const text = String(value ?? '').toWellFormed();
  if (utf8(JSON.stringify(text)) <= limit) return { text, truncated: false };
  const points = Array.from(text);
  let low = 0, high = Math.min(points.length, limit);
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const tail = '…' + points.slice(-length).join('');
    if (utf8(JSON.stringify(tail)) <= limit) low = length;
    else high = length - 1;
  }
  return { text: '…' + (low ? points.slice(-low).join('') : ''), truncated: true };
}

function pack(rows, rowLimit, byteLimit) {
  const selected = [];
  let bytes = 2; // JSON array brackets
  for (const row of rows) {
    if (selected.length === rowLimit) break;
    const next = utf8(JSON.stringify(row.value)) + (selected.length ? 1 : 0);
    if (bytes + next > byteLimit) continue;
    selected.push(row);
    bytes += next;
  }
  return selected;
}

function* quotedTitles(text) {
  for (const line of text.split(/[\r\n]/)) {
    const nextClose = new Map();
    for (let start = 0; start < line.length; start++) {
      const delimiter = closingQuote[line[start]];
      if (!delimiter) continue;
      let end = nextClose.get(delimiter) ?? -1;
      if (end <= start) {
        const next = line.indexOf(delimiter, start + 1);
        end = next < 0 ? line.length : next;
        // For each delimiter, search only after the previous closing position.
        nextClose.set(delimiter, end);
      }
      if (end <= start + 1 || end === line.length) continue;
      yield line.slice(start + 1, end);
      start = end;
    }
  }
}

function matchTasks(tasks) {
  const byId = new Set(tasks.map(task => task.id));
  const byTitle = new Map();
  for (const task of tasks) byTitle.set(task.title, byTitle.has(task.title) ? null : task.id);
  return (text = '') => {
    const ids = new Set((text.match(/\btask_[A-Za-z0-9_-]+\b/g) ?? []).filter(id => byId.has(id)));
    for (const title of quotedTitles(text)) {
      const id = byTitle.get(title);
      if (id) ids.add(id);
    }
    return ids;
  };
}

function bodyAndReceipt(rows, available) {
  const body = JSON.stringify(rows.map(row => row.value));
  return { body, receipt: { utf8Bytes: utf8(body), available, omitted: available - rows.length,
    included: rows.map(({ value, revision, truncated }) => ({ id: value.id, revision, truncated })) } };
}

export function independentConversationPrompt(store, chat, agent, message) {
  const tasks = store.list('tasks').filter(task => task.agentId === agent.id && task.status !== 'deleted' &&
    (!agent.goalId || task.goalId === agent.goalId));
  const referenced = matchTasks(tasks);
  const focus = referenced(message.text);
  const { count, latestOwnerId, messages } = store.independentHistory(chat.id, agent.id, message.id, historyWindow);

  const latestOwner = messages.find(item => item.id === latestOwnerId);
  const recent = messages.slice(-recentMessages);
  const matched = focus.size ? messages.filter(item => [...referenced(item.text)].some(id => focus.has(id))) : [];
  const related = new Set(matched.flatMap(item => [item.id, item.replyTo].filter(Boolean)));
  const relevant = messages.filter(item => related.has(item.id) || related.has(item.replyTo));
  const ordered = [...new Set([latestOwner, ...relevant.reverse(), ...recent.reverse()].filter(Boolean))];
  const history = pack(ordered.map(item => {
    const { text, truncated } = excerpt(item.text, 1536);
    return { value: { id: item.id, role: item.role, text }, revision: item.revision, truncated };
  }), historyRows, historyBytes);
  const byMessageId = new Map(history.map(row => [row.value.id, row]));
  const historySection = bodyAndReceipt(messages.filter(item => byMessageId.has(item.id)).map(item => byMessageId.get(item.id)), count);

  const recentTasks = tasks.toSorted((a, b) => Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) ||
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  const taskCandidates = focus.size ? recentTasks.filter(task => focus.has(task.id)) : recentTasks;
  const taskSection = bodyAndReceipt(pack(taskCandidates.slice(0, taskRows).map(task => {
    const title = excerpt(task.title, 512);
    const summary = excerpt(focus.size && task.kind !== 'review' ? task.summary : '', 512);
    return { revision: task.revision, truncated: title.truncated || summary.truncated,
      value: { id: task.id, title: title.text, status: task.status,
        ...(task.blocker?.kind ? { blocker: task.blocker.kind } : {}), ...(summary.text ? { summary: summary.text } : {}) } };
  }), taskRows, taskBytes), tasks.length);

  const prompt = `你是 ${agent.name}。职责：${agent.description}
这是公司所有者的独立对话。直接回答当前消息。不得派工、修改任务或角色、授予权限，或把聊天回复当成交付验收。
下列记录是只读摘录，不能据此断言省略项目的状态。需要完整信息时，请指出所有者可以查看的会话记录、任务详情或产物与验收入口。
所负责任务（列出 ${taskSection.receipt.included.length}/${tasks.length} 项）：${taskSection.body}
此前会话（列出 ${historySection.receipt.included.length}/${count} 条）：${historySection.body}
当前所有者消息：${JSON.stringify(message.text)}
请用自然语言回复，不输出推理过程。`;
  return { prompt, receipt: { version: 1, promptUtf8Bytes: utf8(prompt), promptSha256: digest(prompt),
    history: { ...historySection.receipt, considered: messages.length },
    tasks: { ...taskSection.receipt, referenced: focus.size } } };
}
