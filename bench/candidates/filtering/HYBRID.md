# Hybrid filtering: first paint from the server, filters from a worker cache

Run on 2026-10-16 for
[Benchmark: server + worker hybrid filtering](https://github.com/tomsjansons/beghu/issues/47). The
`hybrid` variant is described in [README.md](README.md). Browser runs used the far network (100 ms
RTT, 10 Mbps down), 20 iterations per scenario, and held the bench lock. The host was loaded
throughout (about 21 of 31 GB of RAM in use and 28 GB swapped), so compare numbers within a run,
not across days.

## A correction first: CDP doesn't throttle workers

`Emulation.setCPUThrottlingRate` slows a page's main thread only. A loop that takes 93 ms in a
dedicated worker took 93 ms at 6× too, while the same loop on the main thread went from 134 to
1072 ms. Chromium refuses the command on a worker target ("Operation is only supported for pages,
not workers"). So every worker number on the low profile in
[Benchmark: client-side vs server-side filtering](https://github.com/tomsjansons/beghu/issues/20)
ran its worker at full speed.

The harness now puts the profile's rate in `window.__bench.cpuRate`. The worker reads it from its
name, and `Cache` spins after each synchronous chunk of worker work (parse, decode, scan) for
`rate - 1` times as long as the chunk took. This emulation is coarse: it scales the worker's own
CPU time but not the IndexedDB and network work the browser does on other threads, so it is if
anything still a little kind to the worker. The `worker` variant was re-run with it below.

## Passes

**Idiomatic pass:** the hybrid source and the stored snapshot as described in the README. The
worker started after the first paint. The cache was the `worker` variant's: one object per row,
an id index, string timestamps. On the headline cell (low, far, 20k) it loaded like the server
variant (cold 842 / 918 ms, warm 849 / 951) and switched to the cache at 2.2 s. But on warm visits
at 50k, no filter step ever reached the cache: decoding took 0.8–1.1 s after the worker started,
and the scenario had finished by then. Results: `results/2026-10-16-035702-filtering-hybrid`.

**Optimisation pass** (`results/<date>-filtering-hybrid` per row below):

| # | Change | Target | Effect |
|---|---|---|---|
| 1 | Worker starts at boot instead of after the first paint. A first visit holds back only the snapshot download until the first rows are painted (`{ fetch: true }`), so it doesn't compete with the first page | cache ready on warm visits | Worker reads IndexedDB at about 0.7 s instead of after paint (0.9–1.0 s) |
| 2 | Rows stay as the parsed tuples, with the lowercased title added in place. Row objects are built only for rows a query returns, and kept per row in a `WeakMap`, so unchanged rows keep their identity. No id index: a small delta finds its old rows with one filter pass | decode time | Warm decode at 6× (emulated): 0.8–1.1 s → 0.4–0.8 s, noisy |
| 3 | Snapshot rows on the wire: flags as 0/1, `updated_at` as Unix seconds | parse time, wire size | JSON 6.5 → 5.3 MB at 50k; brotli 1190 → 1149 KB |
| 4 | Stored snapshot compressed with brotli 5 / gzip 6 instead of 9 / 9 | rebuild cost | 50k: brotli 1220 KB in 0.5 s. Brotli 9 gives 1126 KB in 1.3 s, and brotli 11 gives 947 KB in 19 s |
| 5 | Label and assignee bitmasks per row. A query that only narrows the previous one (a longer search, an added label or assignee, the same state), or pages through it, scans only the previous matches | filter on the low device | First-page scan of 48 views at 50k, 1×: 618 → 298 ms in total, same rows and totals for all 48 |

Changes 1–4 are in the first full matrix (`…-042130-filtering-hybrid`), and change 5 in the second.
Every change used plain browser and Rust features; nothing fought Solid or axum.

## Browser results

The same day, on the same harness: `server` (`results/2026-10-16-060906-filtering-server`), `worker`
with the worker throttle emulated (`…-051437-filtering-worker`, cache changes 2–3 only), and the
optimised `hybrid` (`…-053928-filtering-hybrid`). p50 / p95 ms, far network.

- **Filter, warm visit** is the filter scenario: a returning tab clicks the moment its list is live.
  The `n local` count says how many of its 180 steps the hybrid's cache answered, and the rest went
  to the server.
- **Early search** is the early scenario's first half: a first visit typing at once, while the
  cache fills. The worker variant shows no list until its cache is ready, so its search is always
  local.
- **After ready** is the early scenario's second half: label, assignee and state toggles once the
  page has switched to its cache (the range over the three).

### Low device (6× CPU, worker throttled to match)

| | 20k server | 20k worker | 20k hybrid | 50k server | 50k worker | 50k hybrid |
|---|---|---|---|---|---|---|
| cold | 955 / 1044 | 1952 / 2152 | **884 / 1045** | **913 / 1046** | 3352 / 3873 ✗ | 934 / 991 |
| cache ready (cold) | — | 2001 / 2210 | 2169 / 2554 | — | 3414 / 3913 | 3420 / 3819 |
| warm | **885 / 972** | 1314 / 1525 ✗ | 949 / 1075 ✗ | **936 / 1040** ✗ | 1722 / 2121 ✗ | 943 / 1007 ✗ |
| filter, warm visit | 178 / 207 ✗ | 91 / 136 | **83 / 188** (157 local) | 173 / 202 ✗ | **117 / 158** | 182 / 217 ✗ (0 local) |
| early search | 182 / 216 ✗ | 90 / 142 | 181 / 222 ✗ | 179 / 203 ✗ | 111 / 162 | 184 / 226 ✗ |
| after ready | 179–189 / 199–212 | 74–106 / 109–144 | **78–88 / 96–116** | 180–188 / 198–221 | 129–167 / 165–230 | **72–91 / 92–152** |
| scroll frame p95 | 49.9, 3 tasks > 100 ms | 33.4 | 33.4 | 33.5 | 33.4 | 50, 1 task > 100 ms |
| live | 164 / 180 | 187 / 235 | 187 / 213 | 162 / 178 | 245 / 301 | 173 / 197 |
| tab PSS, cold | 68 MB | 87 MB | 91 MB | 70 MB | 119 MB | 126 MB |

### Fast device

| | 20k server | 20k worker | 20k hybrid | 50k server | 50k worker | 50k hybrid |
|---|---|---|---|---|---|---|
| cold | 435 / 466 | 1235 / 1265 | **425 / 444** | **423 / 454** | 2198 / 2283 | 429 / 446 |
| cache ready (cold) | — | 1306 / 1339 | 1270 / 1308 | — | 2266 / 2351 | 2077 / 2126 |
| warm | **259 / 273** | 320 / 404 | 266 / 412 | 257 / 280 | 404 / 486 | **257 / 280** |
| filter, warm visit | 123 / 131 | **28 / 36** | 30 / 128 (140 local) | 123 / 131 | **28 / 38** | 124 / 131 (0 local) |
| early search | 123 / 131 | 30 / 36 | 120 / 130 | 121 / 130 | 30 / 36 | 123 / 133 |
| after ready | 125–130 / 131–133 | 31 / 33–47 | **31–32 / 33–38** | 120–130 / 133–190 | 31 / 35–47 | **30–31 / 33** |
| scroll frame p95 | 16.7 | 16.7 | 16.7 | 16.8 | 16.7 | 16.8 |
| live | 127 / 134 | 129 / 146 | 128 / 145 | 127 / 142 | 143 / 157 | 129 / 136 |
| tab PSS, cold | 85 MB | 87 MB | 90 MB | 68 MB | 118 MB | 125 MB |

In all 80 early iterations across the four cells, switching to the cache left the rows on
screen exactly as they were (`bench:switch-same`, none `switch-differs`), so nothing re-rendered.

**When a returning tab's cache is ready.** The harness didn't record this during the matrix (the
`warm` scenario records it from now on), so it was measured afterwards with a throwaway timeline
script on the final build: 6 warm visits per cell, far network.

| | ready after navigation | after the first rows |
|---|---|---|
| fast, 20k | 0.41–0.74 s | 0.14–0.21 s |
| fast, 50k | 0.48–0.65 s | 0.21–0.35 s |
| low, 20k | 1.21–2.22 s | 0.25–1.11 s |
| low, 50k | 1.85–2.22 s | 0.90–1.16 s |

On the low device at 50k, the worker reads IndexedDB about 0.7 s after navigation and then spends
about 1.0–1.3 s parsing and decoding (emulated 6×). Until then the hybrid filters through the
server, which is why the filter scenario's warm visits at 50k never reached the cache.

## Server load (`./bench/load`, one mirror per account)

20 users at once, p50 / p95 ms, with the server's mean / peak CPU (100% = one core). The burst is
every user cold-loading together, five times. A hybrid user fetches facets, the first page and the
stored snapshot. A client user fetches facets and a snapshot built per request, as before. A server
user fetches facets and the first page. Live is one webhook a second for 30 s, each user re-asking
for a delta (hybrid, client) or its first page (server).

| 20 users | burst | live | filter phase | RAM peak |
|---|---|---|---|---|
| 50k hybrid, 4 CPUs | **479 / 629** · 12% / 77% | 13 / 22 | nothing sent | 231 MB |
| 50k hybrid, 1 CPU | **474 / 812** · 13% / 75% | 13 / 22 | nothing sent | 228 MB |
| 50k client, 4 CPUs | 8094 / 11679 · 247% / 417% | 15 / 22 | nothing sent | 551 MB ¹ |
| 50k client, 1 CPU | 31654 / 45841 · 88% / 109% | 13 / 23 | nothing sent | 537 MB ¹ |
| 50k server, 4 CPUs | 41 / 464 · 13% / 73% | 31 / 98 | 87 / 796 · 64% / 180% | 158 MB |
| 20k hybrid, 4 CPUs | 253 / 374 · 9% / 71% | 13 / 18 | nothing sent | 190 MB |
| 20k hybrid, 1 CPU | 246 / 405 · 9% / 73% | 13 / 23 | nothing sent | 193 MB |
| 20k client, 4 CPUs | 1182 / 1628 · 110% / 379% | 14 / 22 | nothing sent | 375 MB |
| 20k client, 1 CPU | 4236 / 5446 · 61% / 100% | 14 / 22 | nothing sent | 400 MB |
| 20k server, 4 CPUs | 34 / 307 · 8% / 50% | 21 / 37 | 15 / 112 · 33% / 71% | 152 MB |

¹ At the container's 512 MB limit, as before.

Results: `results/2026-10-16-060130-load-filtering-hybrid-per-user-pool-4cpu`, `…-062856-…-hybrid-…-1cpu`,
`…-063623-…-client-…-4cpu`, `…-064356-…-client-…-1cpu`, `…-065400-…-server-…-4cpu`. No run had errors.

- **The stored snapshot fixes the burst.** Serving the stored bytes costs no SQL and no compression,
  so 20 cold loads at 50k take 0.47 s p50 on one CPU instead of 32 s, and the server stays at
  about 12% mean CPU. The time left is mostly 20 copies of 1.2 MB leaving the container. Memory
  grows with accounts by the stored bytes (about 2.4 MB per 50k account for brotli plus gzip) and
  the per-account pools, not with requests.
- **A stale snapshot plus a delta is enough.** The stored snapshot is not rebuilt per change. Its
  `seq` travels inside it, and the browser's first delta brings it up to date (5–13 ms of server
  time in every configuration). A rebuild at 50k costs about 1.1 s of CPU (383 ms SQL, 31 ms JSON,
  0.2 s gzip 6, 0.5 s brotli 5), so it runs in the background once 500 rows have changed.
- **The hybrid sends nothing while filtering once warm,** like the client variant. Before its cache
  is ready, it sends what the server variant sends.

## What it says

- **The hybrid keeps the server's load times on every device and at both scales.** Cold and warm
  loads are within noise of the server variant (low: 0.88–0.95 s; fast: 0.26–0.43 s). The worker
  variant, honestly throttled, loads 0.1–2.4 s slower and misses the cold budget at 50k on the low
  device (3.4 / 3.9 s).
- **Once warm, it filters like the worker cache, or faster.** After the switch: 30–32 ms against
  the server's 120–130 on the fast device, and 72–91 ms p50 against 179–189 on the low device. The
  bitmasks and narrowing (change 5) put the low device's p95 at 92–152 ms, where the worker variant
  without them reached 165–230 at 50k.
- **Before it is warm, it filters like the server,** because it is the server. Every keystroke
  keeps working while the cache fills. A first visit's early search costs 120–123 ms p50 (fast) and
  181–184 ms p50 (low), the same as the server variant. The worker variant shows no rows at all
  until its cache is ready.
- **How long "before warm" lasts:** on a first visit the cache is ready 1.3 s (fast, 20k) to 3.4 s
  (low, 50k) after navigation, dominated by downloading about 1.2 MB of brotli at 10 Mbps and then
  decoding it. A returning tab is ready 0.14–0.35 s after its first rows on the fast device, and
  0.25–1.16 s on the low one.
- **The switchover costs nothing visible.** The cache was checked against the rows on screen 80
  times and matched every time, so nothing re-rendered. If it ever differs (a change landed between
  the first page and the delta), the list refetches as on a live update.
- **Memory:** a cold tab holds about 90 MB at 20k and 125 MB at 50k, against 68–70 MB for the
  server variant. The JS heap metric can't see the worker's heap.
- **On the 6× profile at 50k, the margin is thinner than the earlier ticket said.** With the worker
  throttled honestly, the worker variant filters at 117 / 158 ms there instead of the 75 / 120
  reported, and decoding the cache takes about a second. The hybrid's faster scan brings it back
  to 72–91 ms p50. The laptop check found the owner's laptop at
  1× roughly level with this host at 1×. The fast profile is the one that predicts feel, and there
  the cache wins by 4×.
- **Not fixed here:** decoding 5.3 MB of JSON on every warm visit. A columnar copy in IndexedDB
  (typed arrays plus one joined title string) should cut most of the parse, and would also make the
  scan cheaper. Rough cost: half a day. A smaller wire format would help first visits on slow links
  more than any compression level: titles are most of the bytes.

## What the sync stage has to provide

- **A full snapshot that can be stale,** served as stored compressed bytes, with the cursor (`seq`)
  it was built at inside it. One per account, rebuilt in the background, never per request.
- **Deltas since a cursor** (`?since=<seq>`), with every row changed after it, and tombstones once
  deletes exist. The first delta after a snapshot is what makes the cache current.
- **An ordering identical to the server's list query** (`updated_at` desc, then `id` desc) and the
  same filter semantics, so a page from the server and a page from the cache agree row for row.
  That is what lets the switchover check pass without re-rendering.
- **A change signal** for live updates (here SSE carrying ids), after which the cache fetches the
  delta.
- **The server's filtered list endpoint stays,** for first paint and for every query until the
  cache is ready. A sync layer that only feeds the cache doesn't replace it.
- **A worker-safe client.** The cache lives in a dedicated worker, so the sync client must run
  without the DOM, and its CPU work must be throttled in benchmarks: CDP won't do it, so use
  `window.__bench.cpuRate` as the filtering candidate does.
