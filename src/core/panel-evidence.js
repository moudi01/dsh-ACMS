import { assert } from './util.js';

export const PANEL_EVIDENCE_INDEXES = `
  CREATE INDEX IF NOT EXISTS panel_artifacts_order ON entities(collection) WHERE collection='artifacts';
  CREATE INDEX IF NOT EXISTS panel_verifications_order ON entities(collection) WHERE collection='verifications';
  CREATE INDEX IF NOT EXISTS artifacts_by_task ON entities(json_extract(body,'$.taskId')) WHERE collection='artifacts';
  CREATE INDEX IF NOT EXISTS verifications_by_attempt ON entities(json_extract(body,'$.attemptId')) WHERE collection='verifications';
  CREATE INDEX IF NOT EXISTS tasks_by_project ON entities(json_extract(body,'$.projectId')) WHERE collection='tasks';
  CREATE INDEX IF NOT EXISTS goals_by_project ON entities(json_extract(body,'$.projectId')) WHERE collection='goals';
`;

const property = (alias, key) => `json_extract(${alias}.body,'$.${key}')`;
const visible = (alias, key) => `NOT EXISTS (
  SELECT 1 FROM entities AS hidden WHERE hidden.id=${property(alias, key)}
  AND hidden.collection='${key === 'goalId' ? 'goals' : 'projects'}'
  AND ${property('hidden', 'status')}='deleted'
)`;
const activeSubject = alias => `${property(alias, 'status')} IS NOT 'deleted' AND ${visible(alias, 'goalId')} AND ${visible(alias, 'projectId')}`;
const visibleOwner = alias => `NOT EXISTS (
  SELECT 1 FROM entities AS subject WHERE subject.id=${property(alias, 'taskId')}
  AND subject.collection IN ('tasks','goals') AND NOT (${activeSubject('subject')})
)`;
const visibleSubjects = alias => `${visibleOwner(alias)} AND ${visible(alias, 'goalId')} AND ${visible(alias, 'projectId')}`;

function unpackScope(store, params) {
  const keys = ['project', 'goal', 'task'].filter(kind => params.has(kind + 'Id'));
  assert(keys.length <= 1, 'INVALID_INPUT', '请选择一个证据范围。');
  const kind = keys[0] ?? 'all';
  const id = params.get(kind + 'Id');
  if (kind !== 'all') {
    assert(id && id.length <= 200, 'INVALID_INPUT', '无效的证据范围。');
    const subject = store.get(kind + 's', id);
    assert(subject && subject.status !== 'deleted' &&
      (!subject.goalId || store.get('goals', subject.goalId)?.status !== 'deleted') &&
      (!subject.projectId || store.get('projects', subject.projectId)?.status !== 'deleted'),
    'NOT_FOUND', '当前证据范围不可查看。');
  }
  return { kind, id };
}

function taskSubjects(kind) {
  const filter = kind === 'task' ? 't.id=$scope' :
    kind === 'all' ? '1' : `${property('t', kind + 'Id')}=$scope`;
  return `SELECT t.id FROM entities AS t WHERE t.collection='tasks' AND ${filter} AND ${activeSubject('t')}`;
}

function directSubjects(kind, verification) {
  if (!verification || kind === 'task') return 'SELECT id FROM tasks';
  const goals = kind === 'goal' ? 'SELECT $scope' : `SELECT g.id FROM entities AS g
    WHERE g.collection='goals' AND ${property('g', 'projectId')}=$scope AND ${property('g', 'status')} IS NOT 'deleted'`;
  return `SELECT id FROM tasks UNION ALL ${goals}`;
}

function artifactView(row, full = false) {
  const { id, taskId, attemptId, title, path, hash, bytes, textIntegrity, archiveVerification } = row;
  return { id, taskId, attemptId, title, path, hash, bytes,
    ...(full && textIntegrity ? { textIntegrity } : {}),
    ...(full && archiveVerification?.textDiagnostics ? { archiveVerification: { textDiagnostics: archiveVerification.textDiagnostics } } : {}) };
}

