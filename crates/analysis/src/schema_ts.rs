//! `schema.ts`: every type the agent reads or writes, generated from the Rust types with their doc
//! comments, in one file. `tests/schema.rs` writes it to `generated/schema.ts` with the header the
//! schema guard reads, and copies it to the web app.

use std::any::TypeId;
use std::collections::HashSet;

use ts_rs::{Config, TS, TypeVisitor};

use crate::report::Report;

/// A fragment isn't a Rust type: the merge reads fragments as JSON. Its TypeScript is written
/// here.
const FRAGMENT: &str = r#"/**
 * A fragment: what one agent of a split run writes (the skeleton, an area, or the seam pass's
 * input). Any subset of an analysis's fields, each list holding whole elements, plus the hints it
 * leaves for the seam pass. An area's purposes carry only `id` and the members it found
 * (`serves`, `carries`, walks); an area can't create a purpose or a rule, it hints one. Claim IDs
 * are local to the fragment: the merge renumbers them.
 */
export type Fragment = Partial<Omit<Analysis, "purposes">> & {
  purposes?: (Pick<Purpose, "id"> & Partial<Purpose>)[];
  hints?: Array<Hint>;
};
"#;

/// The name of every declared type reachable from the root.
fn collect<T: TS + 'static + ?Sized>(
    cfg: &Config,
    seen: &mut HashSet<TypeId>,
    out: &mut Vec<String>,
) {
    struct Visit<'a> {
        cfg: &'a Config,
        seen: &'a mut HashSet<TypeId>,
        out: &'a mut Vec<String>,
    }
    impl TypeVisitor for Visit<'_> {
        fn visit<U: TS + 'static + ?Sized>(&mut self) {
            if U::output_path().is_some() {
                collect::<U>(self.cfg, self.seen, self.out);
            }
        }
    }
    if !seen.insert(TypeId::of::<T>()) {
        return;
    }
    out.push(T::ident(cfg));
    T::visit_dependencies(&mut Visit { cfg, seen, out });
}

/// The types in reading order: the analysis top-down, then the split procedure's, the previous
/// analysis's skeleton and the report. `body` checks the list against what the roots reach.
macro_rules! in_order {
    ($cfg:expr, $out:expr, $names:expr; $($t:ty),* $(,)?) => {
        $(
            $names.push(<$t as TS>::ident($cfg));
            $out.push(decl::<$t>($cfg));
        )*
    };
}

fn decl<T: TS + ?Sized>(cfg: &Config) -> String {
    let mut d = T::docs().unwrap_or_default();
    d.push_str("export ");
    d.push_str(&pretty(&T::decl(cfg)));
    d
}

/// The declarations, without the header: the part the schema guard hashes.
pub fn body() -> String {
    use crate::report::Finding;
    use crate::schema::*;
    use crate::tools::*;
    let cfg = &Config::new();
    let mut out = Vec::new();
    let mut names = Vec::new();
    in_order!(cfg, out, names;
        Analysis, Pr, PrStats, Coverage, Skipped, Reference, ReferenceHow, Walk,
        Node, NodeKind, Change, Responsibility, FacetAssignment, AssignedValue, Question, FileChange,
        FileStatus, Drawn, Built, BuiltKind,
        Edge, EdgeKind, When, EdgeData, Direction, Mode, NeededBy,
        Boundary, BoundaryKind, Scenario, Step, Chapter,
        Facet, AppliesTo, FacetValue,
        Purpose, PurposeKind, Stop, Serves, Carries, Rule, RuleCheck,
        Conflict, ConflictKind, Side, Who, Sites, Touches, Cause, Unclaimed,
        Carried, CarriedKind, CarriedCause,
        Claim, ClaimStatus, Evidence, CodeSide,
        Split, SplitMode, Area, Candidate, SplitPurpose, Flow, SplitRule,
        Hint, Resolution, ResolutionHow,
    );
    out.push(FRAGMENT.trim_end().to_owned());
    in_order!(cfg, out, names;
        PreviousIds, PreviousNode, PreviousEdge, Vocabulary, VocabularyFacet, VocabularyPurpose,
        Report, Finding,
    );
    // Every type the roots reach is in the list, once.
    let mut seen = HashSet::new();
    let mut reached = Vec::new();
    collect::<Analysis>(cfg, &mut seen, &mut reached);
    collect::<Split>(cfg, &mut seen, &mut reached);
    collect::<Hint>(cfg, &mut seen, &mut reached);
    collect::<PreviousIds>(cfg, &mut seen, &mut reached);
    collect::<Vocabulary>(cfg, &mut seen, &mut reached);
    collect::<Report>(cfg, &mut seen, &mut reached);
    let mut listed = names.clone();
    listed.sort();
    listed.dedup();
    assert_eq!(
        listed.len(),
        names.len(),
        "schema_ts::body lists a type twice"
    );
    let mut reached: Vec<String> = reached;
    reached.sort();
    assert_eq!(
        listed, reached,
        "schema_ts::body's list and the types the roots reach differ"
    );
    let mut s = out.join("\n\n");
    s.push('\n');
    s
}

