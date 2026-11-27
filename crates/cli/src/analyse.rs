//! `beghu analyse`: an analysis run, driven by the agent.
//!
//! `beghu analyse <owner/repo#N | PR URL>` starts a run (`POST /api/cli/runs`, superseding the
//! account's live run on the PR), writes its files to `./.beghu/run-<id>/` (the instructions,
//! `pr.json`, `schema.ts`, and `previous-ids.json` and `vocabulary.json` when there is a previous
//! analysis) with the run's token in `run.toml`, and prints the size line, then the instructions,
//! which name these commands rather than URLs. The subcommands find their run from the one
//! `.beghu/run-*` folder in the current folder that still has its `run.toml` (`--run <id>` picks
//! among several), so an agent never handles a run ID or a credential. A run that ended (`end`,
//! or a call answered `410`) loses its `run.toml`, and so does an older run of the same PR when a
//! new one starts here; their files stay.
//!
//! `check`, `check-split` and `merge` are the analysis crate's own validator, split check and
//! merge, run natively (what `validate.mjs` and `merge.mjs` are built from), and print what those
//! print: the report as JSON on stdout (the merged analysis, for `merge`), a summary on stderr,
//! exit 1 on errors. `upload` runs `check` first and refuses on any error.

use crate::account::{credentials, host_for, signed_in_api};
use crate::reader::Checkouts;
use crate::store::{Doc, Value, write_private};
use crate::{Args, Fail};
use analysis::{Context, PinnedPr, Previous, PreviousIds, Report, Vocabulary};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// The folder the runs live in, in the current folder.
const RUNS: &str = ".beghu";
/// A run folder's own file: its host, token and PR. Without it the folder is no run.
const RUN_FILE: &str = "run.toml";
const INSTRUCTIONS: &str = "instructions.md";

pub async fn command(rest: &[String]) -> Result<(), Fail> {
    match rest.first().map(String::as_str) {
        Some("check") => check(&rest[1..]),
        Some("check-split") => check_split(&rest[1..]),
        Some("merge") => merge(&rest[1..]),
        Some("upload") => upload(&rest[1..]).await,
        Some("end") => end(&rest[1..]).await,
        Some(_) => start(rest).await,
        None => Err(Fail::usage(
            "analyse needs a PR (owner/repo#N, or its URL) or a subcommand",
        )),
    }
}

/// A PR, as `analyse` names it.
#[derive(Debug, PartialEq)]
struct Pr {
    owner: String,
    repo: String,
    number: u64,
}

impl std::fmt::Display for Pr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}#{}", self.owner, self.repo, self.number)
    }
}

fn name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// `owner/repo#N`, or a PR's URL on GitHub or on beghu (`…/owner/repo/pull/N…`).
fn parse_pr(raw: &str) -> Option<Pr> {
    let raw = raw.trim();
    let (owner, repo, number) = if let Some((_, path)) = raw.split_once("://") {
        let segs: Vec<&str> = path.split(['/', '?', '#']).collect();
        let at = segs.iter().position(|s| *s == "pull")?;
        (
            *segs.get(at.checked_sub(2)?)?,
            *segs.get(at - 1)?,
            *segs.get(at + 1)?,
        )
    } else {
        let (repo, n) = raw.split_once('#')?;
        let (o, r) = repo.split_once('/')?;
        (o, r, n)
    };
    let number = number.parse().ok().filter(|n| *n > 0)?;
    (name_ok(owner) && name_ok(repo)).then(|| Pr {
        owner: owner.to_owned(),
        repo: repo.to_owned(),
        number,
    })
}

/// A run folder, as `run.toml` has it.
struct Run {
    id: String,
    dir: PathBuf,
    host: String,
    token: String,
    pr: String,
    max_areas: Option<i64>,
}

impl Run {
    /// Ends the folder's part as a run: its `run.toml` goes, its files stay.
    fn retire(&self) {
        let _ = std::fs::remove_file(self.dir.join(RUN_FILE));
    }
}

