# bench: the shared benchmark fixture and harness

Every stack candidate is measured against the same synthetic mirror, the same fake webhooks and
the same scripted browser run. The method comes from
[Benchmark scenarios and metrics for the stack comparison](https://github.com/tomsjansons/beghu/issues/11#issuecomment-6141302538).
Everything here is throwaway: it exists to compare candidates, not to start the real app.

```sh
./bench/run stub                                   # headline cell: low CPU, far network, 20k issues
./bench/run stub --profile fast --net near --scale 50k
./bench/run stub --profile all --net all --scale all   # the full matrix, 8 cells
./bench/run stub --scenarios filter,live --iterations 5 --no-video   # a quick check while building
```

Runs queue on a host-wide lock (`/tmp/beghu-bench.lock`), because two runs on one host skew each
other. `BENCH_NO_LOCK=1` skips it, for quick checks only.

The first run installs Playwright and Chromium, generates the fixture (about 15 s for 20k and 40 s
for 50k) and builds the candidate's image.

**Needs:** Node 22.13 or newer (for `node:sqlite`), Docker or Podman on the `docker` command, and
Linux for the tab-memory reading.

## Flags

| Flag | Values | Default |
|---|---|---|
| `--profile` | `low` (6× CPU throttle), `fast` (none), `all` or a comma list | `low` |
| `--net` | `near` (20 ms RTT, no cap), `far` (100 ms RTT, 10 Mbps down, 5 up), `all` | `far` |
| `--scale` | `20k`, `50k`, `all` | `20k` |
| `--iterations` | measured iterations per scenario | `20` |
| `--scenarios` | comma list of `cold,warm,filter,scroll,detail,live,write` | all |
| `--latency` | ms the candidate waits to stand in for a GitHub write (`GITHUB_LATENCY_MS`) | `300` |
| `--no-video` | skip the video pass on the low profile | videos on |
| `--headed` | show the browser | headless |

A candidate directory can hold several variants of one app: `./bench/run filtering:client` builds
`candidates/filtering` and starts it with `BENCH_VARIANT=client`. Results go to
`results/<date>-filtering-client/`.

## What a run does

For each cell (profile × net × scale) and each scenario:

1. Copies the pristine fixture mirror into `results/<run>/tmp/<scenario>/mirror.db` and starts the
   candidate's image with `--cpus=1 --memory=512m`, the copy mounted at `/data`. Each scenario gets
   its own container, so writes and webhooks from one scenario never leak into another.
2. Streams `docker stats` for server CPU and RAM.
3. Launches Chromium (Playwright's full build in headless mode, 1280×800). Every tab gets CDP CPU
   throttling and network emulation before it navigates.
4. Primes one browser context with an unmeasured visit, then runs the measured iterations, each in
   a new tab of that context. Warm storage and HTTP cache, like a returning user. Cold load is the
   exception: a new, empty context for every iteration.
5. On the low profile, runs one more iteration with video recording, saved to
   `results/<run>/video/<cell>/<scenario>.webm` for the feel session. It isn't counted.

Results go to `results/<date>-<candidate>/`: `results.json` with every number, and `summary.md` with
one table per cell, marked against the reference lines. Host CPU, Chromium and engine versions are
recorded in both.

## Scenarios

The harness injects a probe (`harness/probe.mjs`) before any candidate code. It timestamps each
input event and checks a condition on every animation frame. A result is the frame in which the DOM
first matched, not the moment Playwright noticed. The expected rows come from the pristine fixture
(`harness/expect.mjs`), so a candidate is only done when it shows the **right** rows.

| # | Scenario | Starts | Ends | Reference (p95, headline) |
|---|---|---|---|---|
| 1 | `cold`: empty context | navigation start | the first 20 rows of the default view are the expected ids and the list carries `data-bench-ready` | ≤ 3 s |
| 2 | `warm`: new tab, warm context | navigation start | same as cold | ≤ 1 s |
| 3 | `filter`: toggle a label, then an assignee, then state closed; then, on a fresh tab, type `dark m` one key at a time | each click or `input` event | the first 20 rows match the expected ids for that filter | ≤ 200 ms |
| 4 | `scroll`: wheel down the list in 400 px steps until row 500 is on screen | first wheel | row 500 visible; every frame time and long task in between is kept | frames ≤ 33 ms, no long task > 100 ms |
| 5 | `detail`: click one of the top 20 rows; each has exactly 30 comments | click event | detail with that id shows its body and 30 comments | ≤ 300 ms |
| 6 | `live`: filter by `bug`, then POST an `issues.edited` webhook renaming the 5th row | just before the POST (harness clock) | the new title is in a row (page clock, same host) | ≤ 2 s |
| 7 | `write`: open a row's detail, click to add a label it lacks | click event | the label chip shows in the detail | ≤ 100 ms |

Notes on the scenarios:

- **Filter** rotates through 8 labels and 7 assignees across iterations. The fixture is tuned so
  that every keystroke of `dark m` changes the top 20 rows (titles include `dart`, `darker`,
  `dark theme`, `date` and `data` as near misses). Without that, a debounced candidate could match
  before it had done anything.
- **Live** edits move the issue to the top, as on GitHub. The expected list accounts for earlier
  edits in the same run.
- **Write** also records the server round trip: from the click to the response of the first
  non-GET request to the candidate. It has no reference line.

## Metrics

| Metric | How |
|---|---|
| p50 / p95 per scenario | from the samples above; filter also breaks down per step kind |
| JS transferred and decoded | CDP Network events for `Script` responses during cold load (median over iterations) |
| Peak JS heap | CDP `Performance.getMetrics` `JSHeapUsedSize`, every 250 ms |
| Peak tab memory | PSS of the largest renderer process, from `/proc/<pid>/smaps_rollup`, every 250 ms (budget about 300 MB at 20k) |
| Long tasks | `PerformanceObserver('longtask')` during the scroll |
| Server CPU and RAM | `docker stats`, mean and peak CPU, peak RAM |
| Cache warm | cold load only, for candidates that fill a browser cache: from navigation to the `bench:cache-warm` performance mark, which the candidate sets once the cache is persisted. Recorded only if the page also set `bench:cache-start` |

**Server load under several users.** `./bench/load <candidate>[:<variant>] --scale all --users 1,5,20`
drives the server over plain HTTP, with no browser: every user cold-loads at once, then runs the
filter scenario's request sequence, then holds `/events` open while one webhook a second arrives.
`docker stats` is sampled in each phase. Users of a `client` or `worker` variant fetch the snapshot
and deltas instead of filtered pages, and send nothing while filtering. See `harness/load.mjs`.
By default every user is their own account (`--accounts per-user`: the candidate gets
`BENCH_ACCOUNTS=<users>` and each user sends `x-account`); `--accounts shared` puts every user on
one mirror. `--conn pool|open` is passed as `BENCH_CONN`, `--cpus N` sets the container's CPU limit
(default 1), and `--sqlite stock` builds with `STOCK_SQLITE=1`. Candidates that ignore these get
the default behaviour.

## The fixture

`fixture/generate.mjs` writes, per scale, into `data/` (gitignored):

- `mirror-<scale>.db`: a SQLite mirror in the shape decided in
  [Mirror schema and per-account isolation](https://github.com/tomsjansons/beghu/issues/8#issuecomment-6149948470)
  (`fixture/schema.sql`). Ten synced repos of uneven size, plus one unsynced repo holding 40 stubs.
- `webhooks-<scale>.jsonl`: 500 GitHub-shaped deliveries (`issues` edited, labeled, closed and
  reopened, `issue_comment.created`, `sub_issues.sub_issue_added`), each touching a different issue.
- `fixture-<scale>.json`: counts and the detail-target ids.

| | 20k | 50k |
|---|---|---|
| Issues (open) | 20,000 (9,092) | 50,000 |
| PRs (read-only rows) | 5,000 | 12,500 |
| Comments | 114,648 | 282,425 |
| Sub-issue / blocks / relates edges | 3,431 / 1,986 / 1,228 | 7,920 / 4,933 / 3,054 |
| File size | 119 MB | 295 MB |

The generator is seeded, so the same scale always produces the same file. Labels (12 shared names
per repo), milestones (4 per repo), 30 users of whom 8 are the team and the assignees. Bodies are
markdown of 200–2,000 characters with checklists, code blocks and headings. Comments average about
5 per item. Timestamps are anchored to a fixed `fixture_now` (2026-10-01) in `meta`.

Replay the feed into a running candidate, for development or to have live changes during the feel
session:

```sh
./bench/replay http://127.0.0.1:<port> --scale 20k --speed 1    # real gaps, 0.2–5 s
./bench/replay http://127.0.0.1:<port> --speed max --limit 50
```

## Candidate contract

A candidate is a directory `candidates/<name>/` with a `Dockerfile`. `candidates/stub/` is the
reference: plain Node, server-side SQL, server-sent events. It is not a contender.

**Container.** Listens on `$PORT` (8080). The mirror is at `$MIRROR_PATH` (`/data/mirror.db`), a
writable copy in a writable directory. Add indexes or tables to it, or import it into anything
else at startup. `GET /healthz` returns 200 once the app can serve. Startup time isn't measured,
but the harness gives up after 3 minutes. Writes wait `$GITHUB_LATENCY_MS` before they confirm, to
stand in for the GitHub API.

**Webhooks.** `POST /webhook` with `X-GitHub-Event` and a GitHub-shaped JSON body. Respond 2xx.
Treat the payload as the truth: there is no GitHub to fetch from.

**The view.** `/` shows, by default, open issues across all synced repos: issues only (no PRs, no
stubs), newest `updated_at` first, ties broken by the higher id. Filters combine with AND: one state
at a time, every selected label (by name, across repos), every selected assignee (by login), and
search as a case-insensitive substring of the title. Only the top of the list renders; windowing
and infinite loading are allowed.

**DOM hooks.** The harness only touches these, so the design is free otherwise:

| Hook | Meaning |
|---|---|
| `[data-bench=list]` | the list. Add `data-bench-ready` once rows are clickable (handlers attached, hydrated). Add `data-bench-empty` while the filter matches nothing |
| `[data-bench=row][data-id=<items.id>]` | one row, in display order. A click opens its detail |
| `[data-bench=row] [data-bench=title]` | the row's title text |
| `[data-bench=filter-state][data-value=open\|closed]` | selects the state |
| `[data-bench=filter-label][data-value=<name>]` | toggles a label, all 12 names visible without opening a menu |
| `[data-bench=filter-assignee][data-value=<login>]` | toggles an assignee, all 8 visible |
| `[data-bench=search]` | the search input |
| `[data-bench=detail][data-id=<id>]` | the open detail, containing `[data-bench=body]` and one `[data-bench=comment]` per comment |
| `[data-bench=detail] [data-bench=label][data-value=<name>]` | a label chip on the open issue |
| `[data-bench=detail] [data-bench=add-label][data-value=<name>]` | a control that adds that label |

Candidates otherwise follow the rules in the scenarios decision: an idiomatic pass, then one
optimisation session with a change log, any idiomatic library except sync engines, and the DX
checklist.

## Host and caveats

Numbers so far come from this host: **Intel Xeon E5-2695 v4 @ 2.10 GHz (Broadwell, 2016), 32
threads, 32 GB, Podman 6.1.3, Chromium 156.** 6× throttling multiplies this CPU's single-thread
speed, so results from a faster host aren't comparable without re-running the stub as a baseline.

- CDP can't cap a tab's memory, so memory is measured against the budget instead.
- The container and the browser share the host. `--cpus=1` limits the server, not the browser.
- CDP network emulation (and DevTools throttling) delays HTTP requests but **not frames on an open
  WebSocket**: its bandwidth cap applies to them, its latency doesn't. Interactions sent over a socket
  (topcoat) therefore skipped the round trip in every `far` cell. SSE frames are probably the same,
  so treat `far` live-update numbers for push transports with care. For honest latency, put
  `./shape` in front of the server: a TCP proxy that adds round-trip latency and a bandwidth cap to
  every byte (`./shape 9091 127.0.0.1:8091 --rtt 300 --down 1600 --up 750`).
- Headless rendering skips the compositor work a visible window does. Use `--headed` to compare.

### Real-laptop sanity check (once, by the owner)

The 6× profile is the reference. One run on the owner's 5–6-year-old laptop checks it isn't
flattering:

1. On the laptop: clone the repo, install Node 22.13+ and Docker or Podman.
2. Run `./bench/run stub --profile fast --net far --scale 20k --no-video`. The laptop's own CPU is
   the throttle, so use `fast`.
3. Compare its `summary.md` with this host's `low-far-20k` run of the stub. If the laptop is slower
   on most scenarios, raise `PROFILES.low.cpu` in `harness/run.mjs` until 6× matches it. Never lower
   it.
4. Note the laptop's CPU and the result in this section.

**Result (2026-10-15): 6× stays.** The laptop is an Intel Core i5-1135G7 (Tiger Lake, 2020, 8
threads, 16 GB, Docker 29.9). At 1× it is faster than this host at 6× on every scenario, and about
level with this host at 1×. So 6× is roughly a 5× slowdown *beyond* the laptop, a stress profile
rather than a flattering one. The most CPU-bound number, the optimistic write, is 77.7 vs 14.8 ms
(about 5.2×). Candidates' 6× misses overstate what the laptop will feel; their `fast` numbers are
closer to it.

| Stub, `far`, 20k: p50 / p95 ms | This host, 6× | Laptop, 1× | This host, 1× |
|---|---|---|---|
| Cold load | 721 / 743 | 503 / 541 | 485 / 516 |
| Warm load | 728 / 759 | 487 / 504 | 481 / 488 |
| Filter and search | 227 / 1279 | 145 / 162 | 144 / 199 |
| Scroll 500 rows (frames) | 16.7 / 66.6, 11 long tasks > 100 ms | 16.7 / 16.8, none > 100 ms | 16.7 / 16.8 |
| Open detail | 240 / 241 | 151 / 165 | 141 / 167 |
| Live update | 177 / 199 | 150 / 157 | 147 / 158 |
| Optimistic write | 78 / 80 | 15 / 20 | 11 / 14 |

The stub is light and mostly bound by the 100 ms round trip, so the cleanest CPU signals are the
write, the scroll long tasks and the filter tail.

## Running a candidate by hand (the feel check)

The harness has no interactive mode, so start the container the way `harness/container.mjs` does,
on a fresh copy of the mirror (candidates may add indexes to it), then use it in a normal browser.
Run `./bench/run <candidate> --iterations 1 --scenarios cold --no-video` once first if the image or
`data/mirror-20k.db` doesn't exist yet.

```sh
cd bench
C=axum-solid                                   # any directory under candidates/
docker build -t beghu-bench-$C candidates/$C
rm -rf /tmp/beghu-$C && mkdir -p /tmp/beghu-$C && cp data/mirror-20k.db /tmp/beghu-$C/mirror.db
docker run --rm --name beghu-$C --cpus=1 --memory=512m -p 127.0.0.1:8080:8080 \
  -v /tmp/beghu-$C:/data -e MIRROR_PATH=/data/mirror.db -e PORT=8080 -e GITHUB_LATENCY_MS=300 \
  beghu-bench-$C
```

Open <http://127.0.0.1:8080>. For live changes while you click around, run
`./bench/replay http://127.0.0.1:8080 --scale 20k --speed 1` in a second terminal. To match the
headline profile in Chrome, open DevTools → Performance → CPU: 6× slowdown, and add a custom network
profile of 100 ms latency, 10 Mbps down and 5 Mbps up. DevTools throttling only applies while
DevTools is open. On the laptop, skip the CPU throttle, since the laptop is the real thing.

## Layout

```
bench/
  run                 the launcher (bash → harness/run.mjs)
  load                server load under several users (bash → harness/load.mjs)
  replay              posts the webhook feed into a running candidate
  shape               a TCP proxy with real latency and bandwidth limits, sockets included
  fixture/            schema.sql, generate.mjs, github-shape.mjs (payload builder)
  harness/            run.mjs, scenarios.mjs, probe.mjs, expect.mjs, metrics.mjs, container.mjs, load.mjs
  candidates/stub/    the reference candidate
  data/, results/     generated, gitignored
```
