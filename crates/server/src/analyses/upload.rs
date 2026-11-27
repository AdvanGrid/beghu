//! `POST /api/runs/{token}/analysis`: an upload. The body is the analysis JSON, gzipped or not
//! (`Content-Encoding: gzip`), at most 8 MB on the wire and 32 MB inflated, enforced while it
//! arrives and while it inflates. `Beghu-Snippets: checked | not-checked` says whether the
//! uploader's tool checked every snippet against the checkouts; it's required, and anything else
//! is a 400 before the body is read, which isn't counted as a refused upload.
//!
//! Two uploads at a time do the heavy work (inflating, the checks, the split and compressing,
//! [`super::Store::uploads`]); the others wait for a turn with their bodies read. From its turn
//! on, an upload is a job of its own, which the request waits for: a client that leaves once it
//! has its turn doesn't stop it, so its turn and its PR's lock are held until its work is done.
//! One that leaves while it waits for a turn leaves nothing behind.
//!
//! The checks, in order, each answering as it fails:
//!
//! 1. the limits (413);
//! 2. the validator with no reader: shape, references, every rule that needs no code, after
//!    migrating an older version (422; a newer one is `version.unknown`);
//! 3. the head SHA against the pinned one (409);
//! 4. every pinned changed file placed (`file.unplaced`), the description's and issues' quotes
//!    word for word against what the run pinned (`evidence.quote-mismatch`), issue evidence only
//!    from issues the run served (`evidence.issue-not-served`), and `carried` against the PR's
//!    stored analysis, both at this build's schema (`carry.*`; with none stored, `carried` must
//!    be empty) (422).
//!
//! The validator runs once, with all it needs; its findings are answered in that order. An
//! accepted upload replaces the PR's analysis (201, with its ID, the head and the warnings,
//! which never refuse), if its run is still live as it's written: a run superseded, ended or
//! expired while the upload was being checked stores nothing, and the upload is told why (410).
//! A refused one stores nothing, counts on the run, and keeps its report there. Either way the
//! account's streams hear it.

use super::runs::{Admitted, Ended, RunError, admit, deadline, end, gone};
use super::stored::{self, Envelope};
use super::{MAX_INFLATED, MAX_WIRE, announce, new_id, pause, pin};
use crate::{App, RunPausePoint, now};
use analysis::{Analysis, Context, Evidence, PinnedPr, Previous, PreviousIds, Report, Vocabulary};
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt as _;
use serde::Serialize;
use std::io::Read as _;
use ts_rs::TS;

/// A description or issue quote that isn't word for word in what the run pinned (server only).
pub const QUOTE_MISMATCH: &str = "evidence.quote-mismatch";
/// Issue evidence from an issue the run didn't serve (server only).
pub const ISSUE_NOT_SERVED: &str = "evidence.issue-not-served";

/// The validator's rules that the server answers after the head check: they need what the run
/// pinned (`file.unplaced`) or the PR's stored analysis (`carry.*`).
fn after_head(rule: &str) -> bool {
    rule == analysis::rule::FILE_UNPLACED || rule.starts_with("carry.")
}

/// An accepted upload's answer.
#[derive(Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Accepted {
    /// The analysis's ID.
    pub analysis: String,
    pub head_sha: String,
    /// The validator's warnings (`schema.migrated` among them): stored, never shown.
    #[ts(type = "Array<{ path: string, rule: string, message: string }>")]
    pub warnings: Vec<analysis::Finding>,
}

/// `POST /api/runs/{token}/analysis`.
pub async fn upload(
    State(app): State<App>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let a = match admit(&app, &token, &headers).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    let got = match receive(&app, &a, &headers, body).await {
        Ok(got) => got,
        Err(e) => return answer(&app, &a, e).await,
    };
    // Waited for in the request: a client that leaves before its turn leaves nothing behind.
    let Ok(turn) = app.analyses().uploads.clone().acquire_owned().await else {
        return RunError::Internal("the uploads' turns closed".into()).into_response();
    };
    // From its turn on, the job owns it. Waited for to its end by the drain, too: cut short, the
    // agent's work would be lost.
    let job = app.jobs().spawn_whole({
        let app = app.clone();
        async move {
            match take(&app, &a, got, turn).await {
                Ok(res) => res,
                Err(e) => answer(&app, &a, e).await,
            }
        }
    });
    match job {
        Some(job) => job.await.unwrap_or_else(|_| {
            RunError::Internal("an upload's job panicked".into()).into_response()
        }),
        None => RunError::from(crate::tokens::Error::Restarting).into_response(),
    }
}

