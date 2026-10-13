# topcoat 0.10.0 client runtime: fit for a local-first data layer

Research date: 2026-10-13. Sources are the published crate sources. Paths below are relative to
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/` and are written as `crate/path:lines`.
Upstream repo: https://github.com/tokio-rs/topcoat (`topcoat-0.10.0/Cargo.toml:38`); it was not
consulted. Measurements came from a scratch app in the session scratchpad (`tcbench/`), not in
this repo.

## Answers

1. **Browser APIs from `raw!`: yes. Async results into signals: yes, with caveats.** Compiled
   expressions run as plain JS through `new Function` with browser globals in scope, so
   IndexedDB, BroadcastChannel and `navigator.locks` are all reachable (verified in headless
   Chromium). An `async` event handler can `await` a promise inside `raw!` and `.set()` a
   signal with the result. To use the value in expressions it has to be converted to a runtime
   value with the internal `cx.hydrate(...)`. Nothing outside topcoat-emitted expressions can
   reach signals: the runtime object is never exposed globally.
2. **Server pushing data over topcoat's connection: no, only HTML.** The WebSocket carries
   four frame types: `snapshot` (HTML), `swap` (region id + HTML), `redirect` and `error`.
   Custom messages would mean patching the runtime on both ends. A separate app WebSocket or
   SSE route is cheap, since the router ships both. Passing data inside emitted HTML (a JSON
   `<script type="application/json">`, or a hydrated expression) works as a workaround.
3. **Client-side variable-length list: no.** Client expressions update a text node or an
   attribute, nothing else. `view!` `for` loops run on the server only. The closest options
   are server-rendered shard or live-region swaps, or JS that owns its own DOM. The JS-owned
   DOM has to sit somewhere topcoat's morph will not overwrite it (shadow DOM is the likely
   place, inferred).
4. **Latency: full server re-render plus a full HTML morph of the shard on every
   interaction.** Measured on localhost, release build, headless Chromium, rows of
   `<li id><span/> <b/></li>`. A 50-row shard takes about 15 ms over HTTP and 8 ms over the
   WebSocket. With stable ids, 500 rows take about 35 ms, 5,000 about 300 ms and 20,000 about
   1.2 s. With all-new ids (a filter or page change), 500 rows take about 170 ms and 5,000
   take about 15 s, which is quadratic in the morph. Server rendering costs about 2 µs per row.
   The browser side dominates.

## 1. `raw!` and browser APIs, async, signals

**How `raw!` is emitted.** `raw!("js", rust_fallback)` is the only builtin expression macro
(`topcoat-runtime-grammar-0.10.0/src/expr/builtin_macro.rs:39-56`). The JS string is copied into
the generated JS verbatim. `${ident}` is the only interpolation: it inserts a local binding or a
captured value (`builtin_macro.rs:136-165`). The Rust fallback runs for server evaluation. Without
one, the server side becomes `panic!("raw! needs a Rust expression to run on the server")`
(`builtin_macro.rs:125-129`), which is acceptable inside event handlers because their bodies
never run on the server (`topcoat-runtime-macro-0.10.0/docs/expr.md:21`). The docs say signal
reads in the fallback decide whether a browser binding is emitted at all (`docs/expr.md:107`).

**How the browser runs it.** Every expression, binding and handler is compiled with
`new Function("cx", "return " + source)` (`topcoat-runtime-0.10.0/browser/src/expression/compile.ts:6-15`).
The `cx` argument "executes as ordinary JavaScript with access to browser globals"
(`browser/src/expression/context.ts:6-11`). Event handlers are compiled from
`data-topcoat-on:*` attributes and attached with `addEventListener`
(`browser/src/dom/event.ts:9-20`). The scratch app's HTML showed the generated code directly:

```html
<button data-topcoat-on:click="async (__local0) => { let __local1 = (await new Promise((res) => {
  const r = indexedDB.open('tc-probe', 1); ... })); (cx.hydrate({&quot;t&quot;:&quot;Signal&quot;,&quot;id&quot;:&quot;27f2…&quot;})).set(__local1); }">
