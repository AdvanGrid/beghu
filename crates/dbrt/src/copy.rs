//! Replacing a database file with an edited copy of another, so a crash leaves the old file or
//! the new one, never half of each.

use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Copies the SQLite file `src` to `<dest>.new`, runs `edit` on the copy, folds the copy's WAL
/// into it and renames it over `dest`, removing `dest`'s old `-wal` and `-shm` first. Every
/// connection to `dest` must be closed. `src` must have no WAL of its own: only the main file is
/// copied. If `edit` fails, `dest` is untouched and the copy is removed.
pub fn copy_over<T, E>(
    src: &Path,
    dest: &Path,
    edit: impl FnOnce(&mut Connection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<rusqlite::Error> + From<std::io::Error>,
{
    let tmp = suffixed(dest, ".new");
    let remove_tmp = || {
        for f in [&tmp, &suffixed(&tmp, "-wal"), &suffixed(&tmp, "-shm")] {
            let _ = std::fs::remove_file(f);
        }
    };
    remove_tmp();
    std::fs::copy(src, &tmp)?;
    let edited = (|| -> Result<T, E> {
        let mut conn = Connection::open(&tmp)?;
        let out = edit(&mut conn)?;
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
        Ok(out)
    })();
    let out = match edited {
        Ok(out) => out,
        Err(e) => {
            remove_tmp();
            return Err(e);
        }
    };
    for ext in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(suffixed(dest, ext));
        let _ = std::fs::remove_file(suffixed(&tmp, ext));
    }
    std::fs::rename(&tmp, dest)?;
    Ok(out)
}

pub(crate) fn suffixed(p: &Path, ext: &str) -> PathBuf {
    PathBuf::from(format!("{}{ext}", p.display()))
}
