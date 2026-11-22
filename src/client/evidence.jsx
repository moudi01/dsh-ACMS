import React, { useLayoutEffect, useRef, useState } from 'react';
import { api } from './api.js';

const empty = { rows: [], cursor: null, total: null, nextBefore: null, loadedOlder: false, loading: true, error: '' };

function acceptEvidence(previous, page, before) {
  const latest = before === null;
  const keepOlder = !latest || (previous.loadedOlder && page.nextBefore !== null);
  let rows = page.rows;
  let nextBefore = page.nextBefore;
  if (keepOlder) {
    const oldest = page.rows.at(-1)?.position;
    const known = new Map(previous.rows.filter(row => !latest || row.position < oldest).map(row => [row.id, row]));
    for (const row of page.rows) known.set(row.id, row);
    rows = [...known.values()].sort((a, b) => b.position - a.position);
    if (latest && oldest <= previous.rows[0]?.position) nextBefore = previous.nextBefore;
  }
  return { rows, cursor: page.cursor, total: page.total ?? previous.total, nextBefore,
    loadedOlder: keepOlder, loading: false, error: '' };
}

export function useEvidence(kind, scope, cursor, enabled) {
  const key = JSON.stringify([kind, scope]);
  const cycle = useRef(null);
  const [view, setView] = useState(null);

  async function load(current, before) {
    if (!current || current.loading || current.signal.aborted) return;
    current.loading = true;
    if (before === null) current.refreshQueued = false;
    const publish = next => {
      if (current.signal.aborted) return;
      current.view = next;
      setView({ key, ...next });
    };
    publish({ ...current.view, loading: true, error: '' });
    try {
      const read = async position => {
        const page = await api.evidence(kind, scope, position, current.signal);
        const [scopeKind, scopeId] = Object.entries(scope)[0] ?? ['allId', null];
        if (page.collection !== kind || page.scope.kind + 'Id' !== scopeKind || page.scope.id !== scopeId) {
          throw new Error('无法核对当前证据范围。');
        }
        return page;
      };
      let page = await read(before);
      current.signal.throwIfAborted();
      let previous = current.view;
      if (previous.cursor !== null && page.cursor < previous.cursor) {
        if (before !== null) page = await read(null);
        before = null;
        previous = empty;
      }
      publish(acceptEvidence(previous, page, before));
    } catch (error) {
      publish({ ...current.view, loading: false, error: error.message, retryBefore: before });
    } finally {
      current.loading = false;
      if (current.refreshQueued && !current.view.error) void load(current, null);
    }
  }

  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const current = { key, signal: controller.signal, view: empty, loading: false, refreshQueued: false };
    cycle.current = current;
    return () => controller.abort();
  }, [enabled, key]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const current = cycle.current;
    // Keep a requested page alive while ordinary events advance the company
    // cursor. Refresh the head once after that page settles.
    current.refreshQueued = true;
    if (!current.view.error || current.view.retryBefore === null) void load(current, null);
  }, [enabled, key, cursor]);

  if (!enabled) return null;
  const current = view?.key === key ? view : empty;
  return { ...current, more: () => {
    if (cycle.current?.key === key) void load(cycle.current, current.error ? current.retryBefore : current.nextBefore);
  } };
}

export function EvidencePager({ page, label }) {
  if (!page) return null;
  return <>{page.loading && <p role="status" className="acms-muted">正在读取{label}…</p>}
    {page.error && <p role="alert">{page.error}</p>}
    {!page.loading && (page.error || page.nextBefore !== null) && <button type="button" onClick={page.more}>
      {page.error ? `重试读取${label}` : `加载更早的${label}`}
    </button>}</>;
}

export function useCompletedArtifactCounts(scope, cursor, enabled) {
  const key = JSON.stringify(scope);
  const [view, setView] = useState(null);
  const [retry, setRetry] = useState(0);
  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    api.artifactCounts(scope, controller.signal).then(result => {
      if (!controller.signal.aborted) setView({ key, counts: result.counts });
    }).catch(error => {
      if (!controller.signal.aborted) setView({ key, error: error.message });
    });
    return () => controller.abort();
  }, [enabled, key, cursor, retry]);
  return { ...(view?.key === key ? view : null), retry: () => setRetry(value => value + 1) };
}
