import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, Errored, Loading, onSettled, Show, untrack, type Element } from "solid-js";
import { revalidate, useLocation, useMatch } from "@solidjs/router";
import { SessionEnded, forgetRemembered, getIssues, getMe, issueId, signIn, signInUrl } from "./api";
import { FilterBar } from "./FilterBar";
import { IssueList } from "./IssueList";
import { connectLive, reconnecting } from "./live";
import { ChunkFailed } from "./router";
import { ThemeSwitch } from "./ThemeSwitch";
import { colors, fonts, media } from "./tokens.stylex";

/**
 * The app: a header over the list, with the open issue's panel (the route's content) beside the
 * list, or under it below 900 px. The root `Errored` sends a signed-out tab to sign in. The panel
 * has boundaries of its own, so while its code loads, or if that fails, the list carries on. The
 * bottom bar holds the status slot. The tab's live stream opens with the app.
 */
export function Root(props: { children?: Element }) {
  onSettled(connectLive);
  const location = useLocation();
  const open = useMatch(() => "/issues/:id");
  // Another view (its query string, with an issue open or not) or leaving the issue for the
  // list's own path forgets the detail a hover remembered; opening an issue uses it up
  // (IssuePanel.tsx).
  createEffect(
    () => ({ search: location.search, path: open() ? undefined : location.pathname }),
    (now, prev) => {
      if (prev && (now.search !== prev.search || (now.path !== undefined && now.path !== prev.path))) forgetRemembered();
    },
  );
  return (
    <div {...stylex.attrs(s.app)}>
      <Errored fallback={(err) => <RootFailure error={err()} />}>
        <Header />
        <main {...stylex.attrs(s.main)}>
          <div {...stylex.attrs(s.listPane)} data-perf="list-pane">
            <List />
          </div>
          <Errored fallback={(err, reset) => <PanelFailure error={err()} reset={reset} />}>
            <Loading fallback={<div {...stylex.attrs(s.panelSlot)} aria-busy="true" />}>{props.children}</Loading>
          </Errored>
        </main>
        <StatusBar />
      </Errored>
    </div>
  );
}

/** The always-shown bottom bar. Its left end is the status slot: quiet states, one at a time. */
function StatusBar() {
  return (
    <footer {...stylex.attrs(s.bar)}>
      <span role="status" data-perf="status" {...stylex.attrs(s.status)}>
        <Show when={reconnecting()}>reconnecting…</Show>
      </span>
    </footer>
  );
}

/** Where a URL's reload for its failed code is noted, so it happens at most once (spec #86). */
const RELOADED = "beghu.chunk-reload:";

/**
 * Reloads `target` (the URL the failed navigation was headed to) with `location.replace`, unless
 * this tab already did for that URL. A deploy that replaced the build is the usual cause, and a
 * fresh shell names the new chunks. Without session storage there's no guard, so no reload.
 */
function reloadOnce(target: string): boolean {
  try {
    if (sessionStorage.getItem(RELOADED + target) !== null) return false;
    sessionStorage.setItem(RELOADED + target, "1");
  } catch {
    return false;
  }
  location.replace(target);
  return true;
}

/**
 * The panel failed outside its own boundaries: its code didn't load (the URL reloads once, then
 * offers Retry), or something else broke in it. The list stays usable, and opening anything else
 * tries again.
 */
function PanelFailure(props: { error: unknown; reset: () => void }) {
  const location = useLocation();
  resetOnChange(() => location.pathname + location.search, props.reset);
  // Decided once, as the failure shows: a reload leaves the page, and Retry must not flash first.
  const reloading = untrack(() => props.error instanceof ChunkFailed) && reloadOnce(location.pathname + location.search + location.hash);
  return (
    <div {...stylex.attrs(s.panelSlot)} aria-busy={reloading ? "true" : undefined}>
      <Show when={!reloading}>
        <IssueNotice error={props.error} retry={props.reset} />
      </Show>
    </div>
  );
}

/** Resets a failure's boundary when `key` changes: opening something else tries again. */
export function resetOnChange(key: () => unknown, reset: () => void): void {
  createEffect(key, (now, prev) => {
    if (prev !== undefined && now !== prev) reset();
  });
}

/** The open issue couldn't load: says so, with Retry (or, signed out, goes to sign in). */
export function IssueNotice(props: { error: unknown; retry: () => void }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.notice)} role="alert">
        Couldn't load this issue ·{" "}
        <button type="button" {...stylex.attrs(s.link)} onClick={() => props.retry()}>
          Retry
        </button>
      </p>
    </Failure>
  );
}

