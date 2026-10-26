//! PROTOTYPE — part 2: mirrors migrating on first use. Drive deploys, requests, webhooks and
//! sweeps by hand and watch the per-account gate (`dbrt::gate`, pure) decide who waits.
//! Migrations run for real on SQLite files under PROTOTYPE-wipe-me/gate/.
//!
//!     cargo run -p proto --bin gate
//!
//! Three builds: B2 knows mirror v2 / control v1, B3 mirror v3 / control v2, B4 mirror v4 /
//! control v3. Mirror 0003 is in place (and fails on bob's duplicate rows), 0004 is a rebuild.
//! Control 0002 is additive, 0003 isn't. Everyone starts on B2.
use dbrt::gate::{Caller, Effect, Event, Gate, State};
use dbrt::migrations::{self, MigError};
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};

const B: &str = "\x1b[1m";
const D: &str = "\x1b[2m";
const Y: &str = "\x1b[33m";
const R: &str = "\x1b[0m";
const ACCOUNTS: &[(&str, bool)] = &[("alice", false), ("bob", false), ("carol", true)];

enum Job { InPlace { acct: String, from: u32, to: u32 }, Recreate { acct: String, why: String }, Import { acct: String } }

struct Shell {
    gate: Gate,
    dir: PathBuf,
    build: u32,
    control: String,
    down: Option<String>,
    jobs: VecDeque<Job>,
    log: Vec<String>,
    sel: usize,
    inject: bool,
}

fn mirror(dir: &Path, a: &str) -> PathBuf { dir.join(format!("mirrors/{a}.sqlite")) }

impl Shell {
    fn log(&mut self, s: String) {
        self.log.push(format!("{D}{:>6.2}s{R} {s}", self.gate.now as f64 / 1000.0));
    }

    fn send(&mut self, ev: Event) {
        if let (Some(why), Event::Use(a, c)) = (&self.down, &ev) {
            let s = format!("{a} {c:?}: {Y}502 from the edge{R}: {why}");
            self.log(s);
            return;
        }
        let fx = self.gate.handle(ev);
        for f in fx {
            self.run(f);
        }
    }

    fn run(&mut self, f: Effect) {
        match f {
            Effect::Open(a) => {
                let v = migrations::file_version(&mirror(&self.dir, &a)).unwrap();
                self.log(format!("{a}: opened, file is {}", v.map_or("missing".into(), |v| format!("v{v}"))));
                self.send(Event::Opened(a, v));
            }
            Effect::RunInPlace { acct, from, to } => {
                self.log(format!("{acct}: queued in-place v{from}→v{to}"));
                self.jobs.push_back(Job::InPlace { acct, from, to });
            }
            Effect::Recreate { acct, why } => {
                self.log(format!("{acct}: {Y}rebuild{R}: {why}"));
                self.jobs.push_back(Job::Recreate { acct, why });
            }
            Effect::StartImport(a) => self.jobs.push_back(Job::Import { acct: a }),
            Effect::Delete(a) => {
                let _ = std::fs::remove_file(mirror(&self.dir, &a));
                self.log(format!("{a}: mirror file deleted"));
            }
            Effect::Serve { acct, id, caller, waited, note } => self.log(format!("{acct}: served #{id} {caller:?} after {waited} ms {D}{note}{R}")),
            Effect::Reject { acct, id, caller, why } => self.log(format!("{acct}: {Y}#{id} {caller:?}: {why}{R}")),
            Effect::Skip { acct, caller, why } => self.log(format!("{acct}: {caller:?} skipped: {why}")),
            Effect::Status(a, s) => self.log(format!("{a}: SSE status → {}", s.unwrap_or("(cleared)".into()))),
        }
    }

