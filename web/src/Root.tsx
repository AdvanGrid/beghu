import * as stylex from "@stylexjs/stylex";
import { createMemo, Errored, Loading, Show, type Element } from "solid-js";
import { revalidate, useLocation, useMatch } from "@solidjs/router";
import { SessionEnded, getIssues, getMe, signIn, signInUrl } from "./api";
import { IssueList } from "./IssueList";
import { ThemeSwitch } from "./ThemeSwitch";
import { colors, fonts } from "./tokens.stylex";

/** The app: a header over the list. The root `Errored` sends a signed-out tab to sign in. */
export function Root(props: { children?: Element }) {
  return (
    <div {...stylex.attrs(s.app)}>
      <Errored fallback={(err) => <RootFailure error={err()} />}>
        <Header />
        <main {...stylex.attrs(s.main)}>
          <List />
          {props.children}
        </main>
      </Errored>
    </div>
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
  return (
    <Errored fallback={(err, reset) => <ListFailure error={err()} reset={reset} />}>
      <IssueList search={location.search} openId={open() ? Number(open()!.params.id) : undefined} />
    </Errored>
  );
}

/** A failed read: a signed-out one goes to sign in; any other shows `children`. */
function Failure(props: { error: unknown; children: Element }) {
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
    flexGrow: 1,
    minHeight: 0,
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
