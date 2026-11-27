//! `beghu`: the beghu CLI (#179). It signs in to a beghu deployment with beghu's own device flow
//! (never GitHub's: it never holds a GitHub token), and drives the PR view's analysis runs for an
//! agent: `beghu analyse owner/repo#N` starts one and prints its instructions, and the `analyse`
//! subcommands are the agent's tools (the validator, the split check and the merge, run natively
//! over the two checkouts) and its upload.
//!
//! - Hosts: any beghu deployment. The hosted one is the default; `beghu login --host URL` adds
//!   another and makes it active (the last one signed in to), and `--host` on any call overrides
//!   it. `BEGHU_HOST` and `BEGHU_TOKEN` override the credentials file, for CI and containers:
//!   `BEGHU_TOKEN` goes only to `BEGHU_HOST`'s host, and is refused without it.
//! - Versions: every call names the CLI's semver and schema version. Below the host's floor every
//!   call is `426`: the CLI updates itself from the host when it can write its own file, says so
//!   on one line, and runs the same command again, once. A CLI newer than the host is refused with
//!   `409`, and only says what to do: going older is a deliberate `beghu update`.
//!
//! Exit codes: 0 done, 1 failed (a check with errors among them), 2 a usage error.

mod account;
mod analyse;
mod http;
mod reader;
mod store;
mod update;

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;

/// The hosted beghu.
pub const DEFAULT_HOST: &str = "https://beghu.dev";

/// How a command failed.
#[derive(Debug)]
pub enum Fail {
    /// The command line was wrong: exit 2.
    Usage(String),
    /// Anything else: exit 1.
    Msg(String),
    /// The host's floor is above this CLI (`426`).
    TooOld { host: String, message: String },
    /// The credential was revoked, expired or is unknown to the host (`401 bad_credential`).
    SignedOut { host: String },
    /// Exit with this code, having said why already (a check's report).
    Exit(i32),
}

impl Fail {
    pub fn msg(m: impl Into<String>) -> Fail {
        Fail::Msg(m.into())
    }

    pub fn usage(m: impl Into<String>) -> Fail {
        Fail::Usage(m.into())
    }
}

/// A command's arguments: positional ones, options with a value, and bare flags.
pub struct Args {
    pub pos: Vec<String>,
    pub opts: BTreeMap<String, String>,
    pub flags: BTreeSet<String>,
}

impl Args {
    /// `args`, where each of `valued` takes a value (`--host URL` or `--host=URL`) and each of
    /// `bare` doesn't. Anything else starting `--` is a usage error.
    pub fn parse(args: &[String], valued: &[&str], bare: &[&str]) -> Result<Args, Fail> {
        let mut out = Args {
            pos: Vec::new(),
            opts: BTreeMap::new(),
            flags: BTreeSet::new(),
        };
        let mut it = args.iter();
        while let Some(a) = it.next() {
            if a == "--" {
                out.pos.extend(it.by_ref().cloned());
                break;
            }
            if !a.starts_with("--") || a == "-" {
                out.pos.push(a.clone());
                continue;
            }
            let (name, inline) = match a.split_once('=') {
                Some((n, v)) => (n, Some(v.to_owned())),
                None => (a.as_str(), None),
            };
            if valued.contains(&name) {
                let v = match inline {
                    Some(v) => v,
                    None => it
                        .next()
                        .cloned()
                        .ok_or_else(|| Fail::usage(format!("{name} needs a value")))?,
                };
                out.opts.insert(name.to_owned(), v);
            } else if bare.contains(&name) && inline.is_none() {
                out.flags.insert(name.to_owned());
            } else {
                return Err(Fail::usage(format!("unknown option {a}")));
            }
        }
        Ok(out)
    }

    pub fn opt(&self, name: &str) -> Option<&str> {
        self.opts.get(name).map(String::as_str)
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }
}

const HELP: &str = "beghu: the beghu CLI

Account:
  beghu login [--host URL] [--no-browser] [--name NAME]
                     sign in to a beghu (the hosted one by default) and make it the active host
  beghu logout [--host URL | --all]
                     revoke the sign-in on the server, then forget it here
  beghu status [--host URL]
                     the host, its account and the sign-in's expiry, this CLI's version and
                     build, and the host's build and the oldest CLI it answers
  beghu update [--host URL]
                     install the host's build of beghu for this machine, newer or older
  beghu --version

