import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import syncFs from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireLease, ThreadStore, fileStem, readJson } from '../lib/store.js'

const STORE_URL = new URL('../lib/store.js', import.meta.url).href
const windows = { skip: process.platform !== 'win32' }
const CHILD_CODE = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ThreadStore } from ${JSON.stringify(STORE_URL)};
const [stateFile, key, mode, faultCount] = process.argv.slice(1);
let faults = 0;
if (Number(faultCount)) {
  const open = fs.openSync;
  fs.openSync = (filename, flags, ...args) => {
    if (filename === stateFile + '.lock' && flags === 'wx' && faults < Number(faultCount)) {
      faults++;
      throw Object.assign(new Error('Injected EPERM opening the discovery lock'), { code: 'EPERM', syscall: 'open', path: filename });
    }
    return open(filename, flags, ...args);
  };
  syncBuiltinESMExports();
}
try {
  const store = new ThreadStore(stateFile, key);
  store.update({ threadId: 'thread-' + key, status: 'running', ownerPid: process.pid });
  await store.publish();
  store.record('turn/started', { threadId: 'thread-' + key, turn: { id: 'turn-' + key } });
  if (mode === 'once') {
    await store.close('completed');
    process.send({ type: 'done', faults });
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
  process.send({ type: 'error', code: error.code, message: error.message, phase: error.phase });
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
  function start(key, mode = 'hold', faults = 0) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_CODE, stateFile, key, mode, String(faults)], {
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

function mockFs(t, name, method) {
  const mock = t.mock.method(syncFs, name, method)
  syncBuiltinESMExports()
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports() })
}

function permissionError(filename, syscall = 'open', code = 'EPERM') {
  return Object.assign(new Error('Injected permission failure'), { code, errno: -4048, syscall, path: filename })
}

async function seededPublisher(t) {
  const f = await fixture(t)
  const index = JSON.stringify({ legacy: { threadId: 'saved-thread', turns: 2, status: 'idle' } }) + '\n'
  await fs.writeFile(f.stateFile, index)
  const store = new ThreadStore(f.stateFile, 'publisher')
  t.after(() => store.release())
  return { ...f, store, index, lock: f.stateFile + '.lock' }
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

test('parallel discovery writers keep all entries after a brief Windows index-lock refusal', { ...windows, timeout: 15000 }, async t => {
  const f = await fixture(t)
  const legacy = { threadId: 'legacy-thread', turns: 7, status: 'idle' }
  await fs.writeFile(f.stateFile, JSON.stringify({ legacy }))
  const runs = Array.from({ length: 6 }, (_, i) => f.start('writer-' + i, 'once', i === 2 ? 3 : 0))
  const results = await Promise.all(runs.map(run => run.first))
  assert.deepEqual(results.map(result => result.type), Array(6).fill('done'), JSON.stringify(results))
  assert.deepEqual(results.map(result => result.faults), [0, 0, 3, 0, 0, 0])
  const index = readJson(f.stateFile, {})
  assert.deepEqual(Object.keys(index).sort(), ['legacy', ...Array.from({ length: 6 }, (_, i) => 'writer-' + i)])
  assert.deepEqual(index.legacy, legacy)
  assert.ok(Object.entries(index).filter(([key]) => key !== 'legacy').every(([, record]) => record.status === 'idle' && record.turns === 1))
  assert.deepEqual((await fs.readdir(f.stateDir)).sort(), ['codex-threads', 'codex-threads.json'])
})

test('discovery publication waits for the current owner and atomically replaces the index under its own lease', async t => {
  const f = await seededPublisher(t)
  const release = acquireLease(f.lock)
  const owner = await fs.readFile(f.lock, 'utf8')
  const open = syncFs.openSync, read = syncFs.readFileSync, rename = syncFs.renameSync
  let commits = 0
  mockFs(t, 'renameSync', (source, target) => {
    if (target === f.stateFile) {
      commits++
      const publishingOwner = read(f.lock, 'utf8')
      assert.notEqual(publishingOwner, owner)
      assert.equal(JSON.parse(publishingOwner).pid, process.pid)
      assert.throws(() => open(f.lock, 'wx'), { code: 'EEXIST' })
      assert.equal(read(target, 'utf8'), f.index)
      assert.equal(JSON.parse(read(source, 'utf8')).publisher.key, 'publisher')
    }
    return rename(source, target)
  })
  const pending = f.store.publish()
  try {
    assert.equal(await fs.readFile(f.lock, 'utf8'), owner)
    assert.equal(await fs.readFile(f.stateFile, 'utf8'), f.index)
    assert.equal(commits, 0)
  } finally { release() }
  await pending
  assert.equal(commits, 1)
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' })
})

test('persistent index-lock refusal is bounded and preserves the final Windows error diagnosis', windows, async t => {
  const f = await seededPublisher(t)
  let time = 0, opens = 0, finalError
  const open = syncFs.openSync, read = syncFs.readFileSync
  t.mock.method(performance, 'now', () => time)
  mockFs(t, 'openSync', (filename, flags, ...args) => {
    if (filename !== f.lock || flags !== 'wx') return open(filename, flags, ...args)
    opens++
    time += 4000
    finalError = permissionError(filename)
    throw finalError
  })
  mockFs(t, 'readFileSync', (filename, ...args) => {
    assert.notEqual(filename, f.stateFile, 'publication must not read the index before taking the lock')
    return read(filename, ...args)
  })
  await assert.rejects(f.store.publish(), error => {
    assert.equal(error, finalError)
    assert.equal(error.code, 'EPERM')
    assert.equal(error.errno, -4048)
    assert.equal(error.syscall, 'open')
    assert.equal(error.path, f.lock)
    assert.equal(error.phase, 'index-lock-open')
    return true
  })
  assert.equal(opens, 3)
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), f.index)
  await assert.rejects(fs.lstat(f.lock), { code: 'ENOENT' })
})

