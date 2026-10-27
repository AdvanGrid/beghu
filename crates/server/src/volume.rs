//! The data directory's filesystem, checked at startup. SQLite's WAL needs POSIX locks and a
//! shared-memory map that network filesystems don't give reliably, so a data directory on one is
//! refused: the volume must be block storage (ext4, xfs and the like). A FUSE filesystem gets a
//! warning: it may be either (a local overlay, or sshfs, s3fs and the like), and `statfs` can't
//! tell which.

use std::path::Path;

/// Creates the data directory if it's missing, and refuses one on a known network filesystem,
/// naming it.
pub fn check(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("BEGHU_DATA_DIR: can't create {}: {e}", dir.display()))?;
    let Some(magic) = fs_magic(dir)? else {
        return Ok(());
    };
    if let Some(fs) = network_fs(magic) {
        return Err(format!(
            "BEGHU_DATA_DIR: {} is on {fs}, a network filesystem; SQLite's WAL needs a block-storage volume (ext4, xfs)",
            dir.display()
        ));
    }
    if is_fuse(magic) {
        eprintln!(
            "warning: BEGHU_DATA_DIR {} is on a FUSE filesystem; if that reaches over the network (sshfs, s3fs, a cloud drive), SQLite's WAL isn't safe on it: use a block-storage volume (ext4, xfs)",
            dir.display()
        );
    }
    Ok(())
}

/// The `statfs` magic number of `dir`'s filesystem.
#[cfg(target_os = "linux")]
fn fs_magic(dir: &Path) -> Result<Option<u32>, String> {
    let st = rustix::fs::statfs(dir)
        .map_err(|e| format!("BEGHU_DATA_DIR: can't statfs {}: {e}", dir.display()))?;
    // The magic is a signed word on some targets: its low 32 bits are the number.
    Ok(Some(st.f_type as u32))
}

/// Elsewhere (a developer's Mac) there's no `statfs` magic to read, and no check.
#[cfg(not(target_os = "linux"))]
fn fs_magic(_dir: &Path) -> Result<Option<u32>, String> {
    Ok(None)
}

/// Whether a `statfs` magic number is FUSE's (`FUSE_SUPER_MAGIC`).
fn is_fuse(magic: u32) -> bool {
    magic == 0x6573_5546
}

/// The network filesystem a `statfs` magic number names (`linux/magic.h`, `statfs(2)`), if any.
fn network_fs(magic: u32) -> Option<&'static str> {
    Some(match magic {
        0x6969 => "NFS",
        0x517B => "SMB",
        0xFF53_4D42 => "CIFS",
        0xFE53_4D42 => "SMB2",
        0x0102_1997 => "9p",
        0x00C3_6400 => "CephFS",
        0x5346_414F => "AFS",
        0x6B41_4653 => "kAFS",
        0x7375_7245 => "Coda",
        0x564C => "NCP",
        0x0BD0_0BD0 => "Lustre",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{is_fuse, network_fs};

    /// An exception to "tests go through public seams" (AGENTS.md), as no seam can put the data
    /// directory on NFS or FUSE (mounting one takes root and a server): the magic numbers are
    /// checked here instead, against `statfs(2)`'s table.
    #[test]
    fn network_filesystems_are_named_and_block_storage_passes() {
        for (magic, fs) in [
            (0x6969, "NFS"),
            (0xFF53_4D42, "CIFS"),
            (0xFE53_4D42, "SMB2"),
            (0x0102_1997, "9p"),
            (0x00C3_6400, "CephFS"),
        ] {
            assert_eq!(network_fs(magic), Some(fs), "{magic:#x}");
        }
        // ext4, xfs, btrfs, tmpfs, overlayfs.
        for magic in [0xEF53, 0x5846_5342, 0x9123_683E, 0x0102_1994, 0x794C_7630] {
            assert_eq!(network_fs(magic), None, "{magic:#x}");
            assert!(!is_fuse(magic), "{magic:#x}");
        }
    }

    /// FUSE is warned about, not refused: it may be a local overlay.
    #[test]
    fn fuse_is_told_apart_and_not_refused() {
        assert!(is_fuse(0x6573_5546));
        assert_eq!(network_fs(0x6573_5546), None);
    }
}
