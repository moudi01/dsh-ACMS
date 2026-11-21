import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DshAdapter } from '../src/adapters/dsh.js';
import { PairedRuntimes } from '../src/adapters/paired.js';
import { executionOccupancy } from '../src/core/execution-capacity.js';
import { createRoutes } from '../src/host/http.js';
import { Conversations } from '../src/runtime/conversations.js';
import { receiptPaths } from '../src/runtime/execution-receipt.js';
import { REVIEW_INLINE_BYTES } from '../src/runtime/review-context.js';
import { digest } from '../src/core/util.js';
import { deliveryZip } from './fixtures/delivery-zip.js';
import { fixture, taskWaitDiagnostics, until } from './helpers.js';

const result = { outcome: 'reviewed', decision: 'approve', summary: 'Checked the exact delivered files' };
const contractOf = prompt => JSON.parse(prompt.slice(prompt.indexOf('\nCONTRACT:\n') + '\nCONTRACT:\n'.length));
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const state = (f, task) => f.store.require('tasks', task.id);
const attemptsFor = (f, task) => f.store.list('attempts').filter(attempt => attempt.taskId === task.id);

function waitFor(f, task, status) {
  return until(() => {
    const current = state(f, task);
    if (current.status === status) return true;
    const latest = attemptsFor(f, task).at(-1);
    if ((latest?.status === 'failed' && !latest.preflightOnly) || ['blocked', 'failed', 'cancelled'].includes(current.status)) {
      assert.fail(latest?.summary ?? current.blocker?.reason ?? current.status);
    }
    return false;
  }, undefined, taskWaitDiagnostics(f, task.id));
}

