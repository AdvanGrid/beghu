fn main() {
    // The truth starts as a copy of a fixture mirror, so the mirror schema comes first and the
    // fake's own tables are migrated on top. It's rebuilt from the fixture, never migrated
    // across a rebuild, so `.rebuild.sql` is moot here.
    sqlcheck::run(sqlcheck::Options {
        allow_rebuild: false,
        base: Some("../mirror-db".into()),
    });
}
