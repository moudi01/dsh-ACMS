/** DSH normally watches configuration, not imported source modules. Publish one
 * immutable host bundle and change only ACMS's managed entry to hot-reload it. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { buildHost } from './host-bundle.mjs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { replaceHostEntry } from '../src/host/deployment.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv[2] ?? 'desktop';
if (!/^[\w-]+$/.test(profile)) throw new Error('Invalid profile name');
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const patch = path.join(home, 'profiles', profile, 'cordis.patch.yml');
const previous = await readFile(patch, 'utf8');
const block = previous.match(/^# BEGIN ACMS MANAGED CONFIG\r?\n[\s\S]*?^# END ACMS MANAGED CONFIG/m)?.[0];
const dataDir = block?.match(/^    dataDir: '((?:[^']|'')*)'\r?$/m)?.[1].replaceAll("''", "'");
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Expected the installed ACMS data directory');
const checkIdle = () => {
  const db = new DatabaseSync(path.join(dataDir, 'company.db'), { readOnly: true });
  try {
    const active = db.prepare("SELECT count(*) AS n FROM entities WHERE collection='attempts' AND (json_extract(body,'$.status') IN ('preparing','running','cancelling','reconciling') OR json_extract(body,'$.cleanupPending')=1)").get().n;
    if (active) throw new Error('ACMS has active executions. Finish or pause them before deploying.');
    const chats = db.prepare("SELECT count(*) AS n FROM entities WHERE collection='conversationMessages' AND (json_extract(body,'$.status') IN ('sending','streaming','restarting') OR json_extract(body,'$.cleanupPending')=1)").get().n;
    if (chats) throw new Error('ACMS has active conversations. Finish or stop replies before deploying.');
  } finally { db.close(); }
};
checkIdle();
const { filename, revision } = await buildHost({ root });
const next = replaceHostEntry(previous, filename);
if (next !== previous) {
  checkIdle();
  const backups = path.join(dataDir, 'install-backups'); await mkdir(backups, { recursive: true });
  await writeFile(path.join(backups, `${profile}-before-host-${Date.now()}.yml`), previous);
  if (await readFile(patch, 'utf8') !== previous) throw new Error('Profile changed during deployment; retry against the new config');
  await writeFile(patch, next);
}
console.log(`ACMS host ${revision} published to ${profile}; refresh the DSH page for client changes.`);
