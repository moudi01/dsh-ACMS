import { useLayoutEffect, useRef, useState } from 'react';
import { api } from './api.js';

const empty = { attempts: [], activeAttempts: [], verifications: [], cursor: null, nextBefore: null, loadedOlder: false,
  loading: true, error: '' };

function acceptPage(previous, page, before, refreshIds) {
  const latest = before === null;
  const keepOlder = !latest || (previous.loadedOlder && page.nextBefore !== null);
  const oldest = page.attempts.at(-1)?.historyPosition;
  let attempts = page.attempts;
  let nextBefore = page.nextBefore;
  if (keepOlder) {
    const refreshed = new Map([...(page.activeAttempts ?? []), ...(page.refreshedAttempts ?? [])].map(row => [row.id, row]));
    const rows = new Map();
    for (const row of previous.attempts) {
      if (latest && row.historyPosition >= oldest) continue;
      if (latest && refreshIds.includes(row.id) && !refreshed.has(row.id)) continue;
      const update = refreshed.get(row.id);
      rows.set(row.id, update ? { ...update, historyPosition: row.historyPosition } : row);
    }
    for (const row of page.attempts) rows.set(row.id, row);
    attempts = [...rows.values()].sort((a, b) => b.historyPosition - a.historyPosition);
    // A large burst can put the first page entirely ahead of the loaded range.
    // In that case, the next request starts at the new gap.
    if (latest && oldest <= previous.attempts[0]?.historyPosition) nextBefore = previous.nextBefore;
  }
  return { attempts, activeAttempts: page.activeAttempts ?? previous.activeAttempts,
    verifications: page.verifications ?? previous.verifications, cursor: page.cursor, nextBefore,
    loadedOlder: latest ? keepOlder : previous.loadedOlder || page.attempts.length > 0, loading: false, error: '' };
}

export function useTaskAttempts(task, data) {
  const enabled = data.attemptsView === 'panel';
  const related = data.attempts.filter(attempt => attempt.taskId === task.id);
  const key = enabled ? JSON.stringify([task.id, task.revision, related.map(attempt => [attempt.id, attempt.revision])]) : null;
  const cycle = useRef(null);
  const [view, setView] = useState(null);

  async function load(current, before) {
    if (!current || current.loading || current.controller.signal.aborted) return;
    current.loading = true;
    const publish = next => {
      if (current.controller.signal.aborted) return;
      current.view = next;
      setView({ key: current.key, ...next });
    };
    publish({ ...current.view, loading: true, error: '' });
    try {
      const read = async (cursor, refreshIds) => {
        const page = await api.taskAttempts(task.id, cursor, current.controller.signal, refreshIds);
        if (page.taskId !== task.id) throw new Error('当前任务执行记录无法核对。');
        return page;
      };
      let previous = current.view;
      const loadedIds = before === null && previous.loadedOlder ? new Set(previous.attempts.map(row => row.id)) : null;
      let refreshIds = loadedIds ? previous.activeAttempts.filter(row => loadedIds.has(row.id)).map(row => row.id).slice(0, 32) : [];
      let page = await read(before, refreshIds);
      if (current.controller.signal.aborted) return;
      if (previous.cursor !== null && page.cursor < previous.cursor) {
        if (before !== null) page = await read(null, []);
        before = null;
        previous = empty;
        refreshIds = [];
      }
      publish(acceptPage(previous, page, before, refreshIds));
    } catch (error) {
      publish({ ...current.view, loading: false, error: error.message });
    } finally { current.loading = false; }
  }

  // Retire the old request at scope commit, before a delayed page can publish.
  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const current = { key, controller, view: cycle.current?.view ?? empty, loading: false };
    cycle.current = current;
    void load(current, null);
    return () => controller.abort();
  }, [enabled, key]);

  if (!enabled) return null;
  const current = view ?? empty;
  const loading = current.key !== key || current.loading;
  return { ...current, loading, load: () => {
    if (cycle.current?.key === key) void load(cycle.current, current.nextBefore);
  } };
}
