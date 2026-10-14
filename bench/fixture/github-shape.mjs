// Builds GitHub-shaped webhook payloads from rows of a fixture mirror, so candidates parse the
// same JSON they will get from GitHub. Shared by the replay feed and the live-update scenario.

const API = 'https://api.github.com';
const WEB = 'https://github.com';

export const INSTALLATION_ID = 41000001;

export function userObject(row) {
  if (!row) return null;
  return {
    login: row.login,
    id: row.id,
    node_id: `U_${row.id}`,
    avatar_url: row.avatar_url,
    html_url: `${WEB}/${row.login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repositoryObject(db, repoId) {
  const r = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    private: !!r.private,
    owner: { login: r.owner, id: 900, type: 'Organization' },
    html_url: `${WEB}/${r.owner}/${r.name}`,
    url: `${API}/repos/${r.owner}/${r.name}`,
  };
}

function labelObject(l) {
  return { id: l.id, node_id: `LA_${l.id}`, name: l.name, color: l.color, description: l.description, default: false };
}

export function labelsForRepo(db, repoId) {
  return db.prepare('SELECT * FROM labels WHERE repo_id = ? ORDER BY name').all(repoId).map(labelObject);
}

// The issue object as it appears in `issues`, `issue_comment`, `sub_issues` payloads.
// `patch` overrides fields after the row is read, e.g. { title, updated_at, labels }.
export function issueObject(db, id, patch = {}) {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(it.repo_id);
  const full = `${repo.owner}/${repo.name}`;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(it.author_id);
  const labels = db
    .prepare('SELECT l.* FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = ? ORDER BY l.name')
    .all(id)
    .map(labelObject);
  const assignees = db
    .prepare('SELECT u.* FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = ? ORDER BY u.login')
    .all(id)
    .map(userObject);
  const ms = it.milestone_id ? db.prepare('SELECT * FROM milestones WHERE id = ?').get(it.milestone_id) : null;
  const subs = db
    .prepare(
      `SELECT count(*) AS total, sum(c.state = 'closed') AS completed
       FROM relationships r JOIN items c ON c.id = r.dst_id WHERE r.kind = 'sub' AND r.src_id = ?`,
    )
    .get(id);
  const deps = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM relationships r JOIN items b ON b.id = r.src_id
            WHERE r.kind = 'blocks' AND r.dst_id = ?1 AND b.state = 'open') AS blocked_by,
         (SELECT count(*) FROM relationships r JOIN items b ON b.id = r.dst_id
            WHERE r.kind = 'blocks' AND r.src_id = ?1 AND b.state = 'open') AS blocking,
         (SELECT count(*) FROM relationships WHERE kind = 'blocks' AND dst_id = ?1) AS total_blocked_by,
         (SELECT count(*) FROM relationships WHERE kind = 'blocks' AND src_id = ?1) AS total_blocking`,
    )
    .get(id);
  const parent = db
    .prepare(
      `SELECT p.number, pr.owner, pr.name FROM relationships r JOIN items p ON p.id = r.src_id
       JOIN repos pr ON pr.id = p.repo_id WHERE r.kind = 'sub' AND r.dst_id = ?`,
    )
    .get(id);

  const obj = {
    url: `${API}/repos/${full}/issues/${it.number}`,
    repository_url: `${API}/repos/${full}`,
    html_url: `${WEB}/${full}/${it.kind === 'pr' ? 'pull' : 'issues'}/${it.number}`,
    id: it.id,
    node_id: it.node_id,
    number: it.number,
    title: it.title,
    user: userObject(author),
    labels,
    state: it.state,
    state_reason: it.state_reason,
    locked: false,
    assignee: assignees[0] ?? null,
    assignees,
    milestone: ms && {
      id: ms.id,
      node_id: `MI_${ms.id}`,
      number: ms.number,
      title: ms.title,
      state: ms.state,
      due_on: ms.due_on,
    },
    comments: it.comments_count,
    created_at: it.created_at,
    updated_at: it.updated_at,
    closed_at: it.closed_at,
    author_association: 'MEMBER',
    body: it.body,
    sub_issues_summary: {
      total: subs.total,
      completed: subs.completed ?? 0,
      percent_completed: subs.total ? Math.round(((subs.completed ?? 0) / subs.total) * 100) : 0,
    },
    issue_dependencies_summary: deps,
  };
  if (parent) obj.parent_issue_url = `${API}/repos/${parent.owner}/${parent.name}/issues/${parent.number}`;
  if (it.kind === 'pr') {
    obj.pull_request = {
      url: `${API}/repos/${full}/pulls/${it.number}`,
      html_url: `${WEB}/${full}/pull/${it.number}`,
      merged_at: it.merged_at,
    };
    obj.draft = !!it.draft;
  }
  return Object.assign(obj, patch);
}

export function commentObject(db, row) {
  const repoRow = db.prepare('SELECT r.owner, r.name, i.number FROM items i JOIN repos r ON r.id = i.repo_id WHERE i.id = ?').get(row.item_id);
  const full = `${repoRow.owner}/${repoRow.name}`;
  const author = db.prepare('SELECT * FROM users WHERE id = ?').get(row.author_id);
  return {
    url: `${API}/repos/${full}/issues/comments/${row.id}`,
    html_url: `${WEB}/${full}/issues/${repoRow.number}#issuecomment-${row.id}`,
    issue_url: `${API}/repos/${full}/issues/${repoRow.number}`,
    id: row.id,
    node_id: row.node_id,
    user: userObject(author),
    created_at: row.created_at,
    updated_at: row.updated_at,
    author_association: 'MEMBER',
    body: row.body,
  };
}

// Wraps a payload body with the keys every delivery carries.
export function envelope(db, repoId, senderId, body) {
  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(senderId);
  return {
    ...body,
    repository: repositoryObject(db, repoId),
    sender: userObject(sender),
    installation: { id: INSTALLATION_ID, node_id: `MDIz_${INSTALLATION_ID}` },
  };
}

// An `issues.edited` delivery for a title change, the shape the live-update scenario sends.
export function titleEdited(db, id, title, updatedAt, senderId) {
  const before = db.prepare('SELECT repo_id, title FROM items WHERE id = ?').get(id);
  return {
    event: 'issues',
    payload: envelope(db, before.repo_id, senderId, {
      action: 'edited',
      issue: issueObject(db, id, { title, updated_at: updatedAt }),
      changes: { title: { from: before.title } },
    }),
  };
}