/// The failed upload's answer: a refused one counts on the run ([`refused`]).
async fn answer(app: &App, a: &Admitted, e: RunError) -> Response {
    let counts = matches!(
        e,
        RunError::Refused { .. } | RunError::HeadMoved { .. } | RunError::TooLarge
    );
    let res = e.into_response();
    if counts {
        refused(app, a, res).await
    } else {
        res
    }
}

/// A refused upload counts on the run, which keeps its answer as the last report, and how many
/// errors it had for the PR panel (a 422's report's, or 1 for a 409 or 413, which have one
/// problem each); the account's streams hear it. The answer goes out as it was.
async fn refused(app: &App, a: &Admitted, res: Response) -> Response {
    let (parts, body) = res.into_parts();
    let bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();
    let report = String::from_utf8_lossy(&bytes).into_owned();
    let errors = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v["report"]["errors"].as_array().map(|e| e.len() as i64))
        .unwrap_or(1)
        .max(1);
    let id = a.run.id.clone();
    match app
        .analyses()
        .dbs
        .write(a.account, move |tx| {
            analysis_db::q::refuse_upload(tx, &id, &report, errors)
        })
        .await
    {
        Ok(_) => announce(app, a.account, &a.repo(), a.run.number, None),
        Err(e) => eprintln!(
            "account {}: counting a refused upload on run {}: {e}",
            a.account, a.run.id
        ),
    }
    Response::from_parts(parts, Body::from(bytes))
}

/// How the body is encoded.
enum Encoding {
    Identity,
    Gzip,
}

/// An upload as it arrived, before its turn: its body read, and what the run pinned.
struct Received {
    snippets: &'static str,
    pinned: PinnedPr,
    encoding: Encoding,
    wire: Vec<u8>,
}

/// The upload's headers checked, the run's pin read, and its body read.
async fn receive(
    app: &App,
    a: &Admitted,
    headers: &HeaderMap,
    body: Body,
) -> Result<Received, RunError> {
    let snippets = match headers.get("beghu-snippets").map(|v| v.to_str()) {
        Some(Ok("checked")) => "checked",
        Some(Ok("not-checked")) => "not-checked",
        None => {
            return Err(RunError::BadRequest(
                "The upload needs a Beghu-Snippets header: `checked` once validate.mjs passed against the checkouts, `not-checked` otherwise.".into(),
            ));
        }
        Some(_) => {
            return Err(RunError::BadRequest(
                "Beghu-Snippets is `checked` (validate.mjs passed against the checkouts) or `not-checked`, nothing else.".into(),
            ));
        }
    };
    let pinned = pin::pinned(app, a).await?;
    let encoding = match headers
        .get(header::CONTENT_ENCODING)
        .map(|v| v.to_str().map(str::trim))
    {
        None | Some(Ok("" | "identity")) => Encoding::Identity,
        Some(Ok(e)) if e.eq_ignore_ascii_case("gzip") => Encoding::Gzip,
        Some(_) => return Err(RunError::Encoding),
    };
    let wire = read_body(body).await?;
    Ok(Received {
        snippets,
        pinned,
        encoding,
        wire,
    })
}

