//! The tiler (#178): the recorded analysis grown to #2627's shape and to 3×, each one an upload
//! the server takes, the same bytes every time and cached by the generator's hash.

use analysis::{Context, NodeKind, PinnedPr, Previous, validate};
use fixture::tile::{TOP_LEVEL_PARTS, cached};

fn top_level_parts(a: &analysis::Analysis) -> usize {
    let system = a
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::System)
        .unwrap()
        .id
        .clone();
    a.nodes
        .iter()
        .filter(|n| {
            n.parent.as_deref() == Some(system.as_str())
                && matches!(
                    n.kind,
                    NodeKind::Service | NodeKind::App | NodeKind::Library | NodeKind::Module
                )
        })
        .count()
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
        shapes.push((top_level_parts(&a), a.edges.len(), a.claims.len()));
    }
    // 1×: #2627's 76 top-level parts; its claims near #2627's ~1,250.
    let (parts, _, claims) = shapes[0];
    assert_eq!(parts, TOP_LEVEL_PARTS);
    assert!((1_000..=1_500).contains(&claims), "{claims} claims");
    // 3×: three times the 1× (and a wire between copies).
    assert_eq!(shapes[1].0, 3 * shapes[0].0);
    assert!(shapes[1].1 >= 3 * shapes[0].1);
    assert_eq!(shapes[1].2, 3 * shapes[0].2);

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
