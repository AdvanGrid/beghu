//! Pinning: the first fetch of any of a run's files fixes what the run is about, as `pr.json`.
//! From GitHub, with the account's own token: the head SHA, the base branch and its tip, the
//! title, the description, the author, the size and the changed files (`GET /pulls/{n}` and
//! `/pulls/{n}/files`). beghu reads no code: it stays off `contents: read`. From the account's
//! mirror: the issues the PR links to, with their comments: its closing references, and the
//! issues its description names (`#N`, `owner/repo#N`, a link to an issue), one hop, only in repos
//! the account syncs. Every other reference is listed in `unreached`, with why.
//!
//! A push during the run changes nothing: the run keeps its pin, and an analysis of a newer head
//! needs a new run.

use super::runs::{Admitted, Ended, RunError, end, github_failed};
use super::{MAX_FILES, announce};
use crate::{App, now};
use analysis::{
    PinnedBase, PinnedComment, PinnedFile, PinnedIssue, PinnedPr, PinnedStats, Unreached,
};
use mirror_db::Caller;
use std::collections::HashSet;

/// The run's `pr.json`, pinning it now if this is the run's first fetch. Two first fetches at
/// once both read GitHub, and the first to write wins: the other serves what it wrote.
pub(crate) async fn pinned(app: &App, a: &Admitted) -> Result<PinnedPr, RunError> {
    if let Some(p) = &a.run.pinned {
        return parse(p);
    }
    let pr = read(app, a).await?;
    let json = serde_json::to_string(&pr).expect("plain data");
    let (id, t, head) = (a.run.id.clone(), now(), pr.head_sha.clone());
    let account = a.account;
    let (attached, row) = app
        .analyses()
        .dbs
        .write(account, move |tx| {
            let n = analysis_db::q::attach_run(tx, &id, &json, &head, t)?;
            Ok((n > 0, analysis_db::q::run(tx, &id)?))
        })
        .await?;
    if attached {
        announce(app, account, &a.repo(), a.run.number, None);
        return Ok(pr);
    }
    // Another fetch pinned it first, or the run ended meanwhile.
    match row {
        Some(r) if r.ended_at.is_none() => parse(r.pinned.as_deref().unwrap_or_default()),
        Some(r) => Err(RunError::Ended(Ended::from_db(
            r.ended_reason.as_deref().unwrap_or_default(),
        ))),
        None => Err(RunError::Gone),
    }
}

fn parse(json: &str) -> Result<PinnedPr, RunError> {
    serde_json::from_str(json).map_err(|e| RunError::Internal(format!("a pinned pr.json: {e}")))
}

/// What the run pins, read now.
async fn read(app: &App, a: &Admitted) -> Result<PinnedPr, RunError> {
    let (owner, name, number) = (a.run.owner.clone(), a.run.name.clone(), a.run.number);
    let gh = app.github().clone();
    let pull = app
        .tokens()
        .with_token(a.account, |token| {
            let (gh, o, n) = (gh.clone(), owner.clone(), name.clone());
            async move { gh.pull(&token, &o, &n, number).await }
        })
        .await;
    let pull = match pull {
        Ok(crate::github::Shown::It(p)) => p,
        // The account can't see the PR any more.
        Ok(_) => return Err(end(app, a.account, &a.run, Ended::NoRead).await),
        Err(crate::tokens::Error::SignInAgain) => {
            return Err(end(app, a.account, &a.run, Ended::SignInAgain).await);
        }
        Err(e) => return Err(e.into()),
    };
    if pull.changed_files > MAX_FILES {
        return Err(end(app, a.account, &a.run, Ended::TooLarge).await);
    }
    let files = app
        .tokens()
        .with_token(a.account, |token| {
            let (gh, o, n) = (gh.clone(), owner.clone(), name.clone());
            async move { gh.pull_files(&token, &o, &n, number).await }
        })
        .await;
    let files = match files {
        Ok(crate::github::Shown::It(f)) => f,
        Ok(_) => return Err(end(app, a.account, &a.run, Ended::NoRead).await),
        Err(crate::tokens::Error::GitHub(e)) => return Err(github_failed(e)),
        Err(e) => return Err(e.into()),
    };
    let body = pull.body.clone().unwrap_or_default();
    let (issues, unreached) = linked(app, a, &body).await?;
    Ok(PinnedPr {
        repo: a.repo(),
        number: number as u32,
        title: pull.title,
        body,
        url: pull.html_url,
        author: pull.user.map(|u| u.login).unwrap_or_default(),
        head_sha: pull.head.sha,
        base: PinnedBase {
            reference: pull.base.reference,
            sha: pull.base.sha,
        },
        files: files
            .into_iter()
            .map(|f| PinnedFile {
                path: f.filename,
                previous_path: f.previous_filename,
                status: f.status,
                additions: f.additions as u32,
                deletions: f.deletions as u32,
            })
            .collect(),
        stats: PinnedStats {
            files: pull.changed_files as u32,
            additions: pull.additions as u32,
            deletions: pull.deletions as u32,
        },
        issues,
        unreached,
    })
}

