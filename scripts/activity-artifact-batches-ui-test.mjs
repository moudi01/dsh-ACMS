import { expect } from '@playwright/test';
import { OWNER, digest } from '../src/core/util.js';
import { startPreview } from './preview-server.mjs';

export async function verifyActivityArtifactBatches(browser) {
  const server = await startPreview({ seed: false, startEngine: false });
  const page = await browser.newPage();
  const { company } = server;
  const { store } = company;
  const batches = [];
  const errors = [];
  const firstReply = Promise.withResolvers();
  const obsoleteReply = Promise.withResolvers();
  let holdProjectA = false;
  let obsoleteReady = false;
  let inFlight = 0;
  let peak = 0;
  const command = (name, args) => company.command(OWNER, crypto.randomUUID(), name, args);
  page.on('pageerror', error => errors.push(error.message));
  try {
    const projects = ['甲', '乙'].map(label => command('project.save', { name: '批量动态项目' + label, repoRoot: server.source, mode: 'copy' }));
    store.transaction(() => {
      for (let index = 0; index < 60; index++) {
        const goalId = 'goal_batch_' + index;
        const projectId = projects[index % 2].id;
        store.put('goals', { id: goalId, projectId, title: '动态交付 ' + index, status: 'active', templateSnapshot: { finalReview: false } });
        for (let item = 0; item < 10; item++) {
          const taskId = `task_batch_${index}_${item}`;
          const artifactId = `artifact_batch_${index}_${item}`;
          store.put('tasks', { id: taskId, goalId, projectId, title: `执行 ${index}/${item}`, dependencies: [], kind: 'work',
            status: 'succeeded', artifactHash: digest(artifactId), artifactIds: [artifactId] });
          store.put('artifacts', { id: artifactId, taskId, title: `交付 ${index}/${item}`, path: 'file.md', bytes: 12 });
        }
        company.refreshGoal(goalId);
      }
      const repeated = store.require('goals', 'goal_batch_59');
      store.put('goals', { ...repeated, status: 'active' });
      company.refreshGoal(repeated.id);
    });
    await page.route(url => url.pathname === '/api/acms/artifact-links', async route => {
      const { references } = route.request().postDataJSON();
      batches.push(references);
      const first = batches.length === 1;
      inFlight++;
      peak = Math.max(peak, inFlight);
      let completed;
      try {
        const response = await route.fetch();
        const body = await response.json();
        if (first) await firstReply.promise;
        if (holdProjectA) {
          holdProjectA = false;
          obsoleteReady = true;
          await obsoleteReply.promise;
        }
        // Real server lookup, with responses deliberately out of input order.
        completed = { response, json: { ...body, rows: body.rows.reverse() } };
      } finally {
        inFlight--;
      }
      try { await route.fulfill(completed); } catch { /* scope can abort this response */ }
    });

    await page.goto(server.url);
    await page.getByRole('button', { name: '动态日志', exact: true }).click();
    const entries = page.locator('.acms-activity-entry');
    const links = page.getByRole('button', { name: /^打开产物「/ });
    await expect(entries).toHaveCount(50);
    await expect.poll(() => batches.length).toBe(1);
    expect(batches[0]).toHaveLength(100);
    firstReply.resolve();
    await expect(links).toHaveCount(500);
    const firstPage = batches.map(batch => batch.length);
    expect(firstPage).toEqual([100, 100, 100, 100, 90]);
    expect(peak).toBe(1);
    expect(new Set(batches.flat().map(ref => ref.id)).size).toBe(490);
    await expect(entries.first().getByRole('button', { name: /^打开产物「/ }).first()).toContainText('交付 59/0');

    await page.getByRole('button', { name: '加载更早的动态', exact: true }).click();
    await expect(links).toHaveCount(610);
    const olderPage = batches.slice(firstPage.length).map(batch => batch.length);
    expect(olderPage).toEqual([100, 10]);
    expect(new Set(batches.flat().map(ref => ref.id)).size).toBe(600);
    expect(batches.flat()).toHaveLength(600);
    expect(peak).toBe(1);

    const taskId = 'task_batch_59_0';
    const reused = page.getByRole('button', { name: /打开产物「交付 59\/0」/ });
    const reuseRef = { id: 'artifact_batch_59_0', taskId };
    await expect(reused).toHaveCount(2);
    const originalBatchCount = batches.length;
    command('task.delete', { id: taskId });
    await expect(reused).toHaveCount(0);
    await expect(page.getByText('历史产物不可用，仅保留哈希', { exact: false })).toHaveCount(2);
    expect(batches.slice(originalBatchCount)).toEqual([[reuseRef]]);
    command('task.restore', { id: taskId });
    await expect(reused).toHaveCount(2);
    expect(batches.slice(originalBatchCount)).toEqual([[reuseRef], [reuseRef]]);

    const filter = page.getByLabel('筛选动态项目');
    holdProjectA = true;
    await filter.selectOption(projects[0].id);
    await expect.poll(() => obsoleteReady).toBe(true);
    await filter.selectOption(projects[1].id);
    await expect(reused).toHaveCount(2);
    obsoleteReply.resolve();
    await expect(page.getByRole('button', { name: /打开产物「交付 58\/0」/ })).toHaveCount(0);
    await expect(filter).toHaveValue(projects[1].id);
    expect(server.adapter.calls).toHaveLength(0);
    expect(errors).toEqual([]);
    console.log('Activity artifact batches ' + JSON.stringify({ firstPage, olderPage, peakBeforeScopeChange: 1, restoreAndDelete: [1, 1] }));
  } finally {
    firstReply.resolve();
    obsoleteReply.resolve();
    await page.close();
    await server.close();
  }
}
