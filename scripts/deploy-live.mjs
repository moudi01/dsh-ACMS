/** DSH normally watches configuration, not imported source modules. Publish one
 * immutable host bundle and change only ACMS's managed entry to hot-reload it. */
import fs from 'node:fs';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { buildHost } from './host-bundle.mjs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { replaceHostEntry } from '../src/host/deployment.js';
import { integrationPending } from '../src/core/task-actions.js';
import { assertWorktreeRestoreReady } from '../src/core/restore-safety.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkIdle(db, dataDir) {
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

function archiveProfile(backup, original) {
  const temporary = backup + '.tmp';
  try {
    fs.writeFileSync(temporary, original, { flag: 'wx', flush: true, mode: 0o600 });
    fs.renameSync(temporary, backup);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function deployLive({ root = projectRoot, profile = 'desktop', home, build = buildHost }) {
  if (!/^[\w-]+$/.test(profile)) throw new Error('Invalid profile name');
  const patch = path.join(home, 'profiles', profile, 'cordis.patch.yml');
  const metadata = await lstat(patch);
  if (!metadata.isFile()) throw new Error('Expected a regular ACMS profile configuration');
  const original = await readFile(patch);
  const previous = original.toString('utf8');
  if (!Buffer.from(previous).equals(original)) throw new Error('Expected a UTF-8 ACMS profile configuration');
  const block = previous.match(/^# BEGIN ACMS MANAGED CONFIG\r?\n[\s\S]*?^# END ACMS MANAGED CONFIG/m)?.[0];
  const dataDir = block?.match(/^    dataDir: '((?:[^']|'')*)'\r?$/m)?.[1].replaceAll("''", "'");
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Expected the installed ACMS data directory');

  assertWorktreeRestoreReady(dataDir);
  const database = path.join(dataDir, 'company.db');
  const db = new DatabaseSync(database, { readOnly: true });
  try { checkIdle(db, dataDir); } finally { db.close(); }
  const { filename, revision } = await build({ root });
  const next = replaceHostEntry(previous, filename);
  if (next === previous) return { filename, revision, backup: null };

  const key = `${Date.now()}-${randomUUID()}`;
  const temporary = path.join(path.dirname(patch), `.acms-host-${key}.tmp`);
  const staged = await open(temporary, 'wx', metadata.mode & 0o777);
  try {
    try {
      await staged.writeFile(next);
      await staged.sync();
    } finally { await staged.close(); }
    const backups = path.join(dataDir, 'install-backups');
    await mkdir(backups, { recursive: true });
    const backup = path.join(backups, `${profile}-before-host-${key}.yml`);
    const gate = new DatabaseSync(database);
    try {
      // Scheduler admission uses writes to this database. Hold its writer lock
      // from the last idle check through publication of the profile entry.
      gate.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      checkIdle(gate, dataDir);
      const unchanged = () => fs.lstatSync(patch).isFile() && fs.readFileSync(patch).equals(original);
      if (!unchanged()) {
        throw new Error('Profile changed during deployment; retry against the new config');
      }
      archiveProfile(backup, original);
      assertWorktreeRestoreReady(dataDir);
      if (!unchanged()) throw new Error(`Profile changed during deployment; retry against the new config. Previous configuration: ${backup}`);
      try { fs.renameSync(temporary, patch); }
      catch (error) { throw new Error(`Could not switch the ACMS host entry. Previous configuration: ${backup}`, { cause: error }); }
    } finally { gate.close(); }
    return { filename, revision, backup };
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const profile = process.argv[2] ?? 'desktop';
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  try {
    const { revision, backup } = await deployLive({ profile, home });
    console.log(`ACMS host ${revision} published to ${profile}; refresh the DSH page for client changes.`);
    if (backup) console.log(`Previous configuration: ${backup}`);
  } catch (error) { console.error(`Deploy failed: ${error.message}`); process.exitCode = 1; }
}
