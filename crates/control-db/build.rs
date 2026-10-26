fn main() {
    // The control DB isn't disposable: no `.rebuild.sql` migrations.
    sqlcheck::run(sqlcheck::Options {
        allow_rebuild: false,
        base: None,
    });
}
