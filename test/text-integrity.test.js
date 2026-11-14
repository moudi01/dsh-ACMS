import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { inspectDeliveryText, MAX_TEXT_BYTES } from '../src/runtime/text-integrity.js';
import { validateDeliveryText, validateDeliveryArchive } from '../src/runtime/archive-validation.js';
import { verifyDeliveryArchive } from '../src/runtime/delivery-archive.js';
import { writeVerifiedUtf8 } from '../scripts/write-utf8.mjs';
import { promptFor, ARCHIVE_PROMPT_BYTES } from '../src/runtime/prompt.js';
import { fixture, until } from './helpers.js';
import { deliveryZip, sha } from './fixtures/delivery-zip.js';
import { createAgentApi } from '../src/host/agent-api.js';

const damaged = '# Handoff ????????\nGoal: ????????????????????\nFiles: ????????????????????\nReview: ????????????????????\n';
const unicode = '# 中文交接 / English\r\n目标：保留 é、e\u0301、🙂、العربية、日本語。\n下一步：核对文件与归档。\n';

test('reports suspicious prose without exposing content or treating a valid hash as approval', () => {
  const report = inspectDeliveryText(Buffer.from(damaged));
  assert.equal(report.status, 'warning'); assert.equal(report.sha256, sha(damaged));
  assert.equal(report.warnings[0].code, 'TEXT_QUESTION_MARK_LOSS');
  assert.deepEqual(report.warnings[0].lines, [1, 2, 3, 4]);
  assert.ok(!JSON.stringify(report).includes('Handoff')); assert.equal(report.passed, undefined);
});

for (const [name, text] of [
  ['mixed Unicode and line endings', unicode], ['English only', 'A complete English handoff.\nNext: review the files.\n'],
  ['ordinary questions', 'What changed? Why? How? Is this correct?\n'.repeat(50)],
  ['question-mark artwork', '?????????????????????????????\n'.repeat(10)],
  ['code examples', '```text\n' + damaged + '```\n'], ['tilde fences', '~~~~\n' + damaged + '~~~~\n'],
  ['inline examples', ('Example: `????????????????????` is a placeholder.\n').repeat(10)],
  ['indented code', damaged.split('\n').map(line => '    ' + line).join('\n')],
  ['one literal replacement character', 'The Unicode replacement character is �.\n'], ['empty text', ''],
]) test(`does not warn for ${name}`, () => assert.equal(inspectDeliveryText(Buffer.from(text)).status, 'no-warning'));

test('distinguishes invalid UTF-8, UTF-16, repeated replacements and uninspected oversized text', () => {
  assert.equal(inspectDeliveryText(Buffer.from([0xc3, 0x28])).warnings[0].code, 'TEXT_INVALID_UTF8');
  assert.equal(inspectDeliveryText(Buffer.from([0xff, 0xfe, 0x61, 0])).warnings[0].code, 'TEXT_ENCODING_NOT_UTF8');
  assert.equal(inspectDeliveryText(Buffer.from('Goal: ���\nNext: ���')).warnings[0].code, 'TEXT_REPLACEMENT_CHARACTERS');
  const large = inspectDeliveryText(Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
  assert.equal(large.status, 'not-inspected'); assert.equal(large.reason, 'TEXT_SIZE_LIMIT');
});

test('verified UTF-8 writer preserves raw Unicode/CRLF bytes and rejects corrupt input before replacing a file', async t => {
  const f = await fixture(t), file = path.join(f.root, 'handoff.md'), bytes = Buffer.from(unicode);
  const result = await writeVerifiedUtf8(file, bytes.toString('base64'), sha(bytes));
  assert.equal(result.readbackVerified, true); assert.deepEqual(await readFile(file), bytes);
  for (const [base64, expected] of [['not base64', sha(bytes)], [bytes.toString('base64'), '0'.repeat(64)],
    [Buffer.from([0xc3, 0x28]).toString('base64'), sha(Buffer.from([0xc3, 0x28]))]]) {
    await assert.rejects(writeVerifiedUtf8(file, base64, expected)); assert.deepEqual(await readFile(file), bytes);
  }
});

test('ASCII shell pipe reproduces loss before file/ZIP; verified ASCII transport avoids it', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'capture.cjs'), 'process.stdin.pipe(require("node:fs").createWriteStream("after.txt"));');
  const script = '$text = [string][char]0x4e2d + [char]0x6587\n' +
    '[IO.File]::WriteAllText((Join-Path (Get-Location) "before.txt"), $text + "`r`n", [Text.UTF8Encoding]::new($false))\n' +
    '$OutputEncoding = [Text.Encoding]::ASCII\n$text | & $env:ACMS_TEST_NODE capture.cjs\nexit $LASTEXITCODE';
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cwd: f.root, env: { ...process.env, ACMS_TEST_NODE: process.execPath }, encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
  const before = await readFile(path.join(f.root, 'before.txt')), after = await readFile(path.join(f.root, 'after.txt'));
  assert.equal(before.toString('utf8'), '中文\r\n'); assert.equal(after.toString('utf8'), '??\r\n');
  const file = path.join(f.root, 'safe.txt');
  const safe = spawnSync(process.execPath, ['scripts/write-utf8.mjs', file, before.toString('base64'), sha(before)], { encoding: 'utf8', windowsHide: true });
  assert.equal(safe.status, 0, safe.stderr); assert.deepEqual(await readFile(file), before);
  const archive = verifyDeliveryArchive(deliveryZip([{ name: 'after.txt', data: after }]));
  assert.equal(archive.passed, true); assert.equal(archive.manifest.files[0].sha256, sha(after));
  // This demonstrates a failure mechanism, not attribution of the historical run.
});

