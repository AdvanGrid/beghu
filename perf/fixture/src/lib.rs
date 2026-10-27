//! The fixture generator: a synthetic mirror in the real mirror schema, for dev, tests and perf.
//! Ported from `bench/fixture/generate.mjs`. Seeded and deterministic: the same scale and the
//! same generator always give the same bytes. Files are cached by the generator's hash (its
//! source plus mirror-db's migrations and queries), so a schema change regenerates them.

use mirror_db::q;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Hash of the generator's source and the mirror schema, computed by `build.rs`.
pub const GENERATOR_HASH: &str = env!("FIXTURE_GENERATOR_HASH");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scale {
    K1,
    K20,
    K50,
}

impl Scale {
    pub const ALL: [Scale; 3] = [Scale::K1, Scale::K20, Scale::K50];

    pub fn issues(self) -> usize {
        match self {
            Scale::K1 => 1_000,
            Scale::K20 => 20_000,
            Scale::K50 => 50_000,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Scale::K1 => "1k",
            Scale::K20 => "20k",
            Scale::K50 => "50k",
        }
    }

    pub fn parse(s: &str) -> Option<Scale> {
        Scale::ALL.into_iter().find(|x| x.name() == s)
    }
}

/// What a generated fixture holds, for tests and harnesses that need expected values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub issues: usize,
    pub prs: usize,
    pub stubs: usize,
    pub comments: usize,
    pub sub: usize,
    pub blocks: usize,
    pub relates: usize,
    pub closes: usize,
    pub stub_edges: usize,
    pub open_issues: usize,
    /// The top 40 rows of the default view (open issues, newest update first): each has exactly
    /// 30 comments.
    pub detail_targets: Vec<i64>,
    /// Every stub's id: issues in the unsynced repo.
    pub stub_ids: Vec<i64>,
}

impl Summary {
    pub fn to_json(&self, scale: Scale) -> String {
        let targets: Vec<String> = self.detail_targets.iter().map(i64::to_string).collect();
        let stubs: Vec<String> = self.stub_ids.iter().map(i64::to_string).collect();
        format!(
            "{{\n  \"scale\": \"{}\",\n  \"generator\": \"{GENERATOR_HASH}\",\n  \"fixture_now\": {FIXTURE_NOW},\n  \"issues\": {},\n  \"prs\": {},\n  \"stubs\": {},\n  \"comments\": {},\n  \"relationships\": {{ \"sub\": {}, \"blocks\": {}, \"relates\": {}, \"closes\": {}, \"stub_edges\": {} }},\n  \"open_issues\": {},\n  \"detail_targets\": [{}],\n  \"stub_ids\": [{}]\n}}\n",
            scale.name(),
            self.issues,
            self.prs,
            self.stubs,
            self.comments,
            self.sub,
            self.blocks,
            self.relates,
            self.closes,
            self.stub_edges,
            self.open_issues,
            targets.join(", "),
            stubs.join(", ")
        )
    }
}

