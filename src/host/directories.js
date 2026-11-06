import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assert } from '../core/util.js';
import { inside } from '../runtime/workspaces.js';

export async function browseDirectories(requested, policy) {
  const configured = policy.allowedProjectRoots;
  const candidates = configured.length ? configured : process.platform === 'win32' ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`) : ['/'];
  const roots = (await Promise.all(candidates.map(p => fs.realpath(p).catch(() => null)))).filter(Boolean);
  if (!requested) return { path: '', parent: null, directories: roots.map(p => ({ name: p, path: p })) };
  assert(path.isAbsolute(requested), 'DIRECTORY_PATH', '请输入完整的绝对目录路径');
  const target = await fs.realpath(requested);
  assert(roots.some(root => inside(root, target)), 'PROJECT_PATH_DENIED', '目录不在公司允许的项目范围内');
  const entries = await fs.readdir(target, { withFileTypes: true });
  const directories = entries.filter(e => e.isDirectory()).map(e => ({ name: e.name, path: path.join(target, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent !== target && roots.some(root => inside(root, parent)) ? parent : '', directories };
}