```

Clicking that button in headless Chromium set the signal to `"idb ok: object function"`. That
string reports IndexedDB open success, `typeof navigator.locks === "object"` and
`typeof BroadcastChannel === "function"`. Measured; the source is `tcbench/src/main.rs`.

Inferred: `new Function` needs a CSP that allows `'unsafe-eval'`. A strict CSP would break the
whole runtime, not just `raw!`.

**Async.** Closures may be `async`, and `.await` lowers to JS `(await …)`
(`grammar/src/expr/expr_closure.rs:18-21`, `grammar/src/expr/expr_await.rs:15-19`; syntax list
in `docs/expr.md:81`). Procedures return a lazy `Future` wrapping `fetch`
(`browser/src/surrogate/procedure.ts:13-28`, `browser/src/surrogate/future.ts:1-23`). The working
pattern is to put the `await` inside the `raw!` string, with a fallback of the right Rust type.
This compiles and runs (scratch app):
`let v = raw!("(await idbGet())", String::new()); sig.set(v);`. Not tried:
`raw!("p").await` with no fallback. The fallback has type `!`, and whether `.await` on that
type-checks is unverified.

**Getting JS values into signals.** Signals hold runtime "surrogate" objects (`Integer`, `Vec`,
`Record` and so on), not raw JS values. `WriteSignal.set` stores whatever it is given
(`browser/src/surrogate/signal.ts:28-30`), and changed values schedule effects in a microtask
(`browser/src/reactivity.ts:19-29`, `62-74`). To make a JS value usable by other expressions,
convert it with `cx.hydrate(dehydratedJson)`. `cx.hydrate` maps strings, numbers and booleans
to surrogates, and tagged objects to integers, `Vec`, `Option`, `Record` and the rest
(`browser/src/expression/hydrate.ts:15-99`; wire shapes in `browser/src/expression/serialized.ts:29-43`).
topcoat's own tests use `raw!("cx.hydrate(7)", …)` (`topcoat-runtime-macro-0.10.0/tests/expr.rs:56`,
`:464`), but `cx.hydrate` is not documented API. Signals are also sent back to the server on
re-renders and must dehydrate (`browser/src/surrogate/signal.ts:61-63`,
`browser/src/expression/dehydrate.ts:5-21`). A raw JS object without `dehydrate()` would make
the rerun throw "Value cannot be serialized for the server" (inferred from `dehydrate.ts:20`).

**Signal access from outside.** The runtime instance is a module-local `const` in the entry
point (`browser/src/index.ts:1-5`), and the registry is a private `Map`
(`browser/src/signal-registry.ts:5-6`). No source file assigns anything to `window` or
`globalThis` (grep of `browser/src`). An external JS module can therefore only touch a signal
through a closure that topcoat-emitted code hands it. For example, a handler or binding
`raw!` could run `window.__setX = (v) => ${sig}.set(cx.hydrate(v))`. That is possible but
unsupported (inferred).

**Vocabulary limits.** Only `f64`, integers, `bool`, `String`/`&str`, `Option`, `Result`, `Vec`
(with `len/get/index/first/last`), tuples, `#[record]` structs and `Signal` are supported
(`docs/expr.md:56-67`). The syntax has no `for`, `match` or iterators
(`docs/expr.md:71-84`; dispatch table in `grammar/src/expr.rs:132-153`, which rejects
everything else as "unsupported expression").

## 2. Server push: transport and wire protocol

**Transport.** There is one WebSocket per document, opened at the page URL with subprotocol
`topcoat-runtime` (`browser/src/render/connection.ts:9-10`, `164-182`;
`topcoat-runtime-0.10.0/src/layer.rs:9-14`, `18-31`). It opens only when rendered content
contains the `<!--::topcoat::connect-->` marker, which `connected(cx)` emits
(`src/connection.rs:36-43`; `browser/src/render/unit.ts:138-155`). After a drop it reconnects
with backoff from 1 s to 30 s (`connection.ts:53-54`, `184-195`), and the server keeps no state
between connections (`connection.ts:27-32`; `topcoat-view-macro-0.10.0/docs/live.md:127`).

**Client to server.** The client sends either `{run, method, path, headers, body}`, an HTTP
request description that the server dispatches through the normal router, or `{stop}`
(`src/layer/socket.rs:57-85`, `158-181`). Only `Content-Type`, the identity header and the
runtime header may be set per run (`socket.rs:117-123`). Each run is an ordinary page or shard
render.