/// The fixture for `scale` in `dir`, generated only if no file for this generator hash exists.
/// Returns the mirror's path; `fixture-<scale>-<hash>.json` beside it holds the `Summary`.
pub fn cached(scale: Scale, dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join(format!("mirror-{}-{GENERATOR_HASH}.db", scale.name()));
    if path.exists() {
        return Ok(path);
    }
    std::fs::create_dir_all(dir)?;
    // Older generators' files for this scale are stale.
    for entry in std::fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        let prefix = (
            format!("mirror-{}-", scale.name()),
            format!("fixture-{}-", scale.name()),
        );
        if name.starts_with(&prefix.0) || name.starts_with(&prefix.1) {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    let tmp = dir.join(format!(".mirror-{}-{GENERATOR_HASH}.db", scale.name()));
    let summary = generate(scale, &tmp).map_err(std::io::Error::other)?;
    std::fs::write(
        dir.join(format!("fixture-{}-{GENERATOR_HASH}.json", scale.name())),
        summary.to_json(scale),
    )?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

pub const FIXTURE_NOW: i64 = 1_790_812_800; // 2026-10-01T00:00:00Z
const DAY: i64 = 86_400;
const OWNER: &str = "acme";
const REPOS: [(&str, f64); 10] = [
    ("web", 0.3),
    ("api", 0.18),
    ("mobile", 0.12),
    ("infra", 0.1),
    ("docs", 0.08),
    ("design", 0.07),
    ("sync", 0.05),
    ("cli", 0.04),
    ("billing", 0.03),
    ("ops", 0.03),
];
const UNSYNCED_REPO: &str = "partner-sdk";
const LABELS: [(&str, &str, f64); 12] = [
    ("bug", "d73a4a", 0.3),
    ("enhancement", "a2eeef", 0.25),
    ("documentation", "0075ca", 0.08),
    ("question", "d876e3", 0.05),
    ("performance", "fbca04", 0.08),
    ("ux", "c5def5", 0.1),
    ("backend", "5319e7", 0.15),
    ("frontend", "1d76db", 0.15),
    ("p0", "b60205", 0.03),
    ("p1", "e99695", 0.08),
    ("p2", "f9d0c4", 0.12),
    ("good first issue", "7057ff", 0.04),
];
/// The first `TEAM` users are the team: authors and assignees. The rest only author.
const LOGINS: [&str; 30] = [
    "tomsj",
    "ilze-k",
    "martins-dev",
    "anna-b",
    "roberts",
    "liga-p",
    "edgars",
    "zane-m",
    "octo-ext",
    "contrib-1",
    "contrib-2",
    "reporter-a",
    "reporter-b",
    "qa-bot",
    "customer-x",
    "design-lead",
    "sre-oncall",
    "pm-kate",
    "intern-j",
    "old-timer",
    "docs-writer",
    "sec-team",
    "mobile-guy",
    "api-fan",
    "cli-power",
    "billing-ops",
    "drive-by",
    "translator",
    "maint-2",
    "maint-3",
];
const TEAM: usize = 8;
const VERBS: [&str; 12] = [
    "Fix",
    "Add",
    "Improve",
    "Remove",
    "Refactor",
    "Investigate",
    "Support",
    "Update",
    "Document",
    "Speed up",
    "Handle",
    "Migrate",
];
const OBJECTS: [&str; 29] = [
    "crash in",
    "rendering of",
    "sync of",
    "the label picker",
    "search results",
    "the comment editor",
    "the sub-issue tree",
    "the dependency graph",
    "keyboard shortcuts",
    "dark mode",
    "markdown preview",
    "the webhook handler",
    "the import job",
    "token refresh",
    "the milestone filter",
    "assignee avatars",
    "scroll position",
    "the notification badge",
    "release notes",
    "pagination",
    "the renderer cache",
    "error toasts",
    "the settings page",
    "rate limit handling",
    // Near misses for the search term "dark m", so every keystroke narrows the results.
    "dark theme contrast",
    "darker borders",
    "dart SDK bindings",
    "date parsing",
    "data export",
];
const QUALIFIERS: [&str; 15] = [
    "on Safari",
    "for large repos",
    "after reconnect",
    "in the detail view",
    "on old laptops",
    "with 50k issues",
    "for cross-repo links",
    "",
    "",
    "in the list header",
    "during import",
    "when the token expires",
    "on mobile",
    "for private repos",
    "in Firefox",
];
const WORDS: &str = "the list should stay responsive while the mirror catches up and the user keeps typing into the filter box \
    we saw this on an older laptop with many repos synced and the scroll stuttered after a webhook burst \
    steps to reproduce open the issue list apply a label filter then open any issue with long comments \
    expected the comments render at once actual a spinner shows and the layout jumps when they arrive \
    this may relate to how the cache invalidates rows after a write or how the server batches deltas";

/// mulberry32, as in the JS generator.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
    fn int(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() * (hi - lo + 1) as f64).floor() as i64
    }
    fn index(&mut self, len: usize) -> usize {
        (self.next() * len as f64).floor() as usize
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.index(xs.len())]
    }
    fn chance(&mut self, p: f64) -> bool {
        self.next() < p
    }
}

