# Comment thread size: how much an issue detail can carry in 200 ms

Research date: 2026-10-24. The question: how many comments can an issue detail carry and still go
from click to painted in about 200 ms? Long agent threads (an agent and a review bot going back and
forth) are expected to reach hundreds of comments. If loading all of them costs 500 ms–1 s, the
detail should load part of the thread and fetch the rest separately. This file measures where that
split should go.

**Stack as decided** ([markdown-rendering.md](markdown-rendering.md)):
- The server renders Markdown with comrak, sanitises it with ammonia and sends a compact AST
  (`[tag, attrs|0, ...children]`).
- The client walks the AST into DOM elements with a ~0.6 KB walker, inside one Solid component per
  comment.
- Highlighting is lazy and off the critical path, so it's left out here. It cost 0.9 ms at 1× and
  8.8 ms at 6× on a budgeted thread, and 141 ms at 6× for 185 comments.

**Method and tags.** Each claim is tagged **[measured]**, **[source]** or **[inferred]**. The
scripts are in [`bench/candidates/markdown-probe/thread`](../../bench/candidates/markdown-probe/thread/README.md)
(throwaway).
- **Host:** the bench host (Xeon E5-2695 v4, 32 threads), shared, with a load average of 4–8
  during runs.
- **Browser:** Chromium 156 under Playwright, with CDP `Emulation.setCPUThrottlingRate`.
- **Profiles:** 1× on this host is about level with the target laptop (i5-1135G7), so 1× is "what
  the laptop feels". 6× is a stress profile about 5× past the laptop.
- **Networks:** the bench profiles `near` (20 ms RTT, no cap) and `far`, the headline (100 ms RTT,
  10 Mbps down), plus 20 ms at 10 and 50 Mbps and 100 ms at 50 Mbps.

## Answers

1. **On the laptop with a near server, about 260 human comments, 15 agent comments or 30 of a
   50/50 mix fit 200 ms cold.** At the 100 ms headline the limits fall to about 59, 4 and 8. On a
   fresh request the response then has to fit TCP's first flight of 10 segments (~14 KB on the
   wire). Anything larger adds a second round trip, and two round trips already cost 200 ms
   **[measured + model]**.
2. **At large N the client's style and layout pass dominates. JSON parse, the DOM walk and the
   server do not.** For 100 agent comments at 1×:
   - parse: 8 ms
   - AST walk into DOM: 51 ms
   - style + layout: ~420 ms
   - frame: 564 ms in total

   Layout cost follows the amount of text: about 0.65 ms per KB of Markdown for human comments and
   0.85 ms/KB for agent comments at 1×, and 7–8× that at 6× **[measured]**. Transfer dominates only
   at 100 ms RTT, and only through slow-start round trips.
3. **"Send all, render first + newest K" fixes the client but not the wire.**
   - **Client.** With K = 10 the frame stays at 10–20 ms for human threads at any N up to 800, and
     at 65–130 ms for agent threads at 1×. Parse grows with N, to 57 ms for 800 agent comments
     (6.4 MB).
   - **Wire.** At the headline, transfer alone breaks 200 ms once the compressed body passes about
     14 KB: roughly 59 human, 4 agent or 8 mix comments. If the connection's window is still
     warm, the limits are about 540, 50 and 90 comments (~125 KB of brotli).
   - **Server.** comrak + ammonia cost about 0.65 ms per agent comment (65 ms for 100), and
     ammonia is about 55% of that **[measured]**.
4. **Split by bytes, not by count.** The first response carries the issue body, the first comment
   and the newest comments, up to **~36 KB of raw compact-AST JSON**. That lands at 10–13.5 KB of
   brotli-4 on every thread measured, so it fits the first flight with headers. It's 3× the
   prototype's 12,000-byte rule. The older middle comes from a second request started right after
   paint, and renders only when expanded (or behind `content-visibility: auto`).
   - In practice this loads a whole human thread of up to ~45 comments, the first plus newest 2–3
     of an agent thread, about 10 of a mix, and the newest 34 of the real 744-comment agent PR.
   - The cost at 1× is about 45–65 ms on a near server and 110–145 ms at the headline
     **[inferred from measured]**.

