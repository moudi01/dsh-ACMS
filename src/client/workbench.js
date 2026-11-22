import { useLayoutEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function useWorkbenchPage(filters, cursor, enabled) {
  const scope = JSON.stringify(filters);
  const [positions, setPositions] = useState(null);
  const [result, setResult] = useState(null);
  const control = useRef(null);
  const bookmarks = positions?.scope === scope ? positions.bookmarks : [null];
  const before = bookmarks.at(-1);
  const key = JSON.stringify([scope, before]);

  async function load(current) {
    if (!current || current.loading || current.signal.aborted) return;
    current.loading = true;
    current.queued = false;
    try {
      const data = await api.workbench(filters, before, current.signal);
      if (!current.signal.aborted) setResult({ key, data });
    } catch (error) {
      if (!current.signal.aborted) setResult(previous => ({ key, error: error.message, data: previous?.key === key ? previous.data : null }));
    } finally {
      current.loading = false;
      if (current.queued) void load(current);
    }
  }

  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    control.current = { signal: controller.signal, loading: false, queued: false };
    return () => controller.abort();
  }, [enabled, key]);

  useLayoutEffect(() => {
    if (!enabled) return;
    control.current.queued = true;
    void load(control.current);
  }, [enabled, key, cursor]);

  if (!enabled) return null;
  const page = result?.key === key ? result : null;
  return {
    ...page?.data,
    error: page?.error,
    loading: !page,
    previous: bookmarks.length > 1 ? () => setPositions({ scope, bookmarks: bookmarks.slice(0, -1) }) : null,
    nextPage: page?.data?.next ? () => setPositions({ scope, bookmarks: [...bookmarks, page.data.next] }) : null,
    retry: () => load(control.current),
  };
}
