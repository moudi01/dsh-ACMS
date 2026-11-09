import path from 'node:path';
import { Store } from '../../src/core/store.js';
import { Company } from '../../src/core/domain.js';
import { Engine } from '../../src/runtime/engine.js';
import { WorkspaceManager } from '../../src/runtime/workspaces.js';

const [dataDir] = process.argv.slice(2);
const store = new Store(path.join(dataDir, 'company.db'));
const company = new Company(store);
const workspaces = new WorkspaceManager(dataDir, company);
const integrate = workspaces.integrate.bind(workspaces);
workspaces.integrate = async (...args) => {
  await integrate(...args);
  // Git and its cleanup receipt are durable; the host has not accepted the
  // result or updated the task status yet.
  process.exit(87);
};
const adapter = { start: () => { throw new Error('Integration recovery must not dispatch a model'); } };
await new Engine(company, adapter, workspaces, { intervalMs: 20 }).start();
await new Promise(resolve => setTimeout(resolve, 30000));
