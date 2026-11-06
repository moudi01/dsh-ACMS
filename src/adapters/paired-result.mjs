// Validate the response identity before displaying a runner's diagnostic.
// Successful responses still pass paired.js's probe/task completion checks.
function safeError(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(authorization)(\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/(token|api[_-]?key|authorization)([=: ]+)[^\s]+/gi, '$1$2[REDACTED]')
    .slice(0, 2000);
}

export function parsePairedResult({ code, stdout }, expected) {
  let response;
  try { response = JSON.parse(String(stdout ?? '').trim()); } catch { /* Use safe generic errors below. */ }
  const matches = response && !Array.isArray(response) && typeof response === 'object'
    && response.protocol === 'acms.runner.v1' && response.requestId === expected.requestId
    && response.model === expected.model;
  // Error envelopes intentionally have neither executed nor output.
  if (matches && typeof response.error === 'string' && response.error.trim()) {
    const error = new Error('外部执行器错误：' + safeError(response.error));
    const cleanup = response.executor?.cleanup;
    error.cleanupUncertain = response.executor?.childClosed === false || !!(cleanup && (cleanup.treeTerminationConfirmed !== true || cleanup.childClosed !== true || cleanup.unresolvedPid));
    error.code = error.cleanupUncertain ? 'PAIRED_CLEANUP_UNCONFIRMED' : 'PAIRED_RUNNER_ERROR';
    throw error;
  }
  if (code !== 0) throw Object.assign(new Error('外部执行器退出码 ' + code + '；未收到匹配的有效错误响应'), { code: 'PAIRED_RUN_FAILED' });
  if (!matches) throw Object.assign(new Error('外部执行器返回无效或不匹配的 ACMS 响应'), { code: 'PAIRED_PROTOCOL' });
  return response;
}
