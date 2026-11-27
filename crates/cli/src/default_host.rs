//! The hosted deployment, the CLI's default host: one file, so the CLI and the server can't
//! disagree. The server reads it too (`#[path]` in `crates/server/src/cli/mod.rs`): `install.sh`
//! and `/cli` from any other host name it in the `beghu login --host` they suggest. The web app
//! has its own copies, which name this file: `web/src/cli.ts` and `web/site/build.ts`.

pub const DEFAULT_HOST: &str = "https://beghu.dev";
