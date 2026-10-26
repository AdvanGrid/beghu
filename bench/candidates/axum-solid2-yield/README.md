# axum + Solid 2 candidate, written with solid-yield (PROTOTYPE)

The [axum + Solid 2 candidate](../axum-solid2/README.md) with its web app ported to
[solid-yield](https://github.com/devagrawal09/solid-yield) (`main` at `29e6082`), for
[Prototype solid-yield for typed pending, failures and contexts](https://github.com/tomsjansons/beghu/issues/45).
Throwaway: it exists to be read and measured, not to start the real app. Verdict: **borrow its
ideas, watch native mode**. Don't build on this.

- `server/`: unchanged from `axum-solid2`.
- `web/`: `solid-js` `2.0.0-rc.15`, solid-yield's three packages vendored as packed tarballs in
  `web/vendor/` (nothing is on npm), TypeScript 6 (typescript-eslint doesn't support 7).
- `web/mistakes/make.py` writes one copy of `App.tsx` per deliberate mistake. Run
  `python3 mistakes/make.py && npx tsc -p mistakes; npx eslint mistakes` in `web/`.

Run it: `./bench/run axum-solid2-yield` from the repo root.

## What the types and the lint catch

| Mistake | Caught by |
|---|---|
| No `Loading` around the list | types: `[PENDING_ROOT]` at `render` |
| A fetch returned from a memo without `attempt` | types (`NeedsAttempt`) |
| A write that may fail, passed to a prop declared `Handler` (never fails) | types |
| `loadMore` reads the list memo, so it may fail with `ListFailed` (a real gap, found while porting) | types |
| A plain `throw` in an event | lint `no-throw` |
| Binding an event that waits on a pending read | lint warning `no-unshown-wait` |
| Tag instead of call, read in the view body, un-yielded setter | lint (dialect rules) |
| No `Errored` around the detail pane | **nothing**: the failure stays in the root's type and is re-thrown |
| `Errored` catching the wrong class | **nothing**, as above |
| `$signal` where `$optimistic` was needed (the chip never shows until the write settles) | **nothing** |

The root's type is `ComponentView<false, ListFailed, …>`: the list and facets have no error
boundary, the same gap as the plain app. Visible only by asking for the type, or with a one-line
"root fails with nothing" assertion. One `Generator<any, …>` in `virtual.ts` had widened every
failure above it to `unknown`, silently.

## Cost of authoring

`App.tsx` 241 → 438 lines, 112 `yield*`. Every component is a call; a signal's field is a hole
function (only props and stores are paths); a memo has no setter, so the writable list memo became
base + extra; plain-Solid reactive state can't enter routine code, so `virtual.ts` was rewritten in
`$signal`/`$event`/`$effect`; an `$event`'s writes are held until it settles, so the optimistic
label is `$optimistic` + `refresh`.

## Speed against axum-solid2

Headline cell (low, far, 20k), 20 iterations, two interleaved pairs on 2026-10-21. ms, p50 / p95.
JS: 35.9 KB gzipped against 24.7 KB.

| | axum-solid2 | axum-solid2-yield |
|---|---|---|
| cold | 876–949 / 970–1055 | 970–1066 / 1059–1202 |
| warm | 755–829 / 831–936 | 865–942 / 988–1097 |
| filter | 187–199 / 222–251 | 194–220 / 237–346 |
| early | 199–203 / 243–259 | 199–212 / 244–266 |
| detail | 295–312 / 326–458 | 303–372 / 351–576 |
| live | 169–174 / 188–202 | 177–191 / 211–212 |
| write | 47–52 / 63–68 | 67–69 / 99–100 |
| scroll frames p95 | 50 | 50–67 |

## Native mode (`proto/sugar-types` at `15992e8`)

Sugar mode was removed on 2026-10-18 (D-127); native mode checks plain Solid 2 as written. Its CLI
over the unmodified `axum-solid2/web` refuses `createMemo(getFacets)` (fine as an arrow) and the
virtualizer's `onChange: publish` (`SUGAR_ESCAPE`; leaving `virtual.ts` unselected avoids it), and
then one `[SUGAR_CALLBACK]` whose span falls back to `function App()`. Five bisects didn't find it.
