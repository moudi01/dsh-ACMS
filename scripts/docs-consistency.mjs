#!/usr/bin/env node
// Documentation consistency checks for ACMS.
// The checks are intentionally dependency-free so they run in CI and tests.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const PS_REF_RE = /scripts[\\/]([A-Za-z0-9_.-]+\.ps1)\b/g;
const PATH_REF_RE = /scripts[\\/]([A-Za-z0-9_.-]+\.(?:ps1|mjs|cjs|js))\b/g;
const ARG_SEPARATOR_RE = /[;；|&]/;
const EVIDENCE_FENCE = 'text-evidence';
const PAUSE_HEADING_RE = /^##\s+.*暂停.*停止/;
const PAUSE_TERMS = ['暂停公司', '恢复调度', '单任务暂停', '停止在途执行', '清理', 'reconciling'];

const toPosix = value => value.split(path.sep).join('/');
const isFence = line => /^\s*```/.test(line);
// A PowerShell continuation uses a backtick preceded by whitespace. Requiring
// that separator avoids mistaking an inline-code line that ends with a
// closing backtick for a continuation.
const isContinuation = line => !isFence(line) && /[ \t]`\s*$/.test(line);

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readMarkdownDocs(root) {
  const files = [path.join(root, 'README.md')];
  const docsDir = path.join(root, 'docs');
  for (const name of (await readdir(docsDir)).sort()) {
    if (name.endsWith('.md')) files.push(path.join(docsDir, name));
  }
  return files;
}

