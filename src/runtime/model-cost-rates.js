import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { validGoalCostMicros } from '../core/goal-cost-budget.js';

const maximumBytes = 64 * 1024;
export const modelCostRatesFile = 'model-route-rates.json';
export const modelCostRateUnit = 'USD-micros-per-million-tokens';
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

function normalizeRates(value) {
  if (value === null) return null;
  if (!validGoalCostMicros(value?.uncachedInputMicros) || !validGoalCostMicros(value?.outputMicros)) return undefined;
  return { uncachedInputMicros: value.uncachedInputMicros, outputMicros: value.outputMicros };
}

function normalizeSheet(value) {
  const expiry = Date.parse(value?.expiresAt);
  if (value?.schema !== 'acms-model-route-rates/1' || value.unit !== modelCostRateUnit ||
      !boundedText(value.source, 120) || typeof value.expiresAt !== 'string' || !Number.isFinite(expiry) ||
      !Array.isArray(value.groups) || !value.groups.length || value.groups.length > 16) return null;
  const iso = new Date(expiry).toISOString();
  if (value.expiresAt !== iso && value.expiresAt !== iso.replace('.000Z', 'Z')) return null;
  const seen = new Set(), ids = new Set(), groups = [];
  for (const group of value.groups) {
    const { id, provider, llmProvider, reasoningEffort, models } = group ?? {};
    if (!boundedText(id, 80) || ids.has(id) || !boundedText(provider, 200) || !boundedText(llmProvider, 200) ||
        !boundedText(reasoningEffort, 80) || !Array.isArray(models) || models.length < 2 || models.length > 16) return null;
    ids.add(id);
    const prices = new Map();
    for (const entry of models) {
      const rates = normalizeRates(entry?.rates);
      if (!boundedText(entry?.model, 200) || rates === undefined) return null;
      const key = JSON.stringify([provider, llmProvider, reasoningEffort, entry.model]);
      if (seen.has(key)) return null;
      seen.add(key);
      prices.set(entry.model, rates);
    }
    groups.push({ id, provider, llmProvider, reasoningEffort, prices });
  }
  return { source: value.source, unit: value.unit, expiresAt: value.expiresAt, groups, expiry };
}

export function readModelCostRates(dataDir) {
  let fd;
  try {
    // Only the fixed file in the canonical host data root is accepted.
    const file = path.join(realpathSync(dataDir), modelCostRatesFile);
    const listed = lstatSync(file);
    if (!listed.isFile()) return { state: 'invalid' };
    if (listed.size > maximumBytes) return { state: 'too-large' };
    fd = openSync(file, 'r');
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== listed.dev || actual.ino !== listed.ino) return { state: 'invalid' };
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null))) length += count;
    if (length > maximumBytes) return { state: 'too-large' };
    const after = fstatSync(fd);
    if (after.size !== length || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) return { state: 'invalid' };
    const content = bytes.subarray(0, length);
    const fingerprint = createHash('sha256').update(content).digest('hex');
    const sheet = normalizeSheet(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)));
    if (!sheet) return { state: 'invalid' };
    const { expiry, ...facts } = sheet;
    return Date.now() < expiry ? { state: 'ready', fingerprint, ...facts } :
      { state: 'expired', fingerprint, source: facts.source, expiresAt: facts.expiresAt };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'invalid' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