function Header() {
  return (
    <header {...stylex.attrs(s.header)}>
      <span {...stylex.attrs(s.brand)}>beghu</span>
      <span {...stylex.attrs(s.spacer)} />
      <Errored fallback={(err, reset) => <AccountFailure error={err()} reset={reset} />}>
        <Loading fallback={<span />}>
          <Account />
        </Loading>
      </Errored>
      <ThemeSwitch />
    </header>
  );
}

function Account() {
  const me = createMemo(() => getMe());
  return (
    <span {...stylex.attrs(s.account)} data-perf="account">
      {me().account.login}
    </span>
  );
}

/** The header's account failed to load. Signed out, the list's own failure goes to sign in. */
function AccountFailure(props: { error: unknown; reset: () => void }) {
  return (
    <Show when={!(props.error instanceof SessionEnded)} fallback={<span />}>
      <button
        type="button"
        {...stylex.attrs(s.link)}
        title="Couldn't load your account"
        onClick={() => {
          void revalidate(getMe.key);
          props.reset();
        }}
      >
        Retry
      </button>
    </Show>
  );
}

function List() {
  const location = useLocation();
  const open = useMatch(() => "/issues/:id");
  // The bar sits outside the list's boundary, so a view that fails to load can be changed.
  return (
    <div {...stylex.attrs(s.listColumn)}>
      <FilterBar />
      <Errored fallback={(err, reset) => <ListFailure error={err()} reset={reset} />}>
        <IssueList search={location.search} openId={open() ? issueId(open()!.params.id) : undefined} />
      </Errored>
    </div>
  );
}

/** A failed read: a signed-out one goes to sign in; any other shows `children`. */
export function Failure(props: { error: unknown; children: Element }) {
  return (
    <Show when={!(props.error instanceof SessionEnded)} fallback={<SigningIn />}>
      {props.children}
    </Show>
  );
}

function ListFailure(props: { error: unknown; reset: () => void }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.notice)} role="alert">
        Couldn't load this view ·{" "}
        <button
          type="button"
          {...stylex.attrs(s.link)}
          onClick={() => {
            // Drop the failed read from the query cache, so the retry fetches again.
            void revalidate(getIssues.key);
            props.reset();
          }}
        >
          Retry
        </button>
      </p>
    </Failure>
  );
}

/** A signed-out load: off to sign in, once, coming back to this URL afterwards. */
function SigningIn() {
  signIn();
  return (
    <p {...stylex.attrs(s.notice)}>
      Signing you in… If nothing happens,{" "}
      <a href={signInUrl()} rel="external" {...stylex.attrs(s.link)}>
        sign in
      </a>
      .
    </p>
  );
}

function RootFailure(props: { error: unknown }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.notice)} role="alert">
        Something broke ·{" "}
        <button type="button" {...stylex.attrs(s.link)} onClick={() => location.reload()}>
          Reload
        </button>
      </p>
    </Failure>
  );
}

const s = stylex.create({
  app: {
    backgroundColor: colors.bg,
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 1.4,
    height: "100dvh",
  },
  header: {
    gap: 12,
    paddingInline: 14,
    alignItems: "center",
    backgroundColor: colors.bgRaised,
    display: "flex",
    flexShrink: 0,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    height: 44,
  },
  brand: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: "-0.01em",
  },
  spacer: {
    flexGrow: 1,
  },
  account: {
    color: colors.muted,
  },
  main: {
    display: "flex",
    flexDirection: {
      [media.stacked]: "column",
      default: "row",
    },
    flexGrow: 1,
    minHeight: 0,
  },
  listColumn: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  // Beside the panel the list takes what the panel leaves; under 900 px it takes 40% to the
  // panel's 60%.
  listPane: {
    display: "flex",
    flexBasis: 0,
    flexGrow: {
      [media.stacked]: 4,
      default: 1,
    },
    minHeight: 0,
    minWidth: 0,
  },
  // The panel's place while its code loads, or after that failed: the panel's share of the room.
  panelSlot: {
    backgroundColor: colors.bg,
    flexBasis: 0,
    flexGrow: {
      [media.stacked]: 6,
      default: 1,
    },
    minHeight: 0,
    minWidth: 0,
  },
  bar: {
    paddingInline: 14,
    alignItems: "center",
    backgroundColor: colors.bgRaised,
    display: "flex",
    flexShrink: 0,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    height: 24,
  },
  status: {
    color: colors.muted,
    fontSize: 12,
  },
  notice: {
    margin: 0,
    padding: 24,
    color: colors.muted,
  },
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
  },
});
