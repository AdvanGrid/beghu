// `/cli/login`: where a person approves a `beghu login` (#179), in the panel's place beside the
// list, its own chunk (router.tsx). The CLI opens it with its code in the URL (`?code=BCDF-GHJK`),
// or prints both over SSH, when the code is typed here. It shows the machine's name, the account
// the CLI will act as (the browser's active one; another of its accounts is a switch away), and
// Approve and Deny. Approve signs the CLI in as that account: it can then start analysis runs
// and act within them, never anything else. A decision that fails is undone and says so.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, Errored, For, Loading, Match, Show, Switch } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { forgetFailure, getMe, Gone, SessionEnded, signIn } from "./api";
import { decideCliLogin, getCliCode, normaliseCode, shownCode, type CliCode } from "./cli";
import { Failure } from "./Root";
import { colors, fonts } from "./tokens.stylex";

export function CliLoginPanel() {
  const location = useLocation();
  const code = createMemo(() => normaliseCode(new URLSearchParams(location.search).get("code") ?? ""));
  return (
    <section aria-label="Sign in the beghu CLI" data-perf="cli-login" {...stylex.attrs(s.panel)}>
      <div {...stylex.attrs(s.scroller)}>
        <div {...stylex.attrs(s.head)}>
          <h2 {...stylex.attrs(s.title)}>Sign in the beghu CLI</h2>
          <a href="/issues" {...stylex.attrs(s.close)} aria-label="Close" title="Close">
            ×
          </a>
        </div>
        <Show when={code()} fallback={<CodeForm />} keyed>
          {(c) => (
            <Errored fallback={(err, reset) => <CodeFailure error={err()} code={c} reset={reset} />}>
              <Loading fallback={<div {...stylex.attrs(s.grow)} aria-busy="true" />}>
                <Confirm code={c} />
              </Loading>
            </Errored>
          )}
        </Show>
      </div>
    </section>
  );
}

/** The code as `beghu login` printed it, typed. */
function CodeForm(props: { said?: string }) {
  const navigate = useNavigate();
  const [typed, setTyped] = createSignal("");
  const [bad, setBad] = createSignal(false);
  return (
    <form
      {...stylex.attrs(s.body)}
      onSubmit={(e) => {
        e.preventDefault();
        const c = normaliseCode(typed());
        if (!c) return setBad(true);
        navigate(`/cli/login?code=${shownCode(c)}`);
      }}
    >
      <Show when={props.said}>{(said) => <p {...stylex.attrs(s.error)} role="alert">{said()}</p>}</Show>
      <label for="cli-code" {...stylex.attrs(s.text)}>
        Enter the code <code {...stylex.attrs(s.code)}>beghu login</code> printed:
      </label>
      <div {...stylex.attrs(s.row)}>
        <input
          id="cli-code"
          name="code"
          autocomplete="off"
          spellcheck={false}
          placeholder="BCDF-GHJK"
          aria-invalid={bad() ? "true" : "false"}
          value={typed()}
          onInput={(e) => {
            setBad(false);
            setTyped(e.currentTarget.value);
          }}
          {...stylex.attrs(s.input)}
        />
        <button type="submit" {...stylex.attrs(s.button, s.primary)}>
          Continue
        </button>
      </div>
      <Show when={bad()}>
        <p {...stylex.attrs(s.error)} role="alert">
          A code is eight letters, like BCDF-GHJK.
        </p>
      </Show>
    </form>
  );
}

/** What was decided here: nothing yet, or Approve or Deny, once the server took it. */
type Decided = "approved" | "denied";

