#!/usr/bin/env node
// Generates the shared benchmark fixture: a synthetic mirror (fixture/schema.sql) and a
// replayable webhook feed. Deterministic: the same scale always gives the same bytes.
//
//   node fixture/generate.mjs [--scale 20k|50k|all] [--out data]
//
// Writes data/mirror-<scale>.db, data/webhooks-<scale>.jsonl and data/fixture-<scale>.json.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envelope, issueObject, commentObject, labelsForRepo } from './github-shape.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const outDir = join(here, '..', args.out ?? 'data');
const SCALES = { '20k': 20_000, '50k': 50_000 };
const scales = !args.scale || args.scale === 'all' ? Object.keys(SCALES) : [args.scale];

// Everything below is fixed so the harness can compute expected results.
export const FIXTURE_NOW = Date.parse('2026-10-01T00:00:00Z');
const DAY = 86_400_000;
const OWNER = 'acme';
const REPOS = [
  ['web', 0.3],
  ['api', 0.18],
  ['mobile', 0.12],
  ['infra', 0.1],
  ['docs', 0.08],
  ['design', 0.07],
  ['sync', 0.05],
  ['cli', 0.04],
  ['billing', 0.03],
  ['ops', 0.03],
];
const UNSYNCED_REPO = 'partner-sdk';
const LABELS = [
  ['bug', 'd73a4a', 0.3],
  ['enhancement', 'a2eeef', 0.25],
  ['documentation', '0075ca', 0.08],
  ['question', 'd876e3', 0.05],
  ['performance', 'fbca04', 0.08],
  ['ux', 'c5def5', 0.1],
  ['backend', '5319e7', 0.15],
  ['frontend', '1d76db', 0.15],
  ['p0', 'b60205', 0.03],
  ['p1', 'e99695', 0.08],
  ['p2', 'f9d0c4', 0.12],
  ['good first issue', '7057ff', 0.04],
];
// The first 8 users are the team: authors and assignees. The rest only author.
const LOGINS = [
  'tomsj', 'ilze-k', 'martins-dev', 'anna-b', 'roberts', 'liga-p', 'edgars', 'zane-m',
  'octo-ext', 'contrib-1', 'contrib-2', 'reporter-a', 'reporter-b', 'qa-bot', 'customer-x',
  'design-lead', 'sre-oncall', 'pm-kate', 'intern-j', 'old-timer', 'docs-writer', 'sec-team',
  'mobile-guy', 'api-fan', 'cli-power', 'billing-ops', 'drive-by', 'translator', 'maint-2', 'maint-3',
];
const TEAM = 8;

