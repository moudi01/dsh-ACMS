import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const empty = { attempts: [], activeAttempts: [], verifications: [], cursor: null, nextBefore: null, loading: true, error: '' };

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
      const read = async cursor => {
        const page = await api.taskAttempts(task.id, cursor, current.controller.signal);
        if (page.taskId !== task.id) throw new Error('当前任务执行记录无法核对。');
        return page;
      };
      let page = await read(before);
      if (current.controller.signal.aborted) return;
      if (before !== null && page.cursor < current.view.cursor) {
        before = null;
        page = await read(null);
      }
      publish({ attempts: before === null ? page.attempts : [...current.view.attempts, ...page.attempts],
        activeAttempts: page.activeAttempts ?? current.view.activeAttempts,
        verifications: page.verifications ?? current.view.verifications, cursor: page.cursor,
        nextBefore: page.nextBefore, loading: false, error: '' });
    } catch (error) {
      publish({ ...current.view, loading: false, error: error.message });
    } finally { current.loading = false; }
  }

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const current = { key, controller, view: empty, loading: false };
    cycle.current = current;
    void load(current, null);
    return () => controller.abort();
  }, [enabled, key]);

  if (!enabled) return null;
  const current = view?.key === key ? view : empty;
  return { ...current, load: () => {
    if (cycle.current?.key === key) void load(cycle.current, current.nextBefore);
  } };
}