## 1. Corpus

**Human comments.** These are the 616 comments of the existing corpus: six public issues (rust,
vite, node, tokio, bun, vscode) **[measured]**:

| Class | Comments | Markdown median | p90 | mean | max | Compact AST median / p90 |
|---|---|---|---|---|---|---|
| human | 616 | **346 B** | **1,204 B** | 632 B | 28,416 B | 411 / 1,399 B |
| agent | 109 | **6,700 B** | **10,533 B** | 6,532 B | 13,944 B | 7,932 / 13,313 B |
| kandev#2669, whole thread | 744 | 71 B | 1,040 B | 473 B | 9,234 B | 83 / 1,411 B |

**Agent comments are real, not synthesized.** `fetch-agents.sh` pulls the issue comments of five
public threads and keeps the bot comments of 1.5–40 KB **[measured]**:
- **kdlbs/kandev#2669**, a PR with 744 comments. A human pings `@claude review`, `@codex review`,
  `@coderabbitai full review` and others, and claude[bot] answers each push with a 3–7 KB review.
  The reviews have headings, a severity table and nested lists. 41 are kept.
- **objectstack-ai/objectstack#6015**, an issue with 1,547 comments. claude[bot] posts an hourly
  "triage round" report of 4–14 KB with tables, inline code and lists. Six are mostly Chinese. 55
  are kept.
- **rmems/synthetic-factory#135, manaflow-ai/cmux#5553 and rjmurillo/ai-agents#5078** add
  coderabbit, codecov, deepsource, sonarqube, kilo-code, greptile and github-actions summaries
  (13 comments).
- Three comments over 40 KB were left out (an 88 KB coderabbit walkthrough and two github-actions
  dumps). Such comments exist, and a byte budget has to cope with them (§5).

Agent comments are about 19× the median human comment. Fenced code blocks are rare in them. They
are mostly headings, tables, lists and inline code.

The whole kandev thread is also measured as it stands, because it's what a real agent PR looks
like: 744 comments, mostly one-line pings and short bot acks between long reviews, 344 KB of
Markdown in total.

**Threads.** `build.mjs` builds threads of N = 2, 5, 10, 25, 50, 100, 200, 400 and 800 comments
per class:
- **human**: drawn from the 616 human comments.
- **agent**: drawn from the 109 agent comments.
- **mix**: alternates human and agent comments.

Comments come from a seeded shuffle and repeat when N exceeds the pool. Item 0 stands in for the
issue body. Each item is `{id, author, created_at, body: <compact AST>}`.

## 2. Server: comrak + ammonia + compact AST

`rs/` runs the decided path. It walks ammonia's sanitised tree straight into the compact JSON. This
closes the earlier open question ("comrak's AST → compact JSON in Rust … wasn't built"). The output
is **byte-identical** to the parse5-based `js/compact.mjs` on all 653 corpus docs **[measured]**.
It uses `Document::to_dom_node`, which needs `--cfg ammonia_unstable` (`ammonia-4.2.4/src/lib.rs:3433`)
**[source]**.

Whole-thread times, as medians of 7–15 runs on one core:

| Thread | Markdown | Server (comrak / ammonia / AST) | gzip-6 | brotli-4 | brotli-5 |
|---|---|---|---|---|---|
| human-50 | 24 KB | 3.1 ms | 1.1 ms | 1.5 ms | 2.1 ms |
| human-200 | 98 KB | 9.5 ms (3.6 / 5.5 / 1.0) | 5.0 | 4.3 | 7.1 |
| human-800 | 470 KB | 50 ms | 22 | 15 | 27 |
| agent-10 | 78 KB | 7.2 ms | 3.3 | 3.2 | 5.4 |
| agent-100 | 651 KB | 66 ms (19 / 34 / 4.4) | 30 | 25 | 45 |
| agent-400 | 2.6 MB | 257 ms | 119 | 47 | 124 |
| mix-100 | 342 KB | 36 ms | 15 | 14 | 22 |
| kandev-744 | 344 KB | 47 ms | 12 | 10 | 22 |

