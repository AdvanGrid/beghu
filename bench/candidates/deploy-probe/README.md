# deploy and sign-in probe (throwaway)

A copy of [axum-solid2-router](../axum-solid2-router/README.md) for
[Check the SPA shell across a deploy and around sign-in](https://github.com/tomsjansons/beghu/issues/74)
(`docs/research/spa-shell-deploy-and-sign-in.md`). Not a bench candidate: it has no Dockerfile and
`./bench/run` doesn't know it.

Changes from the router build:

- The issue route is a `lazy()` chunk, and the detail lazily imports a second chunk (`Highlight.ts`,
  standing in for a highlight.js language).
- `src/probe.ts` stamps the build id (`BUILD` at build time) on `<html data-build>` and records
  errors, `vite:preloadError`s and `pageshow` events in `window.__probe`.
- A 401 from the API sends the page to `/auth/login?next=…`. The header shows the signed-in account
  and has a claimed and a `rel="external"` sign-in link, and a sign-out form.
- The server serves the shell from `builds/<current>/index.html` with `max-age` (`SHELL_MAX_AGE`,
  default 300) and the build id as ETag, serves `/assets/*` immutable from the current build and the
  kept ones (404 when missing, never the shell), and switches builds on `POST /__deploy?build=B&keep=A`.
  `/auth/login`, `/auth/callback` and `/auth/logout` fake GitHub sign-in with an `sid` cookie, and
  `/api/*` and `/events` answer 401 without it. `GET /__log` lists every request it saw.
  Variants: `VARY_COOKIE=1`, `CLEAR_SITE_DATA='"cache"'` on sign-out, `API_CACHE_CONTROL=no-store`.

Run it:

```sh
cd web && for b in A B C; do BUILD=$b OUT=../builds/$b npx vite build; done && cd ..
(cd server && cargo build --release)
# bfcache needs full Chromium in new headless mode with field trials on:
CHANNEL=chromium BF_ARGS=--enable-features=BackForwardCache,ProactivelySwapBrowsingInstance node drive.mjs [scenario-prefix…]
```

`web/node_modules` is a symlink to the router build's. `drive.mjs` copies nothing: it reads
`MIRROR_PATH=$SCRATCH/mirror.db`, so copy `bench/data/mirror-20k.db` there first.
