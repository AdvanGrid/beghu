import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, lazy, Loading, onSettled, Show, untrack, type Element } from "solid-js";
import { revalidate, useLocation, useMatch } from "@solidjs/router";
import { Dynamic } from "@solidjs/web";
import { SessionEnded, forgetRemembered, getIssues, getMe, issueId, signIn, signInUrl } from "./api";
import { FilterBar } from "./FilterBar";
import { IssueList } from "./IssueList";
import { Background } from "./WhileSyncing";
import { stale } from "./account";
import { loadAfresh, newBuildOnNavigate } from "./build";
import { cantReach, connectLive, githubDown, reconnecting } from "./live";
import { createNote, leaving, overlay } from "./overlay";
import { ChunkFailed } from "./router";
import { ThemeSwitch } from "./ThemeSwitch";
import { unsavedText } from "./unsaved";
import { colors, fonts, media } from "./tokens.stylex";

/** The account menu is its own chunk: nothing on first paint needs it. */
const AccountMenu = lazy(() => import("./AccountMenu"), { export: "AccountMenu" });

/**
 * The app: a header over the list, with the open issue's panel (the route's content) beside the
 * list, or under it below 900 px. The root `Errored` sends a signed-out tab to sign in. The panel
 * has boundaries of its own, so while its code loads, or if that fails, the list carries on. The
 * bottom bar holds the status slot. The tab's live stream opens with the app. One banner at a
 * time shows under the header. Leaving on purpose (a sign-out or a switch) blanks the whole app
 * first, header and banners included, so no frame of a page restored from the back-forward cache
 * shows the old account. Once beghu runs another build, the next navigation loads the document
 * afresh (build.ts).
 */