- **Rate.** About 100–110 µs per KB of Markdown. ammonia is ~55% of it, comrak ~33% and the AST
  walk ~7%.
- **Small threads are cheap.** Server time is negligible for small threads. At 100 agent
  comments it's 66 + 25 ms, which is a real share of a 200 ms budget.
- **Caching removes it.** A cache keyed by (comment id, `updated_at`, renderer version), which the
  earlier research already proposed, would take this off the click path. So would rendering only
  the comments in the first response.
- **brotli-4 is the right on-the-fly level.** It's as fast as gzip-6 and 7–10% smaller.
  brotli-5 saves another 5% for about 1.8× the time.

## 3. Wire bytes

The response is a JSON array of `{id, author, created_at, body}` with compact-AST bodies
**[measured]**:

| Thread | Raw JSON | gzip-6 | brotli-4 | br-4 per comment |
|---|---|---|---|---|
| human-10 | 7 KB | 2.5 KB | 2.5 KB | 0.25 KB |
| human-50 | 33 KB | 11.5 KB | 11.5 KB | 0.23 KB |
| human-100 | 73 KB | 24.3 KB | 24.4 KB | 0.24 KB |
| human-400 | 288 KB | 92 KB | 83 KB | 0.21 KB |
| human-800* | 614 KB | 197 KB | 178 KB | 0.22 KB |
| agent-5 | 45 KB | 14.3 KB | 14.6 KB | 2.9 KB |
| agent-10 | 97 KB | 31 KB | 31 KB | 3.1 KB |
| agent-50 | 402 KB | 123 KB | 115 KB | 2.3 KB |
| agent-100 | 818 KB | 252 KB | 228 KB | 2.3 KB |
| agent-400* | 3.2 MB | 992 KB | 899 KB | 2.2 KB |
| mix-10 | 49 KB | 15.6 KB | 15.9 KB | 1.6 KB |
| mix-100 | 434 KB | 135 KB | 127 KB | 1.3 KB |
| mix-200 | 891 KB | 280 KB | 254 KB | 1.3 KB |
| kandev-744 (real) | 471 KB | 84 KB | 77 KB | 0.10 KB |

- **Compression ratio.** brotli-4 is 0.28–0.29× of raw JSON and gzip-6 0.31–0.32× in every
  class.
- **Rows marked \*** repeat comments, because N exceeds the pool. brotli's 4 MB window finds the
  repeats, and agent-400 compressed to 251 KB instead of ~900 KB. Those rows use the ratio from the
  largest non-repeating N, so the figures are estimates.
- **The kandev thread compresses to 0.16×** because its bots repeat templates. That's genuine, but
  it can't be counted on.

## 4. Transfer model

`model.mjs` counts the time from the request leaving the browser to the last byte arriving
**[inferred]**:

- **Idle (the default cold click):** an open connection whose congestion window has fallen back to
  the initial 10 segments. Linux does this after an idle period longer than one RTO
  (`net.ipv4.tcp_slow_start_after_idle = 1` is the default, and this host has it). A user reading a
  list before clicking is idle for longer than that. Slow start then doubles the window each round
  trip until the link is full.
- **Warm:** the window is already past the bandwidth-delay product, so the time is RTT + bytes /
  bandwidth. This is the case right after another transfer, or with
  `tcp_slow_start_after_idle = 0` on the server.
- **New connection:** idle plus 2 RTT for TCP and TLS 1.3. The SPA reuses its HTTP/2 connection,
  so this is shown only for completeness.
- **Framing:** 1,448-byte payloads in 1,514-byte frames, plus 300 B of headers. Delayed ACKs, loss
  and HTTP/2 framing are ignored, so slow start is if anything optimistic.

Transfer in ms for the brotli-4 body (idle / warm):

