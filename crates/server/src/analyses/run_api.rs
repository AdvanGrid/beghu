//! The run API, under `/api/runs/{token}/`: what an agent fetches and posts within a run. The
//! token is the run's capability, so these routes sit outside the browser session's gate and its
//! `Origin` check (an agent calls them with `curl`), and each call is let in by
//! [`admit`](super::runs::admit). The first fetch of any file pins the PR ([`pin`]).
//!
//! - `instructions`: `ANALYSIS.md` under a run header ([`header`]).
//! - `pr.json`: the pinned PR.
//! - `schema.ts`: the analysis's schema, generated from the analysis crate.
//! - `validate.mjs`, `merge.mjs`: the agent's tools, built from this server's commit.
//! - `previous-ids.json`, `vocabulary.json`: the skeleton and vocabulary of the PR's stored
//!   analysis (migrated first), or 404 when it has none. There is no `previous.json`: the agent
//!   mustn't copy claims it hasn't checked again.
//! - `POST analysis`: an upload ([`super::upload`]).
//! - `POST end`: ends the run.

use super::pin;
use super::runs::{Admitted, Ended, Producer, RunError, admit, end, size_line};
use super::stored;
use crate::App;
use analysis::{PinnedPr, PreviousIds, Vocabulary};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

/// `GET /api/runs/{token}/{file}`.
pub async fn file(
    State(app): State<App>,
    Path((token, file)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    match serve(&app, &token, &file, &headers).await {
        Ok(res) => res,
        Err(e) => e.into_response(),
    }
}

async fn serve(
    app: &App,
    token: &str,
    file: &str,
    headers: &HeaderMap,
) -> Result<Response, RunError> {
    const FILES: [&str; 7] = [
        "instructions",
        "pr.json",
        "schema.ts",
        "validate.mjs",
        "merge.mjs",
        "previous-ids.json",
        "vocabulary.json",
    ];
    if !FILES.contains(&file) {
        return Err(RunError::NotFound("No such run file."));
    }
    let a = admit(app, token, headers).await?;
    let pinned = pin::pinned(app, &a).await?;
    Ok(match file {
        "instructions" => text(
            "text/markdown; charset=utf-8",
            format!(
                "{}\n{}",
                header(app, &a, &pinned, token),
                analysis::INSTRUCTIONS
            ),
        ),
        "pr.json" => json(serde_json::to_string_pretty(&pinned).expect("plain data")),
        "schema.ts" => text("text/plain; charset=utf-8", analysis::SCHEMA_TS.to_owned()),
        "validate.mjs" | "merge.mjs" => {
            let Some(tools) = app.analyses().tools() else {
                return Err(RunError::Unavailable {
                    retry_after: std::time::Duration::from_secs(60),
                    why: "This beghu was started without the agent's tools (BEGHU_ANALYSIS_DIR)."
                        .into(),
                });
            };
            let bytes = if file == "validate.mjs" {
                tools.validate.clone()
            } else {
                tools.merge.clone()
            };
            // `Bytes` is shared, not copied: every fetch serves the one read at startup.
            let mut res = axum::body::Body::from(bytes).into_response();
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/javascript; charset=utf-8"),
            );
            res
        }
        _ => {
            let Some(prev) = stored::previous(app, &a.pr()).await? else {
                return Err(RunError::NotFound(
                    "This PR has no previous analysis: `carried` must be empty.",
                ));
            };
            if file == "previous-ids.json" {
                json(serde_json::to_string_pretty(&PreviousIds::of(&prev)).expect("plain data"))
            } else {
                json(serde_json::to_string_pretty(&Vocabulary::of(&prev)).expect("plain data"))
            }
        }
    })
}