/// A reference, as `owner/repo#N` with GitHub's spelling where the mirror has it.
struct Ref {
    owner: String,
    name: String,
    number: i64,
}

impl Ref {
    fn key(&self) -> String {
        format!("{}/{}#{}", self.owner, self.name, self.number).to_lowercase()
    }

    fn shown(&self) -> String {
        format!("{}/{}#{}", self.owner, self.name, self.number)
    }
}

/// The issues the PR links to that the run serves, and the references it doesn't.
async fn linked(
    app: &App,
    a: &Admitted,
    body: &str,
) -> Result<(Vec<PinnedIssue>, Vec<Unreached>), RunError> {
    let (account, repo_id, number) = (a.account, a.run.repo_id, a.run.number);
    let closes = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            mirror_db::q::pull_closes(c, repo_id, number)
        })
        .await?;
    // The description's references, as GitHub reads them: the Markdown's `#N`, `owner/repo#N`
    // and links to an issue's page, never what's in code.
    let (owner, name, md) = (a.run.owner.clone(), a.run.name.clone(), body.to_owned());
    let named = tokio::task::spawn_blocking(move || {
        let sign = |u: &str| u.to_owned();
        let ctx = md_ast::Context {
            owner: &owner,
            repo: &name,
            number,
            id_prefix: "",
            sign: &sign,
        };
        md_ast::render(&md, &ctx).items
    })
    .await
    .map_err(|_| RunError::Internal("reading the description's references panicked".into()))?;
    let this = Ref {
        owner: a.run.owner.clone(),
        name: a.run.name.clone(),
        number,
    }
    .key();
    let mut seen = HashSet::from([this]);
    let refs: Vec<Ref> = closes
        .into_iter()
        .map(|c| Ref {
            owner: c.owner,
            name: c.name,
            number: c.number,
        })
        .chain(named.into_iter().map(|i| Ref {
            owner: i.owner,
            name: i.repo,
            number: i.number,
        }))
        .filter(|r| seen.insert(r.key()))
        .collect();
    let read = app
        .mirrors()
        .read(account, Caller::Request, move |c| {
            let (mut issues, mut unreached) = (Vec::new(), Vec::new());
            for r in refs {
                let reason = match mirror_db::q::linked_item(c, &r.owner, &r.name, r.number)? {
                    None => "not in a repo you sync",
                    Some(i) if i.is_stub || !i.synced => "in a repo you don't sync",
                    Some(i) if i.kind == "pr" => "a pull request, not an issue",
                    Some(i) => {
                        let comments = mirror_db::q::linked_comments(c, i.id)?
                            .into_iter()
                            .map(|c| PinnedComment {
                                author: c.author,
                                body: c.body,
                            })
                            .collect();
                        issues.push(PinnedIssue {
                            repo: format!("{}/{}", i.owner, i.name),
                            number: i.number as u32,
                            title: i.title,
                            body: i.body.unwrap_or_default(),
                            comments,
                        });
                        continue;
                    }
                };
                unreached.push(Unreached {
                    reference: r.shown(),
                    reason: reason.to_owned(),
                });
            }
            Ok((issues, unreached))
        })
        .await?;
    Ok(read)
}
