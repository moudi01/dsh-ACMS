import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { ACTIVITY_ARTIFACT_LINK_LIMIT } from '../core/activity.js';

const keyFor = (taskId, id) => JSON.stringify([taskId, id]);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
export const deliveryArtifactIds = values => Array.isArray(values) ? [...new Set(values.filter(validId))] : [];
const deliveryTaskId = value => validId(value) ? value : null;

export function useActivityArtifacts(entries, availableTasks, enabled, filterKey) {
  const lookup = useRef(new Map());
  const [resolved, setResolved] = useState(lookup.current);
  const [retry, setRetry] = useState(0);
  const { references, inventory, signature } = useMemo(() => {
    const references = new Map();
    if (enabled) for (const entry of entries) {
      if (!Array.isArray(entry.data?.delivery)) continue;
      for (const delivery of entry.data.delivery) {
        const taskId = deliveryTaskId(delivery?.id);
        for (const id of deliveryArtifactIds(delivery?.artifactIds)) {
          references.set(keyFor(taskId, id), { id, taskId, available: taskId ? availableTasks.has(taskId) : null });
        }
      }
    }
    // Old events with no task ID need to reconsider unresolved links when
    // a task leaves or re-enters the current owner view.
    const inventory = [...references.values()].some(ref => ref.taskId === null) ? JSON.stringify([...availableTasks]) : null;
    return { references, inventory, signature: JSON.stringify([[...references.values()], inventory]) };
  }, [entries, availableTasks, enabled]);
  const proof = ref => ref.taskId === null ? inventory : ref.available;

  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    const rows = lookup.current;
    for (const [key, result] of rows) {
      const ref = references.get(key);
      if (!ref || result.proof !== proof(ref)) rows.delete(key);
    }
    const pending = [...references].filter(([key]) => !rows.has(key));
    const publish = () => setResolved(new Map(rows));
    publish();
    async function read() {
      for (let start = 0; start < pending.length && !signal.aborted; start += ACTIVITY_ARTIFACT_LINK_LIMIT) {
        const batch = pending.slice(start, start + ACTIVITY_ARTIFACT_LINK_LIMIT);
        try {
          const response = await api.artifactLinks(batch.map(([, { id, taskId }]) => ({ id, taskId })), signal);
          if (signal.aborted) return;
          const found = new Map(response.rows.filter(row => row.requestedTaskId === null || row.taskId === row.requestedTaskId)
            .map(row => [keyFor(row.requestedTaskId, row.id), row]));
          for (const [key, ref] of batch) rows.set(key, { row: found.get(key) ?? null, proof: proof(ref) });
        } catch (error) {
          if (signal.aborted) return;
          for (const [key, ref] of batch) rows.set(key, { error: error.message, proof: proof(ref) });
        }
        publish();
      }
    }
    void read();
    return () => controller.abort();
  }, [enabled, filterKey, signature, retry]);

  return {
    get(taskId, id) {
      const key = keyFor(deliveryTaskId(taskId), id);
      const ref = references.get(key);
      const result = resolved.get(key);
      return ref && result?.proof === proof(ref) ? result : undefined;
    },
    retry() {
      for (const [key, result] of lookup.current) if (result.error) lookup.current.delete(key);
      setRetry(value => value + 1);
    },
  };
}
