# The cached SPA shell across a deploy and around sign-in

Research date: 2026-10-25, for
[Check the SPA shell across a deploy and around sign-in](https://github.com/tomsjansons/beghu/issues/74).
[First load](first-load.md) settled on an account-free shell cached with `max-age=300` and
immutable hashed assets, without trying either case below.

Probe: [`bench/candidates/deploy-probe`](../../bench/candidates/deploy-probe/README.md), the
`axum-solid2-router` build (Solid `2.0.0-rc.15`, `@solidjs/router` `2.0.0-next.41`, Vite 8) with a
lazy issue route, a second-level lazy chunk, three builds A/B/C with different hashes, an in-process
deploy switch, and a fake cookie sign-in. `drive.mjs` drives Chromium 1248 (Playwright 1.64) on a
persistent profile, so there's a real disk cache. The server's request log shows what reached it;
anything missing from it came from the HTTP cache or bfcache. Raw output:
[`results.jsonl`](../../bench/candidates/deploy-probe/results.jsonl). Each claim is tagged
**[measured]**, **[source]** (read in package code) or **[doc]**.

**Playwright hides bfcache.** It launches Chromium with `--disable-back-forward-cache` and
`--disable-field-trial-config`, and the default headless shell blocks bfcache anyway with
`BackForwardCacheDisabledForDelegate`. Full Chromium in new headless mode, without those two flags
and with `--enable-features=BackForwardCache,ProactivelySwapBrowsingInstance`, restores pages as
desktop Chrome does **[measured]**. The bench harness keeps it off, which is right for timing runs, but
anything about Back has to be tested with it on.

## Where old builds keep running

| After a deploy from A to B | What the browser runs | Server sees |
|---|---|---|
| Open tab | A, for as long as the tab lives | only API calls and chunks A hadn't loaded |
| Navigation, typed URL or new tab to a URL whose shell is cached | A, shell and entry chunk from the HTTP cache | API calls only |
| Same, URL never loaded before (e.g. `/?state=closed`) | B | `GET /?state=closed`, B's entry |
| Reload (F5) | B: Chrome revalidates the document (`If-None-Match: "A"` → 200) | the shell, B's entry |
| Hard reload | B | everything |
| Back/forward to a page past its `max-age` (shell `max-age=2`, waited 2.5 s) | A, restored from bfcache, or with bfcache off, a stale shell from the HTTP cache with no request | nothing for the document |
| Two deploys inside one `max-age` (A → B → C, only B kept) | A | 404 for A's chunk |

All **[measured]**. So `max-age` bounds only fresh navigations. Open tabs, bfcache restores and history navigations
without bfcache all run A after its `max-age` has passed. Chrome keeps a page in bfcache for up to
10 minutes **[doc]**, and a history navigation without bfcache takes a stale shell **[measured]**.

## What breaks

- **Only lazy chunks the old build hadn't fetched yet.** With A's assets gone, opening an issue in an
  A tab gets a 404 for `Issue-<hash>.js`. The route's `Errored` boundary shows "Failed to fetch
  dynamically imported module", and the URL has already moved to `/issues/<id>` **[measured]**.
  Chunks already in memory or in the HTTP cache keep working: router navigation, filtering and
  further details after the chunk loaded all ran fine on A after its assets were deleted
  **[measured]**. With A's assets kept, nothing broke in any scenario **[measured]**.
- **Hashes cascade.** Rolldown names chunks by content including their imports. A leaf chunk that
  didn't change (`Highlight`, `decode`, `server`, the CSS) keeps its name across builds, but every
  chunk that imports the entry (`Issue`, `serverForms`) gets a new name in every build, because the
  entry's name changes **[measured]**. Retention can't count on unchanged code keeping its file.
- **A missing asset must 404.** The router candidate serves `index.html` for any unknown path
  (`ServeDir` with a `ServeFile` fallback), so a missing chunk would come back as HTML with a 200.
  The probe 404s every unknown `/assets/*` **[source]**.
- **Vite's reload recipe misfires.** Every dynamic import goes through Vite's preload wrapper, which
  dispatches a cancelable `vite:preloadError` **[source]**. Its documented use is to reload on the event, and
  that fired on hover. `intentPreload()` loads the route's chunk under the pointer, before any click,
  so the page reloaded `/`, where the pointer was, and the issue being opened was lost **[measured]**. A recovery has to act when the navigation actually happens, for example by
  turning the failed in-app navigation into a full document navigation to its target URL, which
  revalidates the shell and lands on B.
- The API serves old clients too. An A tab calls B's API until it reloads; nothing here measured
  shape changes, but they have to stay compatible across at least the retention window.

## How long to keep old assets

Counting builds doesn't work. Two deploys within one `max-age` already need the build before last
**[measured]**. Keep by time, measured from when a build stopped being current:

- at least the shell's `max-age` (300 s) for cached-shell navigations,
- plus Chrome's bfcache lifetime (10 minutes) for restored pages,
- and open tabs, which have no bound. A missing-chunk recovery covers these; retention only makes the
  recovery rare.

A day of retention covers the first two with a wide margin and nearly every working tab. The probe's
assets are 146 KB a build uncompressed. A container image holds only its own build, so the previous builds' files have
to live somewhere that survives the deploy, such as the mounted volume or the next image built from the last
one. That choice belongs to
[Deploy recipe: image, volume and serving requirements](https://github.com/tomsjansons/beghu/issues/75).

## Sign-in, sign-out and account switching

- **Auth links must be `rel="external"`.** Solid Router 2 claims every same-origin `<a href>` without
  `rel="external"`, a `target` or `download` (`managedLinkUrl`, `claims.js:157`) **[source]**. A plain
  `<a href="/auth/login">` changed the URL client-side with no request, and the page stayed signed in
  as the old account **[measured]**. With `rel="external"` the full redirect chain ran.
  A plain `<form method="post" action="/auth/logout">` was not claimed and reached the server
  **[measured]**.
- **After the callback, the cached shell is reused.** `/auth/callback` → 302 `/` was served from the
  cached shell with no document request, and the preloads and API calls carried the new account's
  cookie (`<link rel=preload as=fetch crossorigin>` sends cookies same-origin) **[measured]**. The
  shell being account-free is what makes this safe. Sign-out's POST → 303 `/` made Chrome revalidate
  the document (304) rather than use it blindly **[measured]**.
- **A signed-out load finds out from the API.** The cached shell can't redirect, so the app has to.
  On a first visit to `/issues/12?state=closed` signed out, the shell, entry and issue chunk loaded,
  five API calls got 401, and the client went to `/auth/login?next=…`. Signing in returned to the
  same URL **[measured]**. Two details: each 401 handler navigated, so the sign-in page loaded three
  times, and `location.assign` left the dead shell in history, so Back lands on a blank page
  restored from bfcache **[measured]**. Navigate once, with `location.replace`.
- **Back after sign-out shows the old account.** Two Backs from the sign-in page restored the
  signed-in issue page from bfcache, rows and detail of account a on screen, with no request
  **[measured]**. After switching from a to b, Back to a view only a had opened restored it from
  bfcache showing account a under b's cookie **[measured]**. Chrome refused to bfcache the `no-store`
  sign-in page after the HttpOnly cookie changed (`CacheControlNoStoreHTTPOnlyCookieModified`)
  **[measured]**, but the shell has `max-age`, so it gets no such protection.
- **API responses must be `Cache-Control: no-store`.** With no header, a history navigation without
  bfcache took `/api/facets`, `/api/issues` and `/api/me` from the HTTP cache with no request
  **[measured]**: whatever account fetched them last. With `no-store` they were refetched, and each
  was still fetched once on load, so the preloads were still used **[measured]**. `no-store` on
  subresources doesn't affect bfcache; only the document's header does **[doc]**.
- **The live stream survives bfcache.** After a restore the `EventSource` was still open
  (`readyState` 1), and a push sent while the page was in bfcache arrived after the restore and
  triggered the refetch **[measured]**.
- **Two headers didn't help.** `Vary: Cookie` on the shell makes Chrome revalidate the document after a
  sign-in or sign-out (304), but Back still restores from bfcache. `Clear-Site-Data: "cache"` on
  sign-out drops the cached shell, but didn't evict the bfcache entry, which still showed account a
  **[measured]**.

## Passed on

- How a restored page or a failed chunk recovers on the client goes to a new ticket. Candidates are
  a check on `pageshow` with `persisted`, an account hint the page can read synchronously, a
  `no-store` shell, and a full navigation on a missing chunk.
- Where old assets live, and for how long, goes to the deploy recipe.
- Not covered are Firefox and Safari, whose bfcache and reload rules differ, and a service worker,
  which v1 doesn't have. A server restart during a deploy drops the stream, which reconnects with
  `reset` per [Close the live-update gap between first fetch and stream open](https://github.com/tomsjansons/beghu/issues/71).
