import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ThreadStore, fileStem, readJson } from '../lib/store.js'

const STORE_URL = new URL('../lib/store.js', import.meta.url).href
const CHILD_CODE = `
import { ThreadStore } from ${JSON.stringify(STORE_URL)};
const [stateFile, key, mode] = process.argv.slice(1);
try {
  const store = new ThreadStore(stateFile, key);
  store.update({ threadId: 'thread-' + key, status: 'running', ownerPid: process.pid });
  await store.publish();
  store.record('turn/started', { threadId: 'thread-' + key, turn: { id: 'turn-' + key } });
  if (mode === 'once') {
    await store.close('completed');
    process.send({ type: 'done' });
    process.disconnect();
  } else {
    process.on('message', async message => {
      if (message === 'close') {
        await store.close('completed');
        process.send({ type: 'done' });
        process.disconnect();
      }
    });
    process.send({ type: 'ready', pid: process.pid, lockPath: store.lockPath });
  }
} catch (error) {
  process.send({ type: 'error', code: error.code, message: error.message });
  process.disconnect();
  process.exitCode = 1;
}
`

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-store-test-'))
  const stateFile = path.join(stateDir, 'codex-threads.json')
  const children = []
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit')
        child.kill()
        await exit
      }
    }
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 })
  })
  function start(key, mode = 'hold') {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_CODE, stateFile, key, mode], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const first = Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error(`Child exited before notification (${code}): ${stderr}`) }),
    ])
    return { child, first }
  }
  return { stateFile, stateDir, start }
}

test('two processes cannot own the same key; releasing permits a later run', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const first = f.start('same-key')
  assert.equal((await first.first).type, 'ready')
  const contender = f.start('same-key', 'once')
  assert.equal((await contender.first).code, 'CODEX_THREAD_BUSY')
  const closed = once(first.child, 'message')
  first.child.send('close')
  assert.equal((await closed)[0].type, 'done')
  const later = f.start('same-key', 'once')
  assert.equal((await later.first).type, 'done')
  const saved = readJson(f.stateFile, {})['same-key']
  assert.equal(saved.turns, 2)
  assert.equal(saved.status, 'idle')
})

test('concurrent processes with distinct keys retain every discovery entry', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const runs = Array.from({ length: 6 }, (_, index) => f.start(`parallel-${index}`, 'once'))
  const results = await Promise.all(runs.map(run => run.first))
  assert.deepEqual(results.map(message => message.type), Array(6).fill('done'), JSON.stringify(results))
  const index = readJson(f.stateFile, {})
  assert.deepEqual(Object.keys(index).sort(), Array.from({ length: 6 }, (_, i) => `parallel-${i}`))
  assert.ok(Object.values(index).every(summary => summary.status === 'idle' && summary.turns === 1))
})

test('a crashed owner lease is recoverable without reusing sequence numbers', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const run = f.start('crashed')
  const ready = await run.first
  assert.equal(ready.type, 'ready')
  const exit = once(run.child, 'exit')
  run.child.kill()
  await exit
  const recovered = new ThreadStore(f.stateFile, 'crashed')
  t.after(() => { if (!recovered.closed) recovered.release() })
  const next = recovered.record('provider/recovered', {})
  assert.equal(next.seq, 2)
  assert.equal(recovered.summary.threadId, 'thread-crashed')
  await recovered.close('interrupted')
  assert.equal(readJson(f.stateFile, {}).crashed.status, 'idle')
})

test('an orphaned recovery lease from a dead process is also recoverable', { timeout: 10000 }, async (t) => {
  const f = await fixture(t)
  const run = f.start('reaper-crash')
  const ready = await run.first
  const exit = once(run.child, 'exit')
  run.child.kill()
  await exit
  await fs.writeFile(ready.lockPath + '.recover', JSON.stringify({ pid: ready.pid, token: 'dead-reaper', at: new Date().toISOString() }))
  const recovered = new ThreadStore(f.stateFile, 'reaper-crash')
  t.after(() => { if (!recovered.closed) recovered.release() })
  await recovered.close('interrupted')
  assert.equal(readJson(f.stateFile, {})['reaper-crash'].lastStatus, 'interrupted')
})

