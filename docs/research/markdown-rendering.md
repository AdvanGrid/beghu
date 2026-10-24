# Markdown rendering for bodies and comments

Research date: 2026-10-24. Ticket: [#59](https://github.com/tomsjansons/beghu/issues/59).

**Stack as settled:**
- An axum server with a per-account SQLite mirror. It's fed by webhooks and a GraphQL import, and
  bodies and comments are stored as raw Markdown.
- A Solid 2 RC SPA, with no SSR and no store in the browser.
- StyleX with no global stylesheet. Anything StyleX can't express goes in a reviewed `escape.css`.
- `light-dark()` color tokens.

**Budgets:**
- ≤ 14 KB per API response. Whether that's raw or compressed is open in another ticket, so both
  are given.
- Cold first load ≤ 48 KB gzipped. Today it's 43.8 KB.

The detail prototype ([#54](https://github.com/tomsjansons/beghu/issues/54), branch
`proto/issue-detail`, `list-prototype/server/src/main.rs:697-792`) folds long threads by bytes. It
keeps the first comment and as many of the newest as fit `COMMENT_BUDGET = 12_000` raw JSON bytes.
So the representation's size decides how many comments a detail response carries.

**Sources and tags:**
- **Sources:**
  - Crate sources in `~/.cargo/registry/src/index.crates.io-*/`, written as `<crate>-<ver>/<path>`.
  - npm package sources in `bench/candidates/markdown-probe/js/node_modules/`, written as `nm/…`.
  - The GFM spec and cmark-gfm's test files.
  - docs.github.com, and GitHub's OpenAPI description (`github/rest-api-description`).
  - The StyleX and Shiki docs.
- **Tags:** each claim is tagged **[source]** (read in code or a spec), **[doc]**, **[measured]**
  or **[inferred]**.
- **Measurements:** the scripts are in
  [`bench/candidates/markdown-probe`](../../bench/candidates/markdown-probe/README.md) (throwaway,
  untracked).
- **Host:** the bench host (Xeon E5-2695 v4, 32 threads), shared and busy (load average 4–20 during
  runs), so p95s are noisy.
- **Browser:** Chromium 156 under Playwright 1.64, with CDP `Emulation.setCPUThrottlingRate`, as in
  `bench/harness/run.mjs:101`.

**Corpus.** Six real public issues with 616 comments, fetched with REST
`application/vnd.github.full+json`:

| Issue | Comments |
|---|---|
| rust-lang/rust#38356 | 184 |
| vitejs/vite#11468 | 192 |
| nodejs/node#37061 | 157 |
| tokio-rs/tokio#1879 | 50 |
| oven-sh/bun#15087 | 17 (task lists) |
| microsoft/vscode#336320 | 16 (images) |

The corpus also includes one 30-comment thread from the bench fixture, `mirror-20k.db`. The
fixture's text is mostly plain prose, so it says little about Markdown cost.

## Answers

1. **Render on the server with comrak, and send a compact AST rather than HTML.** The client walks
   the AST into DOM elements and adds StyleX classes. It needs no parser and no sanitiser, only a
   0.6 KB walker (gzipped) **[measured]**. That walk is as fast as `innerHTML` of the same content.
   At 6× throttle it takes 70–76 ms (sync, p50) for a budgeted detail **[measured]**.
2. **Don't parse Markdown in the browser.** `micromark` + GFM + DOMPurify costs 33 KB gzipped
   **[measured]**. That alone pushes first load past 48 KB unless it's lazy, and it takes
   350–550 ms (p50) at 6× on a budgeted thread. `marked` + DOMPurify is 26 KB and 190–300 ms, and
   it passes fewer spec examples **[measured]**.
3. **Don't use GitHub's `body_html`.**
   - Webhooks don't carry it [source], so every edit would need an extra fetch.
   - It's 2.1× the bytes of Markdown, and 1.3× gzipped [measured].
   - Its private images expire in 300 s [measured].
   - Its `issue-link` anchors carry no title or state, and they reflect what the importing token
     could see [measured].
   - It's full of GitHub-specific markup (`pl-*` highlight classes, custom elements, inline
     `style`, inline SVG) that still needs sanitising and doesn't fit StyleX [measured].
4. **Highlight code on the client, lazily, with highlight.js.** Map its token classes to StyleX
   class names by string replacement, so it needs no theme stylesheet and no `escape.css`. Core
   plus the ten languages is **21.4 KB gzipped as one chunk, not the 8 KB quoted in #54**
   [measured]. It loads only when a fenced block in a known language is on screen. Colouring
   didn't move layout in the test [measured].
5. **References and images need passes beyond GFM.** No Markdown library links `#123` or `@user`.
   Images in private repos (`github.com/user-attachments/assets/…`) need an authenticated server
   redirect [measured].

## 1. Which GFM features v1 needs

GitHub renders user content with cmark-gfm. The GFM spec covers "the dialect … currently supported
for user content on GitHub.com". It also says GitHub "perform[s] additional post-processing and
sanitization after parsing", and the references, mentions and alerts come from that step
(`spec/spec.txt:13-25`) **[source]**. What GitHub's output actually contains, from the corpus and
from a `POST /markdown` render of every feature (`github/probe.md` → `probe.html`) **[measured]**:

| Feature | In the spec? | GitHub output | v1 |
|---|---|---|---|
| Tables, strikethrough, autolinks (`www.`, bare URLs), tagfilter | yes (extensions) | standard; tables wrapped in a `<markdown-accessiblity-table>` custom element | yes; all of comrak's spec-tested extensions |
| Task lists | yes (extension; examples marked `disabled` in the test file, `spec.txt:5108`) | `<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled class="task-list-item-checkbox" checked>` | yes, read-only. Toggling means editing the Markdown source by position (open question) |
| Fenced code with language | yes | already highlighted: `<div class="highlight highlight-source-rust …" data-snippet-clipboard-copy-content=…><pre><span class="pl-k">` | yes, colours from #54. 149 fenced blocks in the corpus, 79 with a language, 74 of them in #54's ten languages **[measured]** |
| `#123`, `GH-123`, `owner/repo#123`, issue URLs | no (post-processing; [autolinked references](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)) | `<a class="issue-link js-issue-link" data-url=… data-hovercard-type="issue" href="https://github.com/o/r/issues/1">#1</a>`, with no title or state. A nonexistent number stays plain text, and so does a private target the renderer can't see | yes, our own pass (below) |
| `@user` | no (post-processing) | `<a class="user-mention notranslate" data-hovercard-type="user" href="https://github.com/x">@x</a>` | yes, our own pass. Team mentions (`@org/team`) weren't linked in the probe |
| Footnotes | no (GitHub extension) | `<sup><a href="#user-content-fn-1-<hash>" data-footnote-ref>`, plus `<section data-footnotes class="footnotes">` | yes. Ids need a per-comment prefix, because many comments share one page |
| Alerts `> [!NOTE]` | no ([basic syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax): five types, not nestable) | `<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title"><svg class="octicon …">…</svg>Note</p>` | yes; comrak has `extension.alerts` (`comrak-0.57.0/src/parser/options.rs:270-282`) |
| Raw HTML | yes, filtered by tagfilter | sanitised: `script` and `iframe` escaped, `on*` and `style`/`class` dropped, user `id` → `user-content-…`; `details/summary`, `kbd`, `sub/sup`, `picture/source` and `div align` kept | yes, through an allowlist (§2) |
| Images | yes | external images go through camo (`camo.githubusercontent.com/<hmac>/<hex>`, inline `style="max-width:100%"`); `user-attachments` → `private-user-images.githubusercontent.com/…?jwt=` | yes, rewritten (below) |
| Emoji `:+1:` | no | plain Unicode, no `g-emoji` | comrak `shortcodes` exists (`options.rs:359`); low priority |
| Mermaid, math | no | `<section class="js-render-needs-enrichment" data-src=…viewscreen…>`, `<math-renderer>`; both need GitHub's JS | not v1: show the source as a code block |
| Per-repo custom autolinks | no | configured per repo (autolinked references doc) | not v1; a local renderer can't know about them |

**References: synced repo vs stub [inferred].**
- The renderer emits a reference node, `["ref", {o, r, n}]` for an issue or `["ref", {u}]` for a
  user. It doesn't emit a finished link, because the target depends on mirror state that changes
  after the comment was written.
- The client already knows which repos the account syncs. For a synced repo it links to the
  in-app issue route. For anything else it links out to `https://github.com/o/r/issues/n` with the
  stub treatment ("not synced").
- Bare `#123` resolves against the comment's own repo.
- Unlike GitHub, we can't tell whether `#999999` exists in an unsynced repo. Within synced repos
  the server could check the mirror (open question).

**Images in private repos need auth.**
- GitHub's changelog: "Future attachments associated with private repositories can only be viewed
  after logging in" ([2023-05-08](https://github.blog/changelog/2023-05-08-more-secure-private-attachments)) **[doc]**.
- Measured on a private repo the owner has, read-only **[measured]**:
  - The raw `github.com/user-attachments/assets/<uuid>` returns **404 without auth**.
  - With an OAuth token it returns **302 to S3 with `X-Amz-Expires=300`**.
  - The same URL from a public repo returns 302 without auth.
- The `private-user-images` URL in `body_html` carries a JWT. Its payload is
  `{"aud":"raw.githubusercontent.com","exp","nbf","path"}`, with `exp − nbf = 300 s` and no user
  in it. It loads for anyone for 5 minutes, then returns 404 **[measured]**.
- So an `<img>` on our origin can't load a private attachment directly. The browser doesn't send
  the user's github.com login, and stored `body_html` URLs die in 5 minutes.
- The fix is to rewrite `user-attachments` URLs to an app route, for example
  `/api/attachments/<uuid>`. The server requests GitHub with its token and passes GitHub's 302 on
  to the browser. The bytes never go through our server **[inferred]**.
- comrak has an `image_url_rewriter` hook for this (`options.rs:519`) **[source]**.

## 2. Server-side vs client-side rendering, sanitisation, spec compliance

**Spec compliance, measured.**
- **Method:** all 670 non-disabled examples of cmark-gfm's `test/spec.txt` (GFM 0.29, commit
  27d942c), scored with cmark-gfm's own `normalize.py`. Every renderer ran with its GFM options and
  raw HTML on (`spec/score.py`, `spec/common.py`) **[measured]**.
