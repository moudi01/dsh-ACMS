import { createHash, randomUUID } from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const clone = (value) => structuredClone(value);
export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export class AcmsError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
export function assert(condition, code, message, details) { if (!condition) throw new AcmsError(code, message, details); }
export function text(value, label, max = 20000) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', `${label} must be a nonempty string, at most ${max} characters`);
  return value.trim();
}
export function integer(value, label, min, max) {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `${label} must be between ${min} and ${max}`);
  return value;
}
export function parseResult(value) {
  if (value && typeof value === 'object') return value;
  const s = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch { throw new AcmsError('INVALID_RESULT', 'Agent must return a valid JSON result'); }
}
export const OWNER = Object.freeze({ kind: 'owner', id: 'owner' });
export const SYSTEM = Object.freeze({ kind: 'system', id: 'scheduler' });
export const TERMINAL = new Set(['succeeded', 'cancelled', 'failed', 'archived', 'deleted']);