test('artifact/ZIP warnings persist with raw bytes and do not schedule repair or manufacture review approval', async t => {
  const zip = deliveryZip([{ name: 'handoff.md', data: damaged }, { name: 'unicode.md', data: unicode }]);
  const f = await fixture(t, async input => {
    await writeFile(path.join(input.task.workspace.path, 'handoff.md'), damaged, 'utf8');
    await writeFile(path.join(input.task.workspace.path, 'unicode.md'), unicode, 'utf8');
    await writeFile(path.join(input.task.workspace.path, 'delivery.zip'), zip);
    return { outcome: 'completed', artifacts: [{ path: 'handoff.md' }, { path: 'unicode.md' }, { path: 'delivery.zip', archiveFormat: 'acms-delivery/1' }] };
  });
  const task = f.task(), next = f.task({ dependencies: [task.id] }); f.store.put('tasks', { ...next, status: 'paused' });
  await f.start(); await until(() => f.store.require('tasks', task.id).status === 'succeeded'); await f.engine.stop();
  assert.equal(f.adapter.calls.length, 1); assert.equal(f.store.list('tasks').filter(t => t.kind === 'review').length, 0);
  const artifacts = f.store.list('artifacts').filter(a => a.taskId === task.id), prose = artifacts.find(a => a.path === 'handoff.md');
  assert.equal(prose.textIntegrity.status, 'warning'); assert.equal(prose.textIntegrity.sha256, sha(damaged));
  assert.deepEqual(await readFile(prose.blob), Buffer.from(damaged));
  const normal = artifacts.find(a => a.path === 'unicode.md');
  assert.equal(normal.textIntegrity.status, 'no-warning'); assert.deepEqual(await readFile(normal.blob), Buffer.from(unicode));
  const packed = artifacts.find(a => a.path === 'delivery.zip');
  assert.deepEqual(await readFile(packed.blob), zip); assert.equal(packed.archiveVerification.passed, true);
  assert.equal(packed.archiveVerification.textDiagnostics.warnings[0].sha256, prose.textIntegrity.sha256);
  const contract = JSON.parse(promptFor(f.company, next, { id: 'test', agentId: 'reviewer' }).split('CONTRACT:\n')[1]);
  assert.equal(contract.inputArtifacts[0].textIntegrity.status, 'warning');
  assert.equal(contract.inputArtifacts[2].archiveVerification.textWarningCount, 1);
  assert.ok(contract.archiveEvidenceBudget.usedBytes <= ARCHIVE_PROMPT_BYTES);
  for (const reviewer of [{ ...next, kind: 'review', reviewOf: task.id },
    { ...next, kind: 'review', reviewScope: 'goal', reviewTargets: [{ id: task.id }] }]) {
    const reviewContract = JSON.parse(promptFor(f.company, reviewer, { id: 'review-test', agentId: 'reviewer' }).split('CONTRACT:\n')[1]);
    const evidence = reviewContract.review.artifacts ?? reviewContract.review.targets[0].artifacts;
    assert.deepEqual(evidence[0].textIntegrity, prose.textIntegrity);
    assert.equal(evidence[2].archiveVerification.textWarningCount, 1);
    assert.equal(evidence[2].archiveVerification.textSkippedCount, 0);
  }
  const api = createAgentApi(f); await api.start(); t.after(() => api.close());
  const credential = f.command('agentCredential.create', { name: 'Text evidence', projectIds: [f.project.id], goalIds: [f.goal.id] });
  const response = await fetch(api.baseUrl + '/artifacts/' + prose.id, { headers: { authorization: `Bearer ${credential.token}` } });
  assert.equal(response.status, 200); const data = (await response.json()).value;
  assert.deepEqual(data.artifact.textIntegrity, prose.textIntegrity); assert.deepEqual(Buffer.from(data.content, 'base64'), Buffer.from(damaged));
});

test('archive text warnings and scan range are bounded, without affecting byte-integrity checks', async () => {
  const entries = Array.from({ length: 102 }, (_, i) => ({ name: `handoff-${i}.md`, data: damaged }));
  entries.push({ name: 'large.txt', data: Buffer.alloc(MAX_TEXT_BYTES + 1, 65) });
  const report = await validateDeliveryArchive(deliveryZip(entries));
  assert.equal(report.passed, true); assert.equal(report.textDiagnostics.warnings.length, 100);
  assert.equal(report.textDiagnostics.warningsOmitted, 2); assert.equal(report.textDiagnostics.skipped, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(validateDeliveryText(Buffer.from(damaged), { signal: controller.signal }), { name: 'AbortError' });
});
