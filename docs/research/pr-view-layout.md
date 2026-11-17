# PR view layout: elkjs in production, its cost, and what else could lay out the graph

Research date: 2026-11-17. Ticket: #148, under the PR view map #142. The question is whether the
production PR view can lay out its graph with `elkjs` 0.12.1, as the prototype does, and what
would do it instead.

The settled layout rules:

- layered, left to right
- orthogonal edges that cross only at right angles
- parallel segments spaced apart
- edges routed around nodes
- labels on horizontal segments, with space made for them
- compound nodes for the zoom frame

The top-level rules from #144 also apply: changed and unchanged groups, the changed group at the
top left, no line labels at the top level, no U-turns.

beghu gained a `LICENSE` today (commit 2424825, "Create LICENSE"), and it is the GNU AGPL-3.0.
The ticket was written when beghu was closed source, so the licence section covers both: beghu
as AGPL-3.0, and a closed or dual-licensed path.

Sources:

- **Licence texts.** The EPL-2.0 text as shipped in the elkjs 0.12.1 tarball (`LICENSE.md`).
  Eclipse's EPL-2.0 FAQ (<https://www.eclipse.org/legal/epl-2.0/faq/>, rendered 2026-11-17).
  The FSF licence list (<https://www.gnu.org/licenses/license-list.html#EPL2>, read through the
  Wayback Machine capture of 2026-11-16, because gnu.org timed out). The AGPL-3.0 text in this
  repo's `LICENSE`. The GPL-3.0 text from the SPDX licence files.
- **Package and repo metadata.** `npm view`, crates.io's API, the GitHub API for
  `kieler/elkjs` and `eclipse-elk/elk`, and the libraries' own repos and docs, linked where
  used.
- **The prototypes.** The `t3/pr-view-top-level-variants` prototype at 2053e39
  (`web/prototype-pr-view/layout.ts`, `main.tsx`, `explore.tsx`, written below as
  `proto/<file>:<lines>`).

Each claim is tagged **[source]** (read in code, metadata or a licence text), **[doc]**,
**[measured]** or **[inferred]**. None of this is legal advice. The licence section lays out
what the texts say and the options; the owner decides.

**How the measurements were taken.** Scripts were throwaway, in `/tmp/pr-view-layout-bench/`,
outside the repo.

