export const codexTokenFields = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];

export function codexTokenCounts(value) {
  return Object.fromEntries(codexTokenFields.map(field => {
    const amount = value?.[field];
    return [field, Number.isSafeInteger(amount) && amount >= 0 ? amount : null];
  }));
}

// Codex's `last` is one increment and `total` is thread cumulative. Use the
// cumulative counter as a continuity check and replay watermark only.
export class CodexTurnUsage {
  amounts = Object.fromEntries(codexTokenFields.map(field => [field, 0]));

  open(threadId, resumed) {
    this.threadId = threadId;
    if (!resumed) this.previous = { ...this.amounts };
  }

  begin() { this.started = true; }

  track(params) {
    if (!this.threadId || this.terminal || params?.threadId !== this.threadId) return;
    if (typeof params.turnId !== 'string' || !params.turnId || params.turnId.length > 256) {
      if (this.started) this.invalidate();
      else {
        this.previous = null;
        this.lastIncrement = null;
        this.baselineTurnId = null;
      }
      return;
    }
    const total = codexTokenCounts(params.tokenUsage?.total);
    const last = codexTokenCounts(params.tokenUsage?.last);
    if (!this.started) {
      this.previous = total;
      this.lastIncrement = last.totalTokens > 0 ? last : null;
      this.baselineTurnId = params.turnId;
      return;
    }
    this.add(params.turnId, total, last);
  }

  accept(turnId) {
    this.turnId = turnId;
    if (this.baselineTurnId === turnId) this.unknown = true;
  }

  add(turnId, total, last) {
    if (turnId !== this.turnId || this.unknown) return;
    const previous = this.previous;
    if (previous?.totalTokens == null || total.totalTokens == null || last.totalTokens == null) { this.invalidate(); return; }
    if (total.totalTokens === previous.totalTokens && last.totalTokens > 0) {
      // An unchanged cumulative total can replay the latest increment. A
      // different tally is ambiguous, even if its headline total is unchanged.
      if (last.totalTokens !== this.lastIncrement?.totalTokens) { this.invalidate(); return; }
      for (const field of codexTokenFields) {
        if (total[field] !== previous[field] || last[field] !== this.lastIncrement[field]) this.amounts[field] = null;
      }
      return;
    }
    if (previous.totalTokens + last.totalTokens !== total.totalTokens) { this.invalidate(); return; }
    for (const field of codexTokenFields) {
      this.amounts[field] = this.amounts[field] !== null && previous[field] !== null && last[field] !== null && total[field] !== null &&
        previous[field] + last[field] === total[field] ? this.amounts[field] + last[field] : null;
    }
    this.previous = total;
    if (last.totalTokens > 0) this.lastIncrement = last;
    this.observed = true;
  }

  invalidate() { this.unknown = true; }

  finish() { this.terminal = true; }

  result() {
    if (!this.terminal || !this.observed || this.unknown || this.threadId.length > 256 || this.turnId.length > 256) return null;
    return { source: 'codex-app-server', threadId: this.threadId, turnId: this.turnId, counts: { ...this.amounts } };
  }
}