function ownerRoutes(f, conversations) {
  const routes = new Map(createRoutes({ ...f, conversations }).map(route => [route.path, route]));
  return async (route, body) => {
    const pathname = '/api/acms/' + route;
    const response = await routes.get(pathname).fetch(new Request('http://localhost' + pathname, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload.value ?? payload;
  };
}

test('ordinary review bounds actual escaped UTF-8 while retaining full workspace evidence and latest owner instructions', async t => {
  const files = new Map([
    ['small.md', Buffer.from('简短交接 with a quote " and \\ plus 🚀\r\n'.repeat(10))],
    ['escaped.json', Buffer.from(JSON.stringify({ escaped: '"\\\n'.repeat(1150) }, null, 2))],
    ['long.md', Buffer.from('Original 中文 handover.\r\n'.repeat(1000))],
    ['mixed.txt', Buffer.from('Latest old delivery body 中文。\n'.repeat(830))],
    ['oversized.md', Buffer.from('审查文件 larger than the text threshold。\n'.repeat(900))],
    ['large.bin', Buffer.alloc(131077, 0x8b)],
    ['nonutf8.txt', Buffer.from([0xff, 0x00, 0x11])],
    ['release.zip', deliveryZip([{ name: 'data.txt', data: 'Checked release' }])],
  ]);
  let observed;
  const f = await fixture(t, async input => {
    if (input.task.kind !== 'review') {
      for (const [name, bytes] of files) await writeFile(path.join(input.task.workspace.path, name), bytes);
      return { outcome: 'completed', artifacts: [...files.keys()].map(name => ({ path: name,
        ...(name === 'release.zip' ? { archiveFormat: 'acms-delivery/1' } : {}) })) };
    }
    const contract = contractOf(input.prompt);
    for (const entry of contract.review.sourceEvidence) {
      assert.equal(path.isAbsolute(entry.workspacePath), false);
      const bytes = await readFile(path.join(input.task.workspace.path, entry.workspacePath));
      assert.deepEqual(bytes, files.get(entry.path));
      assert.equal(entry.rawSha256, rawHash(bytes));
      assert.equal(entry.hash, digest(bytes.toString('base64')));
    }
    observed = { ...input, contract };
    return result;
  });
  const conversations = new Conversations(f.company, f.engine, f.adapter, f.dataDir);
  const post = ownerRoutes(f, conversations);
  const project = f.command('project.save', { id: f.project.id, checks: [{
    id: 'delivered-file-check', command: process.execPath, inputs: ['small.md'],
    args: ['-e', "if (!require('fs').existsSync('small.md')) process.exitCode=3"],
  }] });
  const goal = f.command('goal.create', { projectId: project.id, templateId: f.template.id, plan: false, title: 'Before owner update',
    description: 'Detailed owner scope', acceptance: 'Preserve the complete original binary and text bytes' });
  const author = f.task({ goalId: goal.id, acceptance: 'Review all delivered sources' });
  await f.start();
  await waitFor(f, author, 'succeeded');
  await f.engine.stop();
  const review = await post('command', { name: 'review.request', args: { id: author.id }, requestId: randomUUID() });
  f.command('goal.edit', { id: goal.id, patch: { title: '所有者更新的审查目标' } });
  const chat = await post('conversation', { action: 'open', agentId: review.agentId, taskId: review.id });
  const message = await post('conversation', { action: 'send', conversationId: chat.id, text: '最后一条所有者指令：核对 CRLF。', requestId: randomUUID() });
  assert.equal(message.status, 'queued');
  await f.start();
  await waitFor(f, review, 'succeeded');
  const { contract, prompt, task, attempt } = observed;
  assert.notEqual(task.workspace.path, state(f, author).workspace.path);
  assert.notEqual(attempt.agentId, state(f, author).lastAuthorId);
  assert.equal(contract.goal.title, '所有者更新的审查目标');
  assert.equal(contract.task.acceptance, 'Review all delivered sources');
  assert.deepEqual(contract.role.grants, []);
  assert.equal(contract.ownerConversation.at(-1).text, message.text);
  assert.ok(contract.changeNotifications.some(notice => notice.changes.some(change => change.after === '所有者更新的审查目标')));
  assert.equal(contract.review.scope, 'task');
  assert.equal(contract.review.sourceVersion.artifactHash, state(f, author).artifactHash);
  assert.ok(contract.review.checks.checks.some(check => check.id === 'delivered-file-check' && check.passed));
  const entries = new Map(contract.review.sourceEvidence.map(entry => [entry.path, entry]));
  assert.equal(entries.get('small.md').content, files.get('small.md').toString('utf8'));
  assert.ok(entries.get('escaped.json').bytes < REVIEW_INLINE_BYTES);
  assert.equal(entries.get('escaped.json').omitted, 'inline-budget');
  assert.equal(entries.get('oversized.md').omitted, 'large-text');
  assert.equal(entries.get('large.bin').omitted, 'non-text');
  assert.equal(entries.get('large.bin').workspacePath, 'large.bin');
  assert.equal(entries.get('nonutf8.txt').omitted, 'invalid-utf8');
  const archive = contract.review.artifacts.find(artifact => artifact.path === 'release.zip');
  assert.equal(archive.archiveVerification.manifestReference.archivePath, entries.get('release.zip').workspacePath);
  assert.equal(archive.archiveVerification.archiveSha256, rawHash(files.get('release.zip')));
  const saved = f.store.require('attempts', attempt.id).reviewContext;
  const stripped = { ...contract, review: { ...contract.review, sourceEvidence: saved.evidence } };
  const inline = Buffer.byteLength(JSON.stringify(contract, null, 2)) - Buffer.byteLength(JSON.stringify(stripped, null, 2));
  assert.equal(saved.inlineBytes, inline);
  assert.ok(inline > 0 && inline <= REVIEW_INLINE_BYTES);
  assert.equal(saved.promptUtf8Bytes, Buffer.byteLength(prompt, 'utf8'));
  assert.ok(saved.promptUtf8Bytes > prompt.length && saved.promptUtf8Bytes < 24000);
  const oldInline = ['small.md', 'escaped.json', 'long.md', 'mixed.txt'].map(name => files.get(name).toString('utf8'));
  const oldInlineBytes = Buffer.byteLength(JSON.stringify(oldInline));
  assert.ok(oldInlineBytes > saved.promptUtf8Bytes * 2);
  t.diagnostic(`Previously eligible text alone: ${oldInlineBytes} serialized bytes. Current full prompt: ${saved.promptUtf8Bytes} bytes.`);
  assert.equal(saved.sourceFingerprint, contract.review.sourceFingerprint);
  assert.ok(!JSON.stringify(saved).includes('Original 中文 handover'));
  assert.equal(f.store.require('conversationMessages', message.id).status, 'delivered');
  const ownerState = createRoutes(f).find(route => route.path === '/api/acms/state');
  const response = await ownerState.fetch(new Request('http://localhost/api/acms/state'));
  assert.deepEqual((await response.json()).attempts.find(record => record.id === attempt.id).reviewContext, saved);
});

test('a stale review copy uses the same original bytes after restart and refuses to dispatch while both copies fail verification', async t => {
  const original = Buffer.from('已交付的原文件。Original bytes.\r\n'.repeat(4000));
  const forged = Buffer.alloc(original.length, 0x61);
  const received = [];
  let blob;
  let f;
  f = await fixture(t, async input => {
    if (input.task.kind !== 'review') {
      await writeFile(path.join(input.task.workspace.path, 'report.md'), original);
      return { outcome: 'completed', artifacts: [{ path: 'report.md' }] };
    }
    const entry = contractOf(input.prompt).review.sourceEvidence[0];
    received.push(entry);
    assert.match(entry.workspacePath, /^\.acms\/review-evidence\//);
    assert.deepEqual(await readFile(path.join(input.task.workspace.path, entry.workspacePath)), original);
    assert.deepEqual(await readFile(path.join(input.task.workspace.path, 'report.md')), forged);
    if (received.length === 1) {
      await writeFile(blob, forged);
      f.command('company.pause', { afterCurrent: true });
      throw new Error('Transient reviewer fixture to recheck the saved reference');
    }
    return result;
  });
  const author = f.task();
  await f.start(); await waitFor(f, author, 'succeeded'); await f.engine.stop();
  const delivered = state(f, author);
  const artifact = f.store.require('artifacts', delivered.artifactIds[0]);
  blob = artifact.blob;
  const review = f.command('review.request', { id: author.id });
  const workspace = await f.workspaces.prepare(review, { signal: new AbortController().signal });
  f.store.put('tasks', { ...review, workspace });
  await writeFile(path.join(workspace.path, 'report.md'), forged);
  await writeFile(blob, forged);

  await f.start();
  await waitFor(f, review, 'blocked');
  const blocked = attemptsFor(f, review).at(-1);
  assert.equal(blocked.reviewContextFailure.code, 'REVIEW_EVIDENCE_UNAVAILABLE');
  assert.equal(blocked.preflightOnly, true);
  assert.equal(blocked.cleanupPending, false);
  assert.equal(f.adapter.calls.filter(call => call.task.id === review.id).length, 0);
  assert.equal(state(f, review).attempts, 0);
  assert.equal(f.store.list('verifications').some(row => row.attemptId === blocked.id), false);
  const cache = path.join(workspace.path, '.acms', 'review-evidence');
  assert.deepEqual(await readdir(cache), []);
  await f.engine.stop();
  await writeFile(blob, original);
  const interaction = f.store.list('interactions').find(row => row.taskId === review.id && row.status === 'pending');
  f.command('interaction.answer', { id: interaction.id, answer: '恢复了正确版本，请重新核对。' });
  await f.start();
  await until(() => received.length === 1 && attemptsFor(f, review).at(-1).status === 'failed', undefined, taskWaitDiagnostics(f, review.id));
  await f.engine.stop();
  f.command('company.resume');
  await f.start();
  await until(() => state(f, review).status === 'succeeded', undefined, taskWaitDiagnostics(f, review.id));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], received[1]);
  assert.equal(received[1].hash, artifact.hash);
  assert.equal(received[1].rawSha256, rawHash(original));
  assert.equal(received[1].omitted, 'large-text');
  assert.deepEqual(await readdir(cache), [artifact.hash]);
  assert.deepEqual(await readFile(path.join(delivered.workspace.path, 'report.md')), original);
  assert.equal(f.store.list('verifications').some(row => row.attemptId === attemptsFor(f, review).at(-1).id && row.passed), true);
});

test('a redirected evidence directory cannot write outside an isolated review workspace', async t => {
  const f = await fixture(t);
  const author = f.task();
  await f.start(); await waitFor(f, author, 'succeeded'); await f.engine.stop();
  const review = f.command('review.request', { id: author.id });
  const workspace = await f.workspaces.prepare(review, { signal: new AbortController().signal });
  f.store.put('tasks', { ...review, workspace });
  const outside = path.join(f.root, 'sentinel');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep'), 'unchanged');
  await writeFile(path.join(workspace.path, 'deliverable.md'), 'tampered');
  try { await symlink(outside, path.join(workspace.path, '.acms', 'review-evidence'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('this host does not permit directory symlink fixtures');
    return;
  }
  await f.start();
  await waitFor(f, review, 'blocked');
  assert.equal(f.adapter.calls.filter(call => call.task.id === review.id).length, 0);
  assert.deepEqual(await readdir(outside), ['keep']);
  assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'unchanged');
});

test('a reviewer cannot approve after the bytes of its referenced evidence are changed', async t => {
  let f;
  f = await fixture(t, async input => {
    if (input.task.kind !== 'review') {
      await writeFile(path.join(input.task.workspace.path, 'proof.txt'), 'exact original evidence');
      return { outcome: 'completed', artifacts: [{ path: 'proof.txt' }] };
    }
    const entry = contractOf(input.prompt).review.sourceEvidence[0];
    await writeFile(path.join(input.task.workspace.path, entry.workspacePath), 'other content evidence');
    f.command('company.pause', { afterCurrent: true });
    return result;
  });
  const author = f.task();
  await f.start(); await waitFor(f, author, 'succeeded');
  const review = f.command('review.request', { id: author.id });
  await until(() => f.store.page().entries.some(event => event.type === 'attempt.failed' && event.taskId === review.id &&
    event.code === 'REVIEW_EVIDENCE_CHANGED'), undefined, taskWaitDiagnostics(f, review.id));
  const attempt = attemptsFor(f, review).at(-1);
  assert.equal(attempt.status, 'failed');
  assert.equal(f.store.list('verifications').some(row => row.attemptId === attempt.id), false);
  assert.equal(await readFile(path.join(state(f, author).workspace.path, 'proof.txt'), 'utf8'), 'exact original evidence');
});

async function pairedReview(f) {
  const runner = path.join(f.root, 'reviewer-runner.mjs');
  await writeFile(runner, `import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.mode !== 'task') throw new Error('only local fixture tasks are supported');
const contract = JSON.parse(request.prompt.split('CONTRACT:\\n')[1]);
let output;
if (contract.task.kind === 'review') {
  if (contract.collaboration) {
    const context = JSON.parse(await readFile(contract.collaboration.index, 'utf8'));
    const history = context.handoff?.history;
    if (history && createHash('sha256').update(await readFile(history.path)).digest('hex') !== history.sha256) throw new Error('wrong author history pin');
  }
  for (const entry of contract.review.sourceEvidence) {
    const bytes = await readFile(entry.workspacePath);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.rawSha256) throw new Error('wrong review evidence');
  }
  output = { outcome: 'reviewed', decision: 'approve', summary: 'Fixture read the original artifact' };
} else {
  await writeFile('next.txt', 'unrelated task ran');
  output = { outcome: 'completed', artifacts: [{ path: 'next.txt' }] };
}
console.log(JSON.stringify({ protocol: request.protocol, requestId: request.requestId, model: request.model, executed: true, output }));
`);
  const paired = new PairedRuntimes(f.company, f.dataDir);
  const invite = await paired.invite();
  const { token } = JSON.parse(invite.prompt.slice(invite.prompt.indexOf('{\n  "protocol"'), invite.prompt.lastIndexOf('\n完成后')));
  await writeFile(invite.responseFile, JSON.stringify({ protocol: 'acms.runner.v1', inviteId: invite.id, token, name: 'Local reviewer fixture',
    model: 'review-fixture', command: process.execPath, args: [runner], persistent: false, reasoningEffort: null }));
  const model = await paired.inspect(invite.id);
  await paired.accept(invite.id, model.fingerprint);
  const adapter = new DshAdapter({ get: () => null, subagents: { providers: new Map() } }, f.company, f.dataDir, { paired });
  f.engine.adapter = adapter;
  f.command('agent.save', { id: 'reviewer', provider: model.id, model: model.model });
  return adapter;
}

for (const mode of ['live', 'delayed', 'obsolete-contract', 'restart-before-rejection', 'pinned-history-before-recovery',
  'author-history-before-recovery', 'author-history-delayed']) {
  test(`paired review evidence rejection releases its slot only with the right receipt (${mode})`, async t => {
    const f = await fixture(t);
    const authorHistory = mode.startsWith('author-history-');
    const pause = mode === 'delayed' || mode === 'author-history-delayed';
    const delayedProof = pause || mode === 'obsolete-contract';
    const contextChanged = mode === 'pinned-history-before-recovery' || authorHistory;
    const rejectionCode = authorHistory ? 'ARTIFACT_CHANGED' : 'REVIEW_EVIDENCE_CHANGED';
    f.command('policy.update', { patch: { maxConcurrent: 1 } });
    const author = f.task();
    await f.start(); await waitFor(f, author, 'succeeded'); await f.engine.stop();
    const adapter = await pairedReview(f);
    const review = await ownerRoutes(f)('command', { name: 'review.request', args: { id: author.id }, requestId: randomUUID() });
    const otherGoal = f.command('goal.create', { projectId: f.project.id, templateId: f.template.id, plan: false, title: 'Other goal',
      description: 'Use the available slot', acceptance: 'Next task executes' });
    let observed, priorReceipt, receiptFile, reference, original;
    const accept = f.engine.accept.bind(f.engine);
    f.engine.accept = async (attempt, output, signal) => {
      if (attempt.taskId === review.id && !observed) {
        observed = f.store.require('attempts', attempt.id);
        const fact = await adapter.reconcile(observed);
        assert.equal(fact.status, 'completed');
        assert.equal(fact.cleanupConfirmed, true);
        const workspace = authorHistory ? state(f, author).workspace : observed.workspace;
        reference = path.join(workspace.path, contextChanged ? workspace.collaboration.handoff.history.path
          : observed.reviewContext.evidence[0].workspacePath);
        original = await readFile(reference);
        if (contextChanged) {
          const altered = Buffer.from(original);
          altered[5] ^= 1;
          await writeFile(reference, altered);
        } else await unlink(reference);
        if (authorHistory) {
          const reviewHistory = path.join(observed.workspace.path, observed.workspace.collaboration.handoff.history.path);
          assert.deepEqual(await readFile(reviewHistory), original);
        }
        if (delayedProof) {
          receiptFile = receiptPaths(f.dataDir, observed.execution).file;
          priorReceipt = await readFile(receiptFile, 'utf8');
          const mismatched = JSON.parse(priorReceipt);
          mismatched.identity.attemptId = 'another-attempt';
          await writeFile(receiptFile, JSON.stringify(mismatched));
        }
        if (mode === 'restart-before-rejection' || (contextChanged && !delayedProof)) {
          throw new Error('Interrupted before the host evaluated the review result');
        }
      }
      return accept(attempt, output, signal);
    };
    await f.start();
    await until(() => attemptsFor(f, review).at(-1)?.status === (mode === 'live' ? 'failed' : 'reconciling'),
      undefined, taskWaitDiagnostics(f, review.id));
    if (mode !== 'live') {
      assert.equal(executionOccupancy(f.store, adapter, f.engine.live).used, 1);
      assert.equal(f.store.require('attempts', observed.id).cleanupPending, true);
      if (delayedProof) {
        assert.equal(f.store.require('attempts', observed.id).reviewResultRejected?.code, rejectionCode);
        if (authorHistory) {
          await f.engine.stop();
          await f.start();
          assert.equal(executionOccupancy(f.store, adapter, f.engine.live).used, 1);
          assert.equal(f.store.require('attempts', observed.id).cleanupPending, true);
        }
        if (pause) f.command('task.pause', { id: review.id });
        else {
          f.command('company.pause', { afterCurrent: true });
          const revised = f.command('goal.edit', { id: author.goalId, patch: { acceptance: 'Use the revised owner contract' } });
          assert.equal(revised.contractVersion, 2);
        }
        await writeFile(reference, original);
        await writeFile(receiptFile, priorReceipt);
      }
      await f.engine.stop();
      await f.start();
    }
    const blocked = f.store.require('attempts', observed.id);
    assert.equal(blocked.reviewResultRejected?.code, rejectionCode);
    if (authorHistory) assert.equal(blocked.reviewResultRejected.reason, 'Reviewed files changed after delivery');
    assert.equal(blocked.status, delayedProof ? 'interrupted' : 'failed');
    assert.equal(blocked.cleanupPending, false);
    assert.equal(blocked.resultAccepted, false);
    const task = state(f, review);
    assert.equal(task.status, pause ? 'paused' : mode === 'obsolete-contract' ? 'cancelled' : 'blocked');
    if (!delayedProof) assert.equal(task.blocker.kind, 'review-evidence');
    assert.equal(f.store.list('verifications').some(row => row.attemptId === observed.id), false);
    if (mode === 'obsolete-contract') {
      assert.equal(task.contractObsolete, true);
      assert.equal(executionOccupancy(f.store, adapter, f.engine.live).used, 0);
    } else {
      const next = f.task({ goalId: otherGoal.id, title: 'Use the freed slot' });
      await waitFor(f, next, 'succeeded');
    }
    assert.equal(attemptsFor(f, review).length, 1);
    assert.equal(f.store.list('tasks').some(task => task.kind === 'repair' && task.goalId === author.goalId), false);
    await f.engine.stop();
    await f.start();
    assert.equal(f.store.page().entries.filter(event => event.type === 'attempt.cleanup.confirmed' && event.entityId === observed.id).length, 1);
    assert.equal(f.store.list('verifications').some(row => row.attemptId === observed.id), false);
  });
}

for (const material of ['artifact', 'author history']) test('a paused review cannot reapply a parked answer after its ' + material + ' is changed', async t => {
  const finished = Promise.withResolvers();
  let evidence;
  const f = await fixture(t, async input => {
    if (input.task.kind !== 'review') {
      await writeFile(path.join(input.task.workspace.path, 'proof.md'), 'Recorded proof');
      return { outcome: 'completed', artifacts: [{ path: 'proof.md' }] };
    }
    const workspace = input.task.workspace;
    evidence = path.join(workspace.path, material === 'author history' ? workspace.collaboration.handoff.history.path
      : contractOf(input.prompt).review.sourceEvidence[0].workspacePath);
    await finished.promise; return result;
  });
  const author = f.task();
  await f.start(); await waitFor(f, author, 'succeeded');
  const review = f.command('review.request', { id: author.id });
  try {
    await until(() => !!evidence, undefined, taskWaitDiagnostics(f, review.id));
    f.command('goal.pause', { id: review.goalId, afterCurrent: true });
  } finally { finished.resolve(); }
  const parked = await until(() => attemptsFor(f, review).find(attempt => attempt.resultDeferred && attempt.cleanupPending === false),
    undefined, taskWaitDiagnostics(f, review.id));
  assert.ok(f.store.get('deferredResults', parked.id));
  if (material === 'author history') {
    const altered = await readFile(evidence);
    altered[5] ^= 1;
    await writeFile(evidence, altered);
  } else await unlink(evidence);
  f.command('goal.resume', { id: review.goalId });
  await waitFor(f, review, 'blocked');
  const rejected = f.store.require('attempts', parked.id);
  assert.equal(rejected.reviewResultRejected.code, 'REVIEW_EVIDENCE_CHANGED');
  assert.equal(rejected.cleanupPending, false);
  assert.equal(rejected.resultDeferred, false);
  assert.equal(f.store.get('deferredResults', parked.id), null);
  assert.equal(f.adapter.calls.filter(input => input.task.id === review.id).length, 1);
  assert.equal(f.store.list('verifications').some(row => row.attemptId === parked.id), false);
});
