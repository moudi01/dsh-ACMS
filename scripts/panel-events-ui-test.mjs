import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OWNER, SYSTEM } from '../src/core/util.js';
import { startPreview } from './preview-server.mjs';

const eventRoute = url => url.pathname === '/api/acms/events';
const stateRoute = url => url.pathname === '/api/acms/state';

export async function pauseRead(page, match, beforeRead = false) {
  const release = Promise.withResolvers();
  let reached = false, finished = false, failure;
  await page.route(match, async route => {
    try {
      if (beforeRead) { reached = true; await release.promise; }
      const response = await route.fetch();
      if (!beforeRead) { reached = true; await release.promise; }
      try { await route.fulfill({ response }); } catch {
        // Chromium can cancel a pending read when its scope closes.
      }
    } catch (error) { if (!page.isClosed()) failure = error; }
    finally { finished = true; }
  }, { times: 1 });
  return { wait: async () => {
    await expect.poll(() => reached || finished).toBe(true);
    if (failure) throw failure;
  }, release: () => release.resolve(), finish: async () => {
    release.resolve();
    await expect.poll(() => finished).toBe(true);
    if (failure) throw failure;
  } };
}

export async function verifyPanelEvents(browser) {
  const server = await startPreview({ seed: false });
  const page = await browser.newPage();
  const { store } = server.company;
  const command = (name, args) => server.company.command(OWNER, crypto.randomUUID(), name, args);
  const states = [], polls = [], responses = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (stateRoute(url)) states.push(url);
    if (eventRoute(url)) polls.push(Number(url.searchParams.get('after')));
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (eventRoute(url)) responses.push({ after: Number(url.searchParams.get('after')), body: response.body().catch(() => null) });
  });
  const waitForPoll = cursor => expect.poll(() => polls.at(-1), { timeout: 10000 }).toBe(cursor);
  const rename = (project, name) => store.put('projects', { ...store.require('projects', project.id), name });
  const changeProject = (project, name) => {
    store.transaction(() => { rename(project, name); store.event('project.saved', project.id, {}, SYSTEM); });
    return store.cursor();
  };
  try {
    command('company.pause', {});
    const otherRoot = path.join(server.root, 'other-panel-project');
    await mkdir(otherRoot);
    const first = command('project.save', { name: '水位项目甲', repoRoot: server.source, mode: 'copy' });
    const second = command('project.save', { name: '水位项目乙', repoRoot: otherRoot, mode: 'copy' });
    store.db.exec("DELETE FROM events; DELETE FROM sqlite_sequence WHERE name='events'");

    await page.route(url => eventRoute(url) && url.searchParams.get('view') === 'panel' && url.searchParams.get('after') === '0',
      route => route.fulfill({ json: { latestCursor: 0 } }), { times: 1 });
    await page.goto(server.url);
    await waitForPoll(0);
    await expect.poll(() => store.events.listenerCount('event')).toBeGreaterThan(1);
    expect(states).toHaveLength(1);
    await page.getByRole('button', { name: '任务工作台', exact: true }).click();
    const projectFilter = page.getByLabel('筛选项目');
    await projectFilter.selectOption(second.id);

    const initialReads = states.length;
    const responseStart = responses.length;
    store.transaction(() => {
      rename(first, '突发后的水位项目甲');
      rename(second, '突发后的水位项目乙');
      for (let index = 0; index < 501; index++) {
        store.event('project.saved', index % 2 ? first.id : second.id, { index, note: 'fixed body for a burst' }, SYSTEM);
      }
    });
    const burstCursor = store.cursor();
    await waitForPoll(burstCursor);
    const burstBodies = await Promise.all(responses.slice(responseStart).filter(row => row.after < burstCursor).map(row => row.body));
    console.log('Panel burst ' + JSON.stringify({ events: 501, stateReads: states.length - initialReads,
      eventBytes: burstBodies.reduce((sum, body) => sum + body.length, 0) }));
    expect(states.length - initialReads).toBe(1);
    expect(burstBodies.map(data => JSON.parse(data.toString('utf8')))).toEqual([{ latestCursor: burstCursor }]);
    await expect(projectFilter).toHaveValue(second.id);
    await expect(projectFilter).toContainText('突发后的水位项目乙');
    await projectFilter.selectOption(first.id);
    await expect(projectFilter).toContainText('突发后的水位项目甲');

    // A write before the SQLite read is covered by the same full snapshot.
    let startingReads = states.length;
    const beforeRead = await pauseRead(page, stateRoute, true);
    changeProject(first, '读取前项目甲');
    await beforeRead.wait();
    const covered = changeProject(second, '同一次读取覆盖项目乙');
    await beforeRead.finish();
    await waitForPoll(covered);
    expect(states.length - startingReads).toBe(1);
    await expect(projectFilter).toContainText('同一次读取覆盖项目乙');

    // A write after the SQLite read needs its own refresh, even when the
    // previous response remains in flight until after that write.
    startingReads = states.length;
    const previousPollCount = polls.length;
    const afterRead = await pauseRead(page, stateRoute);
    const firstCursor = changeProject(first, '刚读取的项目甲');
    await afterRead.wait();
    const laterCursor = changeProject(second, '读取之后的项目乙');
    await afterRead.finish();
    await waitForPoll(laterCursor);
    expect(polls.slice(previousPollCount)).toEqual([firstCursor, laterCursor]);
    expect(states.length - startingReads).toBe(2);
    await expect(projectFilter).toContainText('读取之后的项目乙');

    const errorBox = page.getByRole('alert').filter({ hasText: '连接中断' });
    await page.route(stateRoute, route => route.fulfill({ status: 503, json: { error: { message: '夹具状态读取失败' } } }), { times: 1 });
    const retryPoll = polls.length;
    startingReads = states.length;
    const unreconciled = changeProject(first, '状态失败后仍可恢复项目甲');
    await expect(errorBox).toContainText('夹具状态读取失败');
    await expect(projectFilter).toContainText('刚读取的项目甲');
    const duringFailure = changeProject(second, '重试期间写入项目乙');
    await waitForPoll(duringFailure);
    expect(polls.slice(retryPoll)).toEqual([laterCursor, duringFailure]);
    expect(polls.slice(retryPoll)).not.toContain(unreconciled);
    expect(states.length - startingReads).toBe(2);
    await expect(errorBox).toHaveCount(0);
    await expect(projectFilter).toContainText('重试期间写入项目乙');

    const disconnectedPolls = polls.length;
    await page.route(url => eventRoute(url) && Number(url.searchParams.get('after')) > duringFailure,
      route => route.abort('failed'), { times: 1 });
    const beforeDisconnect = changeProject(first, '断线前已应用项目甲');
    await expect(errorBox).toBeVisible();
    const whileOffline = changeProject(second, '断线期间写入项目乙');
    await waitForPoll(whileOffline);
    expect(polls.slice(disconnectedPolls)).toEqual([beforeDisconnect, beforeDisconnect, whileOffline]);
    await expect(errorBox).toHaveCount(0);
    await expect(projectFilter).toContainText('断线期间写入项目乙');

    // The owner command applies its state while the background HTTP request
    // still waits on the earlier cursor. Its notification is already covered.
    const manual = await pauseRead(page, eventRoute, true);
    await page.reload();
    await manual.wait();
    startingReads = states.length;
    await page.getByRole('button', { name: '公司设置', exact: true }).click();
    await page.getByRole('button', { name: '编辑边界', exact: true }).click();
    await page.getByLabel('最大并发', { exact: true }).fill('5');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('5 个', { exact: true })).toBeVisible();
    const manualCursor = store.cursor();
    await manual.finish();
    await waitForPoll(manualCursor);
    expect(states.length - startingReads).toBe(1);

    // A real rewind keeps the previous epoch invalid even if the first
    // recovery read fails and the database has caught up by the next read.
    await expect.poll(() => store.events.listenerCount('event')).toBeGreaterThan(1);
    await page.route(stateRoute, route => route.fulfill({ status: 503, json: { error: { message: '夹具恢复读取失败' } } }), { times: 1 });
    const recoveryPolls = polls.length;
    startingReads = states.length;
    store.transaction(() => {
      store.db.prepare('DELETE FROM events WHERE seq=?').run(manualCursor);
      rename(second, '恢复检查点中的项目乙');
    });
    store.events.emit('event', { type: 'fixture.restored' });
    await expect(errorBox).toContainText('夹具恢复读取失败');
    await expect(page.getByRole('heading', { name: '正在连接公司服务', exact: true })).toBeVisible();
    const restoredCursor = changeProject(second, '追平后重新读取项目乙');
    expect(restoredCursor).toBeGreaterThan(manualCursor);
    await waitForPoll(restoredCursor);
    expect(polls.slice(recoveryPolls)).toEqual([restoredCursor]);
    expect(states.length - startingReads).toBe(2);
    await expect(page.getByRole('button', { name: /追平后重新读取项目乙/ })).toBeVisible();
    await expect(errorBox).toHaveCount(0);

    await page.close();
    await expect.poll(() => store.events.listenerCount('event')).toBe(1);
    expect(server.adapter.calls).toHaveLength(0);
    expect(errors).toEqual([]);
    console.log('Panel watermark: zero cursor, burst merge, concurrent writes, fallback after errors, reconnect and owner refresh passed.');
  } finally {
    await page.close();
    await server.close();
  }
}