/// The heavy work, in its `turn`: inflating, the checks under the PR's lock, and the store.
async fn take(
    app: &App,
    a: &Admitted,
    got: Received,
    turn: tokio::sync::OwnedSemaphorePermit,
) -> Result<Response, RunError> {
    let Received {
        snippets,
        pinned,
        encoding,
        wire,
    } = got;
    // Held to the end: the store below is quick, and the turn covers the split's compressing.
    let _turn = turn;
    // The body as it came, kept gzipped with an accepted analysis (`upload_gz`): a gzip body as
    // it is, a plain one compressed once it's accepted.
    let (text, upload_gz) = match encoding {
        Encoding::Identity => (wire, None),
        Encoding::Gzip => {
            tokio::task::spawn_blocking(move || inflate(&wire).map(|t| (t, Some(wire))))
                .await
                .map_err(|_| RunError::Internal("inflating an upload panicked".into()))??
        }
    };

    let pr = a.pr();
    let _held = app.analyses().lock(&pr).await;
    stored::migrate_if_behind(app, &pr).await?;
    let previous = match stored::whole(app, &pr).await? {
        None => Previous::None,
        Some(p) => Previous::Some {
            ids: PreviousIds::of(&p),
            vocabulary: Vocabulary::of(&p),
        },
    };
    let chain = app.analyses().chain;
    let pinned_for_check = pinned.clone();
    let (checked, text) = tokio::task::spawn_blocking(move || {
        let value: serde_json::Value = match serde_json::from_slice(&text) {
            Ok(v) => v,
            // The validator says what's wrong with it, as `shape.json`.
            Err(_) => {
                let out =
                    analysis::validate(&String::from_utf8_lossy(&text), &Context::default(), None);
                return (out, text);
            }
        };
        let ctx = Context {
            changed_files: Some(
                pinned_for_check
                    .files
                    .iter()
                    .map(|f| f.path.clone())
                    .collect(),
            ),
            previous,
        };
        let mut out = analysis::validate_with(chain, value, &ctx, None);
        if let Some(an) = &out.analysis {
            out.report
                .errors
                .extend(quotes(an, &pinned_for_check).errors);
        }
        (out, text)
    })
    .await
    .map_err(|_| RunError::Internal("checking an upload panicked".into()))?;

    let migrated = checked
        .from_version
        .filter(|v| *v < chain.version)
        .map(|v| (v, chain.version));
    let refuse = |report: Report| RunError::Refused { report, migrated };
    let Some(an) = checked.analysis.clone() else {
        return Err(refuse(checked.report));
    };
    let shape_errors =
        checked.report.errors.iter().any(|f| {
            !after_head(&f.rule) && f.rule != QUOTE_MISMATCH && f.rule != ISSUE_NOT_SERVED
        });
    if shape_errors {
        return Err(refuse(checked.report));
    }
    if an.pr.head_sha != pinned.head_sha {
        return Err(RunError::HeadMoved {
            pinned: pinned.head_sha,
        });
    }
    if !checked.report.errors.is_empty() {
        return Err(refuse(checked.report));
    }
    let upload = Upload {
        text,
        gz: upload_gz,
    };
    accept(
        app,
        a,
        an,
        checked.report,
        checked.renames,
        snippets,
        upload,
    )
    .await
}

/// The upload's body, kept with the analysis it made: inflated, and as it came when gzipped.
struct Upload {
    text: Vec<u8>,
    gz: Option<Vec<u8>>,
}

/// Stores the accepted analysis in place of the PR's, and answers 201.
async fn accept(
    app: &App,
    a: &Admitted,
    an: Analysis,
    report: Report,
    renames: Vec<analysis::Rename>,
    snippets: &'static str,
    upload: Upload,
) -> Result<Response, RunError> {
    let (parts, purposes, conflicts) = stored::counts(&an);
    let ids: Vec<serde_json::Value> = renames
        .iter()
        .map(|r| serde_json::json!({ "old": r.old, "new": r.new, "step": r.step }))
        .collect();
    let env = Envelope {
        id: new_id(),
        version: an.version,
        owner: a.run.owner.clone(),
        name: a.run.name.clone(),
        number: a.run.number,
        head_sha: an.pr.head_sha.clone(),
        merge_base: an.pr.base_sha.clone(),
        created_at: now(),
        snippets: snippets.to_owned(),
        migrated_ids: serde_json::Value::Array(ids),
    };
    let warnings = report.warnings;
    let (id, head) = (env.id.clone(), env.head_sha.clone());
    let blobs = tokio::task::spawn_blocking(move || {
        let value = serde_json::to_value(&an).expect("the schema's types serialise");
        let upload_gz = upload.gz.unwrap_or_else(|| stored::gzip9(&upload.text));
        (stored::split(value, &env), env, upload_gz)
    })
    .await
    .map_err(|_| RunError::Internal("splitting an upload panicked".into()))?;
    let (blobs, env, upload_gz) = blobs;
    let warnings_json = serde_json::to_string(&warnings).expect("plain data");
    let (run, repo_id) = (a.run.id.clone(), a.run.repo_id);
    let lifetimes = app.cfg().runs.clone();
    pause(app, RunPausePoint::Store).await;
    let t = now();
    // Only while the run is live, checked in the write: the checks took a while, and a newer
    // run, an end or the run's deadline may have come meanwhile.
    let stored = app
        .analyses()
        .dbs
        .write(a.account, move |tx| {
            match analysis_db::q::run(tx, &run)? {
                None => return Ok(Store::Gone),
                Some(r) if r.ended_reason.is_some() => {
                    return Ok(Store::Ended(Ended::from_db(
                        r.ended_reason.as_deref().unwrap_or(""),
                    )));
                }
                Some(r) if t >= deadline(&lifetimes, &r) => return Ok(Store::Expired(Box::new(r))),
                Some(_) => {}
            }
            analysis_db::q::put_analysis(
                tx,
                &env.id,
                repo_id,
                &env.owner,
                &env.name,
                env.number,
                i64::from(env.version),
                &env.head_sha,
                &env.merge_base,
                env.created_at,
                &run,
                &env.snippets,
                &warnings_json,
                parts,
                purposes,
                conflicts,
                &env.migrated_ids.to_string(),
                &blobs.graph_br,
                &blobs.graph_gz,
                &blobs.claims_br,
                &blobs.claims_gz,
                &upload_gz,
            )?;
            analysis_db::q::accept_upload(tx, &run)?;
            analysis_db::q::delete_pr_behind(tx, repo_id, env.number)?;
            Ok(Store::Stored)
        })
        .await?;
    match stored {
        Store::Stored => {}
        Store::Ended(why) => return Err(RunError::Ended(why)),
        Store::Expired(row) => return Err(end(app, a.account, &row, Ended::Expired).await),
        // Deleted with its repo's analyses: its token says why.
        Store::Gone => return Err(gone(app, &a.run.id).await),
    }
    eprintln!(
        "account {}: an analysis of {}#{} was accepted ({id})",
        a.account,
        a.repo(),
        a.run.number
    );
    announce(app, a.account, &a.repo(), a.run.number, Some(id.clone()));
    Ok((
        StatusCode::CREATED,
        Json(Accepted {
            analysis: id,
            head_sha: head,
            warnings,
        }),
    )
        .into_response())
}

