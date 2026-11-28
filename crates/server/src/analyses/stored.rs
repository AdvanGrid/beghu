//! A stored analysis: split once into the graph and the claims, each compressed at brotli 9 and
//! gzip 9, and brought up to this build's schema whenever a read finds it behind.
//!
//! - **The graph** is the analysis with each claim cut down to its ID, its status and how many
//!   evidence items of each kind it holds (enough for chips such as `code ×3`), in an envelope
//!   naming the analysis (`id`, `version`, the PR, the head, the merge base, `snippets`), its
//!   claims URL, `migratedIds` and `previous` (the ID of the analysis it replaced, or null). Every item keeps the claim IDs it lists.
//! - **The claims** are the analysis's claims, whole, with their evidence.
//!
//! The two blobs join back into the whole analysis (the graph's claims replaced by the claims'),
//! which is what a migration, the next upload's `carried` check and the run's
//! `previous-ids.json` and `vocabulary.json` read.
//!
//! **Migration on read.** Any read that needs the analysis migrates it first when its version is
//! behind the chain's: it inflates both blobs, joins them, runs the chain, re-splits and
//! recompresses on the blocking pool, and writes the four blobs back in one transaction, keeping
//! the analysis's ID. The PR's analysis lock makes concurrent reads wait on one migration. A
//! failed migration is a bug: the read fails with its own kind, the stored analysis stays as it
//! was, and the log names the account, the PR and the versions.

use super::PrKey;
use crate::App;
use analysis::{Analysis, NodeKind};
use serde_json::{Value, json};
use std::io::{Read, Write};

/// Why a stored analysis couldn't be read.
#[derive(Debug)]
pub(crate) enum ReadError {
    Db(dbrt::Error),
    /// It couldn't be brought to this build's schema; it's left as it was.
    Migration,
}

impl From<dbrt::Error> for ReadError {
    fn from(e: dbrt::Error) -> Self {
        ReadError::Db(e)
    }
}

impl From<ReadError> for super::runs::RunError {
    fn from(e: ReadError) -> Self {
        match e {
            ReadError::Db(e) => e.into(),
            ReadError::Migration => super::runs::RunError::MigrationFailed,
        }
    }
}

impl From<ReadError> for crate::error::ApiError {
    fn from(e: ReadError) -> Self {
        match e {
            ReadError::Db(e) => e.into(),
            ReadError::Migration => crate::error::ApiError::AnalysisMigrationFailed,
        }
    }
}

/// What the graph's envelope names besides the analysis.
pub(crate) struct Envelope {
    pub id: String,
    pub version: u32,
    pub owner: String,
    pub name: String,
    pub number: i64,
    pub head_sha: String,
    pub merge_base: String,
    pub created_at: i64,
    pub snippets: String,
    /// `[{old, new, step}]`.
    pub migrated_ids: Value,
    /// The analysis this one replaced, if it replaced one.
    pub previous: Option<String>,
}

impl Envelope {
    /// Where the graph says its claims are: per analysis and version, so a cached copy of an
    /// old shape never reaches new code.
    pub fn claims_url(&self) -> String {
        format!(
            "/api/{}/{}/pulls/{}/analysis/{}/v{}/claims",
            self.owner, self.name, self.number, self.id, self.version
        )
    }
}

/// An analysis's four blobs.
pub(crate) struct Blobs {
    pub graph_br: Vec<u8>,
    pub graph_gz: Vec<u8>,
    pub claims_br: Vec<u8>,
    pub claims_gz: Vec<u8>,
}

