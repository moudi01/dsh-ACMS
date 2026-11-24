import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceHostEntry } from '../src/host/deployment.js';
test('live deployment only updates the managed host entry and preserves provider/config bytes', () => {
  const original = "# unrelated\r\n- id: existing\r\n  name: old\r\n# BEGIN ACMS MANAGED CONFIG\r\n- id: acms\r\n  config:\r\n    dataDir: 'D:/data'\r\n- id: unrelated-provider\r\n  config:\r\n    model: gpt-6-astra\r\n# END ACMS MANAGED CONFIG\r\n# trailing\r\n";
  const filename = "D:\\ACMS\\release $&'s\\host-a.mjs";
  const updated = replaceHostEntry(original, filename);
  const deployed = "- insert:\r\n    - id: acms-versioned-host\r\n      name: 'D:/ACMS/release $&''s/host-a.mjs'\r\n      config:\r\n        dataDir: 'D:/data'\r\n";
  assert.equal(updated.replace(deployed, '').replace('  disabled: true\r\n', ''), original);
  assert(updated.includes('- id: acms\r\n  disabled: true\r\n'));
  assert.equal(replaceHostEntry(updated, filename), updated);
  const next = replaceHostEntry(updated, 'D:/ACMS/dist/host-b.mjs');
  assert(!next.includes('host-a')); assert(next.includes("      name: 'D:/ACMS/dist/host-b.mjs'"));
  const legacy = original.replace('- id: acms\r\n', "- id: acms\r\n  name: 'D:/ACMS/dist/legacy-host.mjs'\r\n");
  assert.equal(replaceHostEntry(legacy, filename), updated);
  assert.throws(() => replaceHostEntry('', 'D:/host.mjs'), { code: 'INSTALL_REQUIRED' });
  assert.throws(() => replaceHostEntry(original + original, 'D:/host.mjs'), { code: 'INSTALL_REQUIRED' });
});
