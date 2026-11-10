import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePowerShellParams,
  extractPowerShellCommands,
  checkCommandParams,
  checkDocumentedParams,
  checkRelativeLinks,
  checkReferencedScripts,
  checkPauseSemantics,
  checkRepository,
} from '../scripts/docs-consistency.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const INSTALL_PS = `[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DataDirectory
)
`;

const UNINSTALL_PS = `[CmdletBinding()]
param(
  [string]$DshCommand = 'D:\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd',
  [string]$TargetProfile = 'desktop',
  [string]$DshHomePath = (Join-Path $env:USERPROFILE '.dsh')
)
`;

const OPERATIONS = `# 安装与运行

安装：

\`\`\`powershell
pwsh -File .\\scripts\\install.ps1 -TargetProfile desktop
\`\`\`

参数：\`-DshCommand\`、\`-TargetProfile\`、\`-DataDirectory\`。

## 暂停、停止与恢复

暂停公司阻止新派发；恢复调度只解除公司级暂停；单任务暂停只作用于指定任务；停止在途执行必须等清理确认。
无法确认清理时保持 reconciling 和资源占位。

\`\`\`powershell
pwsh -File .\\scripts\\uninstall.ps1 -TargetProfile desktop
\`\`\`

参数：\`-DshCommand\`、\`-TargetProfile\`、\`-DshHomePath\`。
`;

async function fixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acms-docs-'));
  const defaults = {
    'README.md': '# ACMS\n\n见 [运行说明](docs/operations.md)。\n',
    'scripts/install.ps1': INSTALL_PS,
    'scripts/uninstall.ps1': UNINSTALL_PS,
    'docs/operations.md': OPERATIONS,
  };
  for (const [name, body] of Object.entries({ ...defaults, ...files })) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
  }
  return root;
}

test('PowerShell param 解析支持带括号的默认值', () => {
  assert.deepEqual(parsePowerShellParams(INSTALL_PS), ['DshCommand', 'TargetProfile', 'DataDirectory']);
  assert.deepEqual(parsePowerShellParams(UNINSTALL_PS), ['DshCommand', 'TargetProfile', 'DshHomePath']);
});

test('命令参数提取在命令分隔符处停止', () => {
  const text = [
    'pwsh -File .\\scripts\\install.ps1 -TargetProfile desktop -DataDirectory data',
    'pwsh -File .\\scripts\\install.ps1 -TargetProfile desktop；node scripts/deploy-live.mjs -Live',
  ].join('\n');
  const commands = extractPowerShellCommands(text);
  assert.deepEqual(commands[0].params, ['TargetProfile', 'DataDirectory']);
  assert.deepEqual(commands[1].params, ['TargetProfile']);
});

test('text-evidence 摘录不当作可执行命令校验', () => {
  const text = [
    '```text-evidence',
    'pwsh -File .\\scripts\\install.ps1 -Bogus',
    '```',
    '',
    '```powershell',
    'pwsh -File .\\scripts\\install.ps1 -TargetProfile desktop',
    '```',
  ].join('\n');
  const commands = extractPowerShellCommands(text);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].params, ['TargetProfile']);
});

test('反引号续行的多行命令参数仍被校验', () => {
  const text = [
    '```powershell',
    'pwsh -File .\\scripts\\install.ps1 -TargetProfile desktop `',
    '  -BogusParam',
    '```',
  ].join('\n');
  const commands = extractPowerShellCommands(text);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].params, ['TargetProfile', 'BogusParam']);
});

test('脚本名大写时仍按 Windows 大小写不敏感校验参数', async () => {
  const root = await fixture({
    'docs/operations.md': `${OPERATIONS}\n\`\`\`powershell\npwsh -File .\\scripts\\Install.ps1 -BogusParam\n\`\`\`\n`,
  });
  try {
    const errors = await checkCommandParams(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /-BogusParam/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('仓库自身通过全部文档一致性检查', async () => {
  const { errors } = await checkRepository(repoRoot);
  assert.deepEqual(errors, []);
});

test('未声明的命令参数被报告，并带文件行号', async () => {
  const root = await fixture({
    'docs/operations.md': `${OPERATIONS}\n\`\`\`powershell\npwsh -File .\\scripts\\uninstall.ps1 -TargetProfile desktop -RemoveCodexProvider\n\`\`\`\n`,
  });
  try {
    const errors = await checkCommandParams(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /docs\/operations\.md:\d+/);
    assert.match(errors[0], /-RemoveCodexProvider/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('脚本参数未写入运行说明时失败', async () => {
  const root = await fixture({
    'docs/operations.md': OPERATIONS.replace('、`-DataDirectory`', ''),
  });
  try {
    const errors = await checkDocumentedParams(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /-DataDirectory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('失效相对链接被报告，有效链接通过', async () => {
  const root = await fixture({
    'docs/operations.md': `${OPERATIONS}\n[缺失](missing.md)\n`,
    'README.md': '# ACMS\n\n见 [运行说明](docs/operations.md)。\n',
  });
  try {
    const errors = await checkRelativeLinks(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /missing\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('引用不存在的 scripts 路径被报告', async () => {
  const root = await fixture({
    'docs/operations.md': `${OPERATIONS}\n运行 \`node scripts/deploy-live.mjs desktop\`。\n`,
  });
  try {
    const errors = await checkReferencedScripts(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /scripts\/deploy-live\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('暂停章节缺少动作标签时失败', async () => {
  const errors = checkPauseSemantics(OPERATIONS.replace('单任务暂停只作用于指定任务；', ''));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /单任务暂停/);
});

test('缺少暂停章节本身也被报告', () => {
  const errors = checkPauseSemantics('# 运行\n\n只有普通说明。\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /缺少“暂停、停止与恢复”章节/);
});
