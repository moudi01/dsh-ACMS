import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceHostEntry } from '../src/host/deployment.js';
test('live deployment only updates the managed host entry and preserves provider/config bytes', () => {
  const original = "# unrelated\r\n- id: existing\r\n  name: old\r\n# BEGIN ACMS MANAGED CONFIG\r\n- id: acms\r\n  config:\r\n    dataDir: 'D:/data'\r\n- id: unrelated-provider\r\n  config:\r\n    model: gpt-6-astra\r\n# END ACMS MANAGED CONFIG\r\n# trailing\r\n";
  const updated = replaceHostEntry(original, 'D:\\ACMS\\dist\\host-a.mjs');
  assert.equal(updated.replace("  name: 'D:/ACMS/dist/host-a.mjs'\r\n", ''), original);
  assert.equal(replaceHostEntry(updated, 'D:/ACMS/dist/host-a.mjs'), updated);
  const next = replaceHostEntry(updated, 'D:/ACMS/dist/host-b.mjs');
  assert(!next.includes('host-a')); assert(next.includes('host-b'));
  assert.throws(() => replaceHostEntry('', 'D:/host.mjs'), { code: 'INSTALL_REQUIRED' });
  assert.throws(() => replaceHostEntry(original + original, 'D:/host.mjs'), { code: 'INSTALL_REQUIRED' });
});
