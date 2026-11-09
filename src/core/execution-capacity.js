import { isLiveAttempt } from './entity-actions.js';
import { integrationPending } from './task-actions.js';

export function executionOccupancy(store, adapter, live) {
  const attempts = store?.list('attempts').filter(a => !a.legacyBatch && (isLiveAttempt(a) || live?.has(a.id))) ?? [];
  const integrations = store?.list('integrations').filter(integrationPending).length ?? 0;
  return {
    attempts, integrations,
    used: attempts.length + integrations + (adapter?.activeChats ?? 0) + (adapter?.activeProbes ?? 0),
  };
}