export function Root(props: { children?: Element }) {
  onSettled(connectLive);
  newBuildOnNavigate();
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
    <div aria-hidden={leaving() ? "true" : undefined} {...stylex.attrs(s.app, leaving() && s.blank)}>
      <Errored fallback={(err) => <RootFailure error={err()} />}>
        <Header />
        <Banner />
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

/** Which banner shows: the first that holds, in the spec's order. */
function banner(): "switched" | "signed_out" | "sign_in_again" | "cant_reach" | "github" | undefined {
  return stale() ?? (cantReach() ? "cant_reach" : githubDown() ? "github" : undefined);
}

/**
 * One banner at a time under the header (`role="alert"`), in precedence order: the tab is on
 * another account (or signed out, or its account must sign in again), beghu can't be reached
 * (after 15 s), GitHub is unreachable. Each one disables Save and Send, and keeps any text.
 */
function Banner() {
  return (
    <Show when={banner()}>
      {(which) => (
        <p role="alert" data-perf="banner" data-banner={which()} {...stylex.attrs(s.banner)}>
          <Show when={which() === "switched"}>
            This tab is on another account —{" "}
            <button type="button" {...stylex.attrs(s.link)} onClick={() => location.reload()}>
              Reload
            </button>
          </Show>
          <Show when={which() === "signed_out"}>
            You signed out in another tab —{" "}
            <a href={signInUrl()} rel="external" {...stylex.attrs(s.link)}>
              Sign in
            </a>
          </Show>
          <Show when={which() === "sign_in_again"}>
            GitHub access for this account ended. Your text is kept —{" "}
            <a href={signInUrl()} rel="external" {...stylex.attrs(s.link)}>
              Sign in again
            </a>
          </Show>
          <Show when={which() === "cant_reach"}>Can't reach beghu. What's shown may be out of date; your text is kept.</Show>
          <Show when={which() === "github"}>GitHub is unreachable. Writes are paused until it's back; your text is kept.</Show>
        </p>
      )}
    </Show>
  );
}

/**
 * The hint bar's keys and the `?` overlay: their own chunk, loaded after first paint. Until it
 * lands (or if it fails) the bar shows only the status slot; the keys work all the same.
 */
const Hints = lazy(
  () =>
    import("./Hints").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the key hints: ${String(e)}`);
    }),
  { export: "Hints" },
);

/**
 * The always-shown bottom bar. Its left end is the status slot: quiet states, one at a time. Once
 * the tab can write, the writes code fills it, failed writes first, a failed create among them,
 * then a create made while its form was closed (overlay.ts); otherwise that create's word comes
 * first, then a lost connection before the import (whose progress it can't hear meanwhile), and
 * the import before the sync state. Its right side shows the quick keys for where the focus is
 * (Hints.tsx).
 */
function StatusBar() {
  return (
    <footer {...stylex.attrs(s.bar)}>
      <span role="status" data-perf="status" {...stylex.attrs(s.status)}>
        <Show
          when={overlay()?.Status}
          fallback={
            <Show
              when={createNote()?.Note}
              fallback={
                <Show when={reconnecting()} fallback={<Background />}>
                  reconnecting…
                </Show>
              }
            >
              {(note) => <Dynamic component={note()} />}
            </Show>
          }
        >
          {(status) => <Dynamic component={status()} />}
        </Show>
      </span>
      <Errored fallback={null}>
        <Loading fallback={null}>
          <Hints />
        </Loading>
      </Errored>
    </footer>
  );
}

/** Where a URL's reload for its failed code is noted, so it happens at most once (spec #86). */
const RELOADED = "beghu.chunk-reload:";

/**
 * Reloads `target` (the URL the failed navigation was headed to) in place of this history entry,
 * unless this tab already did for that URL. A deploy that replaced the build is the usual cause,
 * and a fresh shell names the new chunks (`loadAfresh`, build.ts). Without session storage
 * there's no guard, so no reload. Nor while the tab holds unsaved text (unsaved.ts): the failure
 * offers Retry instead.
 */
export function reloadOnce(target: string): boolean {
  if (unsavedText()) return false;
  try {
    if (sessionStorage.getItem(RELOADED + target) !== null) return false;
    sessionStorage.setItem(RELOADED + target, "1");
  } catch {
    return false;
  }
  loadAfresh(target, true);
  return true;
}

/**
 * The panel failed outside its own boundaries: its code didn't load (the URL reloads once, then
 * offers Retry), or something else broke in it. The notice names what the panel held: an issue,
 * repo picking, the create form or preferences. The list stays usable, and opening anything else
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
        <Show when={PAGES[location.pathname]} fallback={<IssueNotice error={props.error} retry={props.reset} />}>
          {(what) => <PageNotice what={what()} error={props.error} retry={props.reset} />}
        </Show>
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

/** The panel's pages besides an issue, by path: what each is called in its failure notice. */
const PAGES: Record<string, string> = { "/repos": "repo picking", "/new": "the create form", "/prefs": "preferences" };

/** A page's code couldn't load (repo picking, the create form, preferences): says so, with Retry (or, signed out, goes to sign in). */
function PageNotice(props: { what: string; error: unknown; retry: () => void }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.notice)} role="alert">
        Couldn't load {props.what} ·{" "}
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
      <a href="/repos" {...stylex.attrs(s.headerLink)} data-perf="repos-link">
        Repos
      </a>
      <a href="/prefs" {...stylex.attrs(s.headerLink)} data-perf="prefs-link">
        Preferences
      </a>
      <Errored fallback={(err, reset) => <AccountFailure error={err()} reset={reset} />}>
        <Loading fallback={<span />}>
          <Account />
        </Loading>
      </Errored>
      <ThemeSwitch />
    </header>
  );
}

/**
 * The active account, opening the account menu: switch, add an account, sign out, Disconnect.
 * The menu's code loads on the first hover, focus or click.
 */
function Account() {
  const me = createMemo(() => getMe());
  const [open, setOpen] = createSignal(false);
  const warm = () => void import("./AccountMenu").catch(() => {});
  return (
    <span {...stylex.attrs(s.accountWrap)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        title="Accounts"
        {...stylex.attrs(s.accountButton)}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => setOpen((v) => !v)}
      >
        <span data-perf="account">{me().account.login}</span>
        <span aria-hidden="true"> ▾</span>
      </button>
      <Show when={open()}>
        <Loading fallback={null}>
          <AccountMenu me={me()} close={() => setOpen(false)} />
        </Loading>
      </Show>
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

/**
 * A failed read: a signed-out one goes to sign in, or, in a tab that went stale instead (its
 * banner offers sign-in, account.ts), says so; any other shows `children`.
 */
export function Failure(props: { error: unknown; children: Element }) {
  return (
    <Show
      when={!(props.error instanceof SessionEnded)}
      fallback={
        <Show when={!stale()} fallback={<p {...stylex.attrs(s.notice)}>Sign in again to see this.</p>}>
          <SigningIn />
        </Show>
      }
    >
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
  // Leaving on purpose: nothing of the app paints, the page's own background only.
  blank: {
    visibility: "hidden",
  },
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
  accountWrap: {
    position: "relative",
  },
  accountButton: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
    cursor: "pointer",
  },
  banner: {
    margin: 0,
    paddingBlock: 4,
    paddingInline: 14,
    backgroundColor: colors.bgRaised,
    color: colors.danger,
    flexShrink: 0,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  headerLink: {
    textDecoration: "none",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
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
