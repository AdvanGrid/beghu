fn main() {
    // An account's analyses can't be had from GitHub again (only by running the agent again), so
    // `analyses.db` migrates in place only: no `.rebuild.sql` migrations.
    sqlcheck::run(sqlcheck::Options {
        allow_rebuild: false,
        base: None,
    });
}
