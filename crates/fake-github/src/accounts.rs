//! The fixture accounts that can sign in to the fake, with different access and roles, and the
//! App installation that holds the fixture's synced repos.

use fake_db::q;
use rusqlite::Transaction;
use std::path::{Path, PathBuf};

/// An account's **Role** on a repo, in GitHub's five levels (beghu folds the top three into
/// "Write and up"). Ordered from least to most access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Read,
    Triage,
    Write,
    Maintain,
    Admin,
}

impl Role {
    /// GitHub's name for the role, as the truth stores it.
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Read => "read",
            Role::Triage => "triage",
            Role::Write => "write",
            Role::Maintain => "maintain",
            Role::Admin => "admin",
        }
    }

    /// The role GitHub calls `name`, or `None` for a name GitHub doesn't have.
    pub fn from_name(name: &str) -> Option<Role> {
        match name {
            "admin" => Some(Role::Admin),
            "maintain" => Some(Role::Maintain),
            "write" => Some(Role::Write),
            "triage" => Some(Role::Triage),
            "read" => Some(Role::Read),
            _ => None,
        }
    }
}

pub struct Account {
    pub login: &'static str,
    pub name: &'static str,
    /// The account's role on a fixture repo, by repo name. `None`: it can't see the repo.
    pub role: fn(&str) -> Option<Role>,
    /// A member of the org that owns the fixture repos, rather than an outside collaborator.
    pub member: bool,
}

/// Who the authorize page offers, in order.
pub const ACCOUNTS: [Account; 4] = [
    // An org owner: admin everywhere.
    Account {
        login: "tomsj",
        name: "Toms J.",
        role: |_| Some(Role::Admin),
        member: true,
    },
    // A member with a mix of roles: write, triage and read.
    Account {
        login: "ilze-k",
        name: "Ilze K.",
        role: |repo| match repo {
            "web" | "api" | "mobile" => Some(Role::Write),
            "cli" | "billing" | "ops" => Some(Role::Read),
            _ => Some(Role::Triage),
        },
        member: true,
    },
    // An outside collaborator with read on two repos.
    Account {
        login: "octo-ext",
        name: "Octo External",
        role: |repo| matches!(repo, "web" | "docs").then_some(Role::Read),
        member: false,
    },
    // Someone new: no access to the org's repos, and a repo of their own the App isn't installed
    // on, so signing in leads to installing it (see `newcomer`).
    Account {
        login: NEWCOMER,
        name: "New Comer",
        role: |_| None,
        member: false,
    },
];

/// The account with no installation, and its own repo, `newcomer/notes`.
pub const NEWCOMER: &str = "newcomer";
const NEWCOMER_ID: i64 = 1_100;
const NOTES_REPO: i64 = 9_000_200;

/// The org that owns the fixture repos and installed the App.
const ORG_ID: i64 = 61_000_001;
const INSTALLED_AT: i64 = 1_756_684_800; // 2025-09-01T00:00:00Z

/// Fills the fake's tables in a fresh copy of the fixture.
pub(crate) fn seed(tx: &Transaction) -> rusqlite::Result<()> {
    newcomer(tx)?;
    let repos = q::installed_repos(tx)?;
    let mut installations: Vec<(i64, &str)> = repos
        .iter()
        .map(|r| (r.installation_id, r.owner.as_str()))
        .collect();
    installations.dedup();
    for (id, owner) in installations {
        q::add_installation(tx, id, ORG_ID, owner, "Organization", INSTALLED_AT)?;
    }
    for (position, a) in ACCOUNTS.iter().enumerate() {
        let user = q::user_by_login(tx, a.login)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        q::add_account(tx, user.id, a.name, position as i64)?;
        for r in &repos {
            if let Some(role) = (a.role)(&r.name) {
                q::add_permission(tx, user.id, r.id, role.as_str())?;
            }
        }
    }
    q::add_permission(tx, NEWCOMER_ID, NOTES_REPO, Role::Admin.as_str())?;
    Ok(())
}

