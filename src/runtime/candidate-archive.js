import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assert, digest } from '../core/util.js';
import { acceptedGoalComposition, COPY_COMPOSITION, finalGoalComposition } from '../core/composite-delivery.js';
import { ARCHIVE_LIMITS, ARCHIVE_FORMAT, byteSha256 } from './delivery-archive.js';
import { buildCandidateArchive, validateCandidateArchive } from './archive-validation.js';
import { checkoutCopyComposition } from './copy-composition.js';
import { checkoutComposition } from './git-composition.js';
import { removeTemporary } from './git-delivery.js';
import { inside, run } from './workspaces.js';

const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const absent = error => { if (error.code === 'ENOENT') return null; throw error; };

async function directory(root, name, create) {
  const folder = path.join(root, name);
  if (create) await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await fs.lstat(folder).catch(absent);
  if (!info) return null;
  assert(info.isDirectory() && await fs.realpath(folder) === folder, 'ARTIFACT_CORRUPT',
    '候选归档存储路径经过链接或不是目录，请核对数据目录。');
  return folder;
}

async function archiveStorage(dataDir, create) {
  const root = await fs.realpath(dataDir);
  const deliveries = await directory(root, 'deliveries', create);
  const archives = deliveries && await directory(deliveries, 'archives', create);
  assert(archives, 'ARTIFACT_MISSING', '候选尚未归档，请先生成交付归档。');
  return archives;
}

function currentFinal(company, selection) {
  const goal = company.store.get('goals', selection.goalId);
  assert(goal && goal.status !== 'deleted', 'NOT_FOUND', '未找到候选所属目标。');
  const candidate = acceptedGoalComposition(company.store, goal);
  const completed = finalGoalComposition(company, goal, candidate, company.deliveryHash(goal.id));
  assert(completed, 'COMPOSITE_NOT_VERIFIED', '请先完成当前候选的联合检查和模板要求的最终审查。');
  assert(completed.version === selection.version && completed.deliveryHash === selection.deliveryHash,
    'STALE_COMPOSITION', '目标交付版本已变化，请刷新并选择当前候选。');
  const evidence = evidenceFor({ goal, candidate, completed });
  const authority = evidence.mode === 'git' ? { mode: 'git', tree: candidate.tree }
    : { mode: 'copy', contentHash: candidate.contentHash };
  const key = digest({ evidence, authority });
  const maxBytes = Math.min(company.policy().maxArtifactBytes, ARCHIVE_LIMITS.archiveBytes);
  return { goal, candidate, completed, evidence, authority, key, maxBytes };
}

async function authorizedFinal(company, selection) {
  const state = currentFinal(company, selection);
  const roots = company.policy().allowedProjectRoots;
  if (roots.length) {
    const approved = await Promise.all(roots.map(root => fs.realpath(root).catch(() => null)));
    assert(digest(roots) === digest(company.policy().allowedProjectRoots), 'STALE_COMPOSITION', '项目目录授权已变化，请刷新并重试。');
    const source = state.goal.compositionBase?.source;
    assert(typeof source === 'string' && path.isAbsolute(source) && approved.some(root => root && inside(root, source)),
      'PROJECT_PATH_DENIED', '候选所属项目不在当前批准目录内。');
  }
  const fresh = currentFinal(company, selection);
  assert(fresh.key === state.key, 'STALE_COMPOSITION', '候选审查结果已变化，请刷新并重试。');
  return fresh;
}

function requestSelection(selection) {
  assert(typeof selection?.goalId === 'string' && selection.goalId.length <= 200 && selection.goalId &&
    isHash(selection.version) && isHash(selection.deliveryHash),
  'INVALID_INPUT', '请指定目标、候选版本和已完成交付指纹。');
  return selection;
}

function filenameFor(state) { return `acms-candidate-${state.candidate.version.slice(0, 12)}.zip`; }

async function readRegular(filename, limit, expectedBytes) {
  const info = await fs.lstat(filename).catch(absent);
  if (!info) return null;
  assert(info.isFile() && await fs.realpath(filename) === filename &&
    (expectedBytes === undefined || expectedBytes === info.size), 'ARTIFACT_CORRUPT',
  '候选归档存储中的文件类型、位置或大小与记录不符。请核对备份。');
  assert(info.size <= limit, 'ARTIFACT_TOO_LARGE', '候选归档超出当前公司或归档大小限制。');
  const bytes = await fs.readFile(filename);
  assert(bytes.length === info.size, 'ARTIFACT_CORRUPT', '候选归档读取时大小已变化。');
  return bytes;
}

async function readRecord(archives, state) {
  const bytes = await readRegular(path.join(archives, state.key + '.json'), 8192);
  if (!bytes) return null;
  let record;
  try { record = JSON.parse(bytes); } catch { /* Report the invalid record below. */ }
  assert(record?.format === ARCHIVE_FORMAT && record.key === state.key &&
    record.version === state.completed.version && record.deliveryHash === state.completed.deliveryHash &&
    record.contentHash === state.candidate.contentHash && record.filename === filenameFor(state) &&
    Number.isSafeInteger(record.bytes) && record.bytes > 0 && isHash(record.archiveSha256) && isHash(record.manifestSha256) &&
    Number.isSafeInteger(record.files) && record.files >= 0 && Number.isSafeInteger(record.directories) && record.directories >= 0,
  'ARTIFACT_CORRUPT', '持久候选归档记录无法核对，请从备份恢复。');
  return record;
}

