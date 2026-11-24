//! How the crate sees the two checkouts without doing I/O: the caller supplies a `Reader`. The
//! server passes none; the beghu CLI passes one over the two checkouts; `validate.mjs` passes
//! one over `node:fs`.

use crate::schema::CodeSide;

/// What a path is in a checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File,
    Dir,
}

/// Read-only access to the base and head checkouts. Paths are repo-relative, `/`-separated, with
/// no `.` or `..` segments (the crate refuses any other before asking).
pub trait Reader {
    /// A file's text, or `None` if it doesn't exist or isn't text.
    fn read(&self, side: CodeSide, path: &str) -> Option<String>;
    /// What the path is, or `None` if it doesn't exist.
    fn kind(&self, side: CodeSide, path: &str) -> Option<EntryKind>;
    /// Every file git tracks on that side (`git ls-files` run in the checkout), repo-relative and
    /// `/`-separated, or `None` if it can't list them (the folder isn't a git checkout). Folder
    /// counts read this list, so untracked and ignored folders (`node_modules`, build output)
    /// never count.
    fn tracked(&self, side: CodeSide) -> Option<Vec<String>>;
}

/// A repo path the crate will hand a reader: relative, `/`-separated, with no empty, `.` or
/// `..` segments. A trailing slash is allowed and dropped.
pub fn clean_path(path: &str) -> Option<&str> {
    let p = path.strip_suffix('/').unwrap_or(path);
    if p.is_empty() || p.starts_with('/') || p.contains('\\') {
        return None;
    }
    if p.split('/').any(|s| s.is_empty() || s == "." || s == "..") {
        return None;
    }
    Some(p)
}

/// Whether a prefix names the whole repo: empty, `.`, `./` or `/`.
pub fn is_root(prefix: &str) -> bool {
    matches!(prefix, "" | "." | "./" | "/")
}

/// Whether `path` is `prefix` or lies under it, on whole path segments. A root prefix (see
/// [`is_root`]) holds every path.
pub fn under(path: &str, prefix: &str) -> bool {
    if is_root(prefix) {
        return true;
    }
    let prefix = prefix.strip_suffix('/').unwrap_or(prefix);
    let path = path.strip_suffix('/').unwrap_or(path);
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes()[prefix.len()] == b'/')
}

/// The folders under any of `paths` (not counting the paths themselves) that hold at least one
/// of the `tracked` files, directly or in a subfolder: the folders git knows about. A folder under
/// two of the paths counts once.
pub(crate) fn count_folders(tracked: &[String], paths: &[&str]) -> u32 {
    let mut folders = std::collections::HashSet::new();
    for f in tracked {
        for base in paths {
            let base = base.strip_suffix('/').unwrap_or(base);
            if f == base || !under(f, base) {
                continue;
            }
            // The first slash past `base` closes the first folder inside it.
            let skip = if is_root(base) { 0 } else { base.len() + 1 };
            for (i, c) in f.char_indices().skip_while(|&(i, _)| i < skip) {
                if c == '/' {
                    folders.insert(&f[..i]);
                }
            }
        }
    }
    folders.len() as u32
}