**Server to client.** The server sends `{"run": n, "frame": F}` (`socket.rs:104-115`), where
`F` is one of the following (`topcoat-core-0.10.0/browser/frames.ts:5-9`):

```ts
| { t: "snapshot"; html: string }
| { t: "swap"; region: string; html: string }
| { t: "redirect"; location: string }
| { t: "error"; status: number }
```

The client switches on exactly these four (`browser/src/render/frames.ts:33-52`). Server-side,
any response that is not `application/x-ndjson` frames becomes an `error` frame
(`socket.rs:207-217`). The same NDJSON frames are used for HTTP reruns
(`browser/src/render/request.ts:39-79`). Arbitrary payloads and custom message types are not
supported. Adding one would mean editing `ServerMessage`, `applyFrame` and the Rust renderer,
which is a fork of the bundled JS.

**What push looks like in practice.** Push is a `live!` region that keeps emitting HTML while
connected (`docs/live.md:76-125`). Every emission replaces the region
(`topcoat-view-0.10.0/src/internal/live_view.rs:17-29`, `99-114`). The scratch app's ticker
shard updated `tick 23 -> tick 26` over 3 s, so this was observed working.

**Low-effort alternatives.**
- An app-owned WebSocket or SSE route. The router provides `WebSocketUpgrade` and `Sse`
  (`topcoat-router-0.10.0/src/content/websocket/upgrade.rs:26-60`,
  `src/content/sse/response.rs:21-50`) behind topcoat features `websocket` and `sse`. Neither
  is in the default feature set (`topcoat-0.10.0/Cargo.toml:72-84`, `186`, `202`). This is
  independent of the runtime and the cleanest data channel.
- Data inside emitted HTML. Inline `<script>` tags inserted by morph or `innerHTML` do not
  execute; the runtime says so for page updates (`browser/src/render/navigation.ts:292-294`)
  and parses swaps with `innerHTML` (`browser/src/dom/fragment.ts:8-15`). Two options remain.
  The first is a non-executing `<script type="application/json">` that a client
  `MutationObserver` picks up (inferred, not tried). The second is a hydrated expression: on
  hydrate, `data-topcoat-bind:*` attributes and `expr::start` comments are compiled and run
  immediately (`browser/src/dom/hydrate.ts:71-82`, `120-136`; `browser/src/dom/binding.ts:19-29`),
  so a non-static `$(raw!("ingest(${data})", …))` inside an emission runs with the captured
  data. Captured values travel as JSON snapshots (`docs/expr.md:39`). Inferred, not tried.
  Static expressions render no JS (`docs/expr.md:21`).

## 3. Variable-length lists on the client

Not supported. The client has four DOM update paths:
- Text expressions remove the nodes between their markers and insert one `createTextNode`
  (`browser/src/dom/text.ts:25-40`), so output is always text and never markup.
- Bind attributes set one attribute or property (`browser/src/dom/binding.ts:31-59`).
- Event handlers (`browser/src/dom/event.ts`).
- Server HTML: shard snapshots and region swaps, applied by morph.

The marker vocabulary is fixed: `signal`, `dep`, `connect`, `expr-start/end`,
`region-start/end` and `shard-start/end` (`browser/src/dom/markers.ts:5-45`). There is no list
or keyed-block marker. `view!` `for` loops and `#[key]` are server-render constructs
(`topcoat-view-macro-0.10.0/docs/view.md:153`, `348-371`). The expression grammar has no `for`
(see section 1).

**Workarounds.**
- Server-rendered shard (`docs/runtime.md:191-220`, `251-276`) or live region (`docs/live.md`).
  Elements are matched by tag and position, or by `id` (`docs/shard.md:41-43`). See the
  section 4 costs.
- `raw!` or an external module that builds DOM itself. Morph has no opt-out attribute; there is
  no ignore or permanent flag in `topcoat-core-0.10.0/browser/morph.ts`. A page rerun or
  navigation morphs the whole `<body>` (`browser/src/render/page.ts:64-82`, `118-127`), and a
  morph syncs an element's children to the server HTML (`morph.ts:288-315`). Client-built
  children of a server-rendered element therefore get removed on the next rerun of the
  enclosing unit (inferred from the code). Morph walks `childNodes` only, so a custom element
  that renders into its own shadow root should survive. That is inferred and not tested.

## 4. Latency per interaction