async function readArchive(archives, state, record) {
  assert(record.bytes <= state.maxBytes, 'ARTIFACT_TOO_LARGE', '候选归档超出当前公司大小限制。');
  const bytes = await readRegular(path.join(archives, record.archiveSha256 + '.zip'), state.maxBytes, record.bytes);
  if (bytes) assert(byteSha256(bytes) === record.archiveSha256, 'ARTIFACT_CORRUPT', '候选归档摘要不一致，请从备份恢复。');
  return bytes;
}

async function verifyArchiveEvidence(bytes, state, record, signal) {
  const proof = await validateCandidateArchive(bytes, { authority: state.authority, signal });
  assert(proof.passed && proof.contentMatches && proof.manifestSha256 === record.manifestSha256 &&
    proof.files === record.files && proof.directories === record.directories &&
    digest(proof.candidate ?? null) === digest({ ...state.evidence, materialization: 'clean-directory' }),
  'ARTIFACT_CORRUPT', '归档清单与当前候选的交付证据不一致，请核对备份。');
}

function evidenceFor(state) {
  const { candidate, goal, completed } = state;
  return {
    goalId: goal.id, ...completed, mode: goal.deliveryMode === COPY_COMPOSITION ? 'copy' : 'git',
    contentHash: candidate.contentHash, ...(candidate.baseHash ? { baseHash: candidate.baseHash }
      : { baseCommit: candidate.baseCommit, tree: candidate.tree }),
    checks: candidate.checks.map(check => ({
      id: check.id, command: check.command ?? null, checkVersion: check.checkVersion ?? null, environment: check.environment ?? null,
      inputHash: check.inputHash ?? null, code: check.code ?? null, logSha256: check.log?.hash ?? null,
    })),
  };
}

async function linkOnce(from, to) {
  try { await fs.link(from, to); } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

async function stillCurrent(company, selection, state, bytes, signal) {
  signal?.throwIfAborted();
  const fresh = await authorizedFinal(company, selection);
  assert(fresh.key === state.key, 'STALE_COMPOSITION', '候选审查结果已变化，请刷新并重试。');
  assert(bytes <= fresh.maxBytes, 'ARTIFACT_TOO_LARGE', '候选归档超出当前公司大小限制。');
  signal?.throwIfAborted();
}

export async function prepareCandidateArchive(company, dataDir, input, signal) {
  signal?.throwIfAborted();
  const selection = requestSelection(input);
  const state = await authorizedFinal(company, selection);
  const archives = await archiveStorage(dataDir, true);
  const existing = await readRecord(archives, state);
  const archived = existing && await readArchive(archives, state, existing);
  if (archived) {
    await verifyArchiveEvidence(archived, state, existing, signal);
    await stillCurrent(company, selection, state, existing.bytes, signal);
    return existing;
  }
  const parent = await directory(await fs.realpath(dataDir), 'integration', true);
  const temporary = await fs.mkdtemp(path.join(parent, 'candidate-archive-'));
  try {
    const checkout = path.join(temporary, 'checkout');
    const { evidence } = state;
    const entries = evidence.mode === 'copy' ? await checkoutCopyComposition(state.candidate.snapshot, checkout, dataDir, signal)
      : await checkoutComposition(state.candidate, checkout, temporary, dataDir, run, signal);
    const built = await buildCandidateArchive({ root: checkout, entries: [...entries], mode: evidence.mode, evidence,
      authority: state.authority, maxBytes: state.maxBytes }, { signal });
    const { bytes, ...summary } = built;
    const record = { format: ARCHIVE_FORMAT, key: state.key, version: state.completed.version,
      deliveryHash: state.completed.deliveryHash, contentHash: state.candidate.contentHash, filename: filenameFor(state),
      bytes: bytes.length, ...summary };
    assert(!existing || digest(existing) === digest(record), 'ARTIFACT_CORRUPT', '重新生成的归档与已有记录不一致。请保留原记录并核对备份。');
    const staged = path.join(temporary, 'candidate.zip');
    const metadata = path.join(temporary, 'candidate.json');
    await fs.writeFile(staged, bytes, { flag: 'wx', flush: true });
    await fs.writeFile(metadata, JSON.stringify(record), { flag: 'wx', flush: true });
    await stillCurrent(company, selection, state, bytes.length, signal);
    await linkOnce(staged, path.join(archives, record.archiveSha256 + '.zip'));
    assert(await readArchive(archives, state, record), 'ARTIFACT_MISSING', '无法重新读取已生成的候选归档，请重试。');
    await stillCurrent(company, selection, state, bytes.length, signal);
    await linkOnce(metadata, path.join(archives, state.key + '.json'));
    const saved = await readRecord(archives, state);
    assert(saved && digest(saved) === digest(record), 'ARTIFACT_CORRUPT', '并发发布的候选归档与当前版本不一致。');
    await stillCurrent(company, selection, state, saved.bytes, signal);
    return saved;
  } finally { await removeTemporary(temporary, parent); }
}

export async function readCandidateArchive(company, dataDir, input, signal) {
  signal?.throwIfAborted();
  const selection = requestSelection(input);
  const state = await authorizedFinal(company, selection);
  const archives = await archiveStorage(dataDir, false);
  const record = await readRecord(archives, state);
  assert(record, 'ARTIFACT_MISSING', '候选尚未归档，请先生成交付归档。');
  assert(input.archiveSha256 === record.archiveSha256, 'STALE_COMPOSITION', '候选归档摘要已变化，请刷新并重新获取归档。');
  const bytes = await readArchive(archives, state, record);
  assert(bytes, 'ARTIFACT_MISSING', '候选归档文件缺失。请重新生成，或从备份恢复。');
  await verifyArchiveEvidence(bytes, state, record, signal);
  await stillCurrent(company, selection, state, bytes.length, signal);
  return { record, bytes };
}
