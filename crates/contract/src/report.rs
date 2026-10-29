//! The report: drift, coverage gaps and notes as Markdown, and the one "Contract drift" issue on
//! the sandbox it goes to. The issue's body keeps when each webhook event and action was last
//! seen, so a nightly run, which sees only the App's last 3 days of deliveries, can tell which
//! went unseen for 14.

use crate::check::Findings;
use crate::http::{Extra, Http};
use crate::run::{now, rfc3339};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The drift issue's title, on the sandbox.
pub const ISSUE_TITLE: &str = "Contract drift";
/// How long a webhook event and action may go unseen before it's a coverage gap.
pub const GAP_AFTER: i64 = 14 * 24 * 60 * 60;
const STATE_OPEN: &str = "<!-- contract-state ";
const STATE_CLOSE: &str = " -->";

/// Webhook events and actions neither real traffic nor the write run can produce
/// (docs/research/contract-check-shapes.md, "none"): deleting or transferring an issue,
/// archiving or renaming a repo, revoking a grant, and installing the App. Their templates are
/// recorded by hand before releases, so going unseen isn't a gap.
pub const BY_HAND: [&str; 6] = [
    "issues.deleted",
    "issues.transferred",
    "repository.",
    "github_app_authorization.",
    "installation.",
    "installation_repositories.",
];

fn by_hand(pair: &str) -> bool {
    BY_HAND.iter().any(|p| {
        if p.ends_with('.') {
            pair.starts_with(p)
        } else {
            pair == *p
        }
    })
}

/// The webhook events and actions with a template that weren't seen since `GAP_AFTER` ago:
/// each with when it last was, if ever. Those only made by hand ([`BY_HAND`]) aren't gaps.
pub fn gaps(
    pairs: &[String],
    last_seen: &BTreeMap<String, String>,
) -> Vec<(String, Option<String>)> {
    let since = rfc3339(now() - GAP_AFTER);
    pairs
        .iter()
        .filter(|p| !by_hand(p))
        .filter_map(|p| match last_seen.get(p) {
            Some(at) if *at >= since => None,
            at => Some((p.clone(), at.cloned())),
        })
        .collect()
}

/// The report as Markdown: drift first, then the coverage gaps under their own heading, then
/// the notes. `gaps` is None for a run that doesn't look at webhooks (the write run).
pub fn markdown(
    run: &str,
    target: &str,
    found: &Findings,
    gaps: Option<&[(String, Option<String>)]>,
) -> String {
    let mut out = format!(
        "## Contract check: {run} run against {target}, {}\n\n{} templates checked.\n",
        rfc3339(now()),
        found.checked.len()
    );
    out.push_str("\n### Drift\n\n");
    if found.drift.is_empty() && found.left_changed.is_empty() {
        out.push_str("None.\n");
    }
    for d in &found.drift {
        out.push_str(&format!(
            "- `{}` (`{}`): {}\n",
            d.request, d.template, d.what
        ));
    }
    if !found.left_changed.is_empty() {
        out.push_str("- The write run left the sandbox changed:\n");
        for l in &found.left_changed {
            out.push_str(&format!("  - {l}\n"));
        }
    }
    if let Some(gaps) = gaps {
        out.push_str("\n### Coverage gaps\n\n");
        if gaps.is_empty() {
            out.push_str("None: every webhook event and action with a template was seen in the last 14 days.\n");
        } else {
            out.push_str(
                "Webhook events and actions with a template that no delivery showed in the last 14 days (not drift; the next write run or real traffic may cover them):\n\n",
            );
            for (pair, at) in gaps {
                let when = at
                    .as_deref()
                    .map_or("never seen".to_owned(), |a| format!("last seen {a}"));
                out.push_str(&format!("- `{pair}` ({when})\n"));
            }
        }
    }
    if !found.notes.is_empty() {
        out.push_str("\n### Notes\n\n");
        for n in &found.notes {
            out.push_str(&format!("- {n}\n"));
        }
    }
    out
}

/// What the drift issue's body keeps between runs.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct State {
    /// When each webhook event and action was last seen.
    #[serde(default)]
    pub last_seen: BTreeMap<String, String>,
    /// The coverage gaps the last report listed: a run comments on gaps only when they change.
    #[serde(default)]
    pub gaps: Vec<String>,
    /// The drift each run (`read`, `write`) last reported, as a fingerprint: a run comments on
    /// the same drift once, not every night (it still fails).
    #[serde(default)]
    pub drift: BTreeMap<String, String>,
}