**Path for a shard.**
1. A signal write schedules effects in a microtask (`reactivity.ts:62-74`). The shard's watch
   effect calls `RenderRequest.schedule`, which batches writes from the same tick and aborts
   the previous request (`unit.ts:182-197`; `request.ts:18-32`; `docs/shard.md:43`).
2. The client builds a request body of all argument values plus every signal the shard's
   content owns, dehydrated to JSON (`browser/src/render/shard.ts:58-72`;
   `browser/src/scope.ts:126-134`). Page reruns send every signal in the document
   (`page.ts:49-57`).
3. Transport is `fetch` POST to the shard endpoint, or a `run` message on the WebSocket if the
   shard requested a connection (`unit.ts:222-234`; `connection.ts:134-147`).
4. The server re-runs the whole shard function and renders its full HTML; nothing is diffed on
   the server. The response is a `snapshot` frame with the complete HTML
   (`socket.rs:186-229`; frame type above). Page reruns render the full document, but only
   `<body>` children are morphed (`page.ts:15-18`, `113-127`).
5. The client parses the HTML with `innerHTML` on a detached element (`fragment.ts:8-15`).
6. Morph runs, adapted from idiomorph (`morph.ts:1-58`). Its `findBestMatch` scans forward
   over old siblings for each new node and stops early only on an id-set match or displaced
   persistent ids (`morph.ts:207-247`). When no ids persist, every new sibling scans all
   remaining old siblings, which is O(n²) (inferred from the code, and the measurements agree).
7. Re-hydration walks every element and comment in the shard range with a TreeWalker,
   recompiling every binding and handler with `new Function` (`hydrate.ts:36-69`;
   `unit.ts:245-253`, `297-310`; `shard.ts:86-97`).

**Measured.** Release build, localhost, headless Chromium, 32-core Linux box. Each row is
`<li id=…><span>#N</span> <b>title</b></li>`. "DOM" is click to MutationObserver, which covers
everything up to the end of morph and hydrate. Values are medians of 3–5 runs.

| Case | Rows | HTTP shard | WS shard | Main-thread long task |
|---|---|---|---|---|
| All row ids change (page/filter change) | 50 | ~15 ms | ~8 ms | none |
| All row ids change | 500 | ~170 ms | ~205 ms | ~160–200 ms |
| All row ids change | 5,000 | ~15–17 s | not run | ~15 s |
| Ids stable, one row's text changes | 500 | ~35 ms | — | none |
| Ids stable, one row's text changes | 5,000 | ~300 ms | — | ~250–360 ms |
| Ids stable, one row's text changes | 20,000 | ~1.2 s | — | ~1.0–1.2 s |
| 20,000 → 50 rows (new ids) | — | ~2.0 s | ~1.9 s | ~1.9 s |

Server-only cost was measured with curl POSTs to the shard endpoint, uncompressed, ttfb/total:
0.7 ms for 50 rows (4 KB), 2.9 ms for 500 (42 KB), 12.6 ms for 5,000 (430 KB) and 47 ms for
20,000 (1.8 MB). That is about 2 µs per row, so the browser's parse, morph and hydrate work
dominates. Over HTTP every rerun also paid a `fetch`; the WebSocket path saves roughly 5–7 ms
at small sizes and makes no difference at large ones.

**Live emissions** take the same client path through `applySwap`: parse the region HTML,
morph the region, re-hydrate it and resubscribe (`unit.ts:264-291`). The server only renders
the emitted view. Cost per emission therefore scales with region size the same way as the
table above (inferred, not measured separately).

## Other runtime behaviour that matters for local-first

- **Navigation is SPA-like, so JS state survives.** `link` and `link_attrs` fetch the
  destination, morph the document and push history (`topcoat-runtime-0.10.0/docs/link.md:145-151`;
  `navigation.ts:211-290`, `318-337`). The JS realm is not reloaded, so module-level state
  survives: an open IndexedDB connection, BroadcastChannel subscriptions, in-memory caches.
  That is inferred from there being no reload. If the destination needs a script not already
  loaded, or the doctype or `<base>` differs, the browser does a full load instead
  (`navigation.ts:292-307`, `511-535`). Keep the same script tags on every page.
- **Signal lifetime.** Signals declared on both pages keep their values across navigation
  (`docs/link.md:147`). Signals missing from new content are deleted (`unit.ts:236-244`,
  `307`). An existing client value wins over the server's declaration on re-render
  (`hydrate.ts:96-107`).
