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
  const taskReview = context.kind === 'review' && context.reviewScope === 'task';
  const supportedTask = taskReview ? requirements.isolation === 'independent-review' : context.kind === 'work' && !requirements.isolation;
  if (!supportedTask || requirements.continuity !== 'none' ||
      requirements.inheritsParentContext === true || requirements.model || requirements.provider ||
      requirements.llmProvider || requirements.reasoningEffort || !supportsComparison(baseline) ||
      !context.allowsComparison(baseline)) return unchanged('protected-task');
  const scope = taskReview ? 'task-review' : 'work';
  const defaults = { defaultFingerprint: context.defaultFingerprint, scope };
  if (!baseline.reasoningEffort) return unchanged('unknown-depth', defaults);

  const previous = context.previous();
  if (previous && !previous.costSelected) return unchanged('retry-default', { previousAttemptId: previous.attemptId });
  const retry = previous && eligible.find(candidate => candidate.candidateId === previous.candidateId &&
    candidate.reasoningEffort === previous.reasoningEffort && sameCohort(candidate, baseline) && context.available(candidate));
  const evidence = previous ? { ...defaults, previousAttemptId: previous.attemptId } : defaults;
  if (previous && !retry) return unchanged('retry-route-unavailable', evidence);
  if (retry && !taskReview) return { candidate: retry, evidence: { ...evidence, reason: 'retry-route' } };

  const sheet = context.read();
  const observation = { ...evidence, sourceState: sheet.state, sourceFingerprint: sheet.fingerprint ?? null,
    source: sheet.source ?? null, unit: sheet.unit ?? null, expiresAt: sheet.expiresAt ?? null };
  if (sheet.state !== 'ready') return unchanged(retry ? 'retry-route-unavailable' : 'rates-unavailable', observation);
  const group = sheet.groups.find(group => group.scope === scope && group.provider === baseline.provider && group.llmProvider === baseline.llmProvider &&
    group.reasoningEffort === baseline.reasoningEffort && group.prices.has(baseline.model));
  if (retry) {
    if (!group?.prices.has(retry.model)) return unchanged('retry-route-unavailable', observation);
    return { candidate: retry, evidence: { ...observation, reason: 'retry-route', group: group.id } };
  }
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