/// A stable fingerprint of `lines` (FNV-1a, hex): the same drift gives the same one on every
/// run and Rust version.
pub fn fingerprint(lines: &[String]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in lines.join("\n").bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub fn read_state(body: &str) -> State {
    body.split_once(STATE_OPEN)
        .and_then(|(_, rest)| rest.split_once(STATE_CLOSE))
        .and_then(|(json, _)| serde_json::from_str(json).ok())
        .unwrap_or_default()
}

fn issue_body(state: &State) -> String {
    format!(
        "beghu's contract check (`crates/contract`, `.github/workflows/contract.yml`) diffs GitHub's \
answers with Fake GitHub's recorded templates (`crates/fake-github/templates/`). A run that finds \
drift or coverage gaps comments here, and drift also fails the run. Fix the fake and its template \
(`./dev-ctl contract record`), then close this issue; the next drift reopens it.\n\n\
{STATE_OPEN}{}{STATE_CLOSE}\n",
        serde_json::to_string(state).unwrap_or_default()
    )
}

/// The drift issue on `sandbox`: its number, state and body; None when there's none yet.
pub async fn find_issue(
    http: &Http,
    token: &str,
    sandbox: &str,
) -> Result<Option<(i64, String, String)>, String> {
    let mut next = Some(format!(
        "/repos/{sandbox}/issues?state=all&sort=updated&direction=asc&per_page=100"
    ));
    let mut pages = 0;
    while let Some(path) = next.take() {
        let a = http.get(&path, token).await?;
        if a.status != 200 {
            return Err(format!("listing {sandbox}'s issues answered {}", a.status));
        }
        for i in a.body.as_array().into_iter().flatten() {
            if i["title"] == ISSUE_TITLE && i.get("pull_request").is_none() {
                return Ok(Some((
                    i["number"].as_i64().unwrap_or_default(),
                    i["state"].as_str().unwrap_or_default().to_owned(),
                    i["body"].as_str().unwrap_or_default().to_owned(),
                )));
            }
        }
        pages += 1;
        if pages < 50 {
            next = a.next;
        }
    }
    Ok(None)
}

/// Posts `run`'s report: keeps `state` in the issue's body, and comments `report` when there's
/// drift it hasn't reported yet (or the issue was closed since) or the coverage gaps changed,
/// reopening the issue for drift. Opens the issue the first time.
pub async fn post(
    http: &Http,
    token: &str,
    sandbox: &str,
    run: &str,
    report: &str,
    drift: bool,
    state: &State,
) -> Result<i64, String> {
    let call = |method: Method, path: String, body: Value| async move {
        let a = http
            .call(
                method.clone(),
                &path,
                Some(token),
                Extra {
                    body: Some(&body),
                    ..Extra::default()
                },
            )
            .await?;
        if !(200..300).contains(&a.status) {
            return Err(format!("{method} {path} answered {}: {}", a.status, a.body));
        }
        Ok(a.body)
    };
    let body = issue_body(state);
    let mut gaps_changed = !state.gaps.is_empty();
    let mut drift_new = drift;
    let number = match find_issue(http, token, sandbox).await? {
        Some((n, open, old)) => {
            let was = read_state(&old);
            gaps_changed = was.gaps != state.gaps;
            // The same drift again, on an issue still open: said already.
            drift_new = drift && (open != "open" || was.drift.get(run) != state.drift.get(run));
            let mut patch = serde_json::Map::new();
            if old != body {
                patch.insert("body".into(), json!(body));
            }
            if drift && open != "open" {
                patch.insert("state".into(), json!("open"));
            }
            if !patch.is_empty() {
                call(
                    Method::PATCH,
                    format!("/repos/{sandbox}/issues/{n}"),
                    Value::Object(patch),
                )
                .await?;
            }
            n
        }
        None => {
            let made = call(
                Method::POST,
                format!("/repos/{sandbox}/issues"),
                json!({ "title": ISSUE_TITLE, "body": body }),
            )
            .await?;
            made["number"].as_i64().unwrap_or_default()
        }
    };
    if drift_new || gaps_changed {
        call(
            Method::POST,
            format!("/repos/{sandbox}/issues/{number}/comments"),
            json!({ "body": report }),
        )
        .await?;
    }
    Ok(number)
}
