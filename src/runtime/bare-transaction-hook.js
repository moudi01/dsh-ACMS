import { spawnSync } from 'node:child_process';
import { assert } from '../core/util.js';
import { assertBareDeliveryFence, assertBareMetadataPaths, assertBareRepositoryPolicy, bareHooksArgs, barePolicyArgs } from './bare-delivery-target.js';

// Git calls this helper with both the repository proof and target ref locks
// held. Read the real repository policies without the parent's private
// hooksPath override, which Git normally forwards to subprocesses.
try {
  const record = JSON.parse(process.env.ACMS_BARE_WRITE);
  assertBareDeliveryFence(record);
  assertBareMetadataPaths(record.targetRoot, record.targetRef);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (args, accepted = [0]) => {
    const result = spawnSync('git', ['--git-dir=.', ...args], { cwd: record.targetRoot, env,
      encoding: 'utf8', windowsHide: true, timeout: 3000 });
    assert(!result.error && accepted.includes(result.status), 'GIT_ERROR',
      result.error?.message || result.stderr || 'Unable to check the confirmed bare target.');
    return result;
  };
  assertBareRepositoryPolicy(git(bareHooksArgs).stdout.trim(), git(barePolicyArgs, [0, 1]).status);
  assert(git(['symbolic-ref', '--quiet', record.targetRef], [0, 1]).status === 1,
    'TARGET_REF_UNSUPPORTED', 'The confirmed target is no longer a direct branch.');
} catch (error) {
  process.stderr.write(String(error.message) + '\n');
  process.exitCode = 1;
}