    fn next_job(&mut self) {
        let Some(job) = self.jobs.pop_front() else { return self.log("no pending job".into()) };
        match job {
            Job::InPlace { acct, from, to } => {
                let mut c = rusqlite::Connection::open(mirror(&self.dir, &acct)).unwrap();
                let inject = std::mem::take(&mut self.inject).then(|| MigError::Transient("database or disk is full (injected)".into()));
                let r = migrations::migrate_in_place(&mut c, mirror_db::MIGRATIONS, from, to, inject);
                drop(c);
                let file = migrations::file_version(&mirror(&self.dir, &acct)).unwrap().unwrap_or(0);
                self.log(format!("{acct}: in-place v{from}→v{to}: {} {D}(file now v{file}){R}", match &r { Ok(()) => "ok".into(), Err(e) => format!("{Y}{e:?}{R}") }));
                self.send(Event::InPlaceDone(acct, r));
            }
            Job::Recreate { acct, why: _ } => {
                let r = migrations::create_fresh(&mirror(&self.dir, &acct), mirror_db::MIGRATIONS, self.build).map_err(|e| e.to_string());
                self.log(format!("{acct}: created empty mirror at v{}", self.build));
                self.send(Event::Recreated(acct, r));
            }
            Job::Import { acct } => {
                let c = rusqlite::Connection::open(mirror(&self.dir, &acct)).unwrap();
                seed(&c, false);
                self.log(format!("{acct}: import finished"));
                self.send(Event::ImportDone(acct));
            }
        }
    }

    fn deploy(&mut self, build: u32) {
        if !self.jobs.is_empty() {
            self.log(format!("{Y}stop: {} job(s) killed; an uncommitted migration leaves its file as it was{R}", self.jobs.len()));
            self.jobs.clear();
        }
        self.build = build;
        let ctl_to = build - 1;
        let mut c = rusqlite::Connection::open(self.dir.join("control.sqlite")).unwrap();
        let r = migrations::migrate_control(&mut c, &control_db::MIGRATIONS[..], ctl_to, &self.dir.join("backups"));
        self.control = match &r {
            Ok(o) => format!("{o:?}"),
            Err(e) => format!("{Y}refuses to start{R}: {e}"),
        };
        self.down = r.err().map(|e| format!("B{build} isn't running ({e})"));
        self.gate.handle(Event::Restart(build));
        self.log(format!("{B}deploy B{build}{R}: control {}", self.control));
    }

    fn frame(&self) {
        print!("\x1b[2J\x1b[H");
        println!("{B}build{R} B{} {D}(mirror v{}, control v{}){R}   {B}clock{R} {:.2} s   {B}inject disk-full{R} {}", self.build, self.build, self.build - 1, self.gate.now as f64 / 1000.0, if self.inject { "ON" } else { "off" });
        println!("{B}control{R} {}", self.control);
        if let Some(d) = &self.down { println!("{Y}{d}{R}") }
        println!("\n{B}  {:<18}{:<6}{:<40}{:<34}{}{R}", "account", "file", "gate state", "waiting", "status slot");
        for (i, (a, ac)) in self.gate.accounts.iter().enumerate() {
            let file = migrations::file_version(&mirror(&self.dir, a)).ok().flatten().map_or("—".into(), |v| format!("v{v}"));
            let state = match &ac.state {
                State::Migrating { from, to, since } => format!("Migrating v{from}→v{to} ({} ms)", self.gate.now - since),
                State::Importing { since } => format!("Importing ({} ms)", self.gate.now - since),
                State::Backoff { version, until, .. } => format!("Backoff at v{version}, retry ≥ {:.1} s", *until as f64 / 1000.0),
                State::Recreating { .. } => "Recreating".into(),
                s => format!("{s:?}"),
            };
            let waiting: Vec<String> = ac.waiting.iter().map(|w| format!("#{} {:?} {}ms", w.id, w.caller, self.gate.now - w.since)).collect();
            let name = format!("{}{a}{}", if i == self.sel { "▸ " } else { "  " }, if ac.dormant { " (dormant)" } else { "" });
            println!("{:<20}{:<6}{:<40}{:<34}{}", name, file, trunc(&state, 39), trunc(&waiting.join(", "), 33), ac.status.clone().unwrap_or_default());
        }
        println!("\n{B}pending jobs{R}");
        for j in &self.jobs {
            println!("  {}", match j {
                Job::InPlace { acct, from, to } => format!("{acct}: in-place v{from}→v{to}"),
                Job::Recreate { acct, why } => format!("{acct}: delete + create empty ({why})"),
                Job::Import { acct } => format!("{acct}: import from GitHub"),
            });
        }
        if self.jobs.is_empty() { println!("  {D}none{R}") }
        println!("\n{B}log{R}");
        for l in self.log.iter().rev().take(14).collect::<Vec<_>>().into_iter().rev() {
            println!("  {l}");
        }
        println!("\n{B}[a/b/c]{R}{D} select{R}  {B}r{R}{D} request{R}  {B}w{R}{D} webhook{R}  {B}s{R}{D} sweep{R}  {B}z{R}{D} 2 requests+webhook+sweep{R}  {B}N{R}{D} nightly sweep{R}  {B}j{R}{D} run next job{R}");
        println!("{B}t{R}{D} +100 ms{R}  {B}T{R}{D} +1 s{R}  {B}W{R}{D} +10 s{R}  {B}2/3/4{R}{D} deploy B2/B3/B4{R}  {B}f{R}{D} inject disk-full into next in-place{R}  {B}q{R}{D} quit{R}");
        print!("> ");
        std::io::stdout().flush().unwrap();
    }
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.into() } else { s.chars().take(n - 1).collect::<String>() + "…" }
}