// PowerShell declares parameters inside `param(...)`. Defaults may contain
// parentheses, so the block is located by balancing instead of a regex.
export function parsePowerShellParams(text) {
  const start = text.search(/\bparam\s*\(/);
  if (start < 0) return [];
  const open = text.indexOf('(', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const block = text.slice(open, end + 1);
  return [...block.matchAll(/\[[^\]\n]*\]\s*\$([A-Za-z_][A-Za-z0-9_]*)/g)].map(match => match[1]);
}

// Merge PowerShell backtick continuations so a parameter on the next physical
// line is still associated with the command. Reported line numbers point at the
// first physical line of the command.
function logicalLines(text) {
  const raw = text.split(/\r?\n/);
  const merged = [];
  for (let index = 0; index < raw.length; index += 1) {
    let current = raw[index];
    // Never merge a fence delimiter, and never consume the line that starts a
    // fence, so the fence state stays aligned with the physical document.
    while (isContinuation(current) && index + 1 < raw.length && !isFence(raw[index + 1])) {
      current = current.replace(/[ \t]`\s*$/, ' ') + raw[index + 1];
      index += 1;
    }
    merged.push({ line: index + 1, text: current });
  }
  return merged;
}

// Returns every documented invocation of a scripts/*.ps1 file and the
// `-Switch` tokens that follow it on the same command line. Fenced excerpts
// marked `text-evidence` are quoted evidence, not runnable instructions, so
// their contents are not parsed as invocations.
export function extractPowerShellCommands(text) {
  const commands = [];
  let fence = null;
  for (const { line, text: current } of logicalLines(text)) {
    const fenceMatch = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/.exec(current);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1].toLowerCase() : null;
      continue;
    }
    if (fence === EVIDENCE_FENCE) continue;
    const reference = new RegExp(PS_REF_RE.source, 'g');
    let match;
    while ((match = reference.exec(current))) {
      let tail = current.slice(match.index + match[0].length);
      const cut = tail.search(ARG_SEPARATOR_RE);
      if (cut >= 0) tail = tail.slice(0, cut);
      const params = [...tail.matchAll(/(?:^|\s)-([A-Za-z][A-Za-z0-9_]*)\b/g)].map(item => item[1]);
      commands.push({ line, script: match[1], params });
    }
  }
  return commands;
}

async function scriptParams(root) {
  const dir = path.join(root, 'scripts');
  const declared = new Map();
  for (const name of (await readdir(dir)).sort()) {
    if (!name.endsWith('.ps1')) continue;
    declared.set(name, parsePowerShellParams(await readFile(path.join(dir, name), 'utf8')));
  }
  return declared;
}

export async function checkCommandParams(root) {
  const errors = [];
  const declared = await scriptParams(root);
  for (const file of await readMarkdownDocs(root)) {
    const relative = toPosix(path.relative(root, file));
    const text = await readFile(file, 'utf8');
    for (const command of extractPowerShellCommands(text)) {
      // Windows paths are case-insensitive, so resolve script names the same way.
      const params = declared.get(command.script)
        ?? [...declared.entries()].find(([name]) => name.toLowerCase() === command.script.toLowerCase())?.[1];
      if (!params) continue; // Missing script files are reported by checkReferencedScripts.
      for (const param of command.params) {
        if (!params.includes(param)) {
          errors.push(`${relative}:${command.line}: scripts/${command.script} 未声明参数 -${param}`);
        }
      }
    }
  }
  return errors;
}

// Every user-facing parameter of a documented script must be described in the
// operations document, otherwise adding a parameter silently drifts the docs.
export async function checkDocumentedParams(root) {
  const errors = [];
  const operations = await readFile(path.join(root, 'docs', 'operations.md'), 'utf8');
  for (const [name, params] of (await scriptParams(root)).entries()) {
    for (const param of params) {
      const mentioned = new RegExp(`(^|[^\\w-])-${param}(?![\\w-])`, 'm').test(operations);
      if (!mentioned) errors.push(`docs/operations.md: 未记录 scripts/${name} 的参数 -${param}`);
    }
  }
  return errors;
}

export async function checkRelativeLinks(root) {
  const errors = [];
  for (const file of await readMarkdownDocs(root)) {
    const relative = toPosix(path.relative(root, file));
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    let fenced = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const links = new RegExp(LINK_RE.source, 'g');
      let match;
      while ((match = links.exec(line))) {
        const raw = match[1];
        if (/^(https?:|mailto:|#)/i.test(raw) || raw.includes('://')) continue;
        if (/[<>{}]/.test(raw)) continue; // Placeholders are not link targets.
        const target = raw.replace(/#.*$/, '').trim();
        if (!target) continue;
        const resolved = path.resolve(path.dirname(file), target);
        if (!(await exists(resolved))) {
          errors.push(`${relative}:${index + 1}: 相对链接目标不存在 ${raw}`);
        }
      }
    }
  }
  return errors;
}

// Any scripts/<file> referenced from documentation must exist. This catches
// commands that point at deleted or renamed helper scripts.
export async function checkReferencedScripts(root) {
  const errors = [];
  for (const file of await readMarkdownDocs(root)) {
    const relative = toPosix(path.relative(root, file));
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const references = new RegExp(PATH_REF_RE.source, 'g');
      let match;
      while ((match = references.exec(lines[index]))) {
        if (!(await exists(path.join(root, 'scripts', match[1])))) {
          errors.push(`${relative}:${index + 1}: 引用的脚本不存在 scripts/${match[1]}`);
        }
      }
    }
  }
  return errors;
}

// Issue #10 requires the four pause/stop actions to be described as distinct
// operations, together with cleanup confirmation and reconciling semantics.
export function checkPauseSemantics(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => PAUSE_HEADING_RE.test(line));
  if (start < 0) return ['docs/operations.md: 缺少“暂停、停止与恢复”章节'];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start, end).join('\n');
  return PAUSE_TERMS.filter(term => !section.includes(term))
    .map(term => `docs/operations.md: 暂停章节缺少“${term}”说明`);
}

export async function checkRepository(root = process.cwd()) {
  const operations = await readFile(path.join(root, 'docs', 'operations.md'), 'utf8');
  const errors = [
    ...await checkCommandParams(root),
    ...await checkDocumentedParams(root),
    ...await checkRelativeLinks(root),
    ...await checkReferencedScripts(root),
    ...checkPauseSemantics(operations),
  ];
  return { errors, ok: errors.length === 0 };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const { errors } = await checkRepository();
  if (errors.length) {
    console.error(`文档一致性检查失败：${errors.length} 项`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log('文档一致性检查通过：命令参数、脚本引用、相对链接与暂停语义一致。');
}