| Thread (br-4) | near 20 ms | 20 ms 10 Mbps | 20 ms 50 Mbps | 100 ms 50 Mbps | **headline 100 ms 10 Mbps** |
|---|---|---|---|---|---|
| human-50 (11.5 KB) | 20 / 20 | 31 / 31 | 22 / 22 | 102 / 102 | **111 / 111** |
| human-100 (24 KB) | 40 / 20 | 50 / 42 | 42 / 24 | 202 / 104 | **210 / 122** |
| human-400 (83 KB) | 60 / 20 | 101 / 93 | 67 / 35 | 307 / 115 | **336 / 173** |
| agent-10 (31 KB) | 40 / 20 | 55 / 47 | 43 / 25 | 203 / 105 | **215 / 127** |
| agent-50 (115 KB) | 80 / 20 | 127 / 119 | 83 / 40 | 403 / 120 | **415 / 199** |
| agent-100 (228 KB) | 100 / 20 | 224 / 216 | 103 / 59 | 503 / 139 | **515 / 296** |
| mix-100 (127 KB) | 80 / 20 | 137 / 129 | 85 / 42 | 405 / 122 | **424 / 209** |
| mix-200 (254 KB) | 100 / 20 | 246 / 238 | 107 / 64 | 507 / 144 | **536 / 318** |

- **The first flight sets the headline.** At 100 ms RTT the first 10 segments (~14.1 KB of body)
  arrive in one round trip. The next 20 segments take a second round trip, and the next 40 a third.
  So at the headline the question is whether the response fits about 14 KB compressed, not
  bandwidth.
- **At 20 ms the round trips are cheap**, and 10 Mbps becomes the limit for agent-sized bodies.

**Check through `bench/shape`** (`shapecheck.mjs`, warm keep-alive connection, medians of 5)
**[measured]**:
- For large bodies the model holds. agent-100 (234 KB) took 211 ms at 20 ms / 10 Mbps against
  207 ms modelled, and 326 vs 287 ms at 100 ms / 10 Mbps. The measured slope matches a ~9.4 Mbps
  link.
- Small bodies came in a constant 25–45 ms slower. That fits Nagle's algorithm plus delayed ACK in
  the proxy, whose sockets don't set `noDelay`. It isn't a link effect.
- `shape` has no slow start, so it checks only the warm model.

## 5. Client: parse + walk + layout + frame

`web/` is a Solid 2 page. `window.go(k)` times the whole client span for the decompressed response
text:
- `JSON.parse` of the whole response;
- rendering a `<Thread>` component, with one `Comment` per item whose body is `ast.map(walker)`;
- forcing layout;
- then `requestAnimationFrame` + `setTimeout`, as in `bench.mjs`.

The stylesheet stands in for StyleX output: real font sizes, borders, padding and `pre` and table
overflow, with `light-dark()` colours. Each value below is a median of 5–9 runs (3 at 6× for bodies
over 1.5 MB), after one warm-up. `k` is the render-only-part variant: the page holds all N parsed
comments but renders only the first plus the newest k, with an "N hidden" row between them
**[measured]**.

Frame time in ms (1× / 6×):