fn read_run(dir: &Path) -> Option<Run> {
    let id = dir.file_name()?.to_str()?.strip_prefix("run-")?.to_owned();
    let doc = Doc::parse(&std::fs::read_to_string(dir.join(RUN_FILE)).ok()?).ok()?;
    Some(Run {
        id,
        dir: dir.to_owned(),
        host: Doc::str(&doc.top, "host")?,
        token: Doc::str(&doc.top, "token")?,
        pr: Doc::str(&doc.top, "pr")?,
        max_areas: Doc::int(&doc.top, "max_areas"),
    })
}

/// Every run in `./.beghu/`.
fn runs() -> Vec<Run> {
    let Ok(entries) = std::fs::read_dir(RUNS) else {
        return Vec::new();
    };
    let mut out: Vec<Run> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| read_run(&e.path()))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// The run a subcommand acts on: `--run <id>`, else the only one here.
fn the_run(chosen: Option<&str>) -> Result<Run, Fail> {
    let all = runs();
    if let Some(id) = chosen {
        let id = id.strip_prefix("run-").unwrap_or(id);
        return all
            .into_iter()
            .find(|r| r.id == id)
            .ok_or_else(|| Fail::msg(format!("no run {id} in ./{RUNS}/ (or it has ended)")));
    }
    match all.len() {
        0 => Err(Fail::msg(format!(
            "no beghu run in this folder (./{RUNS}/): start one here with `beghu analyse owner/repo#N`"
        ))),
        1 => Ok(all.into_iter().next().expect("one")),
        _ => Err(Fail::msg(format!(
            "several runs in ./{RUNS}/: pick one with --run <id> ({})",
            all.iter()
                .map(|r| format!("{} for {}", r.id, r.pr))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    run: String,
    token: String,
    size_line: String,
}

/// `beghu analyse <owner/repo#N | PR URL> [--yes] [--max-areas N] [--host URL]`.
async fn start(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--host", "--max-areas", "--run"], &["--yes"])?;
    if a.opt("--run").is_some() {
        return Err(Fail::usage(
            "--run goes with a subcommand, not with a new run",
        ));
    }
    let [target] = a.pos.as_slice() else {
        return Err(Fail::usage("give one PR: owner/repo#N, or its URL"));
    };
    let pr = parse_pr(target).ok_or_else(|| {
        Fail::usage(format!(
            "{target:?} isn't a PR: give owner/repo#N, or the PR's URL"
        ))
    })?;
    let max_areas = match a.opt("--max-areas") {
        None => None,
        Some(n) => Some(
            n.parse::<i64>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| Fail::usage("--max-areas takes a number of areas, 1 or more"))?,
        ),
    };
    let (_, c) = credentials()?;
    let host = host_for(a.opt("--host"), &c)?;
    let api = signed_in_api(&host, &c)?;
    let res = api
        .post_json(
            "/api/cli/runs",
            &serde_json::json!({ "owner": pr.owner, "repo": pr.repo, "number": pr.number }),
        )
        .await?;
    if res.status != 201 {
        return Err(Fail::msg(format!(
            "{host} didn't start a run on {pr}: {}",
            res.why()
        )));
    }
    let started: Started = res.json("starting the run")?;
    let dir = Path::new(RUNS).join(format!("run-{}", started.run));
    std::fs::create_dir_all(&dir)
        .map_err(|e| Fail::msg(format!("can't make {}: {e}", dir.display())))?;
    // Never committed: the folder holds the run's token.
    let ignore = Path::new(RUNS).join(".gitignore");
    if !ignore.exists() {
        let _ = std::fs::write(&ignore, "# beghu's analysis runs: never committed.\n*\n");
    }
    let mut files = BTreeMap::new();
    for f in [
        "instructions",
        "pr.json",
        "schema.ts",
        "previous-ids.json",
        "vocabulary.json",
    ] {
        let res = api.get(&format!("/api/runs/{}/{f}", started.token)).await?;
        match res.status {
            200 => {
                files.insert(f, res.bytes);
            }
            404 if f.ends_with(".json") && f != "pr.json" => {}
            _ => {
                return Err(Fail::msg(format!(
                    "fetching the run's {f} from {host}: {}",
                    res.why()
                )));
            }
        }
    }
    let mut preface = format!(
        "{}. A large PR is split across several agents and can take an hour.\n",
        started.size_line
    );
    if a.flag("--yes") {
        preface.push_str("--yes: at the checkpoint (step 3), go on without asking.\n");
    }
    if let Some(n) = max_areas {
        preface.push_str(&format!(
            "--max-areas {n}: `beghu analyse check-split` refuses a split into more than {n} areas; then stop and say so.\n"
        ));
    }
    let instructions = format!(
        "{preface}\n{}",
        String::from_utf8_lossy(files.get("instructions").map_or(&[][..], |b| b))
    );
    for (f, bytes) in &files {
        let (name, body) = if *f == "instructions" {
            (INSTRUCTIONS, instructions.as_bytes())
        } else {
            (*f, bytes.as_slice())
        };
        std::fs::write(dir.join(name), body)
            .map_err(|e| Fail::msg(format!("can't write {}: {e}", dir.join(name).display())))?;
    }
    let mut doc = Doc::default();
    doc.top.insert("host".into(), Value::Str(host.clone()));
    doc.top.insert("token".into(), Value::Str(started.token));
    doc.top.insert("pr".into(), Value::Str(pr.to_string()));
    if let Some(n) = max_areas {
        doc.top.insert("max_areas".into(), Value::Int(n));
    }
    write_private(
        &dir.join(RUN_FILE),
        &doc.render(
            "This analysis run's token: keep it private. `beghu analyse end` ends the run.",
        ),
    )
    .map_err(Fail::Msg)?;
    // A run of this PR started here before is superseded on the server.
    for r in runs() {
        if r.id != started.run && r.pr == pr.to_string() {
            r.retire();
        }
    }
    print!("{instructions}");
    Ok(())
}

/// The two checkouts: `--base` and `--head`, else `./base` and `./head`.
fn checkouts(a: &Args) -> Result<Checkouts, Fail> {
    let pick = |flag: &str, default: &str| -> Result<PathBuf, Fail> {
        let p = PathBuf::from(a.opt(flag).unwrap_or(default));
        if p.is_dir() {
            Ok(p)
        } else {
            Err(Fail::msg(format!(
                "no checkout at {}: check the PR's {default} out there (the instructions' \"The checkout\"), or give {flag} <dir>",
                p.display()
            )))
        }
    };
    Ok(Checkouts {
        base: pick("--base", "base")?,
        head: pick("--head", "head")?,
    })
}

fn read(path: &Path, what: &str) -> Result<String, Fail> {
    std::fs::read_to_string(path)
        .map_err(|e| Fail::msg(format!("can't read {what} {}: {e}", path.display())))
}

/// The run's pinned PR, and its previous analysis as the run served it (none at all when it
/// served neither file).
fn run_context(run: &Run) -> Result<(PinnedPr, Previous), Fail> {
    let pr: PinnedPr = serde_json::from_str(&read(&run.dir.join("pr.json"), "the run's")?)
        .map_err(|e| Fail::msg(format!("the run's pr.json isn't one: {e}")))?;
    let ids = std::fs::read_to_string(run.dir.join("previous-ids.json")).ok();
    let vocabulary = std::fs::read_to_string(run.dir.join("vocabulary.json")).ok();
    let previous = match (ids, vocabulary) {
        (None, None) => Previous::None,
        (Some(i), Some(v)) => Previous::Some {
            ids: serde_json::from_str::<PreviousIds>(&i)
                .map_err(|e| Fail::msg(format!("the run's previous-ids.json isn't one: {e}")))?,
            vocabulary: serde_json::from_str::<Vocabulary>(&v)
                .map_err(|e| Fail::msg(format!("the run's vocabulary.json isn't one: {e}")))?,
        },
        _ => {
            return Err(Fail::msg(format!(
                "{} holds only one of previous-ids.json and vocabulary.json",
                run.dir.display()
            )));
        }
    };
    Ok((pr, previous))
}

fn print_report(r: &Report) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(
        out,
        "{}",
        serde_json::to_string_pretty(r).expect("plain data")
    );
}

/// Runs the full validator over `file` for the run: its report, and the counts of what it holds.
fn validate(run: &Run, file: &str, a: &Args) -> Result<(Report, String), Fail> {
    let text = read(Path::new(file), "the analysis")?;
    let (pr, previous) = run_context(run)?;
    let co = checkouts(a)?;
    let ctx = Context {
        changed_files: Some(pr.files.iter().map(|f| f.path.clone()).collect()),
        previous,
    };
    let out = analysis::validate(&text, &ctx, Some(&co));
    let counts = out
        .analysis
        .as_ref()
        .map(|an| {
            format!(
                " ({} nodes, {} edges, {} claims, {} scenarios, {} purposes, {} conflicts)",
                an.nodes.len(),
                an.edges.len(),
                an.claims.len(),
                an.scenarios.len(),
                an.purposes.len(),
                an.conflicts.len()
            )
        })
        .unwrap_or_default();
    Ok((out.report, counts))
}

/// `beghu analyse check <analysis.json> [--base DIR] [--head DIR] [--run ID]`.
fn check(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--base", "--head", "--run"], &[])?;
    let [file] = a.pos.as_slice() else {
        return Err(Fail::usage("check takes one analysis file"));
    };
    let run = the_run(a.opt("--run"))?;
    let (r, counts) = validate(&run, file, &a)?;
    print_report(&r);
    eprintln!(
        "{} errors, {} warnings{counts}",
        r.errors.len(),
        r.warnings.len()
    );
    if r.is_ok() {
        Ok(())
    } else {
        Err(Fail::Exit(1))
    }
}

fn json_file(path: &str, what: &str) -> Result<serde_json::Value, Fail> {
    serde_json::from_str(&read(Path::new(path), what)?)
        .map_err(|e| Fail::msg(format!("{what} {path} isn't JSON: {e}")))
}

/// `beghu analyse check-split <split.json> [--skeleton FILE] [--run ID]`: the split check, and
/// the run's `--max-areas`.
fn check_split(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--skeleton", "--run"], &[])?;
    let [split_file] = a.pos.as_slice() else {
        return Err(Fail::usage("check-split takes split.json"));
    };
    let run = the_run(a.opt("--run"))?;
    let (pr, _) = run_context(&run)?;
    let skeleton = json_file(
        a.opt("--skeleton").unwrap_or("skeleton.json"),
        "the skeleton",
    )?;
    let split = json_file(split_file, "the split")?;
    let changed: Vec<String> = pr.files.iter().map(|f| f.path.clone()).collect();
    let mut r = analysis::check_split(&skeleton, &split, Some(&changed));
    if let Some(max) = run.max_areas {
        let n = split
            .get("areas")
            .and_then(|a| a.as_array())
            .map_or(0, Vec::len);
        if n as i64 > max {
            r.error(
                "/areas",
                "split.max-areas",
                format!(
                    "the split has {n} areas, more than `beghu analyse --max-areas {max}` allows: stop here, and say so"
                ),
            );
        }
    }
    print_report(&r);
    eprintln!("{} errors, {} warnings", r.errors.len(), r.warnings.len());
    if r.is_ok() {
        Ok(())
    } else {
        Err(Fail::Exit(1))
    }
}

/// `beghu analyse merge [--split split.json] <skeleton.json> <area.json>...`, or `merge --finish
/// <merged.json>`: the analysis on stdout, the report on stderr.
fn merge(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--split"], &["--finish"])?;
    let finishing = a.flag("--finish");
    if finishing && a.opt("--split").is_some() {
        return Err(Fail::usage("--split goes with the merge, not --finish"));
    }
    let m = if finishing {
        let [file] = a.pos.as_slice() else {
            return Err(Fail::usage("merge --finish takes one merged file"));
        };
        analysis::finish(json_file(file, "the merged analysis")?)
    } else {
        if a.pos.is_empty() {
            return Err(Fail::usage(
                "merge takes the fragments: the skeleton first, then each area",
            ));
        }
        let fragments = a
            .pos
            .iter()
            .map(|f| json_file(f, "the fragment"))
            .collect::<Result<Vec<_>, _>>()?;
        let split = a
            .opt("--split")
            .map(|f| json_file(f, "the split"))
            .transpose()?;
        analysis::merge(fragments, split.as_ref())
    };
    {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(&m.analysis).expect("plain data")
        );
    }
    let hints = m
        .analysis
        .get("hints")
        .and_then(|h| h.as_array())
        .map_or(0, Vec::len);
    eprintln!(
        "{}",
        serde_json::to_string_pretty(&m.report).expect("plain data")
    );
    eprintln!(
        "{} errors, {} warnings, {hints} hints left for the seam pass",
        m.report.errors.len(),
        m.report.warnings.len()
    );
    if m.report.is_ok() {
        Ok(())
    } else {
        Err(Fail::Exit(1))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Accepted {
    analysis: String,
    head_sha: String,
    warnings: Vec<serde_json::Value>,
}

/// A run call answered `410`: the run is over, and its folder no run any more.
fn ended(run: &Run, why: String) -> Fail {
    run.retire();
    Fail::msg(format!(
        "{why} (start a new run with `beghu analyse {}`)",
        run.pr
    ))
}

/// `beghu analyse upload <analysis.json> [--base DIR] [--head DIR] [--run ID]`.
async fn upload(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--base", "--head", "--run"], &[])?;
    let [file] = a.pos.as_slice() else {
        return Err(Fail::usage("upload takes one analysis file"));
    };
    let run = the_run(a.opt("--run"))?;
    let (r, _) = validate(&run, file, &a)?;
    if !r.is_ok() {
        print_report(&r);
        eprintln!(
            "refusing to upload: {} errors, {} warnings (`beghu analyse check {file}` shows the same)",
            r.errors.len(),
            r.warnings.len()
        );
        return Err(Fail::Exit(1));
    }
    let text = read(Path::new(file), "the analysis")?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(text.as_bytes())
        .and_then(|_| gz.flush())
        .map_err(|e| Fail::msg(format!("can't gzip the analysis: {e}")))?;
    let body = gz
        .finish()
        .map_err(|e| Fail::msg(format!("can't gzip the analysis: {e}")))?;
    let (_, c) = credentials()?;
    let api = signed_in_api(&run.host, &c)?;
    let res = api
        .send(
            api.request(
                reqwest::Method::POST,
                &format!("/api/runs/{}/analysis", run.token),
            )
            .header("content-type", "application/json")
            .header("content-encoding", "gzip")
            .header("beghu-snippets", "checked")
            .body(body),
        )
        .await?;
    match res.status {
        201 => {
            let ok: Accepted = res.json("the upload")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "analysis": ok.analysis, "headSha": ok.head_sha, "warnings": ok.warnings,
                }))
                .expect("plain data")
            );
            eprintln!(
                "uploaded: analysis {} of {} at {}, {} warnings",
                ok.analysis,
                run.pr,
                &ok.head_sha[..ok.head_sha.len().min(12)],
                ok.warnings.len()
            );
            Ok(())
        }
        422 => {
            let e = res.error();
            if let Some(rep) = &e.report {
                println!("{}", serde_json::to_string_pretty(rep).expect("plain data"));
            }
            eprintln!("beghu: {}", e.message);
            Err(Fail::Exit(1))
        }
        410 => Err(ended(&run, res.why())),
        _ => Err(Fail::msg(format!("the upload: {}", res.why()))),
    }
}

/// `beghu analyse end [--run ID]`.
async fn end(rest: &[String]) -> Result<(), Fail> {
    let a = Args::parse(rest, &["--run"], &[])?;
    if let Some(p) = a.pos.first() {
        return Err(Fail::usage(format!("end takes no {p:?}")));
    }
    let run = the_run(a.opt("--run"))?;
    let (_, c) = credentials()?;
    let api = signed_in_api(&run.host, &c)?;
    let res = api
        .post_json(
            &format!("/api/runs/{}/end", run.token),
            &serde_json::json!({}),
        )
        .await?;
    match res.status {
        204 => {
            run.retire();
            println!("Ended the run on {}.", run.pr);
            Ok(())
        }
        410 => {
            run.retire();
            println!("The run on {} had ended already: {}", run.pr, res.why());
            Ok(())
        }
        _ => Err(Fail::msg(format!("ending the run: {}", res.why()))),
    }
}
