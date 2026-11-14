# AGENTS.md

beghu v1 is being built to the spec in issue #86. Read `CONTEXT.md` for the glossary and use its
terms.

## Running the app

Run `./dev-ctl help` to learn how to start, stop and inspect the dev stack. `./dev-ctl start` runs
Fake GitHub, the server and Vite in the background in fixture mode (50k issues by default), with
no GitHub account. Read the logs with `./dev-ctl logs` and `./dev-ctl grep`; avoid `logs -f`,
which never exits. `./dev-ctl` is TypeScript run directly by Node (23.6 or newer).

## Checks

CI runs all of these; run them before you commit:

- `cargo fmt --all --check` (fix with `cargo fmt --all`)
- `cargo build --workspace --all-targets --locked`, which also runs the build-time SQL check
- `cargo clippy --workspace --all-targets --locked -- -D warnings -D clippy::disallowed_methods`
- `cargo test --workspace --locked`
- `npm --prefix tools/dev-ctl ci --ignore-scripts && npm --prefix tools/dev-ctl run typecheck` after
  changing `./dev-ctl`
- `npm --prefix perf/harness ci --ignore-scripts && npm --prefix perf/harness run typecheck && npm --prefix perf/harness test`
  after changing the perf harness
- `./dev-ctl perf` after changing the server or the web app (about a minute once main is built,
  longer on a busy host:
  this tree against local `main`, failing at more than 10% slower), and `./dev-ctl perf --full`
  (CI's three suites at their absolute limits) before a PR. CI's `perf` check runs the suites on
  every PR that touches them and comments the table
- In `web/`: `npm ci --ignore-scripts`, then `npm run typecheck`, `npm run lint` (StyleX's rules and the colour,
  `class`/`style` and CSS-import rules in `eslint-rules.js`), `npm run test:lint` (those rules'
  and the highlight.js output reader's Node tests) and
  `npx vite build` (which also prerenders the public site, `web/site/`, in its own Node process)
- `cargo test` regenerates `web/src/bindings/` (the server's wire types, through ts-rs): commit it
  with the Rust change
- npm installs run no install scripts: always `npm ci --ignore-scripts` (CI, the `Dockerfile`
  and `./dev-ctl` do). After changing a lockfile, `npm audit signatures` in that directory checks
  the packages' registry signatures, as CI does. A new package that needs its install script is
  a decision for the owner, not a dropped flag
- After adding or updating a Rust dependency (`cargo install --locked cargo-deny cargo-vet` once):
  `cargo deny --locked check` (`deny.toml`: RustSec advisories, the licence allowlist, crates.io
  only) and `cargo vet --locked`. A crate or version cargo-vet hasn't seen needs an audit
  (`cargo vet certify`) or an exemption (`cargo vet add-exemption`) in `supply-chain/`; try
  `cargo vet suggest` first, and never `cargo vet regenerate` to make the check pass
- After changing a workflow: `uvx zizmor --min-severity medium .github/workflows` (CI's `zizmor`
  job) and `actionlint`. Pin every `uses:` to a full commit SHA with its version in a comment
  (`uses: owner/action@<40-hex sha> # v1.2.3`), and give each checkout
  `persist-credentials: false`. `publish.yml`'s file name and its push-to-`main` trigger are what
  deployers verify the image against (`docs/deploy.md`, "The published image"): don't rename it
  or add a trigger
- The browser suite, against a running stack: `./dev-ctl start --scale 1k`, then
  `npm --prefix web run e2e` (set `DEV_APP_PORT` as for `./dev-ctl` if you changed it)

## Rules

- **SQL lives only in the database crates**: `crates/sqlcheck`, `crates/dbrt`, `crates/mirror-db`,
  `crates/control-db` and `crates/fake-db` (Fake GitHub's truth). Add a named query to a schema
  crate's `queries/` (or a migration to its `migrations/`) and call the function the build
  generates for it. Clippy fails on rusqlite `prepare`/`execute`/`query_*`/`pragma*` anywhere
  else.
- **Colours come only from the token modules** (`web/src/tokens.stylex.ts`, and
  `web/src/md/tokens.stylex.ts` for posts' Markdown and code highlighting, kept apart so its JS
  stays out of first-load JS; its CSS still goes in the app's one stylesheet, so nothing splits
  the app's CSS; the public site has its own, below).
  Every page supports
  light and dark mode: each token is a `light-dark()` pair, and `web/theme.js` sets
  `color-scheme` on `<html>`. Style elements with `{...stylex.attrs(…)}`, or with `class={…}`
  bound to a class string StyleX made once: a module-level constant from a `web/src/cx.ts`
  function (`cx`, `cxTable`, `cxMap`), an entry of one, or a choice of two such, never a
  hand-written class. The lint allows that constant on any element; use it where elements are
  built by the thousand (the list's and Tree mode's rows, and the parts they share such as
  avatars, review chips and label dots), where a spread costs, and the spread elsewhere. `style`
  may only set CSS custom properties (`style={{ "--row-y": … }}`), read by a static style. No
  `className`, `classList` or other `style`. The only CSS file is `web/src/escape.css`, one
  comment per rule. The lint enforces all of these. A width a row's styles draw with and its
  code measures by (a slot, an avatar) is one constant in `web/src/layout.stylex.ts`, read by
  both. The public site follows these rules too. The server's and Fake GitHub's other plain HTML pages use system colours (`Canvas`,
  `CanvasText`, `GrayText`, `LinkText`) under `color-scheme: light dark`, never literals. GitHub
  label colours are data, not design: they come from GitHub per label and are exempt from the
  token rule (passed into a dynamic style, as the detail's label dots do, or a custom property,
  as the list's do).
- **The public site is prerendered Solid.** The landing page (`/`), `/pricing`, `/privacy` and
  the other marketing pages live in `web/site/`: Solid components with StyleX and the same
  tokens, rendered to static HTML at build time (`renderToString`, compiled with
  `generate: "ssr"` and `hydratable: false`), never hydrated. They ship no JS but the inline
  `web/theme.js`, so they stay out of the app's first-load JS and its perf gates, and search
  engines get the whole page in the first response. They have their own small stylesheet,
  so a visit to the site doesn't load the app's CSS. Each page sets its own `<title>`, meta
  description and canonical URL, and the same build writes `robots.txt` and `sitemap.xml`
  from the page list. The server serves the prerendered files at their paths, with
  `public` caching; the app's shell is never served for them. The app's list is at `/issues`, not
  `/`, and `/` is the landing page for everyone, signed in or not, with no redirect.
- **Check UI changes in fixture mode.** Start the stack, sign in as a fixture user
  (`./dev-ctl login <user>`), and drive the failure states with `./dev-ctl fake …` (latency,
  failing calls, down). Look at the change in both themes. `./dev-ctl reset` puts the mirrors and
  the fake back to pristine afterwards.
- **Review rules** (borrowed from solid-yield): a named error class per failure kind, thrown from
  the API layer; an `Errored` boundary above every async read, root included; writes absorb their
  own failure and roll back.
- **Tests go through public seams** (spec, "Testing Decisions"): the server's HTTP surface with
  Fake GitHub behind it (`crates/server/tests/`, whose `common` harness starts both on a fresh
  data dir with the 1k fixture), Fake GitHub's own HTTP and control surfaces, and the browser
  (`web/e2e/`, Playwright against the `./dev-ctl` stack). Set state up through Fake GitHub or the
  fixture, never by writing to a mirror directly.
- **The allowed exceptions**, each saying why in its file: md-ast's GFM spec conformance run
  (`crates/md-ast/src/gfm_spec.rs`, 670 examples scored on comrak's HTML), md-ast's work counts
  (`crates/md-ast/src/scaling.rs`), the server's render cache tests (the `tests`
  module of `crates/server/src/markdown.rs`), which count renders no HTTP answer shows, the
  web's highlight.js output reader under hostile input (`web/src/md/hljs.test.ts`), which only
  ever sees highlight.js's own escaped output through the app, and the keys module's unit test
  (`web/src/keys.test.ts`), which covers what the browser suite can't drive: a Mac's Cmd and Alt,
  AltGr, non-Latin layouts and input-method composition (the suite runs one platform and layout),
  what the setup page records for a Mac's Cmd and Option keys (dead keys included) and a non-Latin
  layout's letters, and the areas of touchpoints no view offers yet. Rebinding itself (swaps,
  refusals, sequences, other tabs) goes through the setup page (`web/e2e/prefs.spec.ts`). Both
  web tests run under `npm run test:lint`.
- **Perf budgets are owner-reviewed.** `perf-budgets.toml` holds every gate's limit with a reason
  (CODEOWNERS). A new gate gets its budget in the same change, calibrated from a measured run
  (+15% for timings, +5% for bytes, exact for counts); a limit never moves just to pass a PR.
  `BEGHU_SCAN_STEPS=1` makes each API answer report its own full-scan steps
  (`x-beghu-scan-steps`) and log the statements, for the "no full scans" gates.
- **Fake GitHub models GitHub, it doesn't invent.** Response shapes follow GitHub's; when the fake
  learns an endpoint, match GitHub's documented or recorded shape and status codes.
  Exception: `crates/fake-github/src/web_hosts.rs` (`/ext/…`) stands in for the arbitrary web
  hosts a post's images name, not GitHub.

## What only real GitHub can show

Fake GitHub can't tell you these. Check them against your own dev App (see `github-app/`) before
relying on them: GraphQL validity and point cost, real webhook timing, the install and permission
screens, SAML, hidden issues, real rate limits, payload drift, and the relationship limits beghu
assumes (how deep sub-issues nest, and whether a dependency loop through other issues is refused:
`docs/research/github-relationship-apis.md`, "Open questions").