| Thread | all | first + newest 10 | first + newest 20 | all, `content-visibility: auto` | elements (all) | parse 1× / 6× | JS heap held |
|---|---|---|---|---|---|---|---|
| human-10 | 13 / 68 | 13 / 56 | 13 / 60 | 12 / 60 | 103 | 0.1 / 0.2 | 0.03 MB |
| human-50 | 24 / 169 | 12 / 59 | 14 / 91 | 14 / 81 | 483 | 0.3 / 2.3 | 0.1 MB |
| human-100 | 47 / 377 | 13 / 64 | 14 / 115 | 18 / 123 | 1,014 | 0.5 / 5.5 | 0.3 MB |
| human-200 | 97 / 582 | 14 / 43 | 16 / 92 | 24 / 222 | 1,865 | 0.9 / 6.9 | 0.5 MB |
| human-400 | 168 / 1,229 | 14 / 65 | 15 / 126 | 37 / 338 | 3,806 | 1.7 / 12.5 | 1.0 MB |
| human-800 | 310 / 2,392 | 10 / 76 | 16 / 138 | 83 / 698 | 7,575 | 3.6 / 26 | 2.0 MB |
| agent-2 | 18 / 165 | | | 28 / 221 | 398 | 0.3 / 2.2 | 0.1 MB |
| agent-5 | 39 / 415 | | | 39 / 342 | 775 | 0.4 / 4.5 | 0.1 MB |
| agent-10 | 70 / 640 | | | 57 / 452 | 1,641 | 0.7 / 6.3 | 0.3 MB |
| agent-25 | 185 / 1,343 | 85 / 680 | 135 / 1,275 | 60 / 553 | 3,865 | 2.3 / 14 | 0.6 MB |
| agent-50 | 277 / 2,380 | 65 / 609 | 99 / 995 | 75 / 631 | 6,693 | 2.9 / 30 | 1.1 MB |
| agent-100 | 564 / 5,109 | 72 / 640 | 124 / 1,087 | 113 / 922 | 14,020 | 8.3 / 45 | 2.2 MB |
| agent-200 | 1,229 / 9,486 | 82 / 730 | 145 / 1,147 | 161 / 1,537 | 27,737 | 10 / 111 | 4.4 MB |
| agent-400 | 2,263 / 19,946 | 116 / 754 | 158 / 1,253 | 296 / 2,387 | 55,329 | 24 / 181 | 8.7 MB |
| agent-800 | 4,803 / 39,215 | 129 / 870 | 156 / 1,324 | 538 / 4,221 | 110,653 | 57 / 424 | 18 MB |
| mix-10 | 36 / 352 | | | 34 / 307 | 842 | 0.4 / 3.6 | 0.1 MB |
| mix-50 | 165 / 1,556 | 35 / 287 | 72 / 636 | 49 / 454 | 4,101 | 1.8 / 12 | 0.7 MB |
| mix-100 | 279 / 2,363 | 36 / 294 | 58 / 494 | 57 / 581 | 7,176 | 3.1 / 25 | 1.0 MB |
| mix-200 | 635 / 4,983 | 42 / 297 | 76 / 702 | 100 / 884 | 15,034 | 7.0 / 42 | 2.5 MB |
| mix-800 | 2,462 / 20,573 | 54 / 367 | 98 / 688 | 315 / 2,638 | 59,135 | 21 / 204 | 7.6 MB |
| kandev-744 (real) | 308 / 2,474 | 19 / 151 | 24 / 183 | 87 / 701 | 8,859 | 3.1 / 27 | 1.9 MB |

Empty cells: with N ≤ k + 1 the variant renders everything, so it's the same as "all". DOM nodes,
counting text nodes, run about 2.3× the element count. The heap column is the JS heap held after
GC, with the page keeping the parsed thread and the rendered DOM. Blink's DOM memory isn't in that
number.

What the client numbers show **[measured, inferred]**:
- **Style and layout are the cost.** Parse is under 2% of the frame and the walk about 10%. In
  agent-100 at 1× they take 8 and 51 ms of 564 ms. Dropping the stylesheet entirely
  (`client-nocss.json`) only cut agentEN-50 from 187 to 158 ms and mix-100 from 279 to 242 ms. So
  the cost is text layout itself, not the CSS.
- **Language matters.** Chinese-heavy agent comments cost about 2× more per element than English
  ones (agentZH-50 576 ms vs agentEN-50 187 ms at 1×, `diag.mjs`), probably from font fallback and
  shaping. The agent pool is 95% English.
- **Render-part keeps 1× flat.** With first + newest 10 a human thread stays at 10–20 ms at any N.
  Agent threads at 1× stay at 65–130 ms. That cost is the ten 7 KB comments themselves plus parse,
  which grows with N.
- **At 6× nothing agent-sized fits.** Two agent comments already cost 165 ms, and ten cost 600 ms.
  At that profile only rendering the first screenful (or chunked rendering with yields) stays
  under 200 ms.
- **`content-visibility: auto`** on each comment skips layout for comments off screen. Rendering
  *all* comments becomes about 4–5× cheaper (agent-100 at 1×: 113 vs 564 ms; human-400: 37 vs
  168 ms), but it's still linear in N because the DOM walk is. It's worth having for the expanded
  thread. It doesn't replace the split.