/// The newcomer and their repo, in the truth only (the fixture mirror is what the org's accounts
/// sync): a few issues, a PR, labels, a milestone and comments, enough to watch an import land.
/// The App isn't installed on the repo until the newcomer installs it.
fn newcomer(tx: &Transaction) -> rusqlite::Result<()> {
    use mirror_db::q as m;
    /// The fixture's "now" (2026-10-01T00:00:00Z).
    const NOW: i64 = 1_790_812_800;
    const DAY: i64 = 86_400;
    let seq = m::bump_seq(tx)?;
    let user = NEWCOMER_ID;
    m::insert_user(
        tx,
        user,
        NEWCOMER,
        &format!("https://avatars.githubusercontent.com/u/{user}?v=4"),
    )?;
    m::insert_repo(
        tx,
        NOTES_REPO,
        &format!("R_kw{NOTES_REPO}"),
        NEWCOMER,
        "notes",
        true,
        None,
        true,
        None,
    )?;
    let labels = [
        (5_100_000, "idea", "0e8a16"),
        (5_100_001, "chore", "c2e0c6"),
    ];
    for (id, name, color) in labels {
        m::insert_label(tx, id, NOTES_REPO, name, color, &format!("{name} notes"))?;
    }
    m::insert_milestone(
        tx,
        7_100_001,
        NOTES_REPO,
        1,
        "Someday",
        "open",
        NOW + 30 * DAY,
        NOW - 40 * DAY,
    )?;
    // (title, open, PR)
    let items = [
        ("Write down the reading list", true, false),
        ("Sort the photo archive", true, false),
        ("Plan the garden beds", true, false),
        ("Fix the bike's back brake", true, false),
        ("Try the new sourdough recipe", true, false),
        ("Renew the passport", false, false),
        ("Back up the old laptop", false, false),
        ("Add a notes index page", true, true),
    ];
    let mut comment = 2_950_000_000;
    for (n, (title, open, pr)) in items.into_iter().enumerate() {
        let n = n as i64;
        let id = 3_950_000_000 + n;
        let created = NOW - (40 - n) * DAY;
        let updated = NOW - (20 - n) * DAY;
        m::insert_item(
            tx,
            id,
            &format!("I_kwnew{id}"),
            NOTES_REPO,
            n + 1,
            if pr { "pr" } else { "issue" },
            title,
            &format!("{title}, when there's a free evening."),
            if open { "open" } else { "closed" },
            (!open && !pr).then_some("completed"),
            user,
            (n % 3 == 0).then_some(7_100_001),
            created,
            updated,
            (!open).then_some(updated),
            pr.then_some(2_450_000_000 + n),
            pr.then_some(false),
            None,
            pr.then_some("notes-index"),
            pr.then_some("main"),
            pr.then_some("review_required"),
            (!pr && n % 2 == 0).then_some("Task"),
            seq,
        )?;
        m::add_item_label(tx, id, labels[(n % 2) as usize].0)?;
        if open {
            m::add_item_assignee(tx, id, user)?;
        }
        let count = n % 3;
        for k in 0..count {
            m::insert_comment(
                tx,
                comment,
                &format!("IC_kwnew{comment}"),
                id,
                user,
                &format!("Note {} on this.", k + 1),
                created + (k + 1) * 3600,
                seq,
            )?;
            comment += 1;
        }
        if count > 0 {
            m::set_comment_stats(tx, id, count, created + count * 3600)?;
        }
    }
    Ok(())
}

/// Writes a pristine mirror, `<dir>/<github_user_id>.db`, for each fixture account that sees
/// every synced fixture repo: a copy of the fixture with that account's roles. Accounts that see
/// fewer repos get none (their mirror comes from an import). Returns `(login, path)` for each.
pub async fn pristine_mirrors(
    fixture: &Path,
    db: &Path,
    dir: &Path,
) -> Result<Vec<(String, PathBuf)>, fake_db::Error> {
    let (fixture, db, dir) = (fixture.to_owned(), db.to_owned(), dir.to_owned());
    let truth = {
        let (fixture, db) = (fixture.clone(), db.clone());
        tokio::task::spawn_blocking(move || fake_db::Truth::open(&db, &fixture, Box::new(seed)))
            .await
            .map_err(|_| fake_db::Error::Panicked)??
    };
    let plan = truth
        .read(|c| {
            let installed = q::installed_repos(c)?.len();
            let mut out = Vec::new();
            for a in q::accounts(c)? {
                let roles = q::account_roles(c, a.id)?;
                if roles.len() == installed {
                    out.push((a.id, a.login, roles));
                }
            }
            Ok(out)
        })
        .await?;
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)?;
        let mut written = Vec::new();
        for (id, login, roles) in plan {
            let path = dir.join(format!("{id}.db"));
            dbrt::copy::copy_over(&fixture, &path, |conn| {
                let tx = conn.transaction()?;
                mirror_db::q::bump_seq(&tx)?;
                for r in &roles {
                    mirror_db::q::set_repo_role(&tx, r.repo_id, &r.role)?;
                }
                // A mirror holds a stub only while a relationship reaches it, as the import
                // leaves one: it can't learn of a stub nothing points to. The truth keeps them
                // all, as the unsynced repo's issues.
                mirror_db::q::drop_orphan_stubs(&tx)?;
                tx.commit()?;
                Ok::<_, fake_db::Error>(())
            })?;
            written.push((login, path));
        }
        Ok::<_, fake_db::Error>(written)
    })
    .await
    .map_err(|_| fake_db::Error::Panicked)?
}
