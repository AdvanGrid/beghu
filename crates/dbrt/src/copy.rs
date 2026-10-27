//! Replacing a file whole: a database file with an edited copy of another, or any file with one
//! written beside it, so a crash leaves the old file or the new one, never half of each.

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

/// Writes `dest` whole or not at all: `fill` writes `<dest>.tmp` (a stale one from a crash is
/// removed first), which is flushed to disk, renamed over `dest`, and the directory flushed, so
/// after a crash or a power cut `dest` is the old file or the new one. If `fill` fails, `dest`
/// is untouched and the temporary file is removed.
pub fn write_whole<E>(dest: &Path, fill: impl FnOnce(&Path) -> Result<(), E>) -> Result<(), E>
where
    E: From<std::io::Error>,
{
    let tmp = suffixed(dest, TMP);
    let _ = std::fs::remove_file(&tmp);
    let written = fill(&tmp).and_then(|()| Ok(std::fs::File::open(&tmp)?.sync_all()?));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest)?;
    if let Some(dir) = dest.parent() {
        // The rename lives in the directory: flushed too, or a power cut can undo it.
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

/// What [`write_whole`] appends to the name of the file it writes first.
pub const TMP: &str = ".tmp";

pub(crate) fn suffixed(p: &Path, ext: &str) -> PathBuf {
    PathBuf::from(format!("{}{ext}", p.display()))
}