## 6. Click → paint

Click → paint here is transfer (idle window) + server (render + brotli-4) + client frame. It
leaves out route-change overhead, which is small in Solid, and assumes no cache.

Totals in ms with all comments rendered (the headline figure in brackets has a warm window):

| Thread | 1× near | 1× headline | 6× near | 6× headline |
|---|---|---|---|---|
| human-25 | 37 | 123 (123) | 137 | 223 |
| human-50 | 48 | 139 (139) | 194 | 285 |
| human-100 | 95 | 265 (177) | 424 | 594 |
| human-200 | 171 | 413 (249) | 657 | 898 |
| human-400 | 257 | 533 (369) | 1,318 | 1,594 |
| agent-5 | 84 | 245 (157) | 460 | 621 |
| agent-10 | 121 | 295 (207) | 691 | 865 |
| agent-25 | 270 | 532 (368) | 1,428 | 1,690 |
| agent-100 | 754 | 1,168 (950) | 5,299 | 5,713 |
| mix-10 | 82 | 244 (156) | 397 | 560 |
| mix-50 | 254 | 521 (357) | 1,645 | 1,912 |
| mix-100 | 410 | 754 (539) | 2,495 | 2,839 |
| kandev-744 (real) | 424 | 695 (531) | 2,590 | 2,860 |

So the owner's 500 ms–1 s worry starts at about 50 mix or 25–50 agent comments at the headline, and
at 100 agent comments even with a near server.

**Max comments under 200 ms click → paint, cold (idle window)**, interpolated linearly in N
between the measured points, with the transfer model run on the interpolated bytes:

| Class | 1× near 20 ms | 1× 20 ms 10 Mbps | 1× headline | 6× near | 6× headline | preloaded 1× | preloaded 6× |
|---|---|---|---|---|---|---|---|
| **all comments rendered** | | | | | | | |
| human | **~265** | 239 | **59** | 51 | 18 | 490 | 57 |
| agent | **~16** | 15 | **4** | 2 | <2 | 29 | 2 |
| mix | **~32** | 30 | **8** | 2 | <2 | 65 | 3 |
| **all sent, first + newest 10 rendered** | | | | | | | |
| human | ≥800 | 603 | 59 | 621 | 59 | ≥800 | ≥800 |
| agent | 50 | 26 | 4 | 2 | <2 | ≥800 | 2 |
| mix | 160 | 82 | 8 | 3 | <2 | ≥800 | 5 |
| **all rendered, `content-visibility: auto`** | | | | | | | |
| human | 664 | 483 | 59 | 128 | 53 | ≥800 | 178 |
| agent | 44 | 33 | 4 | <2 | <2 | 257 | <2 |
| mix | 112 | 70 | 8 | 3 | <2 | 490 | 5 |

"Preloaded" means a hover preload finished before the click, so only the client frame counts. With
a warm window (`tcp_slow_start_after_idle = 0`, or a recent transfer), the 1× headline limits for
all comments rendered rise to 132 human, 9 agent and 17 mix. With first + newest 10 they rise to
339, 8 and 33.

**Max N for transfer alone under 200 ms:**

| Class | near 20 ms | 20 ms 50 Mbps | 20 ms 10 Mbps | 100 ms 50 Mbps | headline 100 ms 10 Mbps |
|---|---|---|---|---|---|
| idle window: human | ≥800 | ≥800 | ≥800 | 59 | 59 |
| idle window: agent | ≥800 | 353 | 87 | 4 | 4 |
| idle window: mix | ≥800 | 636 | 158 | 8 | 8 |
| warm window: human | ≥800 | ≥800 | ≥800 | ≥800 | 537 |
| warm window: agent | ≥800 | 467 | 91 | 258 | 50 |
| warm window: mix | ≥800 | ≥800 | 164 | 467 | 90 |

## Recommendation

