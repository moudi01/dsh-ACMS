import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = name => path.join(repoRoot, 'scripts', name);
const run = (name, args) => spawnSync(process.execPath, [script(name), ...args], { cwd: repoRoot, encoding: 'utf8' });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'acms-backup-test-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const database = new DatabaseSync(path.join(dataDir, 'company.db'));
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE entities (collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(collection,id));`);
  const insert = database.prepare('INSERT INTO entities VALUES (?,?,?,?)');
  insert.run('tasks', 'task_active', 1, JSON.stringify({ id: 'task_active', status: 'running', workspace: { path: path.join(dataDir, 'workspaces', 'task_active') } }));
  insert.run('tasks', 'task_done', 1, JSON.stringify({ id: 'task_done', status: 'succeeded', workspace: { path: path.join(dataDir, 'workspaces', 'task_done') } }));
  insert.run('attempts', 'attempt_live', 1, JSON.stringify({ id: 'attempt_live', taskId: 'task_active', status: 'running' }));
  database.close();
  const put = async (relative, bytes) => { const target = path.join(dataDir, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes); return target; };
  await put('artifacts/blob_binary', Buffer.from([0, 255, 1, 2]));
  await put('workspaces/task_active/notes.md', 'active work');
  await put('workspaces/task_done/result.md', 'done work');
  await put('workspaces/task_done/node_modules/pkg/index.js', 'rebuildable');
  await put('workspaces/task_done/.git/HEAD', 'ref: refs/heads/main');
  await put('reviews/review_1/file.txt', 'review copy');
  await put('integration/candidate/file.txt', 'candidate');
  await put('diagnostics/probe/report.json', '{"status":"ok"}');
  await put('pairing/runner.json', '{"command":"secret-runner"}');
  await put('conversations/chat/message.json', '{"text":"private"}');
  await put('company.db-wal', 'wal');
  await put('company.db-shm', 'shm');
  return { root, dataDir };
}

test('备份计划区分必需材料与可重建/敏感目录，并显示范围与空间', async t => {
  const f = await fixture();
  try {
    const result = run('backup.mjs', ['--data-dir', f.dataDir, '--out', path.join(f.root, 'backup'), '--json']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.mode, 'plan');
    assert.equal(plan.format, 'acms-backup/1');
    const paths = plan.files.map(file => file.path);
    assert.ok(paths.includes('artifacts/blob_binary'));
    assert.ok(paths.includes('conversations/chat/message.json'));
    assert.ok(paths.includes('workspaces/task_active/notes.md'));
    assert.ok(!paths.some(file => file.startsWith('pairing/')));
    assert.ok(!paths.some(file => file.includes('node_modules')));
    assert.ok(!paths.some(file => file.includes('.git/')));
    assert.ok(!paths.includes('company.db-wal'));
    const excluded = new Map(plan.excluded.map(item => [item.path, item]));
    assert.ok(excluded.has('pairing'));
    assert.ok(excluded.has('diagnostics'));
    assert.ok(excluded.has('workspaces/task_done/node_modules'));
    assert.ok(excluded.has('workspaces/task_done/.git'));
    assert.ok(excluded.has('company.db-wal'));
    assert.ok(plan.totals.files >= 6);
    assert.ok(plan.totals.bytes > 0);
    assert.ok(plan.warnings.some(warning => warning.includes('pairing')));
    assert.ok(plan.warnings.some(warning => warning.includes('conversations')));
    assert.equal(plan.space.sufficient, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('应用备份生成一致性数据库、清单与校验，篡改后校验失败', async t => {
  const f = await fixture();
  try {
    const backup = path.join(f.root, 'backup');
    const applied = run('backup.mjs', ['--data-dir', f.dataDir, '--out', backup, '--apply', '--json']);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.verified, true);
    const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json'), 'utf8'));
    assert.equal(manifest.format, 'acms-backup/1');
    assert.ok(manifest.database.sha256.match(/^[0-9a-f]{64}$/));
    assert.ok(manifest.files.every(file => file.sha256.match(/^[0-9a-f]{64}$/)));
    assert.ok(manifest.files.some(file => file.path === 'artifacts/blob_binary' && file.sha256));
    const verified = run('backup.mjs', ['--verify', backup, '--json']);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).ok, true);

    await writeFile(path.join(backup, 'artifacts', 'blob_binary'), Buffer.from([9, 9, 9]));
    const tampered = run('backup.mjs', ['--verify', backup, '--json']);
    assert.equal(tampered.status, 1);
    assert.equal(JSON.parse(tampered.stdout).ok, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('恢复到空目录可复现数据库与产物，并写明被排除材料的重建方法', async t => {
  const f = await fixture();
  try {
    const backup = path.join(f.root, 'backup');
    assert.equal(run('backup.mjs', ['--data-dir', f.dataDir, '--out', backup, '--apply', '--json']).status, 0);
    const target = path.join(f.root, 'restored');
    const restored = run('restore-backup.mjs', ['--backup', backup, '--target', target, '--json']);
    assert.equal(restored.status, 0, restored.stderr);
    const result = JSON.parse(restored.stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(await readFile(path.join(target, 'artifacts', 'blob_binary')), Buffer.from([0, 255, 1, 2]));
    assert.ok((await lstat(path.join(target, 'company.db'))).size > 0);
    const rebuild = await readFile(path.join(target, 'REBUILD.md'), 'utf8');
    assert.match(rebuild, /pairing/);
    assert.match(rebuild, /reconciling/);
    assert.ok(!(await exists(path.join(target, 'pairing'))));
    const verified = run('backup.mjs', ['--verify', target, '--json']);
    assert.equal(verified.status, 0, verified.stderr);

    const second = run('restore-backup.mjs', ['--backup', backup, '--target', target, '--json']);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /not empty/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('保留 dry-run 列出过期副本并保护活跃任务', async t => {
  const f = await fixture();
  try {
    const old = new Date(Date.now() - 5 * 86400000);
    for (const relative of ['workspaces/task_active', 'workspaces/task_done', 'reviews/review_1', 'integration/candidate', 'diagnostics/probe']) {
      const target = path.join(f.dataDir, relative);
      const stat = await lstat(target);
      await utimes(target, old, old);
      if (stat.isDirectory()) {
        for (const entry of await readdir(target)) { const child = path.join(target, entry); await utimes(child, old, old); }
      }
    }
    const result = run('prune-data.mjs', ['--data-dir', f.dataDir, '--days', '1', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    const candidates = plan.candidates.map(item => item.path);
    assert.ok(candidates.includes('workspaces/task_done'));
    assert.ok(candidates.includes('reviews/review_1'));
    assert.ok(candidates.includes('integration/candidate'));
    assert.ok(!candidates.includes('workspaces/task_active'));
    assert.ok(plan.protected.some(item => item.path === 'workspaces/task_active' && item.reason.includes('引用')));
    assert.match(plan.note, /Dry-run only/);
    assert.ok(plan.totals.bytes > 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

async function exists(target) { try { await lstat(target); return true; } catch { return false; } }
async function readdir(target) { const { readdir } = await import('node:fs/promises'); return (await readdir(target)); }
