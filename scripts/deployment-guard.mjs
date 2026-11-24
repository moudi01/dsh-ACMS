import { lstatSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { integrationPending } from '../src/core/task-actions.js';
import { assertWorktreeRestoreReady } from '../src/core/restore-safety.js';

export function checkIdle(db, dataDir) {
  assertWorktreeRestoreReady(dataDir);
  const active = db.prepare("SELECT count(*) AS n FROM entities WHERE collection='attempts' AND (json_extract(body,'$.status') IN ('preparing','running','cancelling','reconciling') OR json_extract(body,'$.cleanupPending')=1)").get().n;
  if (active) throw new Error('ACMS has active executions. Finish or pause them before deploying.');
  const chats = db.prepare("SELECT count(*) AS n FROM entities WHERE collection='conversationMessages' AND (json_extract(body,'$.status') IN ('sending','streaming','restarting') OR json_extract(body,'$.cleanupPending')=1)").get().n;
  if (chats) throw new Error('ACMS has active conversations. Finish or stop replies before deploying.');
  for (const row of db.prepare("SELECT id, body FROM entities WHERE collection='integrations'").iterate()) {
    const record = JSON.parse(row.body);
    if (!integrationPending(record) && !record.cleanupPending && !record.cleanupUncertain) continue;
    const action = record.phase === 'reconciling' || record.cleanupPending || record.cleanupUncertain
      ? 'Verify the Git result and process cleanup in the current host before deploying.'
      : 'Let the integration finish or pause it and confirm cleanup before deploying.';
    throw new Error(`ACMS Git integration ${row.id} is ${record.phase}. ${action}`);
  }
}

function identity(database) {
  if (!lstatSync(database, { throwIfNoEntry: false })) return null;
  const stat = statSync(database, { bigint: true });
  if (!stat.isFile()) throw new Error('Expected a regular ACMS database file.');
  return `${stat.dev}:${stat.ino}`;
}

async function holdInstallAdmission(directories) {
  const gates = [], checked = [];
  const verify = () => {
    for (const { dataDir, database, expected } of checked) {
      assertWorktreeRestoreReady(dataDir);
      if (identity(database) !== expected) throw new Error('ACMS database appeared or changed identity during installation. Retry against the current data directory.');
    }
  };
  try {
    const occupied = new Set();
    for (const dataDir of directories.sort()) {
      assertWorktreeRestoreReady(dataDir);
      const database = path.join(dataDir, 'company.db');
      const expected = identity(database);
      checked.push({ dataDir, database, expected });
      if (expected === null || occupied.has(expected)) continue;
      const uri = pathToFileURL(database);
      uri.searchParams.set('mode', 'rw');
      const db = new DatabaseSync(uri.href);
      gates.push(db);
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      verify();
      checkIdle(db, dataDir);
      occupied.add(expected);
    }
    // The installer owns the stdin pipe. A normal close or process exit releases the locks.
    const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
    console.log('ready');
    try {
      for await (const command of commands) {
        if (command !== 'verify') throw new Error('Unexpected ACMS install admission command.');
        verify();
        console.log('ready');
      }
    } finally { commands.close(); }
  } finally { for (const db of gates.reverse()) db.close(); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  try { await holdInstallAdmission(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