function storedRows(store, collection, { kind, id }, before, limit) {
  const verification = collection === 'verifications';
  const order = `e.rowid < $before AND ${visibleSubjects('e')}`;
  const decoded = `e.rowid AS position, e.body${verification ? `, ${property('a', 'taskId')} AS attemptTaskId` : ''}`;
  const attemptJoin = verification ? `LEFT JOIN entities AS a ON a.collection='attempts' AND a.id=${property('e', 'attemptId')}` : '';
  const where = verification ? `${order} AND (${property('e', 'taskId')} IS NOT NULL OR ${visibleOwner('a')})` : order;
  if (kind === 'all') return store.db.prepare(`SELECT ${decoded} FROM entities AS e INDEXED BY panel_${collection}_order ${attemptJoin}
    WHERE e.collection='${collection}' AND ${where} ORDER BY e.rowid DESC LIMIT $limit`).all({ $before: before, $limit: limit });

  const throughAttempt = verification ? `UNION SELECT e.rowid FROM tasks AS s
    CROSS JOIN entities AS a INDEXED BY attempts_usage_by_task
    CROSS JOIN entities AS e INDEXED BY verifications_by_attempt
    WHERE a.collection='attempts' AND ${property('a', 'taskId')}=s.id
    AND e.collection='verifications' AND ${property('e', 'attemptId')}=a.id AND ${order}` : '';
  return store.db.prepare(`WITH tasks AS (${taskSubjects(kind)}), matching(rowid) AS (
    SELECT e.rowid FROM (${directSubjects(kind, verification)}) AS s
    CROSS JOIN entities AS e INDEXED BY ${collection}_by_task WHERE e.collection='${collection}'
    AND ${property('e', 'taskId')}=s.id AND ${order}
    ${throughAttempt}
  ), page AS (SELECT rowid FROM matching ORDER BY rowid DESC LIMIT $limit)
  SELECT ${decoded} FROM page JOIN entities AS e ON e.rowid=page.rowid ${attemptJoin} ORDER BY page.rowid DESC`)
    .all({ $scope: id, $before: before, $limit: limit });
}

function taskArtifactCount(store, taskId) {
  return store.db.prepare(`SELECT count(*) AS total FROM entities AS e INDEXED BY artifacts_by_task
    WHERE e.collection='artifacts' AND ${property('e', 'taskId')}=?`).get(taskId).total;
}

export function panelEvidence(store, params) {
  const collection = params.get('kind');
  assert(collection === 'artifacts' || collection === 'verifications', 'INVALID_INPUT', '无效的证据类型。');
  const rawBefore = params.get('before');
  const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
  assert((rawBefore === null || /^\d+$/.test(rawBefore)) && Number.isSafeInteger(before) && before >= 1,
    'INVALID_INPUT', '无效的证据历史游标。');
  return store.readSnapshot(() => {
    const scope = unpackScope(store, params);
    const detail = scope.kind === 'task';
    const limit = collection === 'verifications' && detail ? 6 : 20;
    const page = storedRows(store, collection, scope, before, limit + 1);
    const rows = page.slice(0, limit).map(({ body, position, attemptTaskId }) => {
      const row = JSON.parse(body);
      if (collection === 'artifacts') return { ...artifactView(row, detail), position };
      const { id, taskId, goalId, attemptId, kind, passed, summary, checks } = row;
      return { id, taskId, goalId, attemptId, attemptTaskId, kind, passed, summary, position,
        ...(detail ? { checks } : { checkCount: checks?.length ?? 0 }) };
    });
    return { collection, scope, rows, cursor: store.cursor(), nextBefore: page.length > limit ? rows.at(-1).position : null,
      ...(collection === 'artifacts' && detail && rawBefore === null ? { total: taskArtifactCount(store, scope.id) } : {}) };
  });
}

export function panelArtifactCounts(store, params) {
  return store.readSnapshot(() => {
    const scope = unpackScope(store, params);
    const subjects = taskSubjects(scope.kind);
    const counts = store.db.prepare(`WITH tasks AS (${subjects})
      SELECT t.id, (SELECT count(*) FROM entities AS a INDEXED BY artifacts_by_task
        WHERE a.collection='artifacts' AND ${property('a', 'taskId')}=t.id) AS total
      FROM tasks JOIN entities AS t ON t.collection='tasks' AND t.id=tasks.id
      WHERE ${property('t', 'status')} IN ('succeeded','cancelled','archived','deferred') AND total > 0`)
      .all(...(scope.kind === 'all' ? [] : [{ $scope: scope.id }]));
    return { scope, counts: Object.fromEntries(counts.map(({ id, total }) => [id, total])) };
  });
}

export function panelArtifactLinks(store, params) {
  const ids = params.getAll('id');
  const taskId = params.get('taskId');
  assert(ids.length > 0 && ids.length <= 25 && ids.every(id => id.length > 0 && id.length <= 200) &&
    (taskId === null || (taskId.length > 0 && taskId.length <= 200)), 'INVALID_INPUT', '无效的产物链接。');
  const rows = store.db.prepare(`SELECT e.id, ${property('e', 'title')} AS title, ${property('e', 'path')} AS path
    FROM json_each(?) AS requested JOIN entities AS e ON e.collection='artifacts' AND e.id=requested.value
    WHERE (? IS NULL OR ${property('e', 'taskId')}=?) AND ${visibleSubjects('e')}`)
    .all(JSON.stringify([...new Set(ids)]), taskId, taskId);
  return { rows };
}
