//! The control DB's backups: a `VACUUM INTO` copy every [`Config::backup_every`] (an hour), in
//! `BEGHU_DATA_DIR/backups/control-<UTC time>.db` (`control-20261027T140000Z.db`), keeping the 24
//! newest (the hourly ones) and, from the older ones, the newest of each of the 7 latest days that
//! have one (the daily ones): 31 at most. Mirrors are never backed up: they're rebuilt from
//! GitHub.
//!
//! The first backup of a start is taken at once when the newest one is older than the interval
//! (or there's none). The drain's checkpoint cuts a backup under way short, deleting its
//! half-written copy, rather than wait for it: the next start takes it again if it's due. The copy taken before a migration (`control-before-v<N>.db`) and any other
//! file in the directory are left alone.
//!
//! Restoring: stop beghu, copy a backup over `control.db` as uid 65532 (removing `control.db-wal`
//! and `control.db-shm`), start it (docs/deploy.md has the commands). Redelivery and sweeps
//! (`reconcile/`) catch up what changed since.
//!
//! [`Config::backup_every`]: crate::Config::backup_every

use crate::{App, io_failed};
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

/// Hourly backups kept.
const HOURLY: usize = 24;
/// Days whose newest backup is kept.
const DAILY: usize = 7;
/// A day, in seconds.
const DAY: i64 = 24 * 60 * 60;

/// Rotates the directory, then takes a backup whenever one is due and rotates again, until the
/// drain stops it.
pub async fn job(app: App) {
    let dir = app.cfg().backups();
    let every = app.cfg().backup_every;
    loop {
        let newest = {
            let dir = dir.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(e) = rotate(&dir) {
                    eprintln!("backups: {e}");
                }
                backups_in(&dir).last().copied()
            })
            .await
            .unwrap_or(None)
        };
        let now = crate::now();
        let due = newest.map_or(now, |at| at.saturating_add(every.as_secs() as i64));
        if due > now {
            tokio::time::sleep(Duration::from_secs((due - now) as u64)).await;
            continue;
        }
        if let Err(e) = take(&app, &dir, now).await {
            eprintln!("backups: {e}");
            // Tried again after the interval; an hour's gap is the cost of a failing disk.
            tokio::time::sleep(every).await;
        }
    }
}

async fn take(app: &App, dir: &Path, now: i64) -> Result<(), String> {
    let d = dir.to_owned();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&d).map_err(io_failed("create", &d))
    })
    .await
    .map_err(|_| "creating the backups directory panicked".to_owned())??;
    let path = dir.join(name(now));
    app.control()
        .backup(&path)
        .await
        .map_err(|e| format!("can't back the control DB up to {}: {e}", path.display()))
}

/// Deletes the backups that are neither among the [`HOURLY`] newest nor, of the older ones, the
/// newest of one of the [`DAILY`] latest days (UTC) that have one, and any backup a crash left
/// half written
/// (`<name>.tmp`; none is being written while this runs, as the job takes them in turn).
fn rotate(dir: &Path) -> Result<(), String> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name();
            let half = name.to_str().and_then(|n| n.strip_suffix(dbrt::copy::TMP));
            if half.and_then(parse).is_some() {
                std::fs::remove_file(e.path()).map_err(io_failed("delete", &e.path()))?;
            }
        }
    }
    let all = backups_in(dir);
    let mut keep: BTreeSet<i64> = all.iter().rev().take(HOURLY).copied().collect();
    let mut days = BTreeSet::new();
    for at in all.iter().rev().skip(HOURLY) {
        if days.len() == DAILY && !days.contains(&at.div_euclid(DAY)) {
            break;
        }
        if days.insert(at.div_euclid(DAY)) {
            keep.insert(*at);
        }
    }
    for at in all.iter().filter(|at| !keep.contains(at)) {
        let path = dir.join(name(*at));
        std::fs::remove_file(&path).map_err(io_failed("delete", &path))?;
    }
    Ok(())
}

/// The times (Unix seconds) of the hourly backups in `dir`, oldest first.
fn backups_in(dir: &Path) -> Vec<i64> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut all: Vec<i64> = entries
        .filter_map(|e| parse(e.ok()?.file_name().to_str()?))
        .collect();
    all.sort_unstable();
    all
}

/// `control-20261027T140000Z.db` for 2026-10-27 14:00:00 UTC.
fn name(at: i64) -> String {
    let (days, secs) = (at.div_euclid(DAY), at.rem_euclid(DAY));
    let (y, m, d) = civil_from_days(days);
    format!(
        "control-{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z.db",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// The time a backup's file name stands for; `None` for any other file.
fn parse(file: &str) -> Option<i64> {
    let s = file.strip_prefix("control-")?.strip_suffix("Z.db")?;
    let (date, time) = s.split_once('T')?;
    if date.len() != 8 || time.len() != 6 || !s.bytes().all(|b| b.is_ascii_digit() || b == b'T') {
        return None;
    }
    let n = |s: &str| s.parse::<i64>().ok();
    let (y, m, d) = (n(&date[..4])?, n(&date[4..6])?, n(&date[6..])?);
    let (h, mi, sec) = (n(&time[..2])?, n(&time[2..4])?, n(&time[4..])?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let at = days_from_civil(y, m, d) * DAY + h * 3600 + mi * 60 + sec;
    // A date that doesn't exist (February 30th) names no backup.
    (name(at) == file).then_some(at)
}

/// Howard Hinnant's `civil_from_days`: the proleptic Gregorian date of a day since 1970-01-01.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Howard Hinnant's `days_from_civil`: the inverse of [`civil_from_days`].
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