**Set the split by bytes: the first detail response carries up to ~36 KB of raw compact-AST JSON**
(10–13.5 KB brotli-4 or gzip-6 on the threads measured). It holds the issue body, the first comment and the newest
comments that fit, and always at least the newest one even if it alone is bigger. The remaining
middle comes from a second request that starts right after paint. It renders on expand, in
chunks, or behind `content-visibility: auto`.

- **Why 36 KB.** The binding limit at the headline is TCP's first flight: about 14.1 KB of body
  after headers. A body that fits arrives in one round trip, and one that doesn't needs a second
  round trip, so it lands at ≥ 200 ms before any client work. Small bodies compress worse than
  whole threads (0.33–0.45 instead of 0.28–0.32). 40 KB raw reached 13.5 KB on mix and human
  threads, too close to the limit, while 36 KB stays at or under 13.4 KB. On the client, 36 KB of
  AST is about 28 KB of Markdown, which costs 20–40 ms at 1×. On the server it's 3–4 ms uncached.
- **What it gives** (`split.mjs`; click → paint from §4–§6).

  | Thread | First response holds | Click → paint, near 20 ms, 1× | Click → paint, headline, 1× |
  |---|---|---|---|
  | Human threads of ≤ ~45 comments | the whole thread | ~50 ms | ~130 ms |
  | Long human threads | first + newest 41–52 | ~50 ms | ~130 ms |
  | Agent threads | first + newest 2–3 | ~50 ms | ~130 ms |
  | Mixed threads | first + newest ~10 | ~65 ms | ~145 ms |
  | kandev#2669 (744 real comments) | first + newest 34 | ~45 ms | ~125 ms |

- **Why not a count.** Comment sizes vary 19× between the human and agent medians, and individual
  comments vary 100×. A count of 30 would be 7 KB for human comments and 230 KB for agent ones. A
  count cap can sit on top as a guard (for example 100 tiny comments), but bytes decide.
- **Cheap levers that move the numbers:**
  - Set `net.ipv4.tcp_slow_start_after_idle = 0` on the server (or use a proxy that does). A warm
    window turns "fits 14 KB" into "fits ~60 KB in 50 ms" at the headline.
  - Cache the rendered AST per comment.
  - Use brotli-4 for on-the-fly compression.
  - Hover preload takes the transfer off the click entirely.
- **What it doesn't fix.** At 6×, a single screen of agent comments costs 165–450 ms to lay out.
  On the stress profile, agent threads need the first paint limited to the first screenful
  (render the first and newest one or two comments, then yield and fill in). The laptop (1×)
  doesn't need this.

## Caveats

- **Host.** One shared host, with 6× being CDP throttling of that host's main thread. The laptop
  equivalence of 1× comes from `bench/README.md` and wasn't re-checked on the laptop here.
- **Layout in the probe vs the app.** The probe's stylesheet only approximates the app's StyleX
  output. Layout cost is dominated by text, and removing the CSS changed it by only 15–20%, but
  real chrome (avatars, reactions, timeline events) will add elements per comment.
- **Agent pool.** 109 comments from five threads, of which two threads supply 96. Their tables and
  lists are typical of claude[bot] and coderabbit output. Code-heavy agent comments
  (diff suggestions) weren't well represented, and they'd add `pre` blocks with cheap layout but
  lazy highlighting. Six Chinese-heavy comments make the agent class slightly more expensive than
  an English-only one (agentEN-100 is 514 ms vs agent-100's 564 ms at 1×).
- **Repeated comments.** Threads above 109 agent or 616 human comments repeat comments. Raw sizes
  and client times are fine, but compressed sizes are estimated from ratios (§3).
- **The transfer model** ignores loss, delayed ACKs, HTTP/2 framing and TLS records. Real slow
  start is a little slower than modelled. Only the warm model was checked against `bench/shape`.
- **The JS heap** excludes Blink's DOM memory. The `Performance.getMetrics` node counts were flaky
  after GC, so the table shows element counts.
- **Additive totals.** Server time, compression and transfer are added in sequence. A streaming
  encoder could overlap them for large bodies, which mostly matters above 100 KB, where the
  thread is already far past 200 ms.
