# First load: SPA shell, inlined first page, or Solid 2 SSR

Research date: 2026-10-21. Stack as settled: axum server, Solid `2.0.0-rc.15`, `@solidjs/router`
`2.0.0-next.41`, server-side filtering in SQLite, no browser cache, SSE pushes `{ids}` and the
client revalidates through the router's `query`. The starting code is
[`bench/candidates/axum-solid2-router`](../../bench/candidates/axum-solid2-router/README.md).

Sources: the installed package sources under
`bench/candidates/axum-solid2-router/web/node_modules/` (written below as `nm/<path>:<lines>`),
the hyper 1.12.0 and h2 0.4.20 crate sources in `~/.cargo/registry/src/index.crates.io-*/`
(written as `hyper-1.12.0/<path>:<lines>`), the WHATWG HTML Standard, MDN, Chrome and web.dev
docs, and RFC 6928. Each claim is tagged **[source]** (read in code or a spec), **[doc]**, 
**[measured]** or **[inferred]**.

Measurements are throwaway. A scratch candidate,
[`bench/candidates/first-load-probe`](../../bench/candidates/first-load-probe/README.md) (untracked),
is the router build with only the server's `/` handler changed. A toy Solid 2 SSR app was built in
the session scratchpad, not in the repo. Runs were on the bench host (Xeon E5-2695 v4), which was
busy (load average about 25 on 32 threads), so p95s are noisy.

## Answers

1. **Use the SPA shell. Don't add SSR.** Server-rendered HTML with hydration puts rows on screen
   before the JS runs. The page still isn't usable until the JS has downloaded, run and hydrated,
   and hydration costs more than a client render. Every SSR framework already benchmarked had a
   higher warm-load floor than the axum + Solid SPA (SolidStart 1168 ms, SvelteKit 1190 ms,
   Leptos 1276 ms, against 952 ms at the headline profile). Solid 2 SSR would also need a JS
   engine inside the server. That works for a toy, but it's a real integration job for the app
   (Answer 2).
2. **Solid 2 SSR without Node is possible but not cheap.** `renderToString` from
   `@solidjs/web` ran under **rquickjs 0.14** with only `crypto.getRandomValues` stubbed. It took
   1.2 ms for 20 rows and 5.1 ms for 100 rows, plus 24 ms to load the bundle once **[measured]**.
   The real app is harder: `renderToString` is synchronous, so async `query` reads would render
   their `Loading` fallback. The router's server side also expects `Request`/`Headers`/`URL`.
   Hydration only claims HTML that Solid's SSR produced, because it matches `_hk` keys and
   `<!--$-->` markers. HTML rendered in Rust without them gave a page that looked right but did
   nothing on click, and logged no error **[measured]**.
3. **The data round trip is already off the cold critical path.** The shell's
   `<link rel=preload as=fetch crossorigin>` starts the list and facets requests alongside the JS
   (this is already in the candidates). The preloads are consumed, with one request each
   **[measured]**. On a cold load the JS is the long pole either way, so inlining the rows changes
   nothing measurable (1×: 357–369 vs 359–376 ms p50). Removing the preload costs about 65–80 ms
   at 1× **[measured]**.
4. **A warm load can drop a round trip in two ways.** Measured at 1× CPU with the far network,
   p50:
   - **No-cache shell + preload: 270–272 ms.** The shell is revalidated, then the data is
     fetched: two round trips.
   - **Rows inlined into a private, per-account HTML: 234–239 ms.** One round trip, then the JS
     runs from cache.
   - **Account-free shell served with `max-age` + preload: 148–166 ms.** No document request.
     The data round trip runs in parallel with JS execution.

   At 6× CPU the same order holds, but the gaps (10–40 ms) are inside the host noise.
5. **The inlined page can be seeded into Solid Router 2's `query` cache without hydration.**
   `query` calls `takeHydrationValue(key)` before fetching, and that function reads
   `globalThis._$HY.r[key]`, even in an app started with `render()`. A server-written
   `<script>_$HY={r:{"issues[…]":[…]}}</script>` is adopted and no fetch goes out **[source,
   measured]**. The catch: the key is the router's internal
   `name + JSON.stringify(args, sorted keys)`, so Rust has to reproduce it. If the key ever stops
   matching, the page just fetches as before.
