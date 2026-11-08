#!/usr/bin/env node
/**
 * Export and isolate the legacy stage-based task model (issue #25, P0).
 *
 * Usage:
 *   node scripts/legacy-export.mjs --data-dir C:\Users\me\.dsh\acms            # backup only
 *   node scripts/legacy-export.mjs --data-dir C:\Users\me\.dsh\acms --apply    # backup + isolate
 *
 * `--apply` archives existing tasks/goals and records the batch in meta so the
 * new task model ignores them. Nothing is deleted; restore from the exported
 * `company.db` when needed.
 */
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store.js';
import { exportLegacy } from '../src/core/legacy.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const value = name => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

if (flags.has('--help')) {
  console.log('Usage: node scripts/legacy-export.mjs [--data-dir <dir>] [--db <file>] [--apply] [--force]');
  process.exit(0);
}

const dataDir = path.resolve(value('data-dir') ?? process.env.ACMS_DATA_DIR ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'acms'));
const dbPath = path.resolve(value('db') ?? path.join(dataDir, 'company.db'));
const store = new Store(dbPath);
try {
  const result = exportLegacy(store, { dataDir, apply: flags.has('--apply'), force: flags.has('--force') });
  console.log(JSON.stringify(result, null, 2));
  if (result.skipped) process.exitCode = 1;
} finally {
  store.close();
}