test('aborting a Windows index-lock retry leaves the competing lease and index alone', windows, async t => {
  const f = await seededPublisher(t)
  const release = acquireLease(f.lock)
  const owner = await fs.readFile(f.lock, 'utf8')
  const controller = new AbortController()
  const reason = new Error('Owner cancelled discovery publication')
  const open = syncFs.openSync
  let opens = 0
  mockFs(t, 'openSync', (filename, flags, ...args) => {
    if (filename !== f.lock || flags !== 'wx') return open(filename, flags, ...args)
    opens++
    queueMicrotask(() => controller.abort(reason))
    throw permissionError(filename)
  })
  try {
    await assert.rejects(f.store.publish(controller.signal), error => error === reason || error.cause === reason)
    assert.equal(opens, 1)
    assert.equal(await fs.readFile(f.lock, 'utf8'), owner)
    assert.equal(await fs.readFile(f.stateFile, 'utf8'), f.index)
  } finally { release() }
})

for (const operation of ['token write', 'descriptor close', 'EACCES']) test('index publish does not retry ' + operation, windows, async t => {
  const f = await seededPublisher(t)
  const open = syncFs.openSync, write = syncFs.writeFileSync, close = syncFs.closeSync
  const denied = operation === 'EACCES' ? permissionError(f.lock, 'open', 'EACCES')
    : permissionError(undefined, operation === 'token write' ? 'write' : 'close')
  let fd, attempts = 0
  mockFs(t, 'openSync', (filename, flags, ...args) => {
    if (filename !== f.lock || flags !== 'wx') return open(filename, flags, ...args)
    attempts++
    if (operation === 'EACCES') throw denied
    return fd = open(filename, flags, ...args)
  })
  if (operation === 'token write') mockFs(t, 'writeFileSync', (target, ...args) => {
    if (fd !== undefined && target === fd) throw denied
    return write(target, ...args)
  })
  if (operation === 'descriptor close') mockFs(t, 'closeSync', target => {
    close(target)
    if (target === fd) throw denied
  })
  await assert.rejects(f.store.publish(), error => error === denied && error.phase === undefined)
  assert.equal(attempts, 1)
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), f.index)
})

test('a thread-key lease refusal still returns the original error immediately', windows, async t => {
  const f = await fixture(t)
  const key = 'thread-lock-denied'
  const lock = path.join(f.stateDir, 'codex-threads', fileStem(key) + '.lock')
  const denied = permissionError(lock)
  const open = syncFs.openSync
  let attempts = 0
  mockFs(t, 'openSync', (filename, flags, ...args) => {
    if (filename !== lock || flags !== 'wx') return open(filename, flags, ...args)
    attempts++
    throw denied
  })
  assert.throws(() => new ThreadStore(f.stateFile, key), error => error === denied && error.phase === undefined)
  assert.equal(attempts, 1)
  await assert.rejects(fs.lstat(f.stateFile), { code: 'ENOENT' })
})

for (const phase of ['reaper open', 'owner recheck']) test('index publish does not retry an EPERM during ' + phase, { ...windows, timeout: 15000 }, async t => {
  const f = await seededPublisher(t)
  const run = f.start('dead-owner')
  const ready = await run.first
  assert.equal(ready.type, 'ready')
  const exit = once(run.child, 'exit')
  run.child.kill()
  await exit
  const owner = JSON.stringify({ pid: ready.pid, token: 'crashed-index-writer' })
  await fs.writeFile(f.lock, owner)
  const before = await fs.readFile(f.stateFile, 'utf8')
  const denied = permissionError(phase === 'reaper open' ? f.lock + '.recover' : f.lock)
  const open = syncFs.openSync, read = syncFs.readFileSync
  let attempts = 0, ownerReads = 0
  mockFs(t, 'openSync', (filename, flags, ...args) => {
    if (filename === f.lock && flags === 'wx') attempts++
    if (phase === 'reaper open' && filename === f.lock + '.recover' && flags === 'wx') throw denied
    return open(filename, flags, ...args)
  })
  if (phase === 'owner recheck') mockFs(t, 'readFileSync', (filename, ...args) => {
    if (filename === f.lock && ++ownerReads === 2) throw denied
    return read(filename, ...args)
  })
  await assert.rejects(f.store.publish(), error => error === denied && error.phase === undefined)
  assert.equal(attempts, 1)
  assert.equal(await fs.readFile(f.lock, 'utf8'), owner)
  assert.equal(await fs.readFile(f.stateFile, 'utf8'), before)
  await assert.rejects(fs.lstat(f.lock + '.recover'), { code: 'ENOENT' })
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
