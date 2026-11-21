const sameCohort = (a, b) => [
  'provider', 'llmProvider', 'origin', 'persistent', 'reasoningEffort', 'capabilitySource',
  'continuity', 'inheritsParentContext', 'runningMessages', 'tools', 'sandbox',
].every(key => a[key] === b[key]);
const supportsComparison = candidate => candidate.origin === 'internal' && candidate.persistent === false &&
  candidate.continuity === 'unsupported' && candidate.inheritsParentContext === false;
const noHigher = (a, b) => BigInt(a.uncachedInputMicros) <= BigInt(b.uncachedInputMicros) && BigInt(a.outputMicros) <= BigInt(b.outputMicros);
const lower = (a, b) => noHigher(a, b) && !noHigher(b, a);

export function chooseCostRoute({ baseline, eligible, binding, requirements, context }) {
  const unchanged = (reason, evidence = {}) => ({ candidate: baseline, evidence: { reason, ...evidence } });
  if (binding.mode !== 'default') return unchanged('binding-or-preference');
  if (context.kind !== 'work' || requirements.continuity !== 'none' || requirements.isolation ||
      requirements.inheritsParentContext === true || requirements.model || requirements.provider ||
      requirements.llmProvider || requirements.reasoningEffort || !supportsComparison(baseline) ||
      !context.allowsComparison(baseline)) return unchanged('protected-task');
  if (!baseline.reasoningEffort) return unchanged('unknown-depth');

  const previous = context.previous();
  if (previous) {
    if (!previous.costSelected) return unchanged('retry-default', { previousAttemptId: previous.attemptId });
    const route = eligible.find(candidate => candidate.candidateId === previous.candidateId &&
      candidate.reasoningEffort === previous.reasoningEffort && sameCohort(candidate, baseline) && context.available(candidate));
    return route ? { candidate: route, evidence: { reason: 'retry-route', previousAttemptId: previous.attemptId } } :
      unchanged('retry-route-unavailable', { previousAttemptId: previous.attemptId });
  }

  const sheet = context.read();
  const observation = { sourceState: sheet.state, sourceFingerprint: sheet.fingerprint ?? null,
    source: sheet.source ?? null, unit: sheet.unit ?? null, expiresAt: sheet.expiresAt ?? null, defaultFingerprint: context.defaultFingerprint };
  if (sheet.state !== 'ready') return unchanged('rates-unavailable', observation);
  const group = sheet.groups.find(group => group.provider === baseline.provider && group.llmProvider === baseline.llmProvider &&
    group.reasoningEffort === baseline.reasoningEffort && group.prices.has(baseline.model));
  if (!group || !context.available(baseline)) return unchanged('unpriced-default', observation);
  const peers = eligible.filter(candidate => sameCohort(candidate, baseline) && context.available(candidate) && group.prices.has(candidate.model));
  const comparable = { ...observation, group: group.id, compared: peers.length,
    baseline: { model: baseline.model, reasoningEffort: baseline.reasoningEffort, rates: group.prices.get(baseline.model) } };
  if (peers.some(candidate => group.prices.get(candidate.model) === null)) return unchanged('unknown-rates', comparable);
  if (peers.length < 2) return unchanged('no-comparable-peer', comparable);
  const winner = peers.find(candidate => {
    const rates = group.prices.get(candidate.model);
    return lower(rates, comparable.baseline.rates) && peers.every(peer => noHigher(rates, group.prices.get(peer.model)));
  });
  if (winner) return { candidate: winner, evidence: { ...comparable, reason: 'lower-listed-rates', rates: group.prices.get(winner.model) } };
  const baselineLowest = peers.every(peer => noHigher(comparable.baseline.rates, group.prices.get(peer.model)));
  return unchanged(baselineLowest ? 'default-listed-rates' : 'incomparable-rates', comparable);
}