/// What the accepted upload's write found of its run.
enum Store {
    Stored,
    Ended(Ended),
    Expired(Box<analysis_db::q::RunRow>),
    Gone,
}

/// The body as it came, refused past [`MAX_WIRE`] as soon as it passes it.
async fn read_body(body: Body) -> Result<Vec<u8>, RunError> {
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| RunError::BadRequest(format!("the upload didn't arrive: {e}")))?;
        if out.len() + chunk.len() > MAX_WIRE {
            return Err(RunError::TooLarge);
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// A gzipped body inflated, refused past [`MAX_INFLATED`] as soon as it passes it.
fn inflate(gz: &[u8]) -> Result<Vec<u8>, RunError> {
    let mut out = Vec::new();
    flate2::read::MultiGzDecoder::new(gz)
        .take(MAX_INFLATED as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| RunError::BadRequest(format!("the gzip body doesn't inflate: {e}")))?;
    if out.len() > MAX_INFLATED {
        return Err(RunError::TooLarge);
    }
    Ok(out)
}

/// `quote` appears in `text` word for word: the same words in the same order, whatever the
/// whitespace between them.
fn quoted(text: &str, quote: &str) -> bool {
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let q = words(quote);
    !q.is_empty() && words(text).contains(&q)
}

/// The quote checks: every description quote is in the pinned description, and every issue
/// quote is in the body or a comment of an issue the run served.
fn quotes(a: &Analysis, pinned: &PinnedPr) -> Report {
    let mut r = Report::default();
    for (i, claim) in a.claims.iter().enumerate() {
        for (j, ev) in claim.evidence.iter().enumerate() {
            let at = format!("/claims/{i}/evidence/{j}");
            match ev {
                Evidence::Code { .. } => {}
                Evidence::Description { quote, .. } => {
                    if !quoted(&pinned.body, quote) {
                        r.error(
                            format!("{at}/quote"),
                            QUOTE_MISMATCH,
                            "not word for word in the PR's description as the run pinned it",
                        );
                    }
                }
                Evidence::Issue {
                    repo,
                    number,
                    quote,
                    ..
                } => {
                    let served = pinned
                        .issues
                        .iter()
                        .find(|s| s.repo.eq_ignore_ascii_case(repo) && s.number == *number);
                    match served {
                        None => r.error(
                            format!("{at}/number"),
                            ISSUE_NOT_SERVED,
                            format!("{repo}#{number} isn't one of the issues the run served (`pr.json`'s `issues`)"),
                        ),
                        Some(s) => {
                            if !quoted(&s.body, quote)
                                && !s.comments.iter().any(|c| quoted(&c.body, quote))
                            {
                                r.error(
                                    format!("{at}/quote"),
                                    QUOTE_MISMATCH,
                                    format!("not word for word in {repo}#{number}'s body or comments as the run served them"),
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    r
}