function Confirm(props: { code: string }) {
  const login = createMemo(() => getCliCode(props.code));
  const me = createMemo(() => getMe());
  const [decided, setDecided] = createSignal<Decided>();
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<string>();
  const others = () => me().accounts.filter((a) => a.id !== me().account.id && !a.needs_sign_in);
  const decide = async (approve: boolean) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await decideCliLogin(props.code, approve);
      setDecided(approve ? "approved" : "denied");
    } catch (e) {
      if (e instanceof SessionEnded) signIn();
      // Nothing was decided: it's as it was.
      setFailed(
        e instanceof Gone
          ? "This sign-in has expired, or was decided already. Run beghu login again."
          : `Couldn't ${approve ? "approve" : "deny"} it. Try again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div {...stylex.attrs(s.body)} data-perf="cli-confirm">
      <Switch>
        <Match when={decided() === "approved"}>
          <p {...stylex.attrs(s.text)} role="status">
            Approved: the beghu CLI on <strong>{login().name}</strong> is signed in as <strong>{me().account.login}</strong>. You can close this tab.
          </p>
        </Match>
        <Match when={decided() === "denied"}>
          <p {...stylex.attrs(s.text)} role="status">
            Denied: the beghu CLI on <strong>{login().name}</strong> isn't signed in.
          </p>
        </Match>
        <Match when={login().state !== "pending"}>
          <p {...stylex.attrs(s.text)}>This sign-in was decided already. Run beghu login again for a new one.</p>
        </Match>
        <Match when={true}>
          <Details login={login()} />
          <p {...stylex.attrs(s.text)}>
            It will act as <strong>{me().account.login}</strong>: start analysis runs and act within them, and nothing else. Approve only a sign-in you
            started.
          </p>
          <Show when={others().length > 0}>
            <div {...stylex.attrs(s.accounts)}>
              <span {...stylex.attrs(s.muted)}>Or sign it in as</span>
              <For each={others()}>
                {(a) => (
                  <form method="post" action="/auth/switch">
                    <input type="hidden" name="account" value={String(a.id)} />
                    <input type="hidden" name="next" value={`/cli/login?code=${shownCode(props.code)}`} />
                    <button type="submit" {...stylex.attrs(s.link)}>
                      {a.login}
                    </button>
                  </form>
                )}
              </For>
            </div>
          </Show>
          <div {...stylex.attrs(s.row)}>
            <button type="button" disabled={busy()} onClick={() => void decide(true)} {...stylex.attrs(s.button, s.primary)}>
              Approve
            </button>
            <button type="button" disabled={busy()} onClick={() => void decide(false)} {...stylex.attrs(s.button)}>
              Deny
            </button>
          </div>
          <Show when={failed()}>
            {(f) => (
              <p {...stylex.attrs(s.error)} role="alert">
                {f()}
              </p>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  );
}

function Details(props: { login: CliCode }) {
  return (
    <dl {...stylex.attrs(s.details)}>
      <dt {...stylex.attrs(s.muted)}>Machine</dt>
      <dd {...stylex.attrs(s.dd)}>{props.login.name}</dd>
      <dt {...stylex.attrs(s.muted)}>Code</dt>
      <dd {...stylex.attrs(s.dd, s.code)} data-perf="cli-code">
        {props.login.code}
      </dd>
    </dl>
  );
}

function CodeFailure(props: { error: unknown; code: string; reset: () => void }) {
  return (
    <Failure error={props.error}>
      <Show
        when={props.error instanceof Gone}
        fallback={
          <p {...stylex.attrs(s.body, s.text)} role="alert">
            Couldn't read this sign-in ·{" "}
            <button
              type="button"
              {...stylex.attrs(s.link)}
              onClick={() => {
                forgetFailure(getCliCode);
                props.reset();
              }}
            >
              Retry
            </button>
          </p>
        }
      >
        <CodeForm said={`No sign-in is waiting with the code ${shownCode(props.code)}: it has expired (codes last 10 minutes), or was used. Check the code, or run beghu login again.`} />
      </Show>
    </Failure>
  );
}

const s = stylex.create({
  panel: {
    backgroundColor: colors.bg,
    borderInlineStartColor: colors.line,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 1,
    display: "flex",
    flexBasis: 0,
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  grow: {
    flexGrow: 1,
  },
  scroller: {
    flexGrow: 1,
    overflowY: "auto",
  },
  head: {
    paddingBlock: 12,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
  },
  title: {
    margin: 0,
    flexGrow: 1,
    fontSize: 18,
    fontWeight: 600,
  },
  close: {
    textDecoration: "none",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
  },
  body: {
    margin: 0,
    gap: 12,
    paddingInline: 16,
    display: "flex",
    flexDirection: "column",
    maxWidth: 560,
    paddingBottom: 16,
  },
  text: {
    margin: 0,
    color: colors.fg,
    lineHeight: 1.5,
  },
  muted: {
    color: colors.muted,
  },
  details: {
    margin: 0,
    gap: 6,
    columnGap: 16,
    display: "grid",
    gridTemplateColumns: "auto 1fr",
  },
  dd: {
    margin: 0,
    fontWeight: 600,
  },
  code: {
    fontFamily: fonts.mono,
  },
  row: {
    gap: 8,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
  },
  accounts: {
    gap: 8,
    alignItems: "baseline",
    display: "flex",
    flexWrap: "wrap",
  },
  input: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 8,
    backgroundColor: colors.bg,
    color: colors.fg,
    fontFamily: fonts.mono,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    width: "12ch",
  },
  button: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 12,
    backgroundColor: {
      default: colors.bgRaised,
      ":hover:not(:disabled)": colors.hover,
    },
    color: colors.fg,
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    opacity: {
      default: 1,
      ":disabled": 0.5,
    },
  },
  primary: {
    borderColor: colors.accentBg,
    backgroundColor: {
      default: colors.accentBg,
      ":hover:not(:disabled)": colors.accent,
    },
    color: colors.accentFg,
  },
  error: {
    margin: 0,
    color: colors.danger,
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