Analysis (for an agent; every subcommand finds its run in ./.beghu/):
  beghu analyse <owner/repo#N | PR URL> [--yes] [--max-areas N] [--host URL]
                     start a run (replacing the PR's live one), write its files to
                     ./.beghu/run-<id>/, and print the instructions
  beghu analyse check <analysis.json> [--base DIR] [--head DIR]
                     the full validator, snippet check included (checkouts: ./base, ./head)
  beghu analyse check-split <split.json> [--skeleton FILE]
  beghu analyse merge [--split split.json] <skeleton.json> <area.json>... > merged.json
  beghu analyse merge --finish <merged.json> > analysis.json
  beghu analyse upload <analysis.json> [--base DIR] [--head DIR]
                     check, then upload (gzipped); refuses on any error
  beghu analyse end  end the run
  With several runs in ./.beghu/, give --run <id>.

The environment: BEGHU_HOST overrides the active host, and BEGHU_TOKEN the credentials
file's sign-in for that host, and only that one (for CI and containers; BEGHU_TOKEN needs
BEGHU_HOST); BEGHU_CREDENTIALS names the file itself.
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a tokio runtime");
    let code = rt.block_on(run_and_report(&args));
    drop(rt);
    let _ = std::io::stdout().flush();
    std::process::exit(code)
}

/// Runs the command; on a `426`, updates from the host and runs it again (once).
async fn run_and_report(args: &[String]) -> i32 {
    match run(args).await {
        Ok(()) => 0,
        Err(Fail::TooOld { host, message }) => too_old(args, &host, &message).await,
        Err(Fail::SignedOut { host }) => {
            account::signed_out(&host);
            1
        }
        Err(e) => report(e),
    }
}

fn report(e: Fail) -> i32 {
    match e {
        Fail::Usage(m) => {
            eprintln!("beghu: {m}\n(beghu help lists the commands)");
            2
        }
        Fail::Msg(m) => {
            eprintln!("beghu: {m}");
            1
        }
        Fail::Exit(c) => c,
        Fail::TooOld { message, .. } => {
            eprintln!("beghu: {message}");
            1
        }
        Fail::SignedOut { host } => {
            account::signed_out(&host);
            1
        }
    }
}

/// Set on the command run again after a self-update, to the version it updated from: a second
/// `426` then only says what to do.
const UPDATED: &str = "BEGHU_UPDATED";

async fn too_old(args: &[String], host: &str, message: &str) -> i32 {
    if std::env::var_os(UPDATED).is_some() {
        eprintln!("beghu: {message}");
        return 1;
    }
    match update::install(host).await {
        Ok(update::Installed::Updated { from, to, exe }) => {
            eprintln!("updated beghu {from} \u{2192} {to} from {host}");
            let _ = std::io::stdout().flush();
            use std::os::unix::process::CommandExt as _;
            let err = std::process::Command::new(&exe)
                .args(args)
                .env(UPDATED, &from)
                .exec();
            eprintln!("beghu: can't run the updated {}: {err}", exe.display());
            1
        }
        Ok(update::Installed::Already { .. }) => {
            eprintln!("beghu: {message} ({host} serves this same build)");
            1
        }
        Err(update::Error::NotWritable(path)) => {
            eprintln!(
                "beghu: {message}\n(beghu can't replace {} itself: update it as you installed it)",
                path.display()
            );
            1
        }
        Err(update::Error::Fail(e)) => {
            eprintln!("beghu: {message}");
            report(e)
        }
    }
}

async fn run(args: &[String]) -> Result<(), Fail> {
    let Some((cmd, rest)) = args.split_first() else {
        print!("{HELP}");
        return Ok(());
    };
    match cmd.as_str() {
        "--version" | "-V" | "version" => {
            println!(
                "beghu {} (build {}, {})",
                http::VERSION,
                http::BUILD,
                http::platform()
            );
            Ok(())
        }
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        "login" => account::login(rest).await,
        "logout" => account::logout(rest).await,
        "status" => account::status(rest).await,
        "update" => update::command(rest).await,
        "analyse" | "analyze" => analyse::command(rest).await,
        other => Err(Fail::usage(format!("no command {other:?}"))),
    }
}