/// Splits `analysis` (an analysis at `env.version`, as JSON) into its graph and its claims, and
/// compresses each both ways. CPU-heavy: on the blocking pool.
pub(crate) fn split(mut analysis: Value, env: &Envelope) -> Blobs {
    let claims = analysis
        .get_mut("claims")
        .map(Value::take)
        .unwrap_or_else(|| json!([]));
    let stubs: Vec<Value> = claims
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let (mut code, mut description, mut issue) = (0, 0, 0);
            // The issues it quotes, once each: the walkthrough's `#N` chips, before the claims.
            let mut issues: Vec<String> = Vec::new();
            for e in c["evidence"].as_array().into_iter().flatten() {
                match e["kind"].as_str() {
                    Some("code") => code += 1,
                    Some("description") => description += 1,
                    Some("issue") => {
                        issue += 1;
                        if let (Some(repo), Some(n)) = (e["repo"].as_str(), e["number"].as_i64()) {
                            let r = format!("{repo}#{n}");
                            if !issues.contains(&r) {
                                issues.push(r);
                            }
                        }
                    }
                    _ => {}
                }
            }
            let mut stub = json!({
                "id": c["id"],
                "status": c["status"],
                "code": code,
                "description": description,
                "issue": issue,
            });
            if !issues.is_empty() {
                stub["issues"] = json!(issues);
            }
            stub
        })
        .collect();
    if let Some(o) = analysis.as_object_mut() {
        o.insert("claims".into(), Value::Array(stubs));
    }
    let graph = json!({
        "id": env.id,
        "version": env.version,
        "repo": format!("{}/{}", env.owner, env.name),
        "number": env.number,
        "headSha": env.head_sha,
        "mergeBase": env.merge_base,
        "createdAt": env.created_at,
        "snippets": env.snippets,
        "claimsUrl": env.claims_url(),
        "migratedIds": env.migrated_ids,
        "previous": env.previous,
        "analysis": analysis,
    });
    let claims = json!({ "id": env.id, "version": env.version, "claims": claims });
    let (graph, claims) = (
        serde_json::to_vec(&graph).expect("JSON values serialise"),
        serde_json::to_vec(&claims).expect("JSON values serialise"),
    );
    Blobs {
        graph_br: brotli9(&graph),
        graph_gz: gzip9(&graph),
        claims_br: brotli9(&claims),
        claims_gz: gzip9(&claims),
    }
}

/// The whole analysis from its two gzip blobs: the graph's analysis with its claims put back.
pub(crate) fn join(graph_gz: &[u8], claims_gz: &[u8]) -> Result<Value, String> {
    let graph: Value =
        serde_json::from_slice(&gunzip(graph_gz)?).map_err(|e| format!("the graph: {e}"))?;
    let claims: Value =
        serde_json::from_slice(&gunzip(claims_gz)?).map_err(|e| format!("the claims: {e}"))?;
    let mut analysis = graph
        .get("analysis")
        .cloned()
        .ok_or("the graph has no analysis")?;
    let claims = claims.get("claims").cloned().ok_or("no claims")?;
    analysis
        .as_object_mut()
        .ok_or("the analysis isn't an object")?
        .insert("claims".into(), claims);
    Ok(analysis)
}

pub(crate) fn brotli9(data: &[u8]) -> Vec<u8> {
    let params = brotli::enc::BrotliEncoderParams {
        quality: 9,
        lgwin: 22,
        ..Default::default()
    };
    let mut out = Vec::with_capacity(data.len() / 6);
    brotli::BrotliCompress(&mut &data[..], &mut out, &params).expect("compressing in memory");
    out
}

pub(crate) fn gzip9(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(
        Vec::with_capacity(data.len() / 5),
        flate2::Compression::new(9),
    );
    e.write_all(data).expect("compressing in memory");
    e.finish().expect("compressing in memory")
}

pub(crate) fn gunzip(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    flate2::read::MultiGzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| format!("inflating: {e}"))?;
    Ok(out)
}

/// The analysis's counts, as the run's panel shows them: its parts (the nodes that are code),
/// purposes and conflicts.
pub(crate) fn counts(a: &Analysis) -> (i64, i64, i64) {
    let parts = a
        .nodes
        .iter()
        .filter(|n| {
            matches!(
                n.kind,
                NodeKind::Service | NodeKind::App | NodeKind::Library | NodeKind::Module
            )
        })
        .count();
    (
        parts as i64,
        a.purposes.len() as i64,
        a.conflicts.len() as i64,
    )
}

/// The PR's analysis row, migrated first if it's behind this build's schema. `None` when the PR
/// has none.
pub(crate) async fn current(
    app: &App,
    pr: &PrKey,
) -> Result<Option<analysis_db::q::AnalysisMetaRow>, ReadError> {
    let meta = read_meta(app, pr).await?;
    match &meta {
        Some(m) if m.version != i64::from(app.analyses().chain.version) => {
            let _held = app.analyses().lock(pr).await;
            migrate_if_behind(app, pr).await?;
            read_meta(app, pr).await
        }
        _ => Ok(meta),
    }
}

async fn read_meta(
    app: &App,
    pr: &PrKey,
) -> Result<Option<analysis_db::q::AnalysisMetaRow>, ReadError> {
    let (repo, number) = (pr.repo_id, pr.number);
    Ok(app
        .analyses()
        .dbs
        .read(pr.account, move |c| {
            analysis_db::q::analysis_meta(c, repo, number)
        })
        .await?)
}

