const pending = new Map();
function transport(input, init) { return (globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch.bind(globalThis))(input, init); }
async function request(route, options = {}) {
  const response = await transport(`api/acms/${route}`, { credentials: 'same-origin', ...options });
  const value = await response.json();
  if (!response.ok || value.ok === false) { const e = new Error(value.error?.message ?? `HTTP ${response.status}`); e.code = value.error?.code; throw e; }
  return value;
}
export const api = {
  conversation: (input, signal) => request('conversation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }),
  messages: (id, signal, before) => request(`conversation?id=${encodeURIComponent(id)}${before ? `&before=${encodeURIComponent(before)}` : ''}`, { signal }),
  pairing: input => request('pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  snapshot: signal => request('state', { signal }),
  events: (after, signal) => request(`events?after=${after}`, { signal }),
  activity: (query = {}, signal) => {
    const params = new URLSearchParams();
    for (const key of ['before', 'after', 'limit', 'projectId', 'goalId', 'taskId']) if (query[key] !== undefined && query[key] !== null && query[key] !== '') params.set(key, query[key]);
    return request(`activity?${params.toString()}`, { signal });
  },
  artifact: id => request(`artifact?id=${encodeURIComponent(id)}`),
  directories: directory => request(`directories?path=${encodeURIComponent(directory)}`),
  modelDetails: (input, signal) => request('model-details', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }),
  modelCheck: input => request('model-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  async command(name, args) {
    const key = JSON.stringify([name, args]); const requestId = pending.get(key) ?? crypto.randomUUID(); pending.set(key, requestId);
    const result = await request('command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args, requestId }) });
    pending.delete(key); return result.value;
  },
};
