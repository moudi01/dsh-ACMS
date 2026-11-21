import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { Store } from '../src/core/store.js';
import { createRoutes, waitForEvents, waitForPanelWatermark } from '../src/host/http.js';

test('native routes return state and perform validated owner commands without a separate port', async t => {
  const f = await fixture(t); const routes = createRoutes(f); const state = routes.find(r => r.path.endsWith('/state'));
  const response = await state.fetch(new Request('http://dsh/api/acms/state')); assert.equal(response.status, 200); assert.equal((await response.json()).policy.maxConcurrent, 4);
  const command = routes.find(r => r.path.endsWith('/command')); const requestId = randomUUID();
  const req = () => new Request('http://dsh/api/acms/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, name: 'task.create', args: { goalId: f.goal.id, title: 'Native command' } }) });
  const a = await (await command.fetch(req())).json(); const b = await (await command.fetch(req())).json(); assert.equal(a.value.id, b.value.id);
  assert.equal(f.store.list('tasks').length, 1);
});
test('state snapshot exposes the same execution capacity the scheduler uses', async t => {
  const f = await fixture(t); const routes = createRoutes(f); const state = routes.find(r => r.path.endsWith('/state'));
  const read = async () => (await (await state.fetch(new Request('http://dsh/api/acms/state'))).json()).runtime.capacity;
  const empty = await read();
  assert.equal(empty.used, 0); assert.equal(empty.limit, 4); assert.deepEqual(empty.entries, []);
  assert.deepEqual(empty.counts, { attempt: 0, integration: 0, chat: 0, probe: 0 });

  const task = f.task();
  f.store.put('attempts', { id: 'attempt_running_state', taskId: task.id, goalId: f.goal.id, agentId: 'agent_1', status: 'running' });
  f.adapter.activeChats = 1; f.adapter.activeProbes = 1;
  const mixed = await read();
  assert.equal(mixed.used, 3);
  assert.deepEqual(mixed.counts, { attempt: 1, integration: 0, chat: 1, probe: 1 });
  assert.equal(mixed.free, 1);
  assert.equal(mixed.entries.find(entry => entry.kind === 'attempt').taskId, task.id);

  f.store.put('attempts', { id: 'attempt_running_state', taskId: task.id, goalId: f.goal.id, agentId: 'agent_1', status: 'completed' });
  f.adapter.activeChats = 0; f.adapter.activeProbes = 0;
  assert.equal((await read()).used, 0);
});
test('durable event cursor catches up after disconnect and observer cancellation does not stop work', async t => {
  const f = await fixture(t); const cursor = f.store.cursor(); const abort = new AbortController(); const pending = waitForEvents(f.store, cursor, abort.signal, 1000);
  f.task(); const page = await pending; assert(page.nextCursor > cursor); assert(page.entries.some(e => e.type === 'task.created'));
  abort.abort(); assert.equal(f.company.policy().paused, false); assert.equal(f.store.page(page.nextCursor).entries.length, 0);
});

test('panel events return only a durable watermark and legacy consumers retain full paginated bodies', async t => {
  const f = await fixture(t);
  const events = createRoutes(f).find(route => route.path.endsWith('/events'));
  const after = f.store.cursor();
  f.store.transaction(() => {
    for (let index = 0; index < 501; index++) {
      f.store.event('fixture.batch', f.goal.id, { index, note: 'fixed body for a burst' }, { kind: 'system', id: 'scheduler' });
    }
  });
  const latestCursor = f.store.cursor();
  const read = (cursor, search = '') => events.fetch(new Request('http://dsh/api/acms/events?after=' + cursor + search));
  const original = f.store.page.bind(f.store);
  let pages = 0;
  f.store.page = cursor => { pages++; return original(cursor); };

  const body = await (await read(after, '&view=panel')).text();
  assert.equal(body, JSON.stringify({ latestCursor }));
  assert.equal(pages, 0);
  assert.deepEqual(await (await read(latestCursor + 1, '&view=panel')).json(), { latestCursor });
  assert.equal(pages, 0);
  let cursor = after;
  const sizes = [];
  const seen = [];
  while (cursor < latestCursor) {
    const text = await (await read(cursor)).text();
    const page = JSON.parse(text);
    cursor = page.nextCursor;
    sizes.push(Buffer.byteLength(text));
    seen.push(...page.entries.map(event => event.index));
    assert.equal(page.latestCursor, latestCursor);
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen, Array.from({ length: 501 }, (_, i) => i));
  t.diagnostic('Burst 501 event bytes, legacy=' + sizes.reduce((a, b) => a + b, 0) + ', panel=' + Buffer.byteLength(body));
});

test('only the panel may read an immediate equal watermark for reconnect', async t => {
  const f = await fixture(t);
  const events = createRoutes(f).find(route => route.path.endsWith('/events'));
  const latestCursor = f.store.cursor();
  const url = 'http://dsh/api/acms/events?after=' + latestCursor + '&wait=0';
  const immediate = events.fetch(new Request(url + '&view=panel'));
  assert.equal(f.store.events.listenerCount('event'), 0);
  assert.deepEqual(await (await immediate).json(), { latestCursor });

  const controller = new AbortController();
  const legacy = events.fetch(new Request(url, { signal: controller.signal }));
  assert.equal(f.store.events.listenerCount('event'), 1);
  controller.abort();
  assert.deepEqual(await (await legacy).json(), { entries: [], nextCursor: latestCursor, latestCursor });
  assert.equal(f.store.events.listenerCount('event'), 0);
});

test('panel watermark waits on cursor zero and cleans its subscription on cancellation', async () => {
  const store = new Store(':memory:');
  const controller = new AbortController();
  try {
    const pending = waitForPanelWatermark(store, 0, controller.signal, 1000);
    assert.equal(store.events.listenerCount('event'), 1);
    controller.abort();
    assert.deepEqual(await pending, { latestCursor: 0 });
    assert.equal(store.events.listenerCount('event'), 0);
    assert.deepEqual(await waitForPanelWatermark(store, 10, undefined, 1000), { latestCursor: 0 });
    const next = waitForPanelWatermark(store, 0, undefined, 1000);
    store.transaction(() => store.event('fixture.created', null, {}, { kind: 'system', id: 'scheduler' }));
    assert.deepEqual(await next, { latestCursor: 1 });
    assert.equal(store.events.listenerCount('event'), 0);
  } finally { store.close(); }
});

test('a panel wait observes writes made by a separate SQLite connection without a local broadcast', async t => {
  const f = await fixture(t);
  const writer = new Store(f.store.filename);
  try {
    const before = f.store.cursor();
    const waiting = waitForPanelWatermark(f.store, before, undefined, 30);
    writer.transaction(() => writer.event('fixture.external', f.goal.id, {}, { kind: 'system', id: 'scheduler' }));
    assert.deepEqual(await waiting, { latestCursor: before + 1 });
    assert.equal(f.store.events.listenerCount('event'), 0);
  } finally { writer.close(); }
});
