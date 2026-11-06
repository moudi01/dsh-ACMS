import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { createRoutes, waitForEvents } from '../src/host/http.js';

test('native routes return state and perform validated owner commands without a separate port', async t => {
  const f = await fixture(t); const routes = createRoutes(f); const state = routes.find(r => r.path.endsWith('/state'));
  const response = await state.fetch(new Request('http://dsh/api/acms/state')); assert.equal(response.status, 200); assert.equal((await response.json()).policy.maxConcurrent, 4);
  const command = routes.find(r => r.path.endsWith('/command')); const requestId = randomUUID();
  const req = () => new Request('http://dsh/api/acms/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, name: 'task.create', args: { goalId: f.goal.id, title: 'Native command' } }) });
  const a = await (await command.fetch(req())).json(); const b = await (await command.fetch(req())).json(); assert.equal(a.value.id, b.value.id);
  assert.equal(f.store.list('tasks').length, 1);
});
test('durable event cursor catches up after disconnect and observer cancellation does not stop work', async t => {
  const f = await fixture(t); const cursor = f.store.cursor(); const abort = new AbortController(); const pending = waitForEvents(f.store, cursor, abort.signal, 1000);
  f.task(); const page = await pending; assert(page.nextCursor > cursor); assert(page.entries.some(e => e.type === 'task.created'));
  abort.abort(); assert.equal(f.company.policy().paused, false); assert.equal(f.store.page(page.nextCursor).entries.length, 0);
});
