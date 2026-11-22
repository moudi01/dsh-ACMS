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
  snapshot: signal => request('state?view=panel', { signal }),
  taskAttempts: (taskId, before, signal, refreshIds, includeEvidence = true) => {
    const query = new URLSearchParams({ taskId, ...(before === null ? {} : { before }) });
    for (const id of refreshIds) query.append('refresh', id);
    if (!includeEvidence) query.set('evidence', '0');
    return request(`task-attempts?${query}`, { signal });
  },
  evidence: (kind, scope, before, signal) => {
    const query = new URLSearchParams({ kind, ...scope, ...(before === null ? {} : { before }) });
    return request(`evidence?${query}`, { signal });
  },
  artifactCounts: (scope, signal) => request(`artifact-counts?${new URLSearchParams(scope)}`, { signal }),
  artifactLinks: (references, signal) => request('artifact-links', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ references }), signal,
  }),
  usageSummary: (scope, groupBy, { after, attemptBefore = Number.MAX_SAFE_INTEGER } = {}) =>
    request(`usage/summary?${new URLSearchParams({ ...scope, groupBy, attemptBefore, ...(after != null ? { after } : {}) })}`),
  costForecast: goalId => request(`cost/forecast?goalId=${encodeURIComponent(goalId)}`),
  panelWatermark: (after, signal, immediate = false) =>
    request(`events?view=panel&after=${after}${immediate ? '&wait=0' : ''}`, { signal }),
  activity: (query = {}, signal) => {
    const params = new URLSearchParams();
    for (const key of ['before', 'after', 'limit', 'projectId', 'goalId', 'taskId']) if (query[key] !== undefined && query[key] !== null && query[key] !== '') params.set(key, query[key]);
    return request(`activity?${params.toString()}`, { signal });
  },
  artifact: (id, signal) => request(`artifact?id=${encodeURIComponent(id)}`, { signal }),
  candidateArchive: selection => request('composition/archive', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) }),
  candidateMergePreview: selection => request('composition/merge-preview', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) }),
  async downloadCandidateArchive(selection, archive) {
    const params = new URLSearchParams({ ...selection, archiveSha256: archive.archiveSha256 });
    const response = await transport(`api/acms/composition/download?${params}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error?.message ?? `下载失败（HTTP ${response.status}）`);
    }
    return response.blob();
  },
  directories: directory => request(`directories?path=${encodeURIComponent(directory)}`),
  modelDetails: (input, signal) => request('model-details', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }),
  modelCheck: input => request('model-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  async command(name, args) {
    const key = JSON.stringify([name, args]); const requestId = pending.get(key) ?? crypto.randomUUID(); pending.set(key, requestId);
    const result = await request('command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args, requestId }) });
    pending.delete(key); return result.value;
  },
};
