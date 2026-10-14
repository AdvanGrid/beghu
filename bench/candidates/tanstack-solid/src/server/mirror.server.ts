// The SQLite mirror, read and written by server functions and server routes. The SQL is the
// stub candidate's, so the comparison between candidates is about the UI stack, not the queries.

import { DatabaseSync } from 'node:sqlite'
import type { Filters, IssueDetail, IssueRow, Label } from '~/issues'

const LATENCY = Number(process.env.GITHUB_LATENCY_MS ?? 300)

const db = new DatabaseSync(process.env.MIRROR_PATH ?? '/data/mirror.db')
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')

type Raw = Record<string, any>

export const facets = {
  labels: db.prepare('SELECT DISTINCT name FROM labels ORDER BY name').all().map((r: Raw) => r.name as string),
  assignees: db
    .prepare('SELECT DISTINCT u.login FROM item_assignees ia JOIN users u ON u.id = ia.user_id ORDER BY u.id')
    .all()
    .map((r: Raw) => r.login as string),
}

const ROW = `SELECT i.id, i.number, i.title, i.state, i.updated_at, i.comments_count, r.name AS repo,
  (SELECT json_group_array(json_object('name', l.name, 'color', l.color)) FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id) AS labels,
  (SELECT json_group_array(u.login) FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id) AS assignees
  FROM items i JOIN repos r ON r.id = i.repo_id`

const toRow = (r: Raw): IssueRow => ({
  id: String(r.id),
  number: r.number,
  title: r.title,
  state: r.state,
  updated_at: r.updated_at,
  comments_count: r.comments_count,
  repo: r.repo,
  labels: JSON.parse(r.labels),
  assignees: JSON.parse(r.assignees),
})

export function listIssues(f: Filters, offset: number, limit: number): IssueRow[] {
  const where = ["i.kind = 'issue'", 'i.is_stub = 0', 'i.state = ?']
  const args: (string | number)[] = [f.state]
  for (const name of f.labels) {
    where.push('EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name = ?)')
    args.push(name)
  }
  for (const login of f.assignees) {
    where.push('EXISTS (SELECT 1 FROM item_assignees ia JOIN users u ON u.id = ia.user_id WHERE ia.item_id = i.id AND u.login = ?)')
    args.push(login)
  }
  if (f.q) {
    where.push('instr(lower(i.title), lower(?)) > 0')
    args.push(f.q)
  }
  return db
    .prepare(`${ROW} WHERE ${where.join(' AND ')} ORDER BY i.updated_at DESC, i.id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset)
    .map(toRow)
}

export function issueDetail(id: string): IssueDetail | null {
  const row = db.prepare(`${ROW} WHERE i.id = ?`).get(id) as Raw | undefined
  if (!row) return null
  const item = db.prepare('SELECT body, repo_id FROM items WHERE id = ?').get(id) as Raw
  return {
    ...toRow(row),
    body: item.body ?? '',
    repo_labels: db.prepare('SELECT name, color FROM labels WHERE repo_id = ? ORDER BY name').all(item.repo_id) as Label[],
    comments: db
      .prepare(
        'SELECT c.id, c.body, c.created_at, u.login AS author FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.item_id = ? ORDER BY c.created_at, c.id',
      )
      .all(id)
      .map((c: Raw) => ({ id: String(c.id), body: c.body, created_at: c.created_at, author: c.author })),
  }
}

// Live changes: every subscriber (one per open SSE stream) gets the ids that changed.
const subscribers = new Set<(ids: string[]) => void>()
export function subscribe(fn: (ids: string[]) => void) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}
function broadcast(ids: (string | number)[]) {
  const s = ids.map(String)
  for (const fn of subscribers) fn(s)
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function upsertUser(u: Raw | null | undefined) {
  if (u)
    db.prepare('INSERT INTO users (id, login, avatar_url, seq) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET login = excluded.login').run(
      u.id,
      u.login,
      u.avatar_url ?? '',
    )
}

// Applies an issue object from a webhook, guarded by updated_at (newer or equal wins).
function applyIssue(issue: Raw, repoId: number) {
  const cur = db.prepare('SELECT updated_at FROM items WHERE id = ?').get(issue.id) as Raw | undefined
  if (cur && cur.updated_at > issue.updated_at) return false
  upsertUser(issue.user)
  db.prepare(
    `INSERT INTO items (id, node_id, repo_id, number, kind, title, body, state, state_reason, author_id, comments_count, created_at, updated_at, closed_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, state = excluded.state, state_reason = excluded.state_reason,
       comments_count = excluded.comments_count, updated_at = excluded.updated_at, closed_at = excluded.closed_at, is_stub = 0`,
  ).run(
    issue.id,
    issue.node_id,
    repoId,
    issue.number,
    issue.pull_request ? 'pr' : 'issue',
    issue.title,
    issue.body,
    issue.state,
    issue.state_reason,
    issue.user?.id ?? null,
    issue.comments,
    issue.created_at,
    issue.updated_at,
    issue.closed_at,
  )
  db.prepare('DELETE FROM item_labels WHERE item_id = ?').run(issue.id)
  for (const l of issue.labels) {
    db.prepare('INSERT OR IGNORE INTO labels (id, repo_id, name, color, description, seq) VALUES (?, ?, ?, ?, ?, 0)').run(
      l.id,
      repoId,
      l.name,
      l.color,
      l.description ?? null,
    )
    db.prepare('INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)').run(issue.id, l.id)
  }
  db.prepare('DELETE FROM item_assignees WHERE item_id = ?').run(issue.id)
  for (const a of issue.assignees) {
    upsertUser(a)
    db.prepare('INSERT OR IGNORE INTO item_assignees VALUES (?, ?, 0)').run(issue.id, a.id)
  }
  return true
}

export function applyWebhook(event: string | null, p: Raw) {
  const ids: (string | number)[] = []
  db.exec('BEGIN')
  try {
    if (event === 'issues' && p.issue && applyIssue(p.issue, p.repository.id)) ids.push(p.issue.id)
    if (event === 'issue_comment' && p.comment) {
      upsertUser(p.comment.user)
      db.prepare('INSERT OR REPLACE INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(
        p.comment.id,
        p.comment.node_id,
        p.issue.id,
        p.comment.user?.id ?? null,
        p.comment.body,
        p.comment.created_at,
        p.comment.updated_at,
      )
      applyIssue(p.issue, p.repository.id)
      ids.push(p.issue.id)
    }
    if (event === 'sub_issues' && p.action === 'sub_issue_added' && p.parent_issue_id) {
      db.prepare(
        "INSERT OR IGNORE INTO relationships VALUES ('sub', ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM relationships WHERE kind = 'sub' AND src_id = ?), 0)",
      ).run(p.parent_issue_id, p.sub_issue_id, p.parent_issue_id)
      ids.push(p.parent_issue_id, p.sub_issue_id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (ids.length) broadcast(ids)
}

export async function addLabel(id: string, name: string) {
  await new Promise((r) => setTimeout(r, LATENCY)) // stands in for the GitHub API call
  const label = db.prepare('SELECT l.id FROM labels l JOIN items i ON i.repo_id = l.repo_id WHERE i.id = ? AND l.name = ?').get(id, name) as
    | Raw
    | undefined
  if (!label) return false
  db.prepare('INSERT OR IGNORE INTO item_labels VALUES (?, ?, 0)').run(id, label.id)
  db.prepare('UPDATE items SET updated_at = ? WHERE id = ?').run(now(), id)
  broadcast([id])
  return true
}
