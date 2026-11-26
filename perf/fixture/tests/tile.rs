//! The tiler (#178): the recorded analysis grown to #2627's shape and to 3×, each one an upload
//! the server takes, the same bytes every time and cached by the generator's hash.

use analysis::{Analysis, Context, NodeKind, PinnedPr, Previous, validate};
use fixture::tile::cached;
use std::collections::HashMap;

/// An analysis's shape as #2627's is told (#162): its top-level parts, its lines at the top level
/// (edges between two different top-level nodes; an edge inside a part isn't drawn there), and
/// its claims.
#[derive(Debug, Clone, Copy)]
struct Shape {
    parts: usize,
    lines: usize,
    claims: usize,
}

fn shape(a: &Analysis) -> Shape {
    let system = a
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::System)
        .unwrap()
        .id
        .as_str();
    let parts = a
        .nodes
        .iter()
        .filter(|n| {
            n.parent.as_deref() == Some(system)
                && matches!(
                    n.kind,
                    NodeKind::Service | NodeKind::App | NodeKind::Library | NodeKind::Module
                )
        })
        .count();
    let parent: HashMap<&str, &str> = a
        .nodes
        .iter()
        .filter_map(|n| Some((n.id.as_str(), n.parent.as_deref()?)))
        .collect();
    let lines = a
        .edges
        .iter()
        .filter(|e| top(&parent, system, &e.from) != top(&parent, system, &e.to))
        .count();
    Shape {
        parts,
        lines,
        claims: a.claims.len(),
    }
}

fn top<'a>(parent: &HashMap<&'a str, &'a str>, system: &str, mut x: &'a str) -> &'a str {
    while let Some(&p) = parent.get(x).filter(|p| **p != system) {
        x = p;
    }
    x
}

/// Within 5% of `want`.
#[track_caller]
fn near(what: &str, got: usize, want: usize) {
    let off = got.abs_diff(want) as f64 / want as f64;
    assert!(off <= 0.05, "{got} {what}, not within 5% of {want}");
}

#[test]
fn the_tiles_have_their_shape_pass_the_servers_checks_and_are_cached() {
    let dir = tempfile::tempdir().unwrap();
    let tiles = cached(dir.path()).unwrap();
    assert_eq!(tiles.len(), 2);
    let mut shapes = Vec::new();
    for (name, number, analysis, pr) in &tiles {
        let text = std::fs::read_to_string(analysis).unwrap();
        let pr: PinnedPr = serde_json::from_str(&std::fs::read_to_string(pr).unwrap()).unwrap();
        let ctx = Context {
            changed_files: Some(pr.files.iter().map(|f| f.path.clone()).collect()),
            previous: Previous::None,
        };
        let out = validate(&text, &ctx, None);
        assert!(
            out.report.errors.is_empty(),
            "{name}: {:#?}",
            out.report.errors
        );
        let a = out.analysis.unwrap();
        assert_eq!(i64::from(a.pr.number), *number);
        assert_eq!(
            a.pr.head_sha, pr.head_sha,
            "{name}: its pr.json pins its head"
        );
        assert_eq!(pr.number as i64, *number);
        shapes.push(shape(&a));
    }
    // 1×: #2627's shape: 76 top-level parts, 167 lines at the top level, ~1,250 claims.
    let one = shapes[0];
    assert_eq!(one.parts, 76, "{one:?}");
    near("lines at the top level", one.lines, 167);
    near("claims", one.claims, 1_250);
    // 3×: three copies of the 1×, the two later ones each wired to the first by one line.
    let three = shapes[1];
    assert_eq!(three.parts, 3 * one.parts, "{three:?}");
    assert_eq!(three.lines, 3 * one.lines + 2, "{three:?}");
    assert_eq!(three.claims, 3 * one.claims, "{three:?}");

    // Cached: a second call writes nothing; a fresh directory gets the same bytes.
    let written = std::fs::metadata(&tiles[0].2).unwrap().modified().unwrap();
    let again = cached(dir.path()).unwrap();
    assert_eq!(
        std::fs::metadata(&again[0].2).unwrap().modified().unwrap(),
        written
    );
    let other = tempfile::tempdir().unwrap();
    for (a, b) in tiles.iter().zip(cached(other.path()).unwrap()) {
        assert!(std::fs::read(&a.2).unwrap() == std::fs::read(&b.2).unwrap());
        assert!(std::fs::read(&a.3).unwrap() == std::fs::read(&b.3).unwrap());
    }
}