/// A few rows. `dup` adds a second row for (repo 1, #1), which 0003's unique index rejects.
fn seed(c: &rusqlite::Connection, dup: bool) {
    c.execute_batch(
        "INSERT OR IGNORE INTO repos VALUES (1, 'acme', 'web');
         INSERT OR IGNORE INTO items (id, repo_id, number, kind, state, title, updated_at) VALUES
           (1, 1, 1, 'issue', 'open', 'First', '2026-10-20'), (2, 1, 2, 'issue', 'open', 'Second', '2026-10-21');",
    ).unwrap();
    if dup {
        c.execute_batch("INSERT INTO items (id, repo_id, number, kind, state, title, updated_at) VALUES (3, 1, 1, 'issue', 'open', 'Transferred, not tombstoned', '2026-10-22');").unwrap();
    }
}

fn main() {
    let dir = PathBuf::from("PROTOTYPE-wipe-me/gate");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("mirrors")).unwrap();
    for (a, _) in ACCOUNTS {
        let p = mirror(&dir, a);
        migrations::create_fresh(&p, mirror_db::MIGRATIONS, 2).unwrap();
        seed(&rusqlite::Connection::open(&p).unwrap(), *a == "bob");
    }
    let kinds = mirror_db::MIGRATIONS.iter().map(|m| m.kind).collect();
    let mut sh = Shell { gate: Gate::new(kinds, 2, ACCOUNTS), dir, build: 2, control: String::new(), down: None, jobs: VecDeque::new(), log: vec![], sel: 0, inject: false };
    sh.deploy(2);
    let names: Vec<String> = ACCOUNTS.iter().map(|a| a.0.to_string()).collect();
    loop {
        sh.frame();
        let mut line = String::new();
        if std::io::stdin().read_line(&mut line).unwrap() == 0 { break }
        for k in line.trim().chars() {
            let a = names[sh.sel].clone();
            match k {
                'a' => sh.sel = 0,
                'b' => sh.sel = 1,
                'c' => sh.sel = 2,
                'r' => sh.send(Event::Use(a, Caller::Request)),
                'w' => sh.send(Event::Use(a, Caller::Webhook)),
                's' => sh.send(Event::Use(a, Caller::Sweep)),
                'z' => {
                    for c in [Caller::Request, Caller::Request, Caller::Webhook, Caller::Sweep] {
                        sh.send(Event::Use(a.clone(), c));
                    }
                }
                'N' => sh.send(Event::NightlySweep),
                'j' => sh.next_job(),
                't' => sh.send(Event::Tick(100)),
                'T' => sh.send(Event::Tick(1000)),
                'W' => sh.send(Event::Tick(10_000)),
                '2' | '3' | '4' => sh.deploy(k.to_digit(10).unwrap()),
                'f' => sh.inject = !sh.inject,
                'q' => return,
                _ => {}
            }
        }
    }
}