- **Harness artifacts:** the `autolink`-tagged examples expect the extension on and the four plain
  "Autolinks" examples 610/616/619/620 expect it off. One always-on configuration therefore fails
  those four. The emphasis examples 398, 426, 434–436 and 473–477 encode cmark-gfm quirks, which
  comrak reproduces only with `render.gfm_quirks` (`options.rs:1250-1260`) **[source]**.

| Renderer | Passed | Fails that aren't the 4 autolink-off examples |
|---|---|---|
| **comrak 0.57.0** (`gfm_quirks`) | **665/670** | 1. tagfilter (652): the extension was removed in 0.56 ("It's bad. Don't use it.", `comrak-0.57.0/CHANGELOG.md:56`) **[source]** |
| micromark 4.0.3 + gfm 3.0.0 | 652/670 | the 10 quirk examples; 4 HTML blocks (`<script>`/`<style>`/`<textarea>` blocks escaped by tagfilter); 1 autolink |
| markdown-rs 1.0.0 (`Options::gfm()`) | 651/670 | same as micromark, plus one HTML block (it's micromark's Rust port) |
| marked 18.1.1 | 647/670 | quirks; 5 entity refs; tagfilter; tabs; 1 autolink |
| markdown-it 15.0.3 (`linkify`) | 646/670 | quirks; 8 of 11 autolink-extension; tagfilter; 1 table; 1 strikethrough |
| pulldown-cmark 0.13.5 | 626/670 | **0/11 autolink extension**: there is no GFM autolink option (`pulldown-cmark-0.13.5/src/lib.rs:651-735`); 15 emphasis; raw HTML; link refs |