- **Signals are not a data store.** Every shard rerun posts its signals, and every page rerun
  and prefetch posts all of them (`shard.ts:58-72`; `page.ts:49-57`; `navigation.ts:169-175`).
  Putting thousands of issues in signals would upload them on every interaction. Inferred
  consequence: the IndexedDB cache has to live outside signals.
- **Prefetch renders on the server**, by default on hover, focus or touch (`docs/link.md:35-62`).
  It sends the current signals, and any procedure call invalidates prefetches
  (`procedure.ts:19`).
- **Custom JS and assets.** `asset!("./file.js")` bundles a local file or a URL and serves it
  under `/_topcoat/assets` (`topcoat-0.10.0/docs/asset.md:1`, `32-35`, `70`). beghu already
  does this for `theme.js` (`src/main.rs:27`). No bundler, TS or npm step is documented;
  presumably files are copied as-is (inferred from `asset.md:136-148`).
- **beghu has not enabled the runtime yet.** Its router has no `.runtime()` or `.discover()`,
  and the layout lacks `topcoat::runtime::script()` (`/home/tomsj/dev/begihup/src/main.rs:12-14`,
  `22-30`). All of these are required (`topcoat-0.10.0/docs/runtime.md:7-46`).
- **Stability.** The runtime is labelled "highly experimental" (`docs/runtime.md:3`).
- **Security.** Shard arguments, procedure arguments and restored signals are all user input
  (`docs/runtime.md:84`, `189`, `220`, `247`).

## Implications for beghu

- **topcoat can't render a 20k-issue list on the client.** Shards and live regions are
  server-rendered with a full morph. Client cost is about 60 µs per row with stable ids, and
  quadratic when ids change, so a filter change over a few thousand rows takes seconds. The fast
  list view has to be client-owned JS: a virtualized list that renders only visible rows,
  living in a custom element with shadow DOM (or another subtree topcoat never re-renders),
  fed from IndexedDB.
- **Use topcoat for the shell, routing, detail pages and forms; keep shards small.** Server
  shards of up to about 100 rows with stable `id`s stay under about 20 ms locally. If server
  pagination is used, keep pages small and keep row ids stable across reruns.
- **Use a dedicated data channel for the mirror.** Add the `websocket` or `sse` feature and an
  app route that streams JSON deltas (issue upserts with a cursor/`Last-Event-ID`) into
  IndexedDB. Do not route data through the runtime socket. The app route also gives control
  over resume and backfill, which the runtime connection does not have because it keeps no
  state across reconnects.
- **Coordinate tabs in the data module.** Use Web Locks to elect one syncing tab and
  BroadcastChannel to fan out changes. Both work, but the logic belongs in a plain JS module
  loaded via `asset!` and present on every page, not in `raw!` strings.
- **Keep the bridge to topcoat signals thin and optional.** If server-rendered parts need
  client state, such as a selected issue id or an unread count, hand a setter to the module
  through one `raw!` binding that calls `cx.hydrate`. That uses an internal API that may
  change, so isolate it in one helper. Never store bulk data in signals.
- **CSP.** The runtime needs `'unsafe-eval'`. Plan any CSP around that.

## Open questions / unverified

- Whether a custom element with a shadow root really survives page reruns and navigations
  untouched. Inferred from morph walking `childNodes`; needs a test. Also whether morph's
  attribute sync clobbers attributes the component sets on itself (`syncAttributes` in
  `morph.ts`).
- Whether `raw!("…").await` with no fallback type-checks. Only "await inside the string with a
  typed fallback" was tested.
- Whether `cx.hydrate` is stable or intended for user code. It appears in tests only.
- Pushing data via a hydrated expression or a JSON `<script>` inside a `live!` emission was
  not tried.
- The measurements were taken on one fast local machine, on localhost, with headless
  Chromium. Real networks add RTT and slower devices add CPU time. Compression (on by
  default) was not measured. The cost of a 5,000-row all-new-ids rerun over the WebSocket and
  of a live emission into a large region was not measured.
- Not checked: docs.rs or the upstream repo, for newer topcoat versions that might add client
  lists or data frames.
- How `asset!` handles JS module graphs (`import` between local files). Not checked.