6. **103 Early Hints are not available and wouldn't help.** hyper 1.12 refuses to send 1xx
   responses on HTTP/1 **[source]**. Chrome only acts on them over HTTP/2+, for navigations, and
   only for cacheable resources, so our uncacheable API responses would be fetched twice **[doc]**.
   The axum handler answers in a few ms, so there's no server think time for a hint to fill.
7. **Bytes.** The document is 0.5 KB gzipped as a shell, or 4.0 KB with 100 rows and facets
   inlined. Either fits the 14 KB first flight. The cold critical path is 43.8 KB on the wire:
   JS 38.9, list page 3.4, CSS 0.8, shell 0.5, facets 0.2 **[measured]**.

## 1. Solid 2 SSR APIs and running them without Node

**APIs.** `@solidjs/web`'s server entry exports `renderToString(fn, { nonce, renderId,
noScripts, plugins, manifest, onError, onHead })`, which returns a `string`, and
`renderToStream(...)`, which has `pipe`/`pipeTo`/`readable` and a `then` that resolves "once every
boundary settles" (`nm/@solidjs/web/types/server.d.ts:235-344`) **[source]**. The manifest
option notes that "async resolvers require streaming rendering"
(`server.d.ts:80-90`). On the client, `hydrate(fn, node, { renderId, owner, onError })` "resumes a
server-rendered tree... Use this when the page HTML was produced by `renderToString` or
`renderToStream`" (`nm/@solidjs/web/types/client.d.ts:310-329`) **[source]**. The package's
`exports` map the `worker` and `deno` conditions to `dist/server.js`
(`nm/@solidjs/web/package.json`), so non-Node server runtimes are an intended target
**[source]**.

**Compiler modes.** `@solidjs/compiler` (the native Oxc JSX compiler) takes
`generate: "dom" | "ssr" | "universal" | "dynamic"` and `hydratable`
(`nm/@solidjs/compiler/types.d.ts:20-21`). `@solidjs/vite-plugin` `ssr: true` without `start`
"enables the SSR transforms (hydratable client code, SSR server code) — you provide the entries and
the server yourself". Client mode stays `generate: 'dom'`
(`nm/@solidjs/vite-plugin/dist/types/src/index.d.ts:51-73, 102-113`) **[source]**. A hydratable
client is a separate build from today's.

**Hydration markers.** The SSR output carries `_hk=<id>` attributes on elements and
`<!--$-->…<!--/-->` around dynamic text, for example
`<a _hk=100 class="row" …><span class="repo"><!--$-->beghu<!--/-->#…` **[measured]**. The client
finds each node through `sharedConfig.registry.get(getHydrationKey())`, and the keys come from
`sharedConfig.getNextContextId()`: the owner tree's id sequence
(`nm/@solidjs/web/dist/web.js:1488-1501, 1919-1921`) **[source]**. Reproducing those ids from
Rust means mirroring Solid's owner-id allocation, which is an internal detail of every component
and memo. We stripped the markers from SSR output, which stands in for HTML written by Rust, and
hydrated it in Chromium. The rows stayed on screen, no error was logged, and clicks did nothing
**[measured]**. **Hydrating HTML that Solid didn't render doesn't work.**

**Embedded engine.** The toy list (a `<For>` of anchor rows with a click handler) was built with
`vite build --ssr` into one IIFE: 80.8 KB, 26.3 KB gzipped. In a bare `node:vm` context (only
ECMAScript built-ins) it failed on `process` (fixed with a `define`) and then on
`crypto.getRandomValues`, which trace-id generation uses (`nm/@solidjs/web/dist/server.js:115`).
With that one stub it rendered. The same bundle ran in **rquickjs 0.14** from Rust
**[measured]**:

| | rquickjs (QuickJS interpreter), this host |
|---|---|
| Load the bundle into a context | 24 ms (once per context) |
| `renderToString`, 20 rows | 1.2 ms |
| `renderToString`, 100 rows | 5.1 ms |

So the sidecar and the Node runtime aren't needed for a synchronous render. What the real app
would add **[inferred]**:

