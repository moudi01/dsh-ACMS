import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexTurnUsage } from '../lib/turn-usage.js';

function update(usage, total, last, turnId = 'current') {
  usage.track({ threadId: 'fixture', turnId, tokenUsage: { total, last } });
}

test('a counter gap or an unresolved terminal never becomes a known attempt total', () => {
  for (const scenario of ['gap', 'unfinished', 'missing-identity', 'no-usage']) {
    const usage = new CodexTurnUsage();
    usage.open('fixture', false);
    usage.begin();
    usage.accept('current');
    if (scenario === 'gap') {
      update(usage, { totalTokens: 2 }, { totalTokens: 2 });
      update(usage, { totalTokens: 8 }, { totalTokens: 1 });
    }
    if (scenario === 'unfinished') update(usage, { totalTokens: 2 }, { totalTokens: 2 });
    if (scenario === 'missing-identity') usage.track({ threadId: 'fixture', tokenUsage: { total: { totalTokens: 2 }, last: { totalTokens: 2 } } });
    if (scenario !== 'unfinished') usage.finish();
    assert.equal(usage.result(), null, scenario);
  }
});

test('explicit provider zeros are retained while absent or invalid detail fields remain unknown', () => {
  const usage = new CodexTurnUsage();
  usage.open('fixture', false);
  usage.begin();
  usage.accept('current');
  update(usage, { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: -1 },
    { totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  usage.finish();
  assert.deepEqual(usage.result().counts, {
    inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: null, outputTokens: 0, reasoningOutputTokens: null, totalTokens: 0,
  });
});