test('complete events survive a crash before summary persistence and partial tails are discarded', async (t) => {
  const f = await fixture(t)
  const store = new ThreadStore(f.stateFile, 'partial')
  store.update({ threadId: 'thread-partial', status: 'running' })
  await store.publish()
  store.record('turn/started', { threadId: 'thread-partial', turn: { id: 'turn-1' } })
  const complete = { seq: 2, at: new Date().toISOString(), key: 'partial', threadId: 'thread-partial',
    turnId: 'turn-1', method: 'item/agentMessage/delta', params: { delta: 'survives' } }
  await fs.appendFile(store.eventsPath, JSON.stringify(complete) + '\n{"seq":3,"partial"')
  store.release()
  const recovered = new ThreadStore(f.stateFile, 'partial')
  t.after(() => { if (!recovered.closed) recovered.release() })
  assert.equal(recovered.record('provider/recovered').seq, 3)
  const events = (await fs.readFile(store.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(item => item.seq), [1, 2, 3])
  assert.equal(events[1].params.delta, 'survives')
  await recovered.close('interrupted')
})

test('summary tracks turns once, unique tool calls, token usage, and bounded snippets', async (t) => {
  const f = await fixture(t)
  const store = new ThreadStore(f.stateFile, 'summary')
  t.after(() => { if (!store.closed) store.release() })
  store.update({ status: 'running', threadId: 'thread-summary' })
  await store.publish()
  const initialIndexSnippet = readJson(f.stateFile, {}).summary.lastSnippet
  const started = { threadId: 'thread-summary', turn: { id: 'turn-1' } }
  store.record('turn/started', started)
  store.record('turn/started', started)
  assert.equal(store.summary.turns, 1)
  const tool = { threadId: 'thread-summary', turnId: 'turn-1', item: { id: 'tool-1', type: 'commandExecution' } }
  store.record('item/started', tool)
  store.record('item/started', tool)
  assert.equal(store.summary.toolCalls, 1)
  store.record('item/agentMessage/delta', { itemId: 'message-1', delta: 'a'.repeat(600) })
  assert.equal(store.summary.lastSnippet.length, 512)
  store.record('item/agentMessage/delta', { itemId: 'message-2', delta: 'new message' })
  assert.equal(store.summary.lastSnippet, 'new message')
  const usage = { total: { totalTokens: 25 }, last: { totalTokens: 10 } }
  store.record('thread/tokenUsage/updated', { tokenUsage: usage })
  assert.deepEqual(store.summary.tokenUsage, usage)
  assert.deepEqual(readJson(store.summaryPath, {}).tokenUsage, usage)
  assert.equal(readJson(f.stateFile, {}).summary.lastSnippet, initialIndexSnippet, 'Index can stay stale while summary advances')
  await store.close('completed')
  const finished = readJson(f.stateFile, {}).summary
  assert.equal(finished.status, 'idle')
  assert.equal(finished.lastStatus, 'completed')
  assert.equal(finished.currentTurn, null)
  const next = new ThreadStore(f.stateFile, 'summary')
  next.record('turn/started', { threadId: 'thread-summary', turn: { id: 'turn-2' } })
  assert.equal(next.summary.turns, 2)
  assert.equal(next.summary.toolCalls, 0)
  await next.close('completed')
})

test('filename mapping handles Windows device names, case, and long Unicode keys', () => {
  for (const key of ['CON', 'con', 'A/B', 'A\\B', '\u4e2d\u6587'.repeat(1000), '__proto__']) {
    const stem = fileStem(key)
    assert.ok(stem.startsWith('t-'))
    assert.ok(stem.length < 150)
    assert.ok(!/[<>:"/\\|?*]/.test(stem))
  }
  assert.notEqual(fileStem('CON').toLowerCase(), fileStem('con').toLowerCase())
})

test('uncertain cleanup persists a quarantine and cannot release the thread lease', async t => {
  const f = await fixture(t)
  const store = new ThreadStore(f.stateFile, 'uncertain-tree')
  t.after(() => store.release())
  store.quarantine('injected job verification denied')
  await assert.rejects(store.close('failed'), { cleanupUncertain: true })
  assert.equal(readJson(store.summaryPath, {}).cleanupPending, true)
  assert.equal(readJson(store.summaryPath, {}).status, 'reconciling')
  assert.throws(() => new ThreadStore(f.stateFile, 'uncertain-tree'), { code: 'CODEX_THREAD_BUSY' })
  // Simulate loss of the host lease; the durable quarantine still forbids reuse.
  store.release()
  assert.throws(() => new ThreadStore(f.stateFile, 'uncertain-tree'), { code: 'CODEX_THREAD_BUSY', cleanupUncertain: true })
})
