//! `contract`: the contract check's command line. `./dev-ctl contract` runs it, and so does
//! `.github/workflows/contract.yml`. Run `contract help` for its usage.

use contract::check::Mode;
use contract::run::Setup;
use contract::{Kind, templates};
use std::path::PathBuf;

const HELP: &str = "contract - diff GitHub's answers with Fake GitHub's recorded templates

Usage: contract read|write [options]
       contract record read|write [options]

  read          The read run: the App's calls, REST and GraphQL reads on --repos with a read-only
                installation token, the App's webhook deliveries of the last 3 days, and the
                user-token half. Coverage gaps: webhook events unseen for 14 days.
  write         The write run: each of beghu's writes on --sandbox, each undone in the same run;
                fails if the sandbox isn't left as it was found.
  record        Runs read or write and records the templates again from the answers (keeping
                the nulls they allowed and their pins), instead of checking.

Exit status: 0 no drift, 1 drift (or the sandbox left changed), 2 the run couldn't start.

Options (each also read from its environment variable):
  --api URL            GitHub's API (CONTRACT_API_URL; https://api.github.com)
  --web URL            GitHub's web origin, for OAuth (CONTRACT_WEB_URL; https://github.com)
  --app-id ID          The App's id (CONTRACT_APP_ID)
  --app-key-file PATH  The App's private key, PEM (CONTRACT_APP_KEY_FILE, or the key itself in
                       CONTRACT_APP_KEY)
  --repos A/B,C/D      Repos the read run reads, busy ones first (CONTRACT_REPOS); the
                       write run needs none
  --sandbox OWNER/NAME The only repo written to; the drift issue lives there
                       (CONTRACT_SANDBOX; AdvanGrid/beghu-sandbox)
  --client-id ID       The App's OAuth client, for the token endpoint's error shapes
  --client-secret S    (CONTRACT_CLIENT_ID, CONTRACT_CLIENT_SECRET; none: skipped)
                       The machine user's token comes from CONTRACT_USER_TOKEN: the
                       user-token half reads with it and the write run writes with it, as
                       beghu writes with user tokens (none: the user-token half is skipped,
                       and the writes go with an installation token narrowed to the sandbox).
  --templates DIR      The templates (crates/fake-github/templates)
  --report             Post the report to the \"Contract drift\" issue on the sandbox
  --deliveries-hours H How far back the read run reads deliveries (72, GitHub's 3 days)
  --fake URL           Against a Fake GitHub at URL instead (API and web): its dev App, the
                       fixture's acme/web and acme/api, acme/web as the sandbox, and writes as a
                       fixture user (--fake-login, tomsj), signed in through the fake's OAuth
                       with --client-id/--client-secret (Iv1.fakegithub / fake-github-secret).
  --fake-login USER

A summary goes to $GITHUB_STEP_SUMMARY when it's set.";

fn fail(msg: &str) -> ! {
    eprintln!("contract: {msg}\nRun `contract help` for usage.");
    std::process::exit(2)
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1).peekable();
    let mut cmd = args.next().unwrap_or_else(|| fail("no command"));
    if matches!(cmd.as_str(), "help" | "-h" | "--help") {
        println!("{HELP}");
        return;
    }
    let recording = cmd == "record";
    if recording {
        cmd = args
            .next()
            .unwrap_or_else(|| fail("record what: read or write?"));
    }
    let kind = match cmd.as_str() {
        "read" => Kind::Read,
        "write" => Kind::Write,
        other => fail(&format!("unknown command {other}")),
    };
    let mut api = env("CONTRACT_API_URL").unwrap_or_else(|| "https://api.github.com".into());
    let mut web = env("CONTRACT_WEB_URL").unwrap_or_else(|| "https://github.com".into());
    let mut app_id = env("CONTRACT_APP_ID");
    let mut key_file = env("CONTRACT_APP_KEY_FILE").map(PathBuf::from);
    let mut repos = env("CONTRACT_REPOS");
    let mut sandbox = env("CONTRACT_SANDBOX").unwrap_or_else(|| "AdvanGrid/beghu-sandbox".into());
    let mut client_id = env("CONTRACT_CLIENT_ID");
    let mut client_secret = env("CONTRACT_CLIENT_SECRET");
    let mut dir = templates::default_dir();
    let mut report = false;
    let mut hours: i64 = 72;
    let mut fake: Option<String> = None;
    let mut fake_login = "tomsj".to_owned();
    while let Some(flag) = args.next() {
        if flag == "--report" {
            report = true;
            continue;
        }
        let value = args
            .next()
            .unwrap_or_else(|| fail(&format!("{flag} needs a value")));
        match flag.as_str() {
            "--api" => api = value,
            "--web" => web = value,
            "--app-id" => app_id = Some(value),
            "--app-key-file" => key_file = Some(PathBuf::from(value)),
            "--repos" => repos = Some(value),
            "--sandbox" => sandbox = value,
            "--client-id" => client_id = Some(value),
            "--client-secret" => client_secret = Some(value),
            "--templates" => dir = PathBuf::from(value),
            "--deliveries-hours" => {
                hours = value
                    .parse()
                    .unwrap_or_else(|_| fail("--deliveries-hours takes hours"))
            }
            "--fake" => fake = Some(value),
            "--fake-login" => fake_login = value,
            _ => fail(&format!("unknown option {flag}")),
        }
    }

    let setup = match fake {
        Some(url) => {
            let id = client_id.unwrap_or_else(|| "Iv1.fakegithub".into());
            let secret = client_secret.unwrap_or_else(|| "fake-github-secret".into());
            let mut setup = Setup::against_fake(&url, &fake_login, (&id, &secret))
                .await
                .unwrap_or_else(|e| fail(&e));
            if let Some(r) = repos {
                setup.repos = r.split(',').map(|r| r.trim().to_owned()).collect();
            }
            if sandbox != "AdvanGrid/beghu-sandbox" {
                setup.sandbox = sandbox;
            }
            setup.deliveries_for = hours * 3600;
            setup
        }
        None => {
            let app_key = match (&key_file, env("CONTRACT_APP_KEY")) {
                (Some(p), _) => std::fs::read_to_string(p)
                    .unwrap_or_else(|e| fail(&format!("reading {}: {e}", p.display()))),
                (None, Some(k)) => k,
                (None, None) => fail("the App's key: --app-key-file or CONTRACT_APP_KEY"),
            };
            Setup {
                mode: Mode::GitHub,
                api,
                web,
                app_id: app_id.unwrap_or_else(|| fail("--app-id (CONTRACT_APP_ID) is required")),
                app_key,
                // The read run needs them (it says so); the write run doesn't.
                repos: repos
                    .unwrap_or_default()
                    .split(',')
                    .map(|r| r.trim().to_owned())
                    .filter(|r| !r.is_empty())
                    .collect(),
                sandbox,
                user_token: env("CONTRACT_USER_TOKEN"),
                oauth_client: client_id.zip(client_secret),
                // beghu writes with user tokens: the machine user's, when there is one.
                write_token: env("CONTRACT_USER_TOKEN"),
                deliveries_for: hours * 3600,
            }
        }
    };

    if recording {
        let templates = templates::Templates::load(&dir).unwrap_or_else(|e| fail(&e));
        let mut c = contract::check::Checker::new(templates.clone(), setup.mode);
        c.recording = true;
        let done = match kind {
            Kind::Read => contract::run::read(&setup, &mut c).await,
            Kind::Write => contract::run::write(&setup, &mut c).await,
        };
        done.unwrap_or_else(|e| fail(&e));
        let names = c.found.samples.len();
        contract::record::record(templates, &c.found)
            .save(&dir)
            .unwrap_or_else(|e| fail(&e));
        println!("recorded {names} templates in {}", dir.display());
        for n in &c.found.notes {
            println!("note: {n}");
        }
        return;
    }

    let out = contract::run(kind, &setup, &dir, report)
        .await
        .unwrap_or_else(|e| fail(&e));
    println!("{}", out.report);
    if let Some(path) = env("GITHUB_STEP_SUMMARY") {
        use std::io::Write as _;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
        {
            let _ = writeln!(f, "{}", out.report);
        }
    }
    if let Some(n) = out.issue {
        eprintln!("contract: reported on {}#{n}", setup.sandbox);
    }
    if out.failed {
        std::process::exit(1);
    }
}
