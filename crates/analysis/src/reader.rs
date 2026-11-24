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
    /// The names of a folder's immediate subfolders, or `None` if it isn't a folder.
    fn subdirs(&self, side: CodeSide, path: &str) -> Option<Vec<String>>;
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

/// Whether `path` is `prefix` or lies under it, on whole path segments.
pub fn under(path: &str, prefix: &str) -> bool {
    let prefix = prefix.strip_suffix('/').unwrap_or(prefix);
    let path = path.strip_suffix('/').unwrap_or(path);
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes()[prefix.len()] == b'/')
}

/// Every folder under `path` at any depth, not counting `path` itself or `.git`.
pub(crate) fn count_folders(reader: &dyn Reader, side: CodeSide, path: &str) -> Option<u32> {
    let mut count = 0;
    let mut stack = vec![path.to_owned()];
    while let Some(dir) = stack.pop() {
        let subs = reader.subdirs(side, &dir)?;
        for s in subs {
            if s == ".git" {
                continue;
            }
            count += 1;
            stack.push(format!("{dir}/{s}"));
        }
    }
    Some(count)
}
