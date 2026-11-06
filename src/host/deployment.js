import { assert } from '../core/util.js';

/** Change only the ACMS host entry; preserve all other profile bytes. */
export function replaceHostEntry(content, filename) {
  const matches = [...content.matchAll(/^# BEGIN ACMS MANAGED CONFIG\r?\n[\s\S]*?^# END ACMS MANAGED CONFIG/gm)];
  assert(matches.length === 1, 'INSTALL_REQUIRED', 'Expected exactly one ACMS managed block; run install.ps1 first');
  const block = matches[0][0]; const entry = /^- id: acms\r?\n(?:  name:[^\r\n]*\r?\n)?/gm;
  assert([...block.matchAll(entry)].length === 1, 'INSTALL_REQUIRED', 'Expected one ACMS host entry');
  const newline = block.includes('\r\n') ? '\r\n' : '\n';
  const updated = block.replace(entry, `- id: acms${newline}  name: '${filename.replaceAll('\\', '/').replaceAll("'", "''")}'${newline}`);
  return content.slice(0, matches[0].index) + updated + content.slice(matches[0].index + block.length);
}
