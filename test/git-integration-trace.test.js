import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCommandCleanup } from '../src/runtime/host-command.js';
import { fixture, gitProject, until } from './helpers.js';
import { integrationWaitDiagnostics, traceContainedFixture } from './fixture-trace.js';

const windows = { skip: process.platform !== 'win32' };

test('integration diagnostics distinguish an in-flight command and a verified nonzero Windows exit', windows, async t => {
  const f = await fixture(t);
  const trace = traceContainedFixture(t, f.workspaces);
  const diagnostics = integrationWaitDiagnostics(f, f.goal.id, trace);
  const release = path.join(f.root, 'private-release-gate');
  const reached = path.join(f.root, 'private-process-started');
  const receipt = path.join(f.root, 'private-receipt.json');
  const privateOutput = 'private fixture command output';
  const script = "const [release, reached, message] = process.argv.slice(1); const fs = require('node:fs'); "
    + "process.stdout.write(message); fs.writeFileSync(reached, ''); "
    + "setInterval(() => { if (fs.existsSync(release)) process.exit(7); }, 10);";
  const command = f.workspaces.runIntegrationCommand(process.execPath, ['-e', script, release, reached, privateOutput], f.source,
    { cleanupReceipt: receipt, timeout: 20000 });
  command.catch(() => {});
  try {
    await until(() => access(reached).then(() => true, () => false), 15000, diagnostics);
    await assert.rejects(until(() => false, 30, diagnostics), error => {
      assert.match(error.message, /awaiting-native-result|running-or-awaiting-native-cleanup/);
      assert.match(error.message, /"source":"windows-job"/);
      assert.equal(error.message.includes(f.root) || error.message.includes(privateOutput) || error.message.includes(script), false);
      return true;
    });
  } finally {
    await writeFile(release, '');
    await command.catch(() => {});
  }
  const result = await command;
  assert.equal(result.code, 7);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal((await readCommandCleanup(receipt))?.exitCode, 7);
  assert.equal(result.stdout.includes(privateOutput), true);
  const observed = (await diagnostics()).trace.recent.find(entry => entry.operation === 'project-check');
  assert.ok(Number.isSafeInteger(observed.commandMs) && observed.commandMs >= 30);
  assert.equal(observed.exitCode, 7);
  assert.equal(observed.nativeCleanup.exitCode, 7);
  assert.equal(observed.nativeCleanup.jobConfirmed, true);
  assert.equal(observed.nativeCleanup.supervisorExited, true);
  assert.equal(JSON.stringify(observed).includes(privateOutput) || JSON.stringify(observed).includes(f.root), false);
});

test('integration diagnostics distinguish native exit from a missing durable receipt across restart', windows, async t => {
  const f = await fixture(t);
  await gitProject(f);
  f.command('project.save', { id: f.project.id, autoMerge: false });
  const task = f.task();
  const trace = traceContainedFixture(t, f.workspaces);
  const diagnostics = integrationWaitDiagnostics(f, task.goalId, trace);
  const invoke = f.workspaces.runIntegrationCommand.bind(f.workspaces);
  let blockedReceipt;
  let configCalls = 0;
  f.workspaces.runIntegrationCommand = async (command, args, cwd, options) => {
    if (command === 'git' && args[0] === 'config') {
      configCalls++;
      if (!blockedReceipt) {
        blockedReceipt = options.cleanupReceipt;
        // Let Git and its supervisor finish. The directory blocks the native
        // and host atomic renames at the exact durable receipt destination.
        await mkdir(blockedReceipt);
      }
    }
    return invoke(command, args, cwd, options);
  };
  await f.start();
  await until(() => f.store.require('tasks', task.id).status === 'reconciling', 20000, diagnostics);
  await f.engine.integration;
  const before = await diagnostics();
  const command = before.trace.recent.find(entry => entry.operation === 'git:config');
  assert.equal(command.source, 'windows-job');
  assert.equal(command.stage, 'native-cleanup-returned');
  assert.equal(command.nativeCleanup.exitCode, 0);
  assert.equal(command.nativeCleanup.confirmed, true);
  assert.equal(command.cleanupUncertain, true);
  assert.equal(before.integrations[0].phase, 'reconciling');
  assert.deepEqual(before.receipts, [{ integrationId: before.integrations[0].id, kind: 'execution',
    checkpointMoved: false, confirmed: false, notStarted: false, exitCode: null }]);
  assert.equal(JSON.stringify(before).includes(blockedReceipt) || JSON.stringify(before).includes(f.root), false);

  await f.engine.stop();
  await trace.observe('engine-start-recovery', f.start);
  const recovered = await diagnostics();
  assert.equal(recovered.integrations[0].phase, 'reconciling');
  assert.deepEqual(recovered.receipts, before.receipts);
  assert.equal(recovered.tasks.find(row => row.id === task.id).recoveryHold, true);
  assert.equal(configCalls, 1);
  assert.equal(f.adapter.calls.filter(call => call.task.id === task.id).length, 1);
});