/// Migrates the PR's analysis to this build's schema if it's behind, and writes it back. The
/// caller holds the PR's analysis lock.
pub(crate) async fn migrate_if_behind(app: &App, pr: &PrKey) -> Result<(), ReadError> {
    let (repo, number) = (pr.repo_id, pr.number);
    let Some(row) = app
        .analyses()
        .dbs
        .read(pr.account, move |c| {
            analysis_db::q::analysis_whole(c, repo, number)
        })
        .await?
    else {
        return Ok(());
    };
    let chain = app.analyses().chain;
    if row.version == i64::from(chain.version) {
        return Ok(());
    }
    let from = row.version;
    let id = row.id.clone();
    let migrated = tokio::task::spawn_blocking(move || -> Result<(Blobs, String), String> {
        let whole = join(&row.graph_gz, &row.claims_gz)?;
        let m = chain.migrate(whole).map_err(|e| e.to_string())?;
        // The chain ends at the current types: a migrated analysis that doesn't fit them is a
        // failed migration, never served.
        serde_json::from_value::<Analysis>(m.value.clone())
            .map_err(|e| format!("the migrated analysis doesn't fit the schema: {e}"))?;
        let mut ids: Vec<Value> = serde_json::from_str(&row.migrated_ids).unwrap_or_default();
        ids.extend(
            m.renames
                .iter()
                .map(|r| json!({ "old": r.old, "new": r.new, "step": r.step })),
        );
        let env = Envelope {
            id: row.id,
            version: chain.version,
            owner: row.owner,
            name: row.name,
            number,
            head_sha: row.head_sha,
            merge_base: row.merge_base,
            created_at: row.created_at,
            snippets: row.snippets,
            migrated_ids: Value::Array(ids.clone()),
            previous: row.previous_id,
        };
        Ok((split(m.value, &env), Value::Array(ids).to_string()))
    })
    .await;
    let (blobs, ids) = match migrated {
        Ok(Ok(done)) => done,
        Ok(Err(why)) => {
            eprintln!(
                "account {}: migrating the analysis of repo {} #{} from version {from} to {} failed; it stays at version {from}: {why}",
                pr.account, pr.repo_id, pr.number, chain.version
            );
            return Err(ReadError::Migration);
        }
        Err(_) => {
            eprintln!(
                "account {}: migrating the analysis of repo {} #{} from version {from} to {} panicked; it stays at version {from}",
                pr.account, pr.repo_id, pr.number, chain.version
            );
            return Err(ReadError::Migration);
        }
    };
    let version = i64::from(chain.version);
    app.analyses()
        .dbs
        .write(pr.account, move |tx| {
            analysis_db::q::migrated_analysis(
                tx,
                &id,
                from,
                version,
                &ids,
                &blobs.graph_br,
                &blobs.graph_gz,
                &blobs.claims_br,
                &blobs.claims_gz,
            )
        })
        .await?;
    eprintln!(
        "account {}: the analysis of repo {} #{} migrated from version {from} to {version}",
        pr.account, pr.repo_id, pr.number
    );
    Ok(())
}

/// The PR's whole analysis at this build's schema, with its ID, for a check or the run's skeleton
/// files. The caller holds the PR's analysis lock, and has migrated it ([`migrate_if_behind`]).
pub(crate) async fn whole(app: &App, pr: &PrKey) -> Result<Option<(String, Analysis)>, ReadError> {
    let (repo, number) = (pr.repo_id, pr.number);
    let Some(row) = app
        .analyses()
        .dbs
        .read(pr.account, move |c| {
            analysis_db::q::analysis_whole(c, repo, number)
        })
        .await?
    else {
        return Ok(None);
    };
    let id = row.id.clone();
    let parsed = tokio::task::spawn_blocking(move || -> Result<Analysis, String> {
        let v = join(&row.graph_gz, &row.claims_gz)?;
        serde_json::from_value(v).map_err(|e| e.to_string())
    })
    .await;
    match parsed {
        Ok(Ok(a)) => Ok(Some((id, a))),
        Ok(Err(why)) => {
            eprintln!(
                "account {}: the stored analysis of repo {} #{} doesn't read: {why}",
                pr.account, pr.repo_id, pr.number
            );
            Err(ReadError::Migration)
        }
        Err(_) => Err(ReadError::Migration),
    }
}

/// The PR's whole analysis, migrated first: what `previous-ids.json` and `vocabulary.json` are
/// made of.
pub(crate) async fn previous(app: &App, pr: &PrKey) -> Result<Option<Analysis>, ReadError> {
    let _held = app.analyses().lock(pr).await;
    migrate_if_behind(app, pr).await?;
    Ok(whole(app, pr).await?.map(|(_, a)| a))
}
