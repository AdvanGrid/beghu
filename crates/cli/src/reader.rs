//! The validator's view of the two checkouts: plain files under each folder, and the files git
//! tracks there (`git ls-files`), which the folder counts read.

use analysis::{CodeSide, EntryKind, Reader};
use std::path::{Path, PathBuf};

pub struct Checkouts {
    pub base: PathBuf,
    pub head: PathBuf,
}

impl Checkouts {
    fn root(&self, side: CodeSide) -> &Path {
        match side {
            CodeSide::Base => &self.base,
            CodeSide::Head => &self.head,
        }
    }
}

impl Reader for Checkouts {
    fn read(&self, side: CodeSide, path: &str) -> Option<String> {
        // The crate hands over only clean repo-relative paths (no `..`, no leading `/`).
        std::fs::read_to_string(self.root(side).join(path)).ok()
    }

    fn kind(&self, side: CodeSide, path: &str) -> Option<EntryKind> {
        let m = std::fs::metadata(self.root(side).join(path)).ok()?;
        Some(if m.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        })
    }

    fn tracked(&self, side: CodeSide) -> Option<Vec<String>> {
        let mut git = std::process::Command::new("git");
        git.arg("-C")
            .arg(self.root(side))
            .args(["ls-files", "-z"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // Git's own variables would point it at another repo than the checkout's.
        for v in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_COMMON_DIR",
        ] {
            git.env_remove(v);
        }
        let out = git.output().ok().filter(|o| o.status.success())?;
        let files: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|f| !f.is_empty())
            .map(str::to_owned)
            .collect();
        // None tracked: the folder isn't a checkout of its own, so there's no count rather than
        // a count of 0 (as validate.mjs has it).
        (!files.is_empty()).then_some(files)
    }
}
