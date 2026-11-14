import { createHash } from 'node:crypto';

export const TEXT_INTEGRITY_FORMAT = 'acms-text-integrity/1';
export const MAX_TEXT_BYTES = 1024 * 1024;
export const isProseFile = name => /\.(md|markdown|txt|rst)$/i.test(name);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Advisory, not a language detector or content approval. Never store excerpts:
// evidence consists of the exact byte digest, counts and affected line numbers.
export function inspectDeliveryText(bytes) {
  const report = { format: TEXT_INTEGRITY_FORMAT, status: 'not-inspected', bytes: bytes.length,
    sha256: sha256(bytes), warnings: [] };
  if (bytes.length > MAX_TEXT_BYTES) return { ...report, reason: 'TEXT_SIZE_LIMIT' };
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return { ...report, status: 'warning', warnings: [{ code: 'TEXT_ENCODING_NOT_UTF8' }] };
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { ...report, status: 'warning', warnings: [{ code: 'TEXT_INVALID_UTF8' }] }; }
  let fence = null, proseChars = 0, questionMarks = 0, replacementChars = 0;
  const questionLines = [], replacementLines = [];
  for (const [index, line] of text.split(/\r\n|\n|\r/).entries()) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;
    const prose = line.replace(/`+[^`]*`+/g, '');
    // Ignore punctuation-only separators, quizzes, and question-mark artwork.
    if (!/[\p{L}\p{N}]/u.test(prose)) continue;
    proseChars += [...prose].length;
    const questions = (prose.match(/\?/g) ?? []).length;
    const replacements = (prose.match(/\ufffd/g) ?? []).length;
    questionMarks += questions; replacementChars += replacements;
    if (/\?{6,}/.test(prose)) questionLines.push(index + 1);
    if (replacements) replacementLines.push(index + 1);
  }
  report.status = 'no-warning';
  report.metrics = { proseChars, questionMarks, replacementChars, questionRunLines: questionLines.length };
  if (questionMarks >= 40 && questionLines.length >= 3 && questionMarks / Math.max(1, proseChars) >= 0.12) {
    report.warnings.push({ code: 'TEXT_QUESTION_MARK_LOSS', lines: questionLines.slice(0, 12) });
  }
  if (replacementChars >= 3 && replacementChars / Math.max(1, proseChars) >= 0.01) {
    report.warnings.push({ code: 'TEXT_REPLACEMENT_CHARACTERS', lines: replacementLines.slice(0, 12) });
  }
  if (report.warnings.length) report.status = 'warning';
  return report;
}