fn text(content_type: &'static str, body: String) -> Response {
    let mut res = body.into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

fn json(body: String) -> Response {
    text("application/json", body)
}

/// `POST /api/runs/{token}/end`: ends the run. 204, and 410 for a run that had ended already.
pub async fn end_run(
    State(app): State<App>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    match admit(&app, &token, &headers).await {
        Ok(a) => {
            end(&app, a.account, &a.run, Ended::ByUser).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => e.into_response(),
    }
}

/// The run header above `ANALYSIS.md`: the PR, the pinned SHAs, the size, every limit, the
/// deploy's build, and how to fetch the run's files and upload. A button run's agent gets URLs;
/// a CLI run's, the CLI's commands.
fn header(app: &App, a: &Admitted, pr: &PinnedPr, token: &str) -> String {
    let base = format!("{}/api/runs/{token}", app.cfg().public_url);
    let size = size_line(
        i64::from(pr.stats.files),
        i64::from(pr.stats.additions),
        i64::from(pr.stats.deletions),
    );
    let mut h = format!(
        "# beghu analysis run

- **PR:** {repo}#{number}, \"{title}\" ({url})
- **Size:** {size}
- **Head:** `{head}` (pinned: analyse this commit; a push since doesn't change it)
- **Base:** `{base_ref}` at `{base_sha}` (its tip when the run pinned)
- **beghu build:** `{build}`
- **Limits:** a PR of at most 3,000 changed files; an upload of at most 8 MB on the wire and 32 MB
  inflated; the schema version is {version}. The run expires after {idle} h with no call, and {lives}
  days after it started at the most; a newer run for this PR replaces it.
",
        repo = pr.repo,
        number = pr.number,
        title = pr.title,
        url = pr.url,
        head = pr.head_sha,
        base_ref = pr.base.reference,
        base_sha = pr.base.sha,
        build = app.cfg().build_id,
        version = analysis::VERSION,
        idle = app.cfg().runs.idle_for.as_secs() / 3600,
        lives = app.cfg().runs.lives_for.as_secs() / 86_400,
    );
    match Producer::of(&a.run) {
        Producer::Button => h.push_str(&format!(
            "
## This run's files

Fetch each with `curl -fsS -o <file> {base}/<file>`:

- `{base}/pr.json`: the pinned PR, its changed files and the issues you may quote
- `{base}/schema.ts`: the analysis's schema; read it first
- `{base}/validate.mjs` and `{base}/merge.mjs`: the tools (Node, nothing to install)
- `{base}/previous-ids.json` and `{base}/vocabulary.json`: the previous analysis's IDs and
  vocabulary; `404` when there is none, and then `carried` stays empty

## Upload

```sh
gzip -c analysis.json > analysis.json.gz
curl -sS -X POST --data-binary @analysis.json.gz \\
  -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' \\
  -H 'Beghu-Snippets: checked' {base}/analysis
```

Always send the `Beghu-Snippets` header: `checked` only once `validate.mjs` passed against the
checkouts, and `not-checked` otherwise (without Node, or when it didn't pass), when the reader sees
the evidence as not checked. The answer: `201` (accepted, with the analysis ID and any warnings),
`422` (the error report; fix and upload again), `409` (not the pinned head), `413` (too large),
`400` (no `Beghu-Snippets`, or another value), `410` (the run ended; ask for a new one).
Uploads are unlimited while the run lasts; each accepted one replaces the PR's analysis. Beyond
the validator's rules the server checks `evidence.quote-mismatch` (a description or issue quote
that isn't word for word in `pr.json`) and `evidence.issue-not-served` (issue evidence from an
issue `pr.json` doesn't list).

When you're done, end the run: `curl -sS -X POST {base}/end`.
"
        )),
        Producer::Cli => h.push_str(&format!(
            "
## This run's files and commands

`beghu analyse` wrote this run's files to `.beghu/run-{run}/` in the folder it ran in: these
instructions, `pr.json`, `schema.ts`, and `previous-ids.json` and `vocabulary.json` when there is
a previous analysis (with neither, `carried` stays empty). Run every command below from that
folder: each finds its run in `.beghu/`, so you never handle a token or a URL. Check the code out
there too, as `base` and `head` (see \"The checkout\"), or give `--base <dir> --head <dir>` to
`check` and `upload`.

The CLI is the tools: where these instructions say `node validate.mjs` or `node merge.mjs`, run
`beghu analyse` instead. It needs no Node, and finds `pr.json` and the previous analysis itself.

- Check the split: `beghu analyse check-split split.json` (the skeleton is `skeleton.json`, or
  `--skeleton <file>`).
- Merge: `beghu analyse merge --split split.json skeleton.json area-1.json ... > merged.json`,
  then `beghu analyse merge --finish merged.json > analysis.json`.
- Validate: `beghu analyse check analysis.json`, the full validator, snippet check included.
- Upload: `beghu analyse upload analysis.json`. It runs `check` first and refuses on any error,
  and sends `Beghu-Snippets: checked` itself. The answer: accepted, with the analysis ID and any
  warnings; refused with the server's report (fix and upload again); or the run ended.
- When you're done, end the run: `beghu analyse end`.

Uploads are unlimited while the run lasts; each accepted one replaces the PR's analysis. Beyond
the validator's rules the server checks `evidence.quote-mismatch` (a description or issue quote
that isn't word for word in `pr.json`) and `evidence.issue-not-served` (issue evidence from an
issue `pr.json` doesn't list).
",
            run = a.run.id
        )),
    }
    h
}
