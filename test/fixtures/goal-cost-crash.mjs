import assert from 'node:assert/strict';
import path from 'node:path';
import { SimulatedAdapter, defaultSimulation } from '../../src/adapters/simulated.js';
import { Company } from '../../src/core/domain.js';
import { Store } from '../../src/core/store.js';
import { OWNER } from '../../src/core/util.js';
import { Engine } from '../../src/runtime/engine.js';
import { WorkspaceManager } from '../../src/runtime/workspaces.js';
import { cleanupError } from '../../src/runtime/owned-process.js';
import { readCommandCleanup } from '../../src/runtime/host-command.js';

const [dataDir, goalId, mode] = process.argv.slice(2);
assert(['denied', 'withdrawn', 'cancelled', 'optional-quote', 'optional-quote-check', 'optional-quote-recover'].includes(mode));
const store = new Store(path.join(dataDir, 'company.db'));
const company = new Company(store);
const adapter = new SimulatedAdapter(defaultSimulation);
const selection = { status: 'selected', chosen: { provider: 'simulation', model: 'fixed-cost', llmProvider: null, reasoningEffort: null } };
adapter.inspectTaskRoute = () => ({ selection });
adapter.start = () => { throw new Error('A normal model launch is unexpected before the crash'); };
if (mode !== 'denied') adapter.taskCost = {
  id: 'cost-crash.v1',
  quote: ({ route }) => ({ route, quoteId: 'cost-crash-quote', currency: 'USD', upperMicros: '7' }),
  start: () => { throw new Error('A cost-authorized model launch is unexpected before the crash'); },
  reconcile: () => null,
  readReceipt: () => null,
};
const workspaces = new WorkspaceManager(dataDir, company);
if (mode === 'optional-quote') {
  company.command(OWNER, 'quote-fixture-resume', 'company.resume', {});
  workspaces.prepare = (_task, attempt) => {
    assert(attempt.costDeferralRequestId);
    process.exit(73);
  };
}
const engine = new Engine(company, adapter, workspaces, { intervalMs: 20 });
if (mode === 'optional-quote-check') {
  company.command(OWNER, 'quote-fixture-resume', 'company.resume', {});
  const run = workspaces.runDeliveryCheck.bind(workspaces);
  workspaces.runDeliveryCheck = async (command, args, cwd, options) => {
    const delayed = path.join(dataDir, 'delayed-quote-receipt.json');
    const result = await run(command, args, cwd, { ...options, cleanupReceipt: delayed });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readCommandCleanup(delayed))?.exitCode, 0);
    throw cleanupError('Fixture withholds the verified cleanup receipt');
  };
  workspaces.prepare = async (task, attempt) => {
    assert(attempt.costDeferralRequestId);
    await engine.runHostCheck(attempt, process.execPath, ['-e', 'process.exit(0)'], task.workspace.path,
      { checkId: 'fixture-quote-preparation', signal: attempt.signal });
    assert.fail('The delayed-receipt check should be held');
  };
}
if (mode === 'optional-quote-recover') {
  const clear = engine.clearHostCheck.bind(engine);
  engine.clearHostCheck = async (...args) => {
    await clear(...args);
    process.exit(75);
  };
}
store.events.on('event', event => {
  if (event.goalId !== goalId) return;
  if (mode === 'optional-quote-check' && event.type === 'attempt.cleanup.failed') process.exit(73);
  if (mode !== 'denied' && event.type === 'goal.cost_budget.reserved') {
    const args = mode === 'cancelled' ? { id: goalId } : { id: goalId, afterCurrent: true };
    company.command(OWNER, 'withdraw-before-launch', mode === 'cancelled' ? 'goal.cancel' : 'goal.pause', args);
  }
  if (event.type === 'task.cost_budget.' + (mode === 'denied' ? 'blocked' : 'launch_withdrawn')) {
    // Exit after commit and before execute() can enter its finally block.
    process.exit(73);
  }
});
setTimeout(() => {
  console.error(JSON.stringify({ error: engine.lastError, tasks: store.list('tasks').map(task => ({ id: task.id, status: task.status })),
    attempts: store.list('attempts').map(row => ({ id: row.id, status: row.status, summary: row.summary, cleanupPending: row.cleanupPending })) }));
  process.exit(74);
}, 15000);
await engine.start();