- **Inputs.** The ELK input graphs were captured from the running prototype (Vite and #2627's
  analysis, with the gitignored overlay of 59 made-up import edges that #144 used). Playwright
  rewrote `layout.ts` as it was served, to record each `elk.layout()` input. No prototype file
  was changed. The inputs stayed in `/tmp`, and nothing from the analysis is quoted here: only
  counts and timings.
- **Runs.** Layout was timed in Node 26.8.1, by loading `elk.bundled.js`, and in headless
  Chromium 156.0.8078.4 (Playwright 1.64.1), with `elk-api.js` driving `elk-worker.min.js` in a
  real Web Worker. Each browser trial used a fresh browser context, so nothing was cached.
- **Host.** The dev host (Xeon E5-2695 v4, 32 threads) was busy: load average 34 to 43 the
  whole time. Absolute times are pessimistic and p95s are noisy; the ratios between
  configurations are the more reliable part.

## Answers

1. **Licence.** elkjs 0.12.1 is `EPL-2.0 OR GPL-3.0-or-later`: EPL-2.0 with GPL-3.0-or-later
   named as Secondary License in Exhibit A. The GPL option is new: elkjs and ELK added it on
   2026-07-07/09, and up to 0.11.1 it was plain EPL-2.0 **[source]**. Serving the file to
   browsers is "Distribute" under the EPL, whether it runs in a Web Worker or not. It needs:
   - a statement of where the source is (pointing at the upstream repos is enough, per the FAQ)
   - the licence text
   - the copyright notices kept

   Shipping it as its own unmodified file keeps beghu's code out of the EPL's reach (§1, §3).
   - **Under AGPL-3.0 (beghu today):** taking elkjs as GPL-3.0-or-later is compatible through
     GPLv3 §13 / AGPLv3 §13 **[source]**. Taking it as EPL-2.0 is not GPL-compatible if the two
     form one combined work. The owner can remove that doubt with an AGPL §7 additional
     permission for elkjs **[inferred]**.
   - **On a closed or dual-licensed path:** take it as EPL-2.0 only. That works with closed
     code as long as elkjs stays unmodified and in its own file **[doc]**.

   Nothing in the repo checks npm licences today; `deny.toml` covers Rust crates only
   **[source]**. The options are listed at the end of §1.
2. **Cost (measured).**
   - **Bytes:** `elk-worker.min.js` is 1,631,868 bytes raw, 472,498 gzip, 352,935 brotli, plus
     `elk-api.js` at 2,527 brotli. `elk.bundled.js` is 356,421 brotli. That is about 8× the
     app's whole cold critical path (43.8 KB, `first-load.md`).
   - **Worker start:** the worker spends 269–327 ms (median) loading and evaluating the script,
     and 442–455 ms from `new ELK()` to the first trivial layout.
   - **Layout for #2627's largest views, in the worker:**
     - The locked top level (42 parts, 2 group boxes, 83 lines, no labels): 262 ms median and
       440 ms p95 per relayout, and 611 ms for the first layout.
     - Clusters with every block open (the same 42 parts and 83 lines, each with a count label):
       **3.2 s median, 4.0 s p95**.

     Most of that is the `NETWORK_SIMPLEX` node placement plus label layers. With
     `BRANDES_KOEPF` placement the same graph takes 0.77 s. A worker keeps the page responsive,
     but it doesn't make Clusters' relayout fast.
3. **Alternatives.** Only ELK (elkjs, or its new Rust port `elk-layout`, same licence) and
   yFiles (commercial, from about €9,200 a year) meet every rule natively. The viable options:
   - **(a) elkjs in a worker.** Proven in the prototype, but the licence has to be accepted,
     every byte and millisecond above is paid, and all three fix-ups stay.
   - **(b) A layout we write and control** (TypeScript, or Rust on the server). It is specific
     to the PR view's shapes: fixed group columns, no top-level labels, and an orthogonal router
     with channel spacing. It avoids every fix-up by construction and has no licence question,
     but it is real work.
   - **(c) MSAGL-JS** (`@msagl/core`, MIT, 164 KB brotli). It does layered layout and
     rectilinear routing with nudging, but labels get no reserved space and compound handling
     differs from ELK's. It needs a prototype before it can be trusted.
   - **(d) @dagrejs/dagre with libavoid-js.** dagre is MIT and 16 KB brotli; libavoid-js is
     LGPL-2.1-or-later and 166 KB brotli with its wasm. This is the routing pairing JointJS
     ships, but nothing makes space for labels.

   Graphviz `splines=ortho` "does not handle … edge labels" **[doc]**, and dagre and d3-dag
   don't route orthogonally **[source]**.
4. **Server-side layout fits the locked layout well.** Its inputs are a small finite key (lens,
   Show, the lone-parts toggle, the zoom target), it has no labels, and an analysis never
   changes once uploaded. So each layout can be computed on first view and cached with the
   analysis. Clusters relayouts on every open and fold. That is still a finite set of states,
   but each click becomes a server round trip, and each ELK run costs the server 0.2–3 s.
   Path needs no layout. A server engine would be a Rust ELK port (same licence question), a
   JVM sidecar, or a layout we write (§4).

## 1. Licence

### What elkjs is licensed under

- **The package.** `elkjs@0.12.1`'s `package.json` says `"license": "EPL-2.0 OR GPL-3.0-or-later"`.
  0.12.0 and 0.13.0 say the same, and 0.11.1 says `"EPL-2.0"` (`npm view elkjs@<v> license`)
  **[source]**.
- **When it changed.** kieler/elkjs commit 277085ec (2026-07-07, "update license and headers to
  secondary license gpl3") and 3900ed63 (2026-07-07, "update spdx license identifier in
  package.json"). Upstream, eclipse-elk/elk PR #1184 ("Update Secondary Licenses notice in
  LICENSE.md") merged 2026-07-09 **[source]**.
- **The tarball's `LICENSE.md`.** It is the EPL-2.0 with Exhibit A filled in: "This Source Code
  may also be made available under the following Secondary Licenses when the conditions for
  such availability set forth in the Eclipse Public License, v. 2.0 are satisfied: GNU General
  Public License v3.0 or later" **[source]**.
- **Notices in the files.** `lib/elk-api.js` (and `elk.bundled.js`, which contains it) carries
  the header "Copyright (c) 2017 Kiel University and others … SPDX-License-Identifier: EPL-2.0
  OR GPL-3.0-or-later". `lib/elk-worker.min.js`, the 1.6 MB layout engine, carries no copyright
  or licence notice at all: GWT output, starting at "FAKE ELEMENTS GWT ASSUMES EXIST"
  **[source]**.
- **What the GPL option means.** The EPL defines a Secondary License as "the GNU General Public
  License, Version 2.0, or any later versions of that license" (EPL-2.0 §1) **[source]**. The FAQ
  calls the arrangement "extremely close to dual licensing": "The EPL-2.0 is the only license,
  until such time as it is combined and distributed with a work under the Secondary License"
  (FAQ 2.3) **[doc]**. The FSF says designating the GPL "is roughly equivalent, for users, to
  releasing that piece of code under a dual license, EPL | GPL", and that "the EPL2 without
  this designation remains incompatible with the GPL" (licence list, #EPL2) **[doc]**.

### What serving it to browsers asks (taking it under EPL-2.0)

- **Serving it is distribution.** "Distribute" means "distributing or b) making available in
  any manner that enables the transfer of a copy" (§1) **[source]**. A browser downloads the
  file, so the app Distributes elkjs to every visitor who opens the view. A Web Worker changes
  nothing: the worker script is still a transferred copy **[inferred]**. Unlike the AGPL, the
  EPL has no network-use clause, so running ELK on the server and sending only coordinates
  would not be distribution **[inferred]**.
- **The minified file is not source.** "Source Code" is "the form of a Program preferred for
  making modifications" (§1). `elk-worker.min.js` is compiled from ELK's Java by GWT, so its
  Source Code is ELK's Java plus the elkjs build **[source, inferred]**.
- **Distributing in any form** (§3.1(a)) requires the Program to be "made available as Source
  Code", "accompan[ied] … with a statement that the Source Code for the Program is available
  under this Agreement", informing recipients "how to obtain it in a reasonable manner"
  **[source]**.
  - For an unmodified build, FAQ 4.17 says the source need not ship with the object code: "you
    do need to include a statement indicating where the source code is available … you may
    choose to provide a reference to where the source code originated from" **[doc]**.
  - So a notice naming elkjs 0.12.1 and linking `github.com/kieler/elkjs` (tag `0.12.1`) and
    the ELK release it builds on is enough **[inferred]**.
- **Under another licence** (§3.1(b)), any licence it is distributed under must disclaim
  warranties and liability for contributors, must not limit recipients' rights to the source,
  and must pass these requirements on **[source]**.
- **Notices** (§3.3): "Contributors may not remove or alter any copyright … attribution notices,
  disclaimers of warranty, or limitations of liability" **[source]**. §3.2(b), a copy of the
  Agreement with each copy, applies when distributing as Source Code. Shipping the EPL text
  alongside costs nothing and covers both cases **[inferred]**.
- **beghu's own code stays out of scope** while it doesn't modify elkjs's files. "Modified Works"
  covers additions to, deletions from or modifications of the Program, and "shall not include
  works that contain only declarations … solely … to link to, bind by name, or subclass the
  Program" (§1) **[source]**. FAQ 4.22: a module distributed with an EPL Program needn't be
  opened "as long as the module is not a Modified Work" **[doc]**. FAQ 1.4: EPL-2.0 moved the
  boundary to the "file" and is "suitable for scripting languages such as JavaScript" **[doc]**.

### Does the build change any of that?

- **Running in a Web Worker.** It doesn't change what is distributed **[inferred]**.
- **Bundling into a chunk with beghu code.** Putting ELK's code and beghu's code in one output
  file blurs the file boundary the EPL draws. The FAQ's "Modified Works" test is written for
  Source Code, so a single minified file holding both is at least arguable **[inferred]**. The
  clean setup is for the worker to load `elk-worker.min.js` as a separate, unmodified asset.
  Vite can copy it unchanged when it is imported with `?url`; check the build output to confirm
  **[inferred]**. Our own worker wrapper, if any, stays a separate beghu file.
- **Minifying.** The only notice in the package is the header comment in `elk-api.js`. It is
  neither `/*!` nor `@license`, so a minifier's default handling of legal comments would drop
  it; this was not measured on Vite 8's output **[inferred]**. Removing it would conflict with
  §3.3. Two fixes: ship `elk-api.js` (2.5 KB) unminified too, or keep the notice in a licence
  file.
- **Vite's licence file.** Vite 8.3.5 has `build.license`, which emits `.vite/license.md` with
  "all bundled dependencies' licenses" (`vite/dist/node/index.d.ts:2938-2942`) **[source]**.
  `web/vite.config.ts` doesn't set it **[source]**.
- **Where the notices go.** The app ships no third-party notices today: no licence page, and no
  `build.license` **[source, grep of `web/src`, `web/site`, `crates/server/src`]**. That is
  already a gap for the MIT packages it bundles **[inferred]**. A served notices file (or
  page) listing elkjs with its copyright line, the EPL-2.0 text with Exhibit A, and the source
  links covers EPL §3. Link it from the view.

### (a) beghu as AGPL-3.0

There are two ways in.

**Take elkjs as GPL-3.0-or-later.**

- **Compatibility.** GPLv3 §13: "you have permission to link or combine any covered work with
  a work licensed under version 3 of the GNU Affero General Public License into a single
  combined work"; the GPL part stays GPL, and AGPL §13's network clause "will apply to the
  combination as such". AGPLv3 §13 grants the mirror permission **[source]**. So GPL-licensed
  elkjs and AGPL beghu combine cleanly.
- **The catch.** Strictly, the Secondary License becomes available "if the Program (i) is
  combined with other material in a separate file or files made available under a Secondary
  License" (§3.2(a)). AGPL-3.0 is not the GPL. The elkjs package and the FSF both present the
  licence as a plain `EPL-2.0 OR GPL-3.0-or-later` choice, which supports reading it as
  available **[source, doc]**. The owner may want counsel's view on this step **[inferred]**.
- **Obligations.**
  - GPLv3 §6: the Corresponding Source of the object code is "all the source code needed to
    generate … the object code", here ELK's Java and elkjs's build. §6(d) allows it "on a
    different server (operated by you or a third party)" with "clear directions next to the
    object code", but "you remain obligated to ensure that it is available for as long as
    needed" **[source]**. A pointer to upstream relies on upstream staying up; mirroring the
    tagged sources removes that risk **[inferred]**.
  - §4: the notices stay intact **[source]**.
  - AGPL §13 then offers the whole combination's source to network users, which beghu's own
    AGPL release has to arrange anyway **[source, inferred]**.
- **Effect on a commercial licence.** This route makes the elkjs part GPL in every copy, so a
  closed or commercially licensed build of beghu could not use it under these terms
  **[inferred]**.

**Take elkjs as EPL-2.0.**

- **The doubt.** The FSF and Eclipse both say EPL and GPL code can't be combined into one work
  (FAQ 4.27: "you may not combine EPL and GPL code in any scenario where linking exists") **[doc]**.
  Whether a page that posts JSON to a separately loaded worker script forms one "combined work"
  with it, or an "aggregate" of separate programs (AGPL §5), is a judgement call
  **[source, inferred]**.
- **Removing the doubt.** The owner, as beghu's copyright holder, can grant an AGPL §7
  "additional permission" to combine beghu with elkjs under EPL-2.0, for example in a `NOTICE`
  next to `LICENSE` **[source, inferred]**. This keeps elkjs under the EPL in every build, so it
  also suits a later dual-licensed path. It is only clean while the owner holds all of beghu's
  copyright, or contributors agree **[inferred]**.
- **Obligations.** As in "What serving it to browsers asks", above.

### (b) A closed or dual-licensed path

- **Closed source.** Take elkjs under EPL-2.0 only and serve it as its own unmodified file, with
  the notice and source statement above. FAQ 4.16 and 4.18 allow commercially licensing a
  product that includes an unmodified EPL Program "as long as it references the EPL portion and
  complies, for that portion, with the terms of the EPL" **[doc]**. beghu's own code doesn't
  become EPL (§1 "Modified Works", FAQ 4.22) **[source, doc]**. Ignoring the Secondary License is
  explicitly fine: "The code can be consumed purely under the EPL-2.0" (FAQ 2.4) **[doc]**.
- **Dual (AGPL plus commercial).** EPL-2.0 works under both licences. The GPL route works only
  for the AGPL side **[inferred]**.
- **Modifying elkjs** (for example patching ELK to pin blocks to the top) would oblige
  publishing that modified source under the EPL on both paths (FAQ 4.21) **[doc]**.

### What the repo's checks would need

- **`deny.toml`** gates only Cargo crates **[source]**.
  - elkjs, as an npm package, never meets it.
  - A Rust ELK port would: `elk-layout` 0.12.2 is `EPL-2.0 OR GPL-3.0-or-later` (crates.io).
    cargo-deny accepts an `OR` expression when either side is allowed, so it would need a
    per-crate `[[licenses.exceptions]]` for `EPL-2.0` (or `GPL-3.0-or-later`), owner-reviewed
    like the MPL-2.0 ones **[source, inferred]**.
  - Its comment "beghu's own crates aren't published … and carry no licence" predates today's
    AGPL `LICENSE` **[source]**. The crates have no `license` field, and
    `[licenses.private] ignore = true` covers them either way.
- **The web app has no licence check.** CI's workflows mention licences only for cargo-deny and
  a GitHub plan note; `web/package.json` is `"private": true` with no `license` field
  **[source]**. The prototype kept elkjs in its own `package.json`, out of `web/`'s lockfile
  (`proto/package.json`) **[source]**. Adding elkjs to `web/` would pass CI unnoticed. The
  options are an npm licence allowlist in CI (the counterpart of `deny.toml`), or reviewing it
  by hand as the owner does now **[inferred]**.

### Options for the owner

1. **Use elkjs under EPL-2.0.** Serve it as its own unmodified worker file. Ship a notices file
   with the EPL text and source links. Under AGPL, add a §7 permission for elkjs. This works on
   every licensing path.
2. **Use elkjs under GPL-3.0-or-later through AGPL/GPL §13.** No exception is needed, but it
   ties the PR view to AGPL-only distribution, and it rests on reading the Secondary License as
   available to an AGPL combination.
3. **Don't ship ELK.** Use a permissive engine or one we write (§3), and the question goes away.
4. **Run the layout on the server** (§4). Under the EPL nothing is distributed. Under the GPL
   route, AGPL §13 applies to the combination anyway, so server-side gains nothing licence-wise
   there **[inferred]**.

## 2. Cost

### Bytes over the wire

Files from the `elkjs@0.12.1` tarball, gzip at `-9`, brotli at `-q 11` **[measured]**:

| File | Raw | gzip | brotli | Role |
|---|---:|---:|---:|---|
| `lib/elk-worker.min.js` | 1,631,868 | 472,498 | 352,935 | The engine, loaded as the worker |
| `lib/elk-api.js` | 9,782 | 2,962 | 2,527 | The page-side API that posts to the worker |
| `lib/elk.bundled.js` | 1,646,241 | 477,480 | 356,421 | Both in one file, with a fake worker on the main thread (what the prototype imports) |
| `lib/elk-worker.js` | 4,899,976 | 749,962 | 533,798 | Unminified engine; never ship it |

- **Worker plus API.** The setup is `elk-worker.min.js` plus `elk-api.js`: about 355 KB brotli,
  fetched only when a view that needs layout opens. Path doesn't need it **[measured,
  inferred]**.
- **First-load JS.** The PR view is its own route and chunk, so first-load JS and its gates are
  untouched. The view would want a perf gate of its own for this chunk **[inferred]**.
- **Re-minifying.** Not measured. Re-minifying the GWT output with Vite would gain little, and
  it is the copy you'd rather not change for licence reasons (§1).

### Parse, compile and start

All [measured].

| Where | What | Median | p95 / max |
|---|---|---:|---:|
| Chromium worker | `importScripts("elk-worker.min.js")`: fetch from localhost, parse, compile, GWT init (n=22 over 3 runs) | 269–327 ms | 399–509 ms |
| Chromium worker | `new ELK()` to the first trivial layout resolved | 442–455 ms | 587–761 ms |
| Node 26 | `require("elk.bundled.js")` (n=10 fresh processes per graph) | 157–217 ms | 207–238 ms |

The first real layout after start is slower than later ones, because the JIT is still warming:
see the "first" column below.

### Layout time for #2627

The prototype's largest views, captured as built:

- **Locked top level (variant A).** The 42 parts that have lines, inside the changed and
  unchanged group boxes, with 83 lines and no labels. `BRANDES_KOEPF` placement and the
  options from `proto/layout.ts:88-112`. Without the overlay it is 20 parts and 26 lines.
- **Clusters (variant E) with every block opened.** The same 42 parts and 83 lines in 2 boxes,
  with every line labelled by its count. `NETWORK_SIMPLEX` placement, as `proto/layout.ts`
  uses outside the locked layout.

All [measured]:

| Graph | Where | First layout, median (p95) | Relayout, median | Relayout, p95 | n |
|---|---|---:|---:|---:|---:|
| Locked top level | Chromium worker | 611 ms (907) | 262 ms | 440 ms | 100 |
| Locked top level | Node | 810 ms (max 1,219) | 204 ms | 378 ms | 40 |
| Locked top level, no overlay (20 parts, 26 lines) | Node | — | 62 ms | 132 ms | 40 |
| Clusters, one block open (14 parts, 1 box, 28 labelled lines) | Node | — | 299 ms | 473 ms | 40 |
| Clusters, all open | Chromium worker | 4,492 ms (4,817) | 3,168 ms | 3,989 ms | 30 |
| Clusters, all open | Node | 4,250 ms (max 4,824) | 3,151 ms | 3,900 ms | 40 |
| Clusters, all open, no labels | Node | — | 1,153 ms | 1,433 ms | 20 |
| Clusters, all open, `BRANDES_KOEPF` | Chromium worker | 1,401 ms (1,711) | 773 ms | 1,354 ms | 30 |
| Clusters, all open, `BRANDES_KOEPF`, no labels | Node | — | 385 ms | 549 ms | 20 |

What this says:

- **The worker matches Node.** ELK runs at the same speed in a Chromium worker as in Node.
  Moving it off the main thread keeps the page responsive, but each result arrives no sooner
  **[measured]**.
- **Placement and labels dominate.** On the same 42-part graph, `NETWORK_SIMPLEX` with labels
  is 15× the locked layout's time. Switching to `BRANDES_KOEPF` cuts it 4×, and dropping labels
  roughly halves what's left **[measured]**.
- **Clusters, as prototyped, can't relayout per click with ELK.** It needs different options,
  or a layout of its own **[inferred]**.
- **The earlier numbers fit.** The prototype's main-thread 250–440 ms for about 26 nodes with a
  group box matches the one-block-open Clusters row above.
- **These were measured on a loaded host** (load 34–43 on 32 threads). An idle desktop would be
  faster, but by an unmeasured factor, and the ordering would not change **[inferred]**.

## 3. Alternatives

Abbreviations in the table: **R1–R6** are the rules in the order listed at the top: layered left
to right, orthogonal, spaced parallels, around nodes, labels with space, compound. **Fix-ups**
says whether the prototype's three post-ELK fix-ups would still be needed: lifting blocks to the
top, flattening U-turns, and correcting 1e-13 point noise.

Sizes are the main browser bundle, brotli 11, from `npm pack` tarballs (not executed)
**[measured]**. Licences come from `npm view` or crates.io plus the repo's `LICENSE`
**[source]**. Rule judgements cite the engine's docs or source.

| Engine | Licence | Size (brotli) | Rules met natively | Maintained | Fix-ups |
|---|---|---:|---|---|---|
| elkjs 0.12.1 | EPL-2.0 OR GPL-3.0-or-later | 355 KB | R1–R6 | Yes: release 2026-10-28, commits weekly | All three still needed |
| `elk-layout` / `@openedges/elk-layout` 0.12.2 (Rust port of ELK 0.12, wasm or native) | EPL-2.0 OR GPL-3.0-or-later | 1.1 MB (wasm) | R1–R6, claimed | New: repo from 2026-02, 10 stars | Same engine, so the same fix-ups [inferred] |
| @dagrejs/dagre 3.1.3 | MIT | 16 KB | R1. R5 partly (label space, but on polylines). R6 partly | Yes: 2026-10-24 | n/a without a router |
| d3-dag 1.3.0 | MIT | 39 KB | R1 only (no compound, no labels) | Yes: 2026-11-01 | n/a |
| dagre + libavoid-js 0.4.5 / 0.5.0-beta | MIT + LGPL-2.1-or-later | 16 + 20 JS + 146 wasm KB | R1–R4. R5 no. R6 by hand (group as non-obstacle or pins) | libavoid-js active (beta line); adaptagrams last commit 2025-10 | Lift: yes. U-turns: unlikely. Float noise: possible [inferred] |
| WebCola 3.4.0 (GridRouter) | MIT | 20 KB | R2–R4, R6 partly; not layered, no labels | No: last release 2019 | n/a |
| Graphviz 16.1 via @viz-js/viz 3.31 / @hpcc-js/wasm-graphviz 1.30 | Wrappers MIT / Apache-2.0; the Graphviz inside is EPL-2.0 | 378 KB / 632 KB | R1, R2, R4. Not R5: "the routing does not handle ports or, in dot, edge labels" ([graphviz.org/docs/attrs/splines](https://graphviz.org/docs/attrs/splines/)). R3 and clusters with ortho unverified | Yes | Lift: yes; labels unsolved |
| MSAGL-JS (`@msagl/core` 1.1.25) | MIT | 164 KB | R1–R4 (layered, then the rectilinear router with a nudger). R5 weak (labels placed after routing). R6: subgraphs laid out first, then edges lifted, not one pass | Yes: release 2026-11-17, Microsoft | Unknown; needs a prototype [inferred] |
| JointJS core (Manhattan router) | MPL-2.0 | 122 KB | R2, R4; routes each link alone, no shared nudging (R3 not met) | Yes | n/a |
| yFiles for HTML | Commercial, from €9,200 / $11,000 a year per developer | not measured | All six, per its docs (not read first-hand) | Yes | Unknown |
| Rust: layout-rs 0.1.3, rust-sugiyama 0.4, dugong 0.10 (a dagre port) | MIT / MIT / MIT OR Apache-2.0 | server-side | R1 only; no ortho router, no compound boxes | Mixed | n/a |
| Rust: `ortho-router` 0.1.1 | MIT OR Apache-2.0 | server-side | R2–R4 (routing round rectangles, nudging) | New, 2026-10, tiny | Would pair with a placement we write |
| ELK Java on a JVM sidecar | EPL-2.0 OR GPL-3.0-or-later | server-side | R1–R6 | Yes | All three; plus a JVM in the image |
| Hand-written layered layout + orthogonal router | Ours (AGPL, or whatever the owner picks) | a few KB [inferred] | Whatever we build | Ours | Avoided by construction [inferred] |

Notes behind the table:

- **dagre doesn't route orthogonally.** Edge `points` are "control point coordinates for the
  edge" ([dagre wiki](https://github.com/dagrejs/dagre/wiki)). In source they are dummy-node
  positions plus boundary intersections (`lib/layout.ts`, `assignNodeIntersects`). Issue #111
  asks for Manhattan routing and is open **[doc, source]**.
  - Compound nodes work via `setParent`.
  - Edges to a compound node itself fail: issues #236, #238 and #525 are open **[source]**.
  - Its label handling makes rank space for a label node mid-edge (`makeSpaceForEdgeLabels`)
    **[source]**. So a dagre-based pipeline gets label space only if the router keeps the
    label's horizontal stretch where dagre reserved it **[inferred]**.
- **d3-dag** lists compound graphs as unsupported, and its dagre shim accepts labels "for dagre
  compatibility but not used" **[doc, source]**.
- **libavoid** (adaptagrams) routes orthogonal connectors around fixed shapes and nudges shared
  segments apart. `idealNudgingDistance` defaults to 4, and there is
  `nudgeOrthogonalSegmentsConnectedToShapes` (`cola/libavoid/router.h:151-190`) **[source]**.
  - It never moves nodes, so the gaps between layers must be sized for the routing channels
    beforehand **[inferred]**.
  - It is LGPL-2.1-or-later. Monash offers a commercial licence (header of `router.h`)
    **[source]**.
  - The LGPL in a separately loaded wasm file is workable on a closed path, since users can
    swap the file. Under AGPL it is compatible **[inferred]**.
  - JointJS's `@joint/router-avoid` pairs it with dagre placement and runs it in a worker
    **[doc]**.
- **MSAGL-JS** (`modules/core/src` @51ec8f71):
  - With `EdgeRoutingMode.Rectilinear`, `LayeredLayout` skips its spline routing
    (`layout/layered/layeredLayout.ts:129`), and the driver runs `RectilinearEdgeRouter` with a
    `Nudger` (`layout/driver.ts:150-151, 308-318`) **[source]**.
  - Labels are placed after routing by `EdgeLabelPlacement` (`driver.ts:320`), so no space is
    reserved for them **[source, inferred]**.
  - Since the top level has no labels (#144, rule 5), this matters only for zoomed views and
    Clusters' counts **[inferred]**.
- **Other ports of ELK layered.** `elkrs` (Apache-2.0, a "byte-exact" claimed rewrite of ELK
  0.11), `merman-elk-layered` (EPL-2.0), and a TypeScript `ggn-layout` all exist. Each is
  months old with almost no users. A port of EPL code relabelled Apache-2.0 should be treated
  as EPL **[source, inferred]**.

### What a layout we control would take

The PR view's graphs are narrower than ELK's general case **[inferred, from #144's rules and
`proto/layout.ts`]**:

- **Fixed columns.** At the top level, compound nodes are columns in a known order: people,
  then changed, then unchanged, then external. They are not arbitrary nesting.
- **Labels.** The top level has none. Zoomed views and Clusters carry short labels.
- **Size.** Graphs are 20–170 nodes and up to about 250 edges.

A layered layout for that needs four parts [inferred]:

1. **Layers.** Longest-path or network-simplex ranking inside each column.
2. **Order within layers.** Barycentre sweeps to cut crossings.
3. **Coordinates.** Assign them with the blocks pinned to the top, as #144's rule 3 wants, so
   no lift is needed.
4. **Orthogonal routing.** Route between layers in channels, and order the vertical segments in
   each channel so parallel lines are spaced and U-turns can't arise. Use integer coordinates,
   so there is no 1e-13 noise.

ELK's own layered pipeline is the reference design for steps 2–4, but copying its code would
bring its licence with it **[inferred]**. This is the only option that removes all three
fix-ups and the licence question together, and it would be far smaller than 355 KB. The cost is
building and testing it; nothing here measures that.

## 4. Laying out on the server

An analysis is uploaded once, and only the latest is kept, so layouts can be keyed by
(analysis, view key) and cached until the next upload **[inferred, from the #142 brief]**. What
relayouts in the prototype:

| View | What triggers a layout | Static per analysis? |
|---|---|---|
| Locked layout (A) | lens (4), Show (3), the lone-parts toggle (2), the zoom target (top level or any part) (`proto/main.tsx:1232-1290`) | Yes. A finite key, computed on first view or at upload. Hover, selection and the glide don't relayout |
| Clusters (E) | every open or fold of a block (`proto/explore.tsx:620-700`) | Finite (2^blocks open sets per lens), but every click needs the result at once |
| Path (G) | none: columns placed by hand | n/a |

**Fit.**

- **The locked layout suits the server.** It has no labels at the top level, so the server
  doesn't need to know the browser's font metrics. The prototype measures label widths with a
  canvas in the page font (`proto/layout.ts:62-70`) **[source]**. Labels in zoomed views would
  need fixed width estimates or a font metrics table on the server **[inferred]**.
- **Clusters is a poor fit.** Each open becomes a server round trip, and with ELK each costs
  the server 0.3–3 s of CPU (§2) unless the open sets are precomputed at upload. 2^blocks times
  4 lenses is small, but each is a full layout **[inferred]**.
- **Where the view logic lives.** The view model (lenses, Show, roll-ups) lives in the client.
  The simplest server design is a layout endpoint the client posts its graph to, cached by a
  hash of that graph, rather than moving the view model into Rust **[inferred]**.
- **Engines.**
  - **`elk-layout` (Rust ELK port):** EPL-2.0 OR GPL-3.0-or-later, young, and it needs a
    `deny.toml` exception.
  - **ELK Java sidecar:** a JVM in the image.
  - **A layout we write in Rust:** the §3 design, with no licence question, and tested through
    the server's HTTP surface.
- **What it saves.** It removes the 355 KB worker chunk and the 0.3–0.5 s worker start for
  every viewer **[inferred]**.
- **Licence.** Under the EPL, nothing ELK-derived reaches the browser, so nothing is
  distributed. Under the GPL route, AGPL §13 covers the combination regardless (§1)
  **[inferred]**.

## Not measured or not verified

- **Bundle bytes after Vite's own minifier.** Not measured, and nor is whether Vite keeps or
  drops elkjs's header comment.
- **ELK on an idle machine.** Every time above is from a host at load 34–43.
- **Server-side times.** The `elk-layout` Rust port was not built or timed, so neither were
  server-side layout times. Its claimed parity with ELK is unverified.
- **Prototype layouts not run.** MSAGL-JS, dagre + libavoid, and Graphviz ortho were not run on
  #2627's graphs. Their rule coverage comes from docs and source only, and whether they'd need
  the fix-ups is inferred.
- **yFiles' features.** Taken from search summaries of its docs, not read first-hand.
- **Legal readings, for counsel if the owner wants certainty:**
  - whether an AGPL combination can invoke the GPL Secondary License
  - whether a page plus a separately loaded worker script is one "combined work"
- **The Eclipse EPL FAQ is rendered by JavaScript.** It was read through a headless browser on
  2026-11-17; its entry numbers may shift.