/// Lays a ts-rs declaration out one field per line, its doc comments indented with it.
fn pretty(decl: &str) -> String {
    let mut out = String::with_capacity(decl.len() + decl.len() / 4);
    let mut depth = 0usize;
    let mut angle = 0usize;
    let mut at_line_start = false;
    let indent = |out: &mut String, depth: usize| out.push_str(&"  ".repeat(depth));
    let mut rest = decl;
    while let Some(c) = rest.chars().next() {
        if at_line_start && c.is_whitespace() {
            rest = &rest[c.len_utf8()..];
            continue;
        }
        if let Some(after) = rest.strip_prefix("/*") {
            let end = after.find("*/").map_or(after.len(), |i| i + 2);
            if !at_line_start {
                out.truncate(out.trim_end().len());
                out.push('\n');
            }
            let comment = format!("/*{}", &after[..end]);
            for line in comment.lines() {
                let line = line.trim();
                indent(&mut out, depth);
                if line.starts_with('*') {
                    out.push(' ');
                }
                out.push_str(line);
                out.push('\n');
            }
            at_line_start = true;
            rest = &after[end..];
            continue;
        }
        if at_line_start {
            indent(&mut out, depth);
            at_line_start = false;
        }
        match c {
            '"' => {
                let end = rest[1..].find('"').map_or(rest.len(), |i| i + 2);
                out.push_str(&rest[..end]);
                rest = &rest[end..];
                continue;
            }
            '{' => {
                depth += 1;
                out.push_str("{\n");
                at_line_start = true;
            }
            '}' => {
                out.truncate(out.trim_end().len());
                if !out.ends_with('{') && !out.ends_with(',') {
                    out.push(',');
                }
                depth = depth.saturating_sub(1);
                out.push('\n');
                indent(&mut out, depth);
                out.push('}');
            }
            '<' => {
                angle += 1;
                out.push(c);
            }
            '>' => {
                angle = angle.saturating_sub(1);
                out.push(c);
            }
            ',' if depth > 0 && angle == 0 => {
                out.push_str(",\n");
                at_line_start = true;
            }
            _ => out.push(c),
        }
        rest = &rest[c.len_utf8()..];
    }
    out
}

/// The text the schema guard hashes: the body without comments or blank space, declarations
/// sorted, so editing a doc comment (a prompt change) or moving a type leaves it alone.
pub fn shape(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("/*") {
            rest = after.find("*/").map_or("", |i| &after[i + 2..]);
        } else if let Some(after) = rest.strip_prefix("//") {
            rest = after.find('\n').map_or("", |i| &after[i..]);
        } else if let Some(after) = rest.strip_prefix('"') {
            // A string literal, kept whole: a `//` inside one is no comment.
            let end = after.find('"').map_or(after.len(), |i| i + 1);
            out.push('"');
            out.push_str(&after[..end]);
            rest = &after[end..];
        } else {
            let c = rest.chars().next().unwrap_or(' ');
            if !c.is_whitespace() {
                out.push(c);
            }
            rest = &rest[c.len_utf8()..];
        }
    }
    let mut decls: Vec<&str> = out.split("export").filter(|d| !d.is_empty()).collect();
    decls.sort_unstable();
    decls.join("export")
}