comrak's README claims 670/670 GFM and 652/652 CommonMark (`comrak-0.57.0/README.md:4-5`), and
markdown-rs claims "100% GFM" (`markdown-1.0.0/README.md:18-21`) **[source]**.

**Throughput** over all 653 corpus docs (418 KB of Markdown), best of 20 runs (Rust) or 5 (Node)
**[measured]**:

| Renderer | Time | Throughput |
|---|---|---|
| pulldown-cmark | 3.0 ms | 143 MB/s |
| comrak | 6.5 ms | 66 MB/s |
| markdown-rs | 96 ms | 4.5 MB/s |
| ammonia `clean` on comrak's HTML | 16 ms | |
| marked | 46 ms | 9.4 MB/s |
| markdown-it | 63 ms | 6.8 MB/s |
| micromark + gfm | 747 ms | 0.57 MB/s |
| mdast + gfm → hast | 726 ms | 0.59 MB/s |

So on the server comrak + ammonia render the 12 KB a detail response carries in well under 1 ms.
Rendering per request instead of storing the output is cheap **[inferred from measured]**.

**Sanitisation.**
- **Server.** ammonia 4.2.4 (html5ever-based) has an allowlist builder. It adds
  `rel="noopener noreferrer"` to links by default and limits URL schemes
  (`ammonia-4.2.4/src/lib.rs:74, 364-488`) **[source]**. The probe's allowlist is ammonia's
  defaults plus task-list `input`, `code.language-*`, alert `div`/`p` classes and footnote ids and
  sections (`rs/src/main.rs`). It strips `<script>` and `onerror` **[measured]**.