struct Words(Vec<&'static str>);

impl Words {
    fn sentence(&self, r: &mut Rng, min: i64, max: i64) -> String {
        let n = r.int(min, max);
        let mut w: Vec<String> = (0..n).map(|_| r.pick(&self.0).to_string()).collect();
        let mut first = w[0].chars();
        w[0] = first
            .next()
            .map(|c| c.to_uppercase().chain(first).collect())
            .unwrap_or_default();
        w.join(" ") + "."
    }
    fn paragraph(&self, r: &mut Rng) -> String {
        let n = r.int(2, 5);
        (0..n)
            .map(|_| self.sentence(r, 6, 18))
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn issue_body(&self, r: &mut Rng) -> String {
        let mut parts = vec![self.paragraph(r)];
        let target = r.int(200, 2000) as usize;
        while parts.join("\n\n").len() < target {
            let x = r.next();
            if x < 0.15 {
                parts.push(format!(
                    "- [ ] {}\n- [x] {}\n- [ ] {}",
                    self.sentence(r, 3, 8),
                    self.sentence(r, 3, 8),
                    self.sentence(r, 3, 8)
                ));
            } else if x < 0.25 {
                parts.push("```ts\nconst rows = await mirror.query({ state: \"open\", limit: 20 });\nrender(rows);\n```".into());
            } else if x < 0.32 {
                let s = self.sentence(r, 2, 5);
                parts.push(format!("## {}", &s[..s.len() - 1]));
            } else {
                parts.push(self.paragraph(r));
            }
        }
        let body = parts.join("\n\n");
        body.chars().take(target + 200).collect()
    }
    fn comment_body(&self, r: &mut Rng) -> String {
        let target = r.int(50, 800) as usize;
        let mut s = self.sentence(r, 4, 14);
        while s.len() < target {
            s.push_str(if r.chance(0.2) { "\n\n" } else { " " });
            s.push_str(&self.sentence(r, 4, 14));
        }
        s
    }
}

struct Item {
    id: i64,
    repo: i64,
    kind: &'static str,
    open: bool,
    created: i64,
    updated: i64,
}

/// Writes a fresh fixture mirror at `path` in one transaction (`seq` 1).
pub fn generate(scale: Scale, path: &Path) -> Result<Summary, mirror_db::Error> {
    mirror_db::create(path)?;
    let mut conn = Connection::open(path)?;
    let tx = conn.transaction()?;
    let summary = fill(&tx, scale)?;
    tx.commit()?;
    drop(conn);
    Ok(summary)
}

fn fill(tx: &Connection, scale: Scale) -> rusqlite::Result<Summary> {
    let n = scale.issues();
    let r = &mut Rng(n as u32);
    let words = Words(WORDS.split(' ').collect());
    let seq = q::bump_seq(tx)?;

    let users: Vec<i64> = (0..LOGINS.len() as i64).map(|i| 1000 + i).collect();
    for (i, login) in LOGINS.iter().enumerate() {
        q::insert_user(
            tx,
            users[i],
            login,
            &format!("https://avatars.githubusercontent.com/u/{}?v=4", users[i]),
        )?;
    }
    let team = &users[..TEAM];

    struct Repo {
        id: i64,
        weight: f64,
        labels: Vec<(i64, f64)>,
        milestones: Vec<i64>,
    }
    let mut repos = Vec::new();
    for (i, (name, weight)) in REPOS.iter().enumerate() {
        let id = 9_000_000 + i as i64;
        q::insert_repo(
            tx,
            id,
            &format!("R_kw{id}"),
            OWNER,
            name,
            true,
            Some(41_000_001),
            true,
            Some("write"),
        )?;
        let mut labels = Vec::new();
        for (j, (lname, color, p)) in LABELS.iter().enumerate() {
            let lid = 5_000_000 + i as i64 * 100 + j as i64;
            q::insert_label(tx, lid, id, lname, color, &format!("{lname} work"))?;
            labels.push((lid, *p));
        }
        let mut milestones = Vec::new();
        for m in 1..=4 {
            let mid = 7_000_000 + i as i64 * 100 + m;
            q::insert_milestone(
                tx,
                mid,
                id,
                m,
                &format!("v{}.{m}", i % 3),
                if m < 3 { "closed" } else { "open" },
                FIXTURE_NOW + (m - 2) * 60 * DAY,
            )?;
            milestones.push(mid);
        }
        repos.push(Repo {
            id,
            weight: *weight,
            labels,
            milestones,
        });
    }
    let unsynced_repo = 9_000_100;
    q::insert_repo(
        tx,
        unsynced_repo,
        &format!("R_kw{unsynced_repo}"),
        OWNER,
        UNSYNCED_REPO,
        true,
        None,
        false,
        None,
    )?;

    // Items: per repo, issues and PRs share one number sequence in creation order.
    let span = 3 * 365 * DAY;
    let (mut next_item, mut next_pr) = (3_000_000_000i64, 2_400_000_000i64);
    let mut items = Vec::new();
    for repo in &repos {
        let issue_count = (n as f64 * repo.weight).round() as usize;
        let pr_count = (issue_count as f64 / 4.0).round() as usize;
        let mut created: Vec<i64> = (0..issue_count + pr_count)
            .map(|_| FIXTURE_NOW - (r.next() * span as f64).floor() as i64)
            .collect();
        created.sort_unstable();
        let mut kinds: Vec<&'static str> = std::iter::repeat_n("issue", issue_count)
            .chain(std::iter::repeat_n("pr", pr_count))
            .collect();
        for i in (1..kinds.len()).rev() {
            let j = (r.next() * (i + 1) as f64).floor() as usize;
            kinds.swap(i, j);
        }
        for (idx, &created_at) in created.iter().enumerate() {
            let id = next_item;
            next_item += 1;
            let kind = kinds[idx];
            // Older items are more likely to be closed.
            let age = (FIXTURE_NOW - created_at) as f64 / span as f64;
            let closed = r.chance(0.25 + 0.6 * age);
            let updated = (FIXTURE_NOW - r.int(0, 600)).min(
                created_at + (r.next().powi(2) * (FIXTURE_NOW - created_at) as f64).floor() as i64,
            );
            let closed_at = closed.then_some(updated);
            let merged = kind == "pr" && closed && r.chance(0.8);
            let title = format!(
                "{} {} {}",
                r.pick(&VERBS),
                r.pick(&OBJECTS),
                r.pick(&QUALIFIERS)
            )
            .trim()
            .to_string();
            let body = words.issue_body(r);
            let state_reason = (closed && kind == "issue").then(|| {
                if r.chance(0.85) {
                    "completed"
                } else {
                    "not_planned"
                }
            });
            let author = if r.chance(0.7) {
                *r.pick(team)
            } else {
                *r.pick(&users)
            };
            let milestone = r.chance(0.3).then(|| *r.pick(&repo.milestones));
            let pr = kind == "pr";
            let pr_id = pr.then(|| {
                next_pr += 1;
                next_pr - 1
            });
            let draft = pr.then(|| r.chance(0.1));
            let review = pr.then(|| *r.pick(&["approved", "changes_requested", "review_required"]));
            let head = pr.then(|| format!("feature/{}", id % 1000));
            q::insert_item(
                tx,
                id,
                &format!("I_kw{}", radix36(id)),
                repo.id,
                idx as i64 + 1,
                kind,
                &title,
                &body,
                if closed { "closed" } else { "open" },
                state_reason,
                author,
                milestone,
                created_at,
                updated,
                closed_at,
                pr_id,
                draft,
                merged.then_some(updated),
                head.as_deref(),
                pr.then_some("main"),
                review,
                seq,
            )?;
            for &(lid, p) in &repo.labels {
                if r.chance(p) {
                    q::add_item_label(tx, id, lid)?;
                }
            }
            if r.chance(0.6) {
                let a = *r.pick(team);
                q::add_item_assignee(tx, id, a)?;
                if r.chance(0.2) {
                    q::add_item_assignee(tx, id, *r.pick(team))?;
                }
            }
            items.push(Item {
                id,
                repo: repo.id,
                kind,
                open: !closed,
                created: created_at,
                updated,
            });
        }
    }
    let issues: Vec<&Item> = items.iter().filter(|i| i.kind == "issue").collect();

    let mut default_order: Vec<&Item> = issues.iter().copied().filter(|i| i.open).collect();
    default_order.sort_by(|a, b| b.updated.cmp(&a.updated).then(b.id.cmp(&a.id)));
    let detail_targets: Vec<i64> = default_order.iter().take(40).map(|i| i.id).collect();

    // Comments: geometric around 5 per item.
    let mut next_comment = 2_000_000_000i64;
    let mut comment_total = 0;
    for it in &items {
        let count = if detail_targets.contains(&it.id) {
            30
        } else {
            ((-(1.0 - r.next()).ln() * 5.0).floor() as usize).min(80)
        };
        if count == 0 {
            continue;
        }
        let mut times: Vec<i64> = (0..count)
            .map(|_| it.created + (r.next() * (it.updated - it.created) as f64).floor() as i64)
            .collect();
        times.sort_unstable();
        for &t in &times {
            let cid = next_comment;
            next_comment += 1;
            let author = if r.chance(0.75) {
                *r.pick(team)
            } else {
                *r.pick(&users)
            };
            q::insert_comment(
                tx,
                cid,
                &format!("IC_kw{}", radix36(cid)),
                it.id,
                author,
                &words.comment_body(r),
                t,
                seq,
            )?;
        }
        q::set_comment_stats(tx, it.id, count as i64, *times.last().unwrap())?;
        comment_total += count;
    }

    // Relationships.
    let by_repo =
        |repo: i64| -> Vec<&Item> { issues.iter().copied().filter(|i| i.repo == repo).collect() };
    let repo_issues: Vec<(i64, Vec<&Item>)> =
        repos.iter().map(|rp| (rp.id, by_repo(rp.id))).collect();
    let in_repo =
        |repo: i64| -> &Vec<&Item> { &repo_issues.iter().find(|(id, _)| *id == repo).unwrap().1 };
    let other_repo_issue = |r: &mut Rng, repo: i64| -> i64 {
        let others: Vec<&(i64, Vec<&Item>)> =
            repo_issues.iter().filter(|(id, _)| *id != repo).collect();
        let (_, list) = r.pick(&others);
        r.pick(list).id
    };
    let (mut sub, mut blocks, mut relates, mut closes) = (0, 0, 0, 0);
    let mut has_parent = std::collections::HashSet::new();
    for parent in &issues {
        if !r.chance(0.03) {
            continue;
        }
        let kids = r.int(2, 10);
        let mut position = 1.0;
        for _ in 0..kids {
            let child = if r.chance(0.9) {
                r.pick(in_repo(parent.repo)).id
            } else {
                other_repo_issue(r, parent.repo)
            };
            if child == parent.id || !has_parent.insert(child) {
                continue;
            }
            q::add_relationship(tx, "sub", parent.id, child, Some(position), seq)?;
            position += 1.0;
            sub += 1;
        }
    }
    for it in &issues {
        if r.chance(0.05) {
            for _ in 0..r.int(1, 3) {
                let blocker = if r.chance(0.85) {
                    r.pick(in_repo(it.repo)).id
                } else {
                    other_repo_issue(r, it.repo)
                };
                if blocker != it.id {
                    blocks += q::add_relationship(tx, "blocks", blocker, it.id, None, seq)?;
                }
            }
        }
        if r.chance(0.04) {
            for _ in 0..r.int(1, 2) {
                let other = if r.chance(0.8) {
                    r.pick(in_repo(it.repo)).id
                } else {
                    other_repo_issue(r, it.repo)
                };
                if other != it.id {
                    relates += q::add_relationship(
                        tx,
                        "relates",
                        it.id.min(other),
                        it.id.max(other),
                        None,
                        seq,
                    )?;
                }
            }
        }
    }

    // Linked PRs: some PRs close an issue in their repo.
    for pr in items.iter().filter(|i| i.kind == "pr") {
        if r.chance(0.3) {
            closes +=
                q::add_relationship(tx, "closes", pr.id, r.pick(in_repo(pr.repo)).id, None, seq)?;
        }
    }

    // Stubs: issues in the unsynced repo, reached only through relationships.
    let mut stubs = Vec::new();
    for s in 0..40 {
        let id = next_item;
        next_item += 1;
        let title = format!("{} {} in the SDK", r.pick(&VERBS), r.pick(&OBJECTS));
        let state = if r.chance(0.6) { "open" } else { "closed" };
        q::insert_stub(
            tx,
            id,
            &format!("I_kw{}", radix36(id)),
            unsynced_repo,
            100 + s * 7,
            &title,
            state,
            seq,
        )?;
        stubs.push(id);
    }
    let mut stub_edges = 0;
    for _ in 0..60 {
        let it = r.pick(&issues).id;
        let stub = *r.pick(&stubs);
        let kind = *r.pick(&["blocks", "relates", "blocks"]);
        let (src, dst) = if kind == "relates" {
            (it.min(stub), it.max(stub))
        } else if r.chance(0.5) {
            (stub, it)
        } else {
            (it, stub)
        };
        stub_edges += q::add_relationship(tx, kind, src, dst, None, seq)?;
    }

    Ok(Summary {
        issues: issues.len(),
        prs: items.len() - issues.len(),
        stubs: stubs.len(),
        stub_ids: stubs,
        comments: comment_total,
        sub,
        blocks,
        relates,
        closes,
        stub_edges,
        open_issues: default_order.len(),
        detail_targets,
    })
}

fn radix36(mut n: i64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}