- **Async data.** Rows come from `query`, which `fetch`es. `renderToString` returns
  synchronously and can't wait for it, so the data has to be in place before the render. For
  example, Rust runs the SQL and the server-side query functions return values that are already
  there. `renderToStream` would also need `ReadableStream` and `TextEncoder`, which the server
  runtime constructs (`nm/@solidjs/web/dist/server.js`: `new Response` ×13, `new Headers` ×5,
  `ReadableStream`, `TextEncoder`) **[source]**.
- **The router's server path.** It uses `getRequestEvent()` and `Request`/`Headers`/`URL`
  (`nm/@solidjs/router/dist/data/query.js:12, 171-184`) **[source]**. QuickJS doesn't provide
  those, so they'd need polyfills (for example the modules from AWS LLRT, which is built on
  rquickjs, not tried).
- **A hydratable client build**, which is larger (next section).
- **Two copies of the data**: once as markup, and once serialized for hydration, because the
  client `query` must adopt the same values to claim the DOM.

Prerendering the shell at build time with rows rendered in Rust doesn't work, because of the
markers above. The other option, a Node or Deno sidecar, adds a process and a hop per
navigation.

## 2. Hydration against client render

The same toy rendered two ways in Chromium, 15 fresh contexts each, median, from `file://` (no
network) **[measured]**:

| | CPU | 20 rows | 100 rows |
|---|---|---|---|
| `render()` into an empty root, from inlined JSON | 6× | 130 ms | 152 ms |
| `hydrate()` over SSR markup | 6× | 164 ms | 185 ms |
| `render()` | 1× | 11 ms | 21 ms |
| `hydrate()` | 1× | 14 ms | 29 ms |
| Client JS (gzip) | | 13.4 KB (`generate: dom`) | 18.1 KB (hydratable) |
| Page weight, 100 rows (raw) | | JSON 14.6 KB | SSR markup 29.4 KB, plus the same JSON for hydration |

**Hydrating 10–20 rows costs about 25 % more than rendering them**: +34 ms at 6×, +3 ms at 1×.
The hydratable runtime adds about 4.6 KB gzipped (+34 % on this toy). The page still has to load
the JS before a row is clickable. The harness counts a row as done only when it is clickable
(`data-bench-ready`), so SSR can only win on first paint. It loses on time to interactive, as the
SSR frameworks did.

## 3. Preload, inlined JSON, and the router's `query` cache

