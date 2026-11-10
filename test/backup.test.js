import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, utimes, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = name => path.join(repoRoot, 'scripts', name);
const run = (name, args, cwd) => spawnSync(process.execPath, [script(name), ...args], { cwd: cwd ?? repoRoot, encoding: 'utf8' });
const put = async (root, relative, bytes) => { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return target; };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'acms-backup-test-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, 'company.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE entities (collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(collection,id));`);
  const insert = database.prepare('INSERT INTO entities VALUES (?,?,?,?)');
  insert.run('tasks', 'task_active', 1, JSON.stringify({ id: 'task_active', status: 'running', workspace: {
    path: path.join(dataDir, 'workspaces', 'task_active'), source: path.join(root, 'source'), branch: 'acms/task_active', baseCommit: 'a'.repeat(40),
    collaboration: { index: '.acms/context.json' } } }));
  insert.run('tasks', 'task_legacy_noid', 1, JSON.stringify({ status: 'running', workspace: { path: path.join(dataDir, 'workspaces', 'task_legacy_noid') } }));
  insert.run('tasks', 'task_done', 1, JSON.stringify({ id: 'task_done', status: 'succeeded', workspace: { path: path.join(dataDir, 'workspaces', 'task_done') } }));
  insert.run('tasks', 'task_integrating', 1, JSON.stringify({ id: 'task_integrating', status: 'integrating', workspace: { path: path.join(dataDir, 'workspaces', 'task_integrating') } }));
  insert.run('attempts', 'attempt_live', 1, JSON.stringify({ id: 'attempt_live', taskId: 'task_active', status: 'running' }));
  insert.run('integrations', 'integration_pending', 1, JSON.stringify({ id: 'integration_pending', taskId: 'task_integrating', phase: 'checking' }));
  insert.run('artifacts', 'artifact_old', 1, JSON.stringify({ id: 'artifact_old', taskId: 'task_done', blob: path.join(dataDir, 'artifacts', 'blob_binary'), path: '交付/文件.bin' }));
  database.close();
  await put(dataDir, 'artifacts/blob_binary', Buffer.from([0, 255, 1, 2]));
  await put(dataDir, 'workspaces/task_active/notes.md', 'active work');
  await put(dataDir, 'workspaces/task_legacy_noid/notes.md', 'legacy active work');
  await put(dataDir, 'workspaces/task_integrating/plan.md', 'integrating work');
  await put(dataDir, 'workspaces/task_done/result.md', 'done work');
  await put(dataDir, 'workspaces/task_done/node_modules/pkg/index.js', 'rebuildable');
  await put(dataDir, 'workspaces/task_done/.git/HEAD', 'ref: refs/heads/main');
  await put(dataDir, 'workspaces/task_gitfile/.git', 'gitdir: D:/source/.git/worktrees/task_gitfile');
  await put(dataDir, 'reviews/review_1/file.txt', 'review copy');
  await put(dataDir, 'integration/integration_pending/file.txt', 'pending integration');
  await put(dataDir, 'integration/integration_done/file.txt', 'old integration');
  await put(dataDir, 'diagnostics/probe/report.json', '{"status":"ok"}');
  await put(dataDir, 'pairing/runner.json', '{"command":"secret-runner"}');
  await put(dataDir, 'conversations/chat/message.json', '{"text":"private"}');
  await put(dataDir, 'legacy/legacy_old/company.db', 'historical backup bytes');
  await put(dataDir, 'workspaces/task_done/project/company.db', 'delivered database');
  await put(dataDir, 'company.db-wal', 'wal');
  await put(dataDir, 'company.db-shm', 'shm');
  return { root, dataDir, databasePath };
}

test('备份计划区分必需材料与可重建/敏感目录，并显示范围与空间', async t => {
  const f = await fixture();
  try {
    const result = run('backup.mjs', ['--data-dir', f.dataDir, '--out', path.join(f.root, 'backup'), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    const paths = plan.files.map(file => file.path);
    assert.ok(paths.includes('artifacts/blob_binary'));
    assert.ok(paths.includes('conversations/chat/message.json'));
    assert.ok(paths.includes('workspaces/task_active/notes.md'));
    assert.ok(paths.includes('legacy/legacy_old/company.db'), 'historical nested database must be backed up');
    assert.ok(paths.includes('workspaces/task_done/project/company.db'), 'nested delivered database must be backed up');
    assert.ok(paths.includes('workspaces/task_gitfile/.git'), 'worktree git pointer must be preserved');
    assert.ok(!paths.some(file => file.startsWith('pairing/')));
    assert.ok(!paths.some(file => file.includes('node_modules')));
    assert.ok(!paths.some(file => file.includes('.git/')));
    assert.ok(!paths.includes('company.db-wal'));
    const excluded = new Map(plan.excluded.map(item => [item.path, item]));
    assert.ok(excluded.has('pairing'));
    assert.ok(excluded.has('diagnostics'));
    assert.ok(excluded.has('workspaces/task_done/node_modules'));
    assert.ok(excluded.has('workspaces/task_done/.git'));
    assert.ok(!excluded.has('workspaces/task_gitfile/.git'));
    assert.ok(excluded.has('company.db'));
    assert.ok(excluded.has('company.db-wal'));
    assert.ok(plan.warnings.some(warning => warning.includes('pairing')));
    assert.ok(plan.warnings.some(warning => warning.includes('conversations')));
    assert.equal(plan.space.sufficient, true);
    assert.ok(plan.database.estimatedBytes >= plan.database.sourceBytes);
    assert.ok(plan.space.requiredBytes >= plan.database.estimatedBytes);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('应用备份生成一致性数据库、清单与全量校验，篡改或隐藏额外文件后失败', async t => {
  const f = await fixture();
  try {
    const backup = path.join(f.root, 'backup');
    const applied = run('backup.mjs', ['--data-dir', f.dataDir, '--out', backup, '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).verified, true);
    const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'acms-backup/1');
    assert.ok(manifest.files.some(file => file.path === 'legacy/legacy_old/company.db'));
    assert.equal((await readFile(path.join(backup, 'legacy', 'legacy_old', 'company.db'))).toString(), 'historical backup bytes');
    assert.equal(run('backup.mjs', ['--verify', backup, '--json']).status, 0);

    await put(backup, 'node_modules/evil.js', 'hidden extra');
    await put(backup, 'legacy/extra/company.db', 'hidden extra database');
    const hidden = run('backup.mjs', ['--verify', backup, '--json']);
    assert.equal(hidden.status, 1);
    assert.ok(JSON.parse(hidden.stdout).errors.some(error => error.includes('unexpected file')));

    await rm(path.join(backup, 'node_modules'), { recursive: true, force: true });
    await rm(path.join(backup, 'legacy', 'extra'), { recursive: true, force: true });
    await writeFile(path.join(backup, 'artifacts', 'blob_binary'), Buffer.from([9, 9, 9]));
    const tampered = run('backup.mjs', ['--verify', backup, '--json']);
    assert.equal(tampered.status, 1);
    assert.equal(JSON.parse(tampered.stdout).ok, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('恢复到空目录可复现数据并把旧 dataDir 引用改写为新目录', async t => {
  const f = await fixture();
  try {
    const backup = path.join(f.root, 'backup');
    assert.equal(run('backup.mjs', ['--data-dir', f.dataDir, '--out', backup, '--apply', '--json']).status, 0);
    const target = path.join(f.root, 'restored');
    // Running from the old data directory must not rewrite relative fields.
    const restored = run('restore-backup.mjs', ['--backup', backup, '--target', target, '--json'], f.dataDir);
    assert.equal(restored.status, 0, restored.stderr);
    const result = JSON.parse(restored.stdout);
    assert.equal(result.ok, true);
    assert.ok(result.rewrittenPaths >= 3);
    assert.deepEqual(await readFile(path.join(target, 'artifacts', 'blob_binary')), Buffer.from([0, 255, 1, 2]));
    const database = new DatabaseSync(path.join(target, 'company.db'), { readOnly: true });
    try {
      const workspace = JSON.parse(database.prepare("SELECT body FROM entities WHERE collection='tasks' AND id='task_active'").get().body).workspace;
      assert.ok(workspace.path.startsWith(target), 'workspace path was rewritten');
      assert.equal(workspace.branch, 'acms/task_active');
      assert.equal(workspace.baseCommit, 'a'.repeat(40));
      assert.equal(workspace.collaboration.index, '.acms/context.json');
      const artifact = JSON.parse(database.prepare("SELECT body FROM entities WHERE collection='artifacts' AND id='artifact_old'").get().body);
      assert.ok(artifact.blob.startsWith(target), 'artifact blob path was rewritten');
      assert.equal(artifact.path, '交付/文件.bin');
    } finally { database.close(); }
    const rebuild = await readFile(path.join(target, 'REBUILD.md'), 'utf8');
    assert.match(rebuild, /pairing/);
    assert.match(rebuild, /rewritten/);
    assert.match(rebuild, /reconciling/);
    assert.ok(!(await exists(path.join(target, 'pairing'))));
    assert.equal(run('backup.mjs', ['--verify', target, '--json']).status, 0);

    const second = run('restore-backup.mjs', ['--backup', backup, '--target', target, '--json']);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /not empty/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('crafted manifest 的数据库路径不能穿越备份目录', async t => {
  const f = await fixture();
  try {
    const backup = path.join(f.root, 'backup');
    assert.equal(run('backup.mjs', ['--data-dir', f.dataDir, '--out', backup, '--apply', '--json']).status, 0);
    const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json'), 'utf8'));
    const escapePath = path.join(f.root, 'escape.db');
    await writeFile(escapePath, await readFile(path.join(backup, 'company.db')));
    const before = await readFile(escapePath);
    manifest.database.file = '../escape.db';
    await writeFile(path.join(backup, 'backup-manifest.json'), JSON.stringify(manifest, null, 2));
    const verified = run('backup.mjs', ['--verify', backup, '--json']);
    assert.equal(verified.status, 1);
    assert.ok(JSON.parse(verified.stdout).errors.some(error => error.includes('database.file')));
    const target = path.join(f.root, 'escaped-restore');
    const restored = run('restore-backup.mjs', ['--backup', backup, '--target', target, '--json']);
    assert.equal(restored.status, 1);
    assert.deepEqual(await readFile(escapePath), before, 'outside database must not be rewritten');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function ageTree(target, when) {
  await utimes(target, when, when);
  const stat = await lstat(target);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(target)) await ageTree(path.join(target, entry), when);
}

test('保留 dry-run 列出过期副本并保护活跃任务与在途集成', async t => {
  const f = await fixture();
  try {
    const old = new Date(Date.now() - 10 * 86400000);
    for (const relative of ['workspaces/task_active', 'workspaces/task_legacy_noid', 'workspaces/task_done', 'workspaces/task_integrating', 'reviews/review_1', 'integration/integration_pending', 'integration/integration_done', 'diagnostics/probe']) {
      await ageTree(path.join(f.dataDir, relative), old);
    }
    const result = run('prune-data.mjs', ['--data-dir', f.dataDir, '--days', '1', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    const candidates = plan.candidates.map(item => item.path);
    assert.ok(candidates.includes('workspaces/task_done'));
    assert.ok(candidates.includes('reviews/review_1'));
    assert.ok(candidates.includes('integration/integration_done'));
    assert.ok(!candidates.includes('workspaces/task_active'));
    assert.ok(!candidates.includes('integration/integration_pending'));
    assert.ok(plan.protected.some(item => item.path === 'workspaces/task_active'));
    assert.ok(plan.protected.some(item => item.path === 'workspaces/task_legacy_noid'));
    assert.ok(plan.protected.some(item => item.path === 'integration/integration_pending' && item.reason.includes('集成')));
    assert.match(plan.note, /Dry-run only/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('WAL 快照计入空间计划，缺值参数被拒绝', async t => {
  const f = await fixture();
  try {
    const walDatabase = new DatabaseSync(f.databasePath);
    walDatabase.exec('PRAGMA journal_mode=WAL;');
    const insert = walDatabase.prepare('INSERT INTO entities VALUES (?,?,?,?)');
    for (let index = 0; index < 2000; index += 1) insert.run('tasks', 'wal_' + index, 1, JSON.stringify({ id: 'wal_' + index, status: 'succeeded', text: 'x'.repeat(200) }));
    const planResult = run('backup.mjs', ['--data-dir', f.dataDir, '--out', path.join(f.root, 'backup-wal'), '--json']);
    assert.equal(planResult.status, 0, planResult.stderr);
    const plan = JSON.parse(planResult.stdout);
    assert.ok(plan.database.walBytes > 0);
    assert.ok(plan.database.estimatedBytes >= plan.database.sourceBytes + plan.database.walBytes);
    assert.ok(plan.space.requiredBytes >= plan.database.estimatedBytes);
    const applied = run('backup.mjs', ['--data-dir', f.dataDir, '--out', path.join(f.root, 'backup-wal'), '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const snapshot = JSON.parse(applied.stdout);
    assert.ok(snapshot.database.bytes <= plan.database.estimatedBytes, 'snapshot stays within the planned bound');
    assert.equal(run('backup.mjs', ['--verify', path.join(f.root, 'backup-wal'), '--json']).status, 0);
    walDatabase.close();

    const missing = run('backup.mjs', ['--data-dir']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /requires a value/);
    const missingVerify = run('backup.mjs', ['--data-dir', f.dataDir, '--verify']);
    assert.equal(missingVerify.status, 1);
    assert.match(missingVerify.stderr, /requires a value/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('显式包含 pairing 时备份与恢复都会保留，并在恢复说明中标注', async t => {
  const f = await fixture();
  try {
    const backup = path.join(f.root, 'backup-pairing');
    assert.equal(run('backup.mjs', ['--data-dir', f.dataDir, '--out', backup, '--include-pairing', '--apply', '--json']).status, 0);
    assert.equal((await readFile(path.join(backup, 'pairing', 'runner.json'))).toString(), '{"command":"secret-runner"}');
    const target = path.join(f.root, 'restored-pairing');
    const restored = run('restore-backup.mjs', ['--backup', backup, '--target', target, '--json']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal((await readFile(path.join(target, 'pairing', 'runner.json'))).toString(), '{"command":"secret-runner"}');
    const rebuild = await readFile(path.join(target, 'REBUILD.md'), 'utf8');
    assert.match(rebuild, /pairing files were included/);
    assert.doesNotMatch(rebuild, /pairings were excluded/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function exists(target) { try { await lstat(target); return true; } catch { return false; } }
