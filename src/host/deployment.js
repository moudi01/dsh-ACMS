import { assert } from '../core/util.js';

/** Change only the managed ACMS entries; preserve all other profile bytes. */
export function replaceHostEntry(content, filename) {
  const matches = [...content.matchAll(/^# BEGIN ACMS MANAGED CONFIG\r?\n[\s\S]*?^# END ACMS MANAGED CONFIG/gm)];
  assert(matches.length === 1, 'INSTALL_REQUIRED', 'Expected exactly one ACMS managed block; run install.ps1 first');
  const block = matches[0][0];
  const stock = /^- id: acms\r?\n(?:[ \t][^\r\n]*\r?\n)*/gm;
  const deployed = /^- insert:\r?\n    - id: acms-versioned-host\r?\n(?: {6}[^\r\n]*\r?\n)*/gm;
  assert([...block.matchAll(stock)].length === 1 && [...block.matchAll(deployed)].length <= 1,
    'INSTALL_REQUIRED', 'Expected one managed ACMS host configuration');
  const newline = block.includes('\r\n') ? '\r\n' : '\n';
  const name = filename.replaceAll('\\', '/').replaceAll("'", "''");
  // DSH uses a patch entry's name to match the installed plugin. Activate a
  // distinct loader entry for the versioned bundle and disable the stock one.
  const updated = block.replace(deployed, '').replace(stock, entry => {
    const attributes = entry.replace(/^- id: acms\r?\n/, '').replace(/^  (?:name|disabled):[^\r\n]*\r?\n/gm, '');
    const nested = attributes.replace(/^(?=[^\r\n])/gm, '    ');
    return `- id: acms${newline}  disabled: true${newline}${attributes}` +
      `- insert:${newline}    - id: acms-versioned-host${newline}      name: '${name}'${newline}${nested}`;
  });
  return content.slice(0, matches[0].index) + updated + content.slice(matches[0].index + block.length);
}