- **Client.** DOMPurify 3.4.17 is 12.1 KB gzipped. hast-util-sanitize (the core of
  rehype-sanitize) is 3.5 KB, and its default schema "follows GitHub style sanitation"
  (`nm/hast-util-sanitize/lib/schema.js:11`) **[source, measured]**.
- **What GitHub itself drops.** github/markup says the HTML "is sanitized, aggressively removing …
  `script` tags, inline-styles, and `class` or `id` attributes". The public descendant of GitHub's
  allowlist is `html-pipeline`'s `sanitization_filter.rb` **[doc]**. That's the reference for which
  tags v1 keeps.
- **With the compact AST there is one trust boundary.** The server sanitises with ammonia, then
  serialises. The client's walker is a second allowlist: it creates only known tags and copies
  only known attributes, and should also re-check `href`/`src` schemes. Nothing is ever parsed as
  HTML in the browser **[inferred]**.

## 3. GitHub's `body_html` / `bodyHTML`

- **Fetching.** REST `application/vnd.github.html+json` returns `body_html`, and `full+json`
  returns `body`, `body_text` and `body_html`
  ([issue comments](https://docs.github.com/en/rest/issues/comments)) **[doc]**. GraphQL `bodyHTML`
  is byte-identical to REST `body_html` apart from the JWTs (vite#11468, 99,842 B each)
  **[measured]**. A public issue renders the same with and without a token, apart from the JWT
  **[measured]**.
- **Contents.**
  - The markup in the table in §1.
  - Code arrives pre-highlighted (3,340 `pl-*` spans in the corpus).
  - `dir="auto"` on nearly every block.
  - `data-hovercard-*` and `data-octo-*` attributes, inline octicon SVGs (about 0.5 KB per alert),
    custom elements, and inline `style` on images **[measured]**.
- **Whether it fits StyleX.** It doesn't. Styling it needs `pl-*`, `markdown-alert-*` and
  `task-list-*` rules in `escape.css`, or a client pass that rewrites every class, and it still
  has to be sanitised again (inline `style`, `svg`, `js-*` hooks) **[inferred]**.
- **Webhooks don't carry it.** In GitHub's OpenAPI `x-webhooks`, `webhook-issue-comment-created`'s
  `comment` has `body` and no `body_html` or `body_text`. `webhook-issues-edited` `changes` has
  only `{body, title}`. Source:
  [`descriptions/api.github.com/api.github.com.json`](https://github.com/github/rest-api-description)
  **[source]**. Keeping HTML current would cost one REST GET per created or edited event, or a
  batched `nodes(ids:)` refetch.
- **Import cost.**
  - GraphQL points count connections only
    ([rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api))
    **[doc]**, and every shape tried cost 1 point **[measured]**.
  - `bodyHTML` makes GitHub slower to answer, though: a page of 50 issues × 100 comments on
    nodejs/node took 9.7 s with `bodyHTML` against 2.7 s with `body`.
  - Pages of 100 × 30 and 100 × 100 with `bodyHTML` hit the roughly 10 s timeout, which "deducts
    additional points" **[doc, measured]**.
  - Pages would have to shrink about 2–3.5×, so the ~850-point import would cost proportionally
    more points.
  - Response bytes on that page: 357 KB with `body`, 668 KB with `bodyHTML`, and 126 vs 153 KB
    gzipped **[measured]**.
- **Visibility.** References in `body_html` render as links only if the rendering token can see
  the target. An unauthenticated render of a private-repo reference was plain text, and an
  authenticated one was an `issue-link` **[measured]**. HTML cached at import would show what the
  importer could see, not what the viewer can.

## 4. Bytes: bundles and payloads

**Client bundles.** esbuild 0.28 output (`--bundle --minify --format=esm`), gzip -9
(`js/size.sh`) **[measured]**:

| Bundle | min | gzip | brotli |
|---|---|---|---|
| compact-AST → DOM walker (the recommendation) | 1.0 KB | **0.6 KB** | — |
| marked (GFM built in) | 46.5 KB | 13.8 KB | 12.7 KB |
| micromark + micromark-extension-gfm (HTML out) | 75.0 KB | 21.4 KB | 18.8 KB |
| mdast-util-from-markdown + gfm + mdast-util-to-hast | 97.0 KB | 27.8 KB | 24.6 KB |
| markdown-it + task-lists + footnote | 107.2 KB | 44.1 KB | 38.9 KB |
| unified + remark-parse/gfm + remark-rehype + rehype-sanitize/stringify | 164.5 KB | 50.1 KB | 44.0 KB |
| DOMPurify 3.4.17 | 31.2 KB | 12.1 KB | 10.8 KB |
| hast-util-sanitize | 8.4 KB | 3.5 KB | 3.1 KB |

Any client parser plus a sanitiser costs at least 26 KB gzipped. That's more than the 4.2 KB of
headroom under 48 KB, so it would have to be a lazy chunk on the detail route.

**Payloads.** Each thread is serialised as a JSON array of body + comments, in the forms below
(`js/sizes.mjs`) **[measured]**. "fits" counts the comments that fit the prototype's 12,000-byte
rule (first + newest).
- **md:** raw Markdown.
- **html:** comrak + ammonia.
- **ast:** compact AST: `[tag, attrs|0, ...children]`, with text as plain strings and whitespace
  between blocks dropped.
- **+hl:** with highlight.js spans in the code blocks.
- **hast:** `mdast-util-to-hast` JSON without positions.
- **gh:** GitHub `body_html`.

Totals over the six real threads, summing each thread's array:

| Form | Raw | ×md | gzip | ×md | brotli |
|---|---|---|---|---|---|
| md | 425 KB | 1.00 | 129 KB | 1.00 | 107 KB |
| html | 477 KB | 1.12 | 132 KB | 1.03 | 109 KB |
| html+hl | 522 KB | 1.23 | 136 KB | 1.05 | 111 KB |
| **ast** | **482 KB** | **1.13** | **132 KB** | **1.03** | 109 KB |
| ast+hl | 530 KB | 1.25 | 135 KB | 1.05 | 111 KB |
| hast (verbose) | 923 KB | 2.17 | 146 KB | 1.14 | 116 KB |
| gh body_html | 904 KB | 2.13 | 167 KB | 1.30 | 130 KB |

Comments that fit the 12 KB rule, and the size of the whole budgeted response (body + kept
comments):

| Thread | md fits | ast fits | hast fits | gh fits | ast response raw / gz |
|---|---|---|---|---|---|
| rust#38356 (184) | 29 | 23 | 12 | 12 | 17.4 / 5.1 KB |
| vite#11468 (192) | 13 | 12 | 5 | 6 | 15.1 / 5.0 KB |
| node#37061 (157) | 25 | 24 | 12 | 8 | 14.1 / 4.7 KB |
| tokio#1879 (50) | 13 | 12 | 8 | 10 | 18.6 / 6.5 KB |
| fixture (30) | 18 | 18 | 12 | — | 12.5 / 3.8 KB |

What the payload numbers show **[inferred from measured]**:
- The compact AST costs about 13% raw and 3% gzipped over Markdown. On a raw budget that means one
  to six fewer comments per detail. Verbose hast and `body_html` halve what fits.
- Every budgeted response is 3.8–6.5 KB gzipped. On a compressed budget a detail could carry two
  to three times more comments.
- The responses exceed 14 KB raw because the body isn't counted in the 12,000 bytes. That's a
  property of the prototype's rule, not of the form.
- Reference nodes (`["ref",{o,r,n}]`) weren't in the measured AST, because comrak's HTML has no
  reference links. They're about the size of the text they replace.

## 5. Code highlighting

Highlighters, measured on the corpus's 74 fenced blocks in #54's ten languages (43.2 KB of code),
with bundles as in §4 (`js/hl-speed.mjs`) **[measured]**:

| Highlighter | Bundle gzip (core + 10 langs) | Speed (Node) | Token API |
|---|---|---|---|
| **highlight.js 11.12** | **21.4 KB** (core 8.6; langs 0.3–4.4 each, 17.7 KB as separate chunks) | 13.8 ms (3.2 MB/s) | HTML string of `<span class="hljs-…">`; the token tree `_emitter` is private (`nm/highlight.js/types/index.d.ts:107,151`) |
| Prism 1.30 | 13.2 KB | 19.5 ms (2.3 MB/s) | public `Prism.tokenize` → token stream (`nm/prismjs/components/prism-core.js:670-690`) |
| Shiki 4.5 + JS regex engine | 128.6 KB (core + engine alone 53.8 KB) | 179 ms (0.25 MB/s) | `codeToTokens`; the JS engine is "strict by default" and wants the RegExp `v` flag ([docs](https://shiki.style/guide/regex-engines)) |
| lezer (only JS + Rust parsers) | 75.8 KB | — | `highlightCode(code, tree, highlighter, putText, putBreak)` (`nm/@lezer/highlight/dist/index.js:332-338`) |
| syntect 5.3 (Rust, `default-fancy`, class spans) | +2.6 MB stripped server binary | 145 ms for the 64 blocks it knows (no TypeScript among its 75 default syntaxes) | **293 KB of HTML for 43 KB of code** (a nested class per scope) |

On the Rust side, `autumnus` is marked "DEPRECATED - Use `lumis` instead". lumis, inkjet and
tree-sitter-highlight build tree-sitter grammars (C) into the server (crates.io descriptions)
**[doc]**. They weren't measured.

**Where it runs.**
- **On the server.** highlight.js-style spans add about 10% raw and 2.5% gzipped (html → html+hl
  above), and cost a comment or so per budgeted detail. The only good server highlighters are
  tree-sitter ones, which are a build-and-binary cost. syntect's output is far too big for the
  budget unless re-encoded **[inferred from measured]**.
- **On the client.** Lazily, only once a block in a known language renders (as #54 does). On the
  budgeted rust#38356 view it took 0.9 ms at 1× and 8.8 ms at 6×. Expanding all 185 comments
  (29 blocks) took 141 ms at 6× **[measured]**.

**Correction to #54.** highlight.js core plus the ten languages is 21.4 KB gzipped as one chunk,
not 8 KB. 8.6 KB is the core alone **[measured, same version 11.12.0]**. Loading only the
languages a page uses, as separate chunks, keeps a typical Rust- or TS-only thread near 10–12 KB.

**Fitting it to StyleX without a theme sheet [inferred].**
- highlight.js output is the input code, escaped, plus `<span class="hljs-X">`. Before inserting
  it, replace each `hljs-X` with the class string of a StyleX style. For example, `TOK.keyword` is
  `stylex.props(tok.kw).className`, and `tok.kw` is `{ color: colors.hlKeyword }`, where
  `colors.hlKeyword` is a `light-dark()` var in `tokens.stylex.ts`.
- About eight kinds cover the prototype's `app.css` mapping. Anything unmapped stays the default
  foreground.
- No `escape.css` is needed. `innerHTML` is acceptable here because the string is
  highlight.js's own escaped output, not user HTML.
- StyleX can't target descendants that carry no StyleX class: `stylex.when.ancestor` styles "an
  element based on the state of an ancestor", and that element must itself carry the style
  ([docs](https://stylexjs.com/docs/api/javascript/when/)) **[doc]**.

**No text shift.**
- Colour doesn't affect layout. Rendering rust#38356 (41 `pre`, 579 token spans) and colouring it
  left every `pre` box and the page height identical. That held with colour-only rules, with
  italic comments and with bold keywords, in the host's fallback monospace (`web/shift.mjs`)
  **[measured]**.
- Bold and italic can change advances in some fonts, so token styles should be colour-only
  **[inferred]**.

## 6. Rendering in Solid with StyleX: `innerHTML` vs AST

Each run renders a fresh root with one `<div>` per comment.
- **sync** is render + forced layout.
- **frame** runs until the next frame.
- Tags carry a precomputed class string per tag, standing in for `stylex.props`, which compiles to
  static class strings.
- 15 iterations, ms p50 / p95 (`web/bench.mjs`, `data/render-timing*.txt`) **[measured]**.
- The rust#38356 budgeted view is 30 items. The vite#11468 budgeted view is 14 items.

| Mode | 1× rust budgeted | 1× rust all 185 | 6× rust budgeted | 6× vite budgeted | 6× rust all 185 |
|---|---|---|---|---|---|
| `innerHTML` of server HTML | 9–11 / 14–17 | 39–45 / 54–56 | 76–82 / 91–99 | 42–51 / 50–71 | 323–326 / 401–452 |
| **compact AST → `createElement`** | **9–13 / 12–16** | **36–38 / 48–52** | **70–76 / 91–95** | **44–49 / 67–75** | **308–319 / 385–421** |
| compact AST → `<Dynamic>` components | 18 / 26 | 58 / 90 | 138 / 202 | 79 / 87 | 526 / 619 |
| client: marked + DOMPurify | 43 / 48 | 168 / 206 | 297 / 403 | 193 / 217 | 1694 / 2003 |
| client: mdast → hast → DOM | 55 / 73 | 238 / 296 | 356 / 451 | 289 / 378 | 2196 / 2618 |
| client: micromark + DOMPurify | 69 / 80 | 321 / 384 | 551 / 744 | 349 / 420 | 3017 / 3372 |

Ranges are across the two runs. The 1× budgeted numbers are near frame granularity.

What the render numbers show **[inferred from measured]**:
- Building the DOM from a compact AST is as fast as `innerHTML`, and it gives every element a
  StyleX class without `escape.css`.
- Solid's `<Dynamic>` per node costs 1.5–1.8×. Comment content is static, so the walker should
  return plain nodes inside one Solid component and swap the subtree when the comment changes.
- A budgeted detail at 6× is near the 100 ms long-task line (p95 91–99 ms on rust#38356). That
  covers rendering only, with no layout chrome. Expanding a whole 185-comment thread is 300–450 ms
  at 6× in either form, so "show folded" should render in chunks that yield between them.
- Client parsing is 4–10× slower than the AST walk.

## Recommendation

**Render on the server with comrak and ship a compact AST that the client maps to DOM nodes with
StyleX classes.**

1. **Store raw Markdown only.** That's what webhooks and the import already carry.
2. **Render per request** in the detail handler with comrak 0.57. Turn on `table`,
   `strikethrough`, `autolink`, `tasklist`, `footnotes` and `alerts`, plus `render.gfm_quirks`.
   Turn on `render.unsafe` and let ammonia own the raw-HTML allowlist, modelled on html-pipeline's.
   This costs well under 1 ms per detail. An optional cache keyed by (comment id, `updated_at`,
   renderer version) is easy, because nothing in the output depends on mirror state.
3. **Run the post-passes on the AST.**
   - `#n` / `owner/repo#n` / issue URLs → `ref` nodes, with links resolved on the client against
     the account's synced repos (in-app route vs GitHub link + stub).
   - `@login` → `ref` user nodes.
   - Rewrite `user-attachments` URLs to an authenticated redirect route.
   - Prefix footnote ids per comment.
   - Show mermaid and math as code.
4. **Client: a ~0.6 KB walker** that creates only allowlisted tags and attributes, checks URL
   schemes, and adds `stylex.props` classes per tag. It isn't a Solid component per node.
5. **Highlight on the client, lazily, with highlight.js.** Load one chunk per language actually
   present, and map `hljs-*` to StyleX token classes by string replacement. Colours are
   `light-dark()` vars, and token styles are colour-only.

**The trade-off it accepts:**
- **Payload.** The compact AST is about 13% larger than raw Markdown (3% gzipped), which means one
  to six fewer comments per detail on a raw 14 KB budget.
- **Server code.** The server owns a sanitiser allowlist, a reference pass and an attachment
  route.
- **Fidelity.** Rendering won't match github.com in every case: no per-repo custom autolinks, no
  existence check for references outside the mirror, and no mermaid or math.
- **Where the server is avoided.** In exchange the browser ships no parser or sanitiser, and the
  first load stays under 48 KB. Rendering is as fast as `innerHTML`. There's no `escape.css` for
  Markdown, and links to synced vs unsynced repos are decided in the app.

## Open questions

- **Budget unit.** Raw vs compressed 14 KB (other ticket). The decision is worth 2–3× the comments
  per detail.
- **Private attachments under a GitHub App installation token.** Do they redirect the way an
  OAuth user token does (measured)? Which token should the attachment route use for a viewer who
  can't see the repo?
- **External images.** Load them directly (the viewer's IP and referrer reach third parties; use
  `referrerpolicy="no-referrer"` and `loading="lazy"`), or proxy them the way camo does?
- **Task-list toggling** in v1. It needs comrak's `sourcepos` in the AST to rewrite the right line,
  plus the body-edit conflict rule from #54.
- **References.** Check existence in the mirror for synced repos (GitHub leaves nonexistent numbers
  as plain text)? Should `@user` link to github.com or to an in-app "by author" view? Team mentions
  are unhandled.
- **Highlight languages.** Is #54's ten-language set enough? The corpus also had python, cpp, toml
  and Caddyfile, and 47% of fenced blocks had no language. Chunk per language or one bundle?
- **Laptop check.** Re-measure render time on the i5-1135G7 laptop. This host was loaded, and the
  6× budgeted p95 sits at about 95 ms against a 100 ms long-task gate.
- **comrak's AST → compact JSON in Rust.** The measured AST was derived from sanitised HTML with
  parse5 in Node. A Rust implementation should produce the same shape, by walking ammonia's output
  with html5ever, but that wasn't built.