const VERBS = ['Fix', 'Add', 'Improve', 'Remove', 'Refactor', 'Investigate', 'Support', 'Update', 'Document', 'Speed up', 'Handle', 'Migrate'];
const OBJECTS = [
  'crash in', 'rendering of', 'sync of', 'the label picker', 'search results', 'the comment editor', 'the sub-issue tree',
  'the dependency graph', 'keyboard shortcuts', 'dark mode', 'markdown preview', 'the webhook handler', 'the import job',
  'token refresh', 'the milestone filter', 'assignee avatars', 'scroll position', 'the notification badge', 'release notes',
  'pagination', 'the renderer cache', 'error toasts', 'the settings page', 'rate limit handling',
  // Near misses for the search term "dark m", so every keystroke narrows the results.
  'dark theme contrast', 'darker borders', 'dart SDK bindings', 'date parsing', 'data export',
];
const QUALIFIERS = [
  'on Safari', 'for large repos', 'after reconnect', 'in the detail view', 'on old laptops', 'with 50k issues',
  'for cross-repo links', '', '', 'in the list header', 'during import', 'when the token expires', 'on mobile',
  'for private repos', 'in Firefox',
];
const WORDS = (
  'the list should stay responsive while the mirror catches up and the user keeps typing into the filter box ' +
  'we saw this on an older laptop with many repos synced and the scroll stuttered after a webhook burst ' +
  'steps to reproduce open the issue list apply a label filter then open any issue with long comments ' +
  'expected the comments render at once actual a spinner shows and the layout jumps when they arrive ' +
  'this may relate to how the cache invalidates rows after a write or how the server batches deltas'
).split(' ');

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(scale) {
  const N = SCALES[scale];
  const rand = mulberry32(N);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sentence = (min, max) => {
    const n = int(min, max);
    const w = Array.from({ length: n }, () => pick(WORDS));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return w.join(' ') + '.';
  };
  const paragraph = () => Array.from({ length: int(2, 5) }, () => sentence(6, 18)).join(' ');
  const issueBody = () => {
    const parts = [paragraph()];
    const target = int(200, 2000);
    while (parts.join('\n\n').length < target) {
      const r = rand();
      if (r < 0.15) parts.push('- [ ] ' + sentence(3, 8) + '\n- [x] ' + sentence(3, 8) + '\n- [ ] ' + sentence(3, 8));
      else if (r < 0.25) parts.push('```ts\nconst rows = await mirror.query({ state: "open", limit: 20 });\nrender(rows);\n```');
      else if (r < 0.32) parts.push('## ' + sentence(2, 5).slice(0, -1));
      else parts.push(paragraph());
    }
    return parts.join('\n\n').slice(0, target + 200);
  };
  const commentBody = () => {
    const target = int(50, 800);
    let s = sentence(4, 14);
    while (s.length < target) s += (chance(0.2) ? '\n\n' : ' ') + sentence(4, 14);
    return s;
  };

  mkdirSync(outDir, { recursive: true });
  const dbPath = join(outDir, `mirror-${scale}.db`);
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  db.exec('BEGIN');

  const SEQ = 1;
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  meta.run('seq', String(SEQ));
  meta.run('epoch', `fixture-${scale}-v1`);
  meta.run('fixture_now', iso(FIXTURE_NOW));

  // Users
  const insUser = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)');
  const users = LOGINS.map((login, i) => {
    const id = 1000 + i;
    insUser.run(id, login, `https://avatars.githubusercontent.com/u/${id}?v=4`, SEQ);
    return id;
  });
  const team = users.slice(0, TEAM);

  // Repos, labels, milestones
  const insRepo = db.prepare('INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insLabel = db.prepare('INSERT INTO labels VALUES (?, ?, ?, ?, ?, ?)');
  const insMs = db.prepare('INSERT INTO milestones VALUES (?, ?, ?, ?, ?, ?, ?)');
  const repos = REPOS.map(([name, weight], i) => {
    const id = 9_000_000 + i;
    insRepo.run(id, OWNER, name, 1, 41000001, 1, SEQ);
    const labels = LABELS.map(([lname, color, p], j) => {
      const lid = 5_000_000 + i * 100 + j;
      insLabel.run(lid, id, lname, color, `${lname} work`, SEQ);
      return { id: lid, name: lname, p };
    });
    const milestones = [1, 2, 3, 4].map((n) => {
      const mid = 7_000_000 + i * 100 + n;
      insMs.run(mid, id, n, `v${i % 3}.${n}`, n < 3 ? 'closed' : 'open', iso(FIXTURE_NOW + (n - 2) * 60 * DAY), SEQ);
      return mid;
    });
    return { id, name, weight, labels, milestones };
  });
  const unsyncedRepoId = 9_000_100;
  insRepo.run(unsyncedRepoId, OWNER, UNSYNCED_REPO, 1, null, 0, SEQ);

  // Items: per repo, issues + PRs share one number sequence in creation order.
  const insItem = db.prepare(
    `INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, body, state, state_reason, author_id,
       milestone_id, comments_count, created_at, updated_at, closed_at, pr_id, draft, merged_at, seq)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insItemLabel = db.prepare('INSERT INTO item_labels VALUES (?, ?, ?)');
  const insAssignee = db.prepare('INSERT INTO item_assignees VALUES (?, ?, ?)');
  const SPAN = 3 * 365 * DAY;
  let nextItemId = 3_000_000_000;
  let nextPrId = 2_400_000_000;
  const items = []; // { id, repo, kind, state, updated }
  for (const repo of repos) {
    const issueCount = Math.round(N * repo.weight);
    const prCount = Math.round(issueCount / 4);
    const created = Array.from({ length: issueCount + prCount }, () => FIXTURE_NOW - Math.floor(rand() * SPAN)).sort((a, b) => a - b);
    const kinds = [...Array(issueCount).fill('issue'), ...Array(prCount).fill('pr')];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    created.forEach((createdAt, idx) => {
      const id = nextItemId++;
      const kind = kinds[idx];
      // Older items are more likely to be closed.
      const age = (FIXTURE_NOW - createdAt) / SPAN;
      const closed = chance(0.25 + 0.6 * age);
      const updated = Math.min(FIXTURE_NOW - int(0, 600) * 1000, createdAt + Math.floor(rand() ** 2 * (FIXTURE_NOW - createdAt)));
      const closedAt = closed ? iso(updated) : null;
      const merged = kind === 'pr' && closed && chance(0.8);
      insItem.run(
        id,
        `I_kw${id.toString(36)}`,
        repo.id,
        idx + 1,
        kind,
        `${pick(VERBS)} ${pick(OBJECTS)} ${pick(QUALIFIERS)}`.trim(),
        issueBody(),
        closed ? 'closed' : 'open',
        closed && kind === 'issue' ? (chance(0.85) ? 'completed' : 'not_planned') : null,
        chance(0.7) ? pick(team) : pick(users),
        chance(0.3) ? pick(repo.milestones) : null,
        iso(createdAt),
        iso(updated),
        closedAt,
        kind === 'pr' ? nextPrId++ : null,
        kind === 'pr' ? (chance(0.1) ? 1 : 0) : null,
        merged ? closedAt : null,
        SEQ,
      );
      for (const l of repo.labels) if (chance(l.p)) insItemLabel.run(id, l.id, SEQ);
      if (chance(0.6)) {
        const a = pick(team);
        insAssignee.run(id, a, SEQ);
        if (chance(0.2)) {
          const b = pick(team);
          if (b !== a) insAssignee.run(id, b, SEQ);
        }
      }
      items.push({ id, repo: repo.id, kind, state: closed ? 'closed' : 'open', updated, created: createdAt });
    });
  }
  const issues = items.filter((i) => i.kind === 'issue');

  // The top 40 rows of the default view (open issues, newest update first) get exactly 30
  // comments, so the open-detail scenario always has a target without scrolling.
  const defaultOrder = issues
    .filter((i) => i.state === 'open')
    .sort((a, b) => b.updated - a.updated || b.id - a.id);
  const detailTargets = new Set(defaultOrder.slice(0, 40).map((i) => i.id));

  // Comments: geometric around 5 per item.
  const insComment = db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const setCount = db.prepare('UPDATE items SET comments_count = ? WHERE id = ?');
  let nextCommentId = 2_000_000_000;
  let commentTotal = 0;
  for (const it of items) {
    const n = detailTargets.has(it.id) ? 30 : Math.min(80, Math.floor(-Math.log(1 - rand()) * 5));
    if (!n) continue;
    const times = Array.from({ length: n }, () => it.created + Math.floor(rand() * (it.updated - it.created))).sort((a, b) => a - b);
    for (const t of times) {
      const cid = nextCommentId++;
      insComment.run(cid, `IC_kw${cid.toString(36)}`, it.id, chance(0.75) ? pick(team) : pick(users), commentBody(), iso(t), iso(t), SEQ);
    }
    setCount.run(n, it.id);
    commentTotal += n;
  }

  // Relationships
  const insRel = db.prepare('INSERT OR IGNORE INTO relationships VALUES (?, ?, ?, ?, ?)');
  const byRepo = new Map(repos.map((r) => [r.id, issues.filter((i) => i.repo === r.id)]));
  const otherRepoIssue = (repoId) => {
    const r = pick(repos.filter((x) => x.id !== repoId));
    return pick(byRepo.get(r.id));
  };
  const hasParent = new Set();
  const counts = { sub: 0, blocks: 0, relates: 0 };
  for (const parent of issues) {
    if (!chance(0.03)) continue;
    const kids = int(2, 10);
    let position = 1;
    for (let k = 0; k < kids; k++) {
      const child = chance(0.9) ? pick(byRepo.get(parent.repo)) : otherRepoIssue(parent.repo);
      if (child.id === parent.id || hasParent.has(child.id)) continue;
      hasParent.add(child.id);
      insRel.run('sub', parent.id, child.id, position++, SEQ);
      counts.sub++;
    }
  }
  for (const it of issues) {
    if (chance(0.05)) {
      for (let k = int(1, 3); k > 0; k--) {
        const blocker = chance(0.85) ? pick(byRepo.get(it.repo)) : otherRepoIssue(it.repo);
        if (blocker.id !== it.id) counts.blocks += Number(insRel.run('blocks', blocker.id, it.id, null, SEQ).changes);
      }
    }
    if (chance(0.04)) {
      for (let k = int(1, 2); k > 0; k--) {
        const other = chance(0.8) ? pick(byRepo.get(it.repo)) : otherRepoIssue(it.repo);
        if (other.id === it.id) continue;
        const [a, b] = it.id < other.id ? [it.id, other.id] : [other.id, it.id];
        counts.relates += Number(insRel.run('relates', a, b, null, SEQ).changes);
      }
    }
  }

  // Stubs: issues in the unsynced repo, reached only through relationships.
  const insStub = db.prepare(
    `INSERT INTO items (id, node_id, repo_id, number, kind, is_stub, title, state, seq)
     VALUES (?, ?, ?, ?, 'issue', 1, ?, ?, ?)`,
  );
  const stubs = [];
  for (let s = 0; s < 40; s++) {
    const id = nextItemId++;
    insStub.run(id, `I_kw${id.toString(36)}`, unsyncedRepoId, 100 + s * 7, `${pick(VERBS)} ${pick(OBJECTS)} in the SDK`, chance(0.6) ? 'open' : 'closed', SEQ);
    stubs.push(id);
  }
  let stubEdges = 0;
  for (let e = 0; e < 60; e++) {
    const it = pick(issues);
    const stub = pick(stubs);
    const kind = pick(['blocks', 'relates', 'blocks']);
    const [src, dst] = kind === 'relates' ? [Math.min(it.id, stub), Math.max(it.id, stub)] : chance(0.5) ? [stub, it.id] : [it.id, stub];
    stubEdges += Number(insRel.run(kind, src, dst, null, SEQ).changes);
  }

  db.exec(`
    CREATE INDEX items_list ON items(kind, state, updated_at DESC, id DESC);
    CREATE INDEX items_seq ON items(seq);
    CREATE INDEX comments_item ON comments(item_id, created_at);
    CREATE INDEX comments_seq ON comments(seq);
    CREATE INDEX item_labels_label ON item_labels(label_id);
    CREATE INDEX item_assignees_user ON item_assignees(user_id);
    CREATE INDEX relationships_dst ON relationships(dst_id, kind);
    CREATE INDEX relationships_seq ON relationships(seq);
  `);
  db.exec('COMMIT');

  // Replayable webhook feed: GitHub-shaped deliveries, each touching a different issue so they
  // are independent and can be replayed in any order or repeatedly.
  const feed = buildFeed(db, { rand, pick, chance, int, iso, issues, team, repos, commentBody, defaultOrder });
  writeFileSync(join(outDir, `webhooks-${scale}.jsonl`), feed.map((e) => JSON.stringify(e)).join('\n') + '\n');

  db.exec('VACUUM');
  db.close();

  const summary = {
    scale,
    issues: issues.length,
    prs: items.length - issues.length,
    stubs: stubs.length,
    comments: commentTotal,
    relationships: { ...counts, stub_edges: stubEdges },
    open_issues: defaultOrder.length,
    detail_targets: [...detailTargets],
    webhooks: feed.length,
    fixture_now: iso(FIXTURE_NOW),
  };
  writeFileSync(join(outDir, `fixture-${scale}.json`), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

function buildFeed(db, { rand, pick, chance, int, iso, issues, team, repos, commentBody, defaultOrder }) {
  const feed = [];
  const used = new Set();
  // Mostly recent, visible issues, like real traffic.
  const target = () => {
    for (;;) {
      const it = chance(0.7) ? defaultOrder[int(0, Math.min(400, defaultOrder.length - 1))] : pick(issues);
      if (!used.has(it.id)) {
        used.add(it.id);
        return it;
      }
    }
  };
  const repoLabels = new Map(repos.map((r) => [r.id, labelsForRepo(db, r.id)]));
  let t = FIXTURE_NOW + 60_000;
  for (let n = 0; n < 500; n++) {
    t += int(200, 5000);
    const at = iso(t);
    const it = target();
    const sender = pick(team);
    const r = rand();
    let event, body;
    if (r < 0.3) {
      const current = issueObject(db, it.id);
      event = 'issues';
      body = {
        action: 'edited',
        issue: issueObject(db, it.id, { title: `${current.title} (edited)`, updated_at: at }),
        changes: { title: { from: current.title } },
      };
    } else if (r < 0.5) {
      const current = issueObject(db, it.id);
      const missing = repoLabels.get(it.repo).filter((l) => !current.labels.some((c) => c.id === l.id));
      if (!missing.length) { n--; continue; }
      const label = pick(missing);
      event = 'issues';
      body = { action: 'labeled', label, issue: issueObject(db, it.id, { labels: [...current.labels, label], updated_at: at }) };
    } else if (r < 0.62) {
      const closing = it.state === 'open';
      event = 'issues';
      body = {
        action: closing ? 'closed' : 'reopened',
        issue: issueObject(db, it.id, {
          state: closing ? 'closed' : 'open',
          state_reason: closing ? 'completed' : 'reopened',
          closed_at: closing ? at : null,
          updated_at: at,
        }),
      };
    } else if (r < 0.9) {
      const cid = 2_900_000_000 + n;
      const comment = commentObject(db, { id: cid, node_id: `IC_kw${cid.toString(36)}`, item_id: it.id, author_id: sender, body: commentBody(), created_at: at, updated_at: at });
      const current = issueObject(db, it.id);
      event = 'issue_comment';
      body = { action: 'created', comment, issue: issueObject(db, it.id, { comments: current.comments + 1, updated_at: at }) };
    } else {
      // Same-repo sub-issue add: the parent's repo gets both sides (see webhook-delivery.md).
      const child = target();
      if (child.repo !== it.repo || db.prepare("SELECT 1 FROM relationships WHERE kind = 'sub' AND dst_id = ?").get(child.id)) {
        n--;
        continue;
      }
      event = 'sub_issues';
      body = {
        action: 'sub_issue_added',
        parent_issue_id: it.id,
        parent_issue: issueObject(db, it.id),
        sub_issue_id: child.id,
        sub_issue: issueObject(db, child.id),
      };
    }
    feed.push({ at, event, payload: envelope(db, it.repo, sender, body) });
  }
  return feed;
}

for (const scale of scales) {
  if (!SCALES[scale]) throw new Error(`unknown scale ${scale}; use 20k, 50k or all`);
  const started = Date.now();
  const s = generate(scale);
  console.log(
    `${scale}: ${s.issues} issues, ${s.prs} PRs, ${s.comments} comments, ` +
      `${s.relationships.sub} sub / ${s.relationships.blocks} blocks / ${s.relationships.relates} relates, ` +
      `${s.webhooks} webhooks in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}
