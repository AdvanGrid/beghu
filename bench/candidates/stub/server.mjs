// Stub candidate: the simplest thing that meets the candidate contract in bench/README.md, so the
// harness can be checked end to end. Not a contender. Server-side filtering straight off the
// mirror, live changes pushed over server-sent events.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT ?? 8080);
const LATENCY = Number(process.env.GITHUB_LATENCY_MS ?? 300);
const db = new DatabaseSync(process.env.MIRROR_PATH ?? '/data/mirror.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript'],
  '/app.css': ['app.css', 'text/css'],
};
const statics = Object.fromEntries(Object.entries(files).map(([path, [f, type]]) => [path, [readFileSync(new URL(`./public/${f}`, import.meta.url)), type]]));

const facets = {
  labels: db.prepare('SELECT DISTINCT name FROM labels ORDER BY name').all().map((r) => r.name),
  assignees: db.prepare('SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id').all().map((r) => r.login),
};

const ROW = `SELECT i.id, i.number, i.title, i.state, i.updated_at, i.comments_count, r.name AS repo,
  (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id) AS labels,
  (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id) AS assignees
  FROM items i JOIN repos r ON r.id = i.repo_id`;

function listIssues(params) {
  const where = ["i.kind = 'issue'", 'i.is_stub = 0', 'i.state = ?'];
  const args = [params.get('state') === 'closed' ? 'closed' : 'open'];
  for (const name of params.getAll('label')) {
    where.push('EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name = ?)');
    args.push(name);
  }
  for (const login of params.getAll('assignee')) {
    where.push('EXISTS (SELECT 1 FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id AND u.login = ?)');
    args.push(login);
  }
  const q = params.get('q');
  if (q) {
    where.push('instr(lower(i.title), lower(?)) > 0');
    args.push(q);
  }
  const limit = Math.min(Number(params.get('limit') ?? 100), 500);
  const offset = Number(params.get('offset') ?? 0);
  return db
    .prepare(`${ROW} WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
    .map((r) => ({ ...r, id: String(r.id), labels: JSON.parse(r.labels), assignees: JSON.parse(r.assignees) }));
}

function detail(id) {
  const row = db.prepare(`${ROW} WHERE i.id = ?`).get(id);
  if (!row) return null;
  const item = db.prepare('SELECT body, repo_id FROM items WHERE id = ?').get(id);
  return {
    ...row,
    id: String(row.id),
    labels: JSON.parse(row.labels),
    assignees: JSON.parse(row.assignees),
    body: item.body ?? '',
    repo_labels: db.prepare('SELECT name, color FROM labels WHERE repo_id = ? ORDER BY name').all(item.repo_id),
    comments: db
      .prepare('SELECT c.id, c.body, c.created_at, u.login AS author FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.item_id = ? ORDER BY c.created_at, c.id')
      .all(id)
      .map((c) => ({ ...c, id: String(c.id) })),
  };
}

const clients = new Set();
function broadcast(ids) {
  const msg = `data: ${JSON.stringify({ ids: ids.map(String) })}\n\n`;
  for (const res of clients) res.write(msg);
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function upsertUser(u) {
  if (u) db.prepare('INSERT INTO users (id, login, avatar_url, seq) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET login = excluded.login').run(u.id, u.login, u.avatar_url ?? '');
}

// Applies an issue object from a webhook, guarded by updated_at (newer or equal wins).
function applyIssue(issue, repoId) {
  const cur = db.prepare('SELECT updated_at FROM items WHERE id = ?').get(issue.id);
  if (cur && cur.updated_at > issue.updated_at) return false;
  upsertUser(issue.user);
  db.prepare(
    `INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id, comments_count, created_at, updated_at, closed_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason,
       comments_count = excluded.comments_count, updated_at = excluded.updated_at, closed_at = excluded.closed_at, is_stub = 0`,
  ).run(issue.id, issue.node_id, repoId, issue.number, issue.pull_request ? 'pr' : 'issue', issue.title, issue.body, issue.state, issue.state_reason, issue.user?.id ?? null, issue.comments, issue.created_at, issue.updated_at, issue.closed_at);
  db.prepare('DELETE FROM item_labels WHERE item_id = ?').run(issue.id);
  for (const l of issue.labels) {
    db.prepare('INSERT OR IGNORE INTO labels (id, repo_id, name, color, description, seq) VALUES (?, ?, ?, ?, ?, 0)').run(l.id, repoId, l.name, l.color, l.description ?? null);
    db.prepare('INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)').run(issue.id, l.id);
  }
  db.prepare('DELETE FROM item_assignees WHERE item_id = ?').run(issue.id);
  for (const a of issue.assignees) {
    upsertUser(a);
    db.prepare('INSERT OR IGNORE INTO item_assignees VALUES (?, ?, 0)').run(issue.id, a.id);
  }
  return true;
}

function webhook(event, p) {
  const ids = [];
  db.exec('BEGIN');
  try {
    if (event === 'issues' && p.issue && applyIssue(p.issue, p.repository.id)) ids.push(p.issue.id);
    if (event === 'issue_comment' && p.comment) {
      upsertUser(p.comment.user);
      db.prepare('INSERT OR REPLACE INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(p.comment.id, p.comment.node_id, p.issue.id, p.comment.user?.id ?? null, p.comment.body, p.comment.created_at, p.comment.updated_at);
      applyIssue(p.issue, p.repository.id);
      ids.push(p.issue.id);
    }
    if (event === 'sub_issues' && p.action === 'sub_issue_added' && p.parent_issue_id) {
      db.prepare("INSERT OR IGNORE INTO relationships VALUES ('sub', ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM relationships WHERE kind = 'sub' AND src_id = ?), 0)").run(p.parent_issue_id, p.sub_issue_id, p.parent_issue_id);
      ids.push(p.parent_issue_id, p.sub_issue_id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (ids.length) broadcast(ids);
}

async function addLabel(id, name) {
  await new Promise((r) => setTimeout(r, LATENCY)); // stands in for the GitHub API call
  const label = db.prepare('SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?').get(id, name);
  if (!label) return false;
  db.prepare('INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)').run(id, label.id);
  db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now(), id);
  broadcast([id]);
  return true;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && statics[url.pathname]) {
      const [body, type] = statics[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(body);
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname === '/api/facets') return json(res, 200, facets);
    if (url.pathname === '/api/issues') return json(res, 200, listIssues(url.searchParams));
    let m;
    if ((m = /^\/api\/issues\/(\d+)$/.exec(url.pathname))) {
      const d = detail(m[1]);
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = /^\/api\/issues\/(\d+)\/labels$/.exec(url.pathname))) {
      const { name } = JSON.parse(await readBody(req));
      return (await addLabel(m[1], name)) ? json(res, 200, { ok: true }) : json(res, 422, { error: 'no such label' });
    }
    if (req.method === 'POST' && url.pathname === '/webhook') {
      const payload = JSON.parse(await readBody(req));
      webhook(req.headers['x-github-event'], payload);
      return json(res, 202, { ok: true });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': hi\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`stub listening on ${PORT}`));

process.on('SIGTERM', () => process.exit(0));
