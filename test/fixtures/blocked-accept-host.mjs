// Fault-injection host only: consumes an explicit state fixture, never a model.
import { Store } from '../../src/core/store.js';
import { Company } from '../../src/core/domain.js';
import { Engine } from '../../src/runtime/engine.js';
import { readExecution } from '../../src/runtime/execution-receipt.js';

const [database, dataDir, attemptId, crashPoint] = process.argv.slice(2);
const store = new Store(database), company = new Company(store);
const engine = new Engine(company, {}, {});
engine.epoch = store.acquireLease(engine.owner);
const attempt = store.require('attempts', attemptId);
const fact = readExecution(dataDir, attempt);
if (fact.status !== 'completed') throw new Error('Fixture receipt must be complete');
if (crashPoint === 'after-commit') {
  store.events.on('event', event => { if (event.type === 'attempt.finished') process.exit(86); });
} else if (crashPoint === 'before-business-write') {
  const put = store.put.bind(store);
  store.put = (collection, value, ...args) => {
    if (collection === 'tasks' && value.id === attempt.taskId) process.exit(86);
    return put(collection, value, ...args);
  };
} else throw new Error('Unknown fixture crash point');
await engine.accept(attempt, fact.result, new AbortController().signal);
throw new Error('Fault injection was not reached');
