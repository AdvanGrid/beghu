//! The checks that read the two checkouts through the caller's reader: snippets, paths and
//! folder counts. The server runs none of them (it never reads code); the CLI and validate.mjs
//! run them all.

use std::collections::HashMap;

use super::index::Index;
use crate::reader::{EntryKind, Reader, clean_path, count_folders};
use crate::report::{Report, rule};
use crate::schema::{CodeSide, Evidence};

/// A file's lines, as the snippet check compares them: split on `\n`, without the empty line after
/// a final newline.
fn lines(text: &str) -> Vec<&str> {
    let mut v: Vec<&str> = text.split('\n').collect();
    if v.last() == Some(&"") {
        v.pop();
    }
    v
}

/// Lines compared without trailing whitespace (so CRLF files match), and without whitespace
/// around the whole.
fn norm<'a>(lines: impl Iterator<Item = &'a str>) -> String {
    lines
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

pub(super) fn check(ix: &Index, reader: &dyn Reader, r: &mut Report) {
    let a = ix.a;
    let mut files: HashMap<(CodeSide, String), Option<String>> = HashMap::new();
    for (ci, c) in a.claims.iter().enumerate() {
        for (ei, e) in c.evidence.iter().enumerate() {
            let Evidence::Code {
                side,
                path,
                start,
                end,
                snippet,
                ..
            } = e
            else {
                continue;
            };
            let p = format!("/claims/{ci}/evidence/{ei}");
            let at = format!("{}:{path}:{start}-{end}", super::graph::name(side));
            let Some(clean) = clean_path(path) else {
                r.error(
                    format!("{p}/path"),
                    rule::EVIDENCE_FILE,
                    format!("`{path}` isn't a repo-relative path"),
                );
                continue;
            };
            let text = files
                .entry((*side, clean.to_owned()))
                .or_insert_with(|| reader.read(*side, clean));
            let Some(text) = text else {
                r.error(
                    format!("{p}/path"),
                    rule::EVIDENCE_FILE,
                    format!("{at}: no such file at {}", super::graph::name(side)),
                );
                continue;
            };
            if *start < 1 || end < start {
                continue; // evidence.lines already says so
            }
            let ls = lines(text);
            if *end as usize > ls.len() {
                r.error(
                    &p,
                    rule::EVIDENCE_RANGE,
                    format!("{at}: the file has {} lines", ls.len()),
                );
                continue;
            }
            let actual = norm(ls[*start as usize - 1..*end as usize].iter().copied());
            if actual != norm(snippet.split('\n')) {
                r.error(
                    format!("{p}/snippet"),
                    rule::EVIDENCE_SNIPPET,
                    format!("{at}: the snippet doesn't match the file's lines; copy them exactly"),
                );
            }
        }
    }
    for (ni, n) in a.nodes.iter().enumerate() {
        for (pi, path) in n.paths.iter().enumerate() {
            let exists = clean_path(path).is_some_and(|p| {
                reader.kind(CodeSide::Head, p).is_some() || reader.kind(CodeSide::Base, p).is_some()
            });
            if !exists {
                r.error(
                    format!("/nodes/{ni}/paths/{pi}"),
                    rule::PATH_MISSING,
                    format!("`{path}` exists at neither base nor head"),
                );
            }
        }
        if let Some(d) = &n.drawn {
            let mut total = 0;
            for path in &n.paths {
                let Some(p) = clean_path(path) else { continue };
                if reader.kind(CodeSide::Head, p) == Some(EntryKind::Dir) {
                    total += count_folders(reader, CodeSide::Head, p).unwrap_or(0);
                }
            }
            if total != d.folders {
                r.error(
                    format!("/nodes/{ni}/drawn/folders"),
                    rule::DRAWN_FOLDERS,
                    format!(
                        "`{}` has {total} folders under its paths at head, not {}",
                        n.id, d.folders
                    ),
                );
            }
        }
    }
}