**Preload reuse.** A `fetch()` takes a preloaded response only if the preload key matches: URL,
destination, mode and credentials mode, compared item by item (WHATWG HTML, "preload key" and
"consume a preloaded resource",
<https://html.spec.whatwg.org/multipage/links.html#link-type-preload>) **[doc]**. MDN: "`font`
and `fetch` preloading requires the `crossorigin` attribute… needs to be set to match the
resource's CORS and credentials mode, even when the fetch is not cross-origin"
(<https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload>) **[doc]**.
A default `fetch()` is mode `cors` with credentials `same-origin`, which is what `crossorigin`
(anonymous) gives. So the session cookie goes with both the preload and the fetch, and they
match. Without the attribute the preload is `no-cors` and gets fetched twice. In the probe each
preloaded URL was requested once, and `/api/facets` and `/api/issues?…limit=100` were not
requested again by the app **[measured]**. MDN marks `rel=preload` widely available since
January 2021 **[doc]**.

The preload URL has to equal the app's first request, byte for byte. Today it's hard-coded in
`index.html` for the default view only (`state=open&offset=0&limit=100`). A deep link such as
`/?label=bug` or `/issues/123?…` gets no preload. Generating the shell in axum fixes that: the
server parses the URL's query the same way the client does and writes the matching `href`. The
shell then varies by URL but still not by account **[inferred]**.

**Seeding `query` from inlined JSON.** On the client, the router's `query` looks for a server
value before calling the fetcher when nothing is cached for the key and no navigation is in
flight. The intent is undefined on the initial load, and `transitionIntent` returns undefined
when no navigation is unsettled (`nm/@solidjs/router/dist/routing.js:674-680`):

```js
if (!isServer && (!intent || now - bootTime < (intent === "native" ? CACHE_TIMEOUT : PRELOAD_TIMEOUT))) {
    const entry = takeHydrationValue(key); // hydrating
```

(`nm/@solidjs/router/dist/data/query.js:233-236`). `takeHydrationValue` reads and deletes
`globalThis._$HY.r[key]`. A plain value counts as resolved and a thenable counts as pending
(`nm/@solidjs/web/dist/web.js:374-400`). The type docs say it's "readable before `hydrate()` runs
and after hydration has ended" and that "a test seeds them with `globalThis._$HY = { r: {…} }`"
(`nm/@solidjs/web/types/client.d.ts:108-124`) **[source]**. Nothing in the client bundle writes
`_$HY` in a `render()` app **[source]**. The key is `name + hashKey(args)`, where `hashKey` is
`JSON.stringify` with object keys sorted (`query.js:168, 512-522`). For the default list that is

```
issues[{"assignees":[],"labels":[],"q":"","state":"open"},0,100]
```

and for facets it is `facets[]`. The probe's server writes both into
`<script>globalThis._$HY={r:{…}}</script>`, with `<` escaped as `<`. The app made no
`/api/facets` or `/api/issues` request and showed the right rows **[measured]**. The entry is
taken once and stamped with `bootTime`. A later `revalidate` fetches normally, and a navigation
more than 5 s after boot doesn't reuse it (`query.js:226-260`) **[source]**.

This isn't a documented app-level API. The `_$HY.r` slot belongs to Solid's hydration, and the
key format is the router's. A mismatch fails safe, because `query` just fetches. A unit test
that compares the Rust-built key with `getIssues.keyFor(...)` would catch drift **[inferred]**.
A thenable seed is possible too: an inline script could start the `fetch` itself and put the
promise in `_$HY.r`. That would be a preload without a `<link>`. It wasn't measured.

**103 Early Hints.** hyper's HTTP/1 encoder turns a 1xx response into a 500 with "response with
1xx status code not supported", because "Service only allows returning a single Response"
(`hyper-1.12.0/src/proto/h1/role.rs:400-416`). hyper's `ext::on_informational` is
client-only (`hyper-1.12.0/src/ext/informational.rs:6-24`). The `h2` crate has
`SendResponse::send_informational` (`h2-0.4.20/src/server.rs:1146-1191`), but hyper doesn't call
it (no use in `hyper-1.12.0/src`) **[source]**. Chrome: Early Hints are "only available for
navigation requests", "recommended to only be sent over HTTP/2 or HTTP/3", and "only cacheable
resources can be preloaded using Early Hints or the resource will be double fetched"
(<https://developer.chrome.com/docs/web-platform/early-hints>) **[doc]**. A reverse proxy could
send them for the hashed JS and CSS, but the shell is generated in about a millisecond, so the
hint would arrive no earlier than the `<link>` in the HTML **[inferred]**.

## 4. Measured: four first-load variants (throwaway)

`first-load-probe`, all variants on the same image. Far network (100 ms RTT, 10/5 Mbps), 20k, 20
iterations, `--scenarios cold,warm --no-video`, run in interleaved rounds:

- `preload`: today's shell (`no-cache`).
- `nopreload`: the shell without the `<link>`s.
- `cached`: the preload shell with `Cache-Control: max-age=600`.
- `inline`: per-request HTML with facets and 100 rows seeded into `_$HY.r`,
  `private, no-cache`, no preloads.

p50 / p95, ms:

| Variant | 6× cold (round 2) | 6× warm (round 2) | 1× cold (2 rounds) | 1× warm (2 rounds) |
|---|---|---|---|---|
| preload | 1061 / 1198 | 1001 / 1058 | 359, 376 / 403, 595 | 270, 272 / 382, 352 |
| inline | 1021 / 1119 | 986 / 1123 | 357, 369 / 393, 424 | **234, 239** / 299, 284 |
| cached | 1046 / 1211 | 961 / 1150 | 352, 382 / 384, 437 | **148, 166** / 177, 234 |
| nopreload | 1064 / 1251 | 1097 / 1249 | 435, 442 / 457, 460 | 315, 312 / 1275, 354 |

At 6×, rounds 1 and 3 were run while the host was loaded: in round 1 by this session's own
hydration test, in round 3 by other work. All four variants moved by 100–200 ms between rounds,
so only round 2 is shown. Rounds 1 and 3 kept the same order at 1× and at 6× except for noise. The
raw runs are `bench/results/2026-10-21-13*-first-load-probe-*` (gitignored).

Reading **[inferred from the measurements]**:

- **Cold** (empty cache): the order is TCP, then the document, then JS + CSS + data. The JS is
  39 KB and has to be parsed and run, so it finishes last. Inlining the rows takes the data off
  that path, but it wasn't the long pole. Only removing the preload hurts, by about 70 ms at 1×:
  the data request then waits for the JS.
- **Warm, no-cache shell + preload:** the document round trip, then the data round trip. The JS
  comes from cache and overlaps with the second one.
- **Warm, inline:** the document round trip, then the JS from cache, one after the other. One
  round trip is saved, but the JS can't start until the HTML has arrived.
- **Warm, cached shell:** no document request. The JS runs while the one data round trip is in
  flight. This is about 90 ms (1×) faster than inline, and about 120 ms faster than today.
- At 6×, JS execution (hundreds of ms) dwarfs one 100 ms round trip, and the host noise hides
  the differences. On the owner's laptop, which is faster at 1× than this host at 6×, the 1×
  column is the closer guide.

The CDP network emulation adds latency per request. It doesn't model TCP or TLS handshakes or
slow start (`bench/README.md`, "Host and caveats"), so the real cold numbers are higher for every
variant, and the next section's flight counts aren't in them.

## 5. Bytes and the 14 KB first flight

RFC 6928 sets the initial window to `min(10*MSS, max(2*MSS, 14600))`, about 14.6 KB
(<https://www.rfc-editor.org/rfc/rfc6928>) **[doc]**. Measured on the wire, gzip, router build
**[measured]**:

| Resource | Wire (gzip) | Raw |
|---|---|---|
| Shell HTML (with the preload `<link>`s) | 0.5 KB | 0.8 KB |
| Inline HTML (facets + 100 rows) | 4.0 KB | 25.8 KB |
| JS (one file, router build) | 38.9 KB | 109.8 KB |
| CSS | 0.8 KB | 2.0 KB |
| `/api/facets` | 0.2 KB | 0.2 KB |
| `/api/issues` 100 rows / 30 / 20 | 3.4 / 1.4 / 1.1 KB | 24.8 / 7.5 / 5.0 KB |

Both documents fit in the first flight, and so does every API response, well inside the 14 KB
per-response budget. The second generation (JS + CSS + data, 43.3 KB) does not fit in one
flight. Over one HTTP/2 connection with slow start it needs about two more flights after the
document: about 14.6 KB, then about 29 KB. That's two round trips of transfer on a cold
connection **[inferred]**. The 14.7 KB Solid Router 2 adds, as measured in
[the router results](../../bench/candidates/axum-solid2-router/RESULTS.md), is what pushes the JS
past one flight. Without the router the second generation is about 28.6 KB, which is close to one
flight.

## 6. Live updates, the reload banner, and HTTP caching

- **Live updates.** With any variant, the rows are a snapshot taken when the document (inline)
  or the preload was served. The client opens `EventSource('/events')` in `onSettled`, which is
  after the first render (`axum-solid2-router/web/src/App.tsx`). A change that lands in between
  is missed until the next push. All variants have this window. Inlining makes it longer by the
  JS download on a cold load **[inferred]**. Fix it in all variants: put a change sequence number
  in the first response, as a field or a header, and have `/events?since=<seq>` replay anything
  newer. Or revalidate once when the stream opens. The SSE refetch path (`revalidate` on the
  `query` keys) works the same for seeded entries, because a seeded entry is a normal cache entry
  once taken **[source]**.
- **Reload banner (stale account tab).** The shell carries no account, so it doesn't affect the
  banner. The tab learns its account from the first API response, and every later response or
  SSE message can say "the cookie now selects another account". Inlined HTML has to carry the
  account id it was rendered for, next to the rows, so the tab knows what it is showing
  **[inferred]**.
- **Caching the document.**
  - A shell with no account data is the same for everyone, so it can be cached, even by a shared
    cache.
  - Inlined rows make the document per-account. It then has to be `private, no-cache`, never a
    public `max-age`.
  - Don't use `no-store`: "when `Cache-Control: no-store` is set on the page resource itself,
    browsers have chosen not to store the page in bfcache"; web.dev advises `no-cache` or
    `max-age=0` for content that isn't sensitive
    (<https://web.dev/articles/bfcache>) **[doc]**.
  - A cached shell has its own risks **[inferred]**. After a deploy, an old shell can name old
    asset hashes for up to `max-age`, so keep the previous build's hashed assets for at least
    that long. An old client may also call the new API for that long.
  - Responses that aren't the shell, such as a login redirect or a signed-out page at `/`, must
    be `no-store` or `private`, so the cache never keeps one in place of the shell.
  - A reload revalidates the document whatever its `max-age`, so a reload costs the same as the
    `preload` variant.

## Recommendation

**First load:**

- Serve an SPA shell from axum. No SSR, no hydration, no JS engine in the server.
- The shell carries no account data. Generate it per URL, so the `<link rel=preload as=fetch
  crossorigin>` for facets and the first list page (and the open issue, on `/issues/:id`) match
  what the client will request.
- Serve it with a short `Cache-Control: max-age` (start at 300 s) and keep the previous build's
  hashed assets. A warm load then makes one data round trip that overlaps JS execution:
  148–166 ms at 1× far, against 270 ms today.
- Keep the inlined-JSON seed (`_$HY.r`) as the fallback if a cacheable shell turns out to be a
  problem (deploy skew, an auth flow at `/`). It still saves a round trip on warm loads (234–239
  ms at 1×), needs `private, no-cache`, and is tied to the router's key format, which needs a
  test.
- Don't use 103 Early Hints.

**Budgets for perf CI (issue #44):**

- **Critical-path depth: 2 request generations on a cold load.** The document comes first.
  Everything needed for the first rows (JS, CSS, facets, the list page) must be discoverable
  from the document and requested in parallel, not started by JS. A check: in the cold run, every
  critical-path resource has `initiatorType` `link` or `script` from the parser, with
  `/api/issues` started before the JS has run. A warm load with a fresh shell makes **1** network
  generation (the data).
- **HTML document ≤ 14 KB on the wire.** Today it's 0.5 KB (4.0 KB inline).
- **Summed cold first-load bytes ≤ 48 KB on the wire (gzip)**: document + JS + CSS + every
  request before `data-bench-ready`. Today it's 43.8 KB with Solid Router 2, or about 29 KB
  without the router. That leaves about 10 % headroom. Tighten it to about 30 KB if the router's
  bytes are ever dropped. That would put the second generation in one or two slow-start flights.
- **Per API response ≤ 14 KB.** The 100-row first page is 3.4 KB.

## Open

- The `cached` shell's deploy-skew and auth behaviour are reasoned, not tested. So is
  per-URL preload generation for deep links.
- The live-update gap between the snapshot and SSE connect exists today in every variant. It
  needs a `since` sequence or a revalidate on open. Neither was built.
- The measurements came from a loaded host. Only round 2 at 6× is clean. Real TCP/TLS slow
  start isn't modelled by CDP, so the flight counts in section 5 are inferred. Running the
  `preload`, `inline` and `cached` variants behind `./bench/shape`, and once on the owner's
  laptop, would settle the 1× ordering.
- Solid 2 SSR of the real app under rquickjs (router, async data, polyfills) wasn't tried. Only
  a synchronous toy render was. Solid 2 is an RC, so the hydration and `_$HY` internals may
  change.
- A thenable seed (an inline script that starts the fetch and puts the promise in `_$HY.r`) as
  an alternative to `<link rel=preload>` wasn't measured.
- `EventSource` and bfcache: web.dev lists open WebSocket and in-flight fetch as blockers, but
  doesn't mention SSE. Closing the stream on `pagehide` and reopening it on `pageshow` is the
  safe default.
