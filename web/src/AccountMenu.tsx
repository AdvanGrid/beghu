// The account menu, from the header's account name: every account signed in on this browser
// (shown plainly, so none can hide), switching between them, adding one, signing out of one or
// all, and Disconnect. A chunk of its own, loaded on the first hover, focus or click.
//
// Switching and signing out are form posts: the page leaves, and the next one is the other
// account's (URLs carry no account). They ask first, in the app, only while the tab holds text
// it would lose; Disconnect, which can't be undone, always asks. Leaving on purpose blanks the
// view first (overlay.ts), so Back never shows the old account's data from the cache.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show } from "solid-js";
import type { Me } from "./api";
import { leave } from "./overlay";
import { unsavedText } from "./unsaved";
import { colors } from "./tokens.stylex";

/** What leaving will do, waiting for the user to say yes. */
interface Ask {
  /** The question. */
  what: string;
  /** What it means beyond losing unsaved text (Disconnect's consequences). */
  detail?: string;
  /** The confirming button's label. */
  yes: string;
  go: () => void;
}

/** The page to come back to: the same view, under whichever account is active. */
function here(): string {
  return location.pathname + location.search;
}

export function AccountMenu(props: { me: Me; close: () => void }) {
  const [ask, setAsk] = createSignal<Ask>();
  let menu!: HTMLDivElement;
  onSettled(() => {
    const away = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node) && !(e.target as Element).closest?.("[aria-haspopup=menu]")) props.close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.close();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  });
  const unsaved = unsavedText;
  /**
   * Leaves through `go`: at once, or once the user confirms when there's unsaved text (always,
   * with `always`, adding `detail`).
   */
  const leaveBy = (go: () => void, what: string, yes: string, opts: { always?: boolean; detail?: string } = {}) => {
    const leaveNow = () => {
      leave();
      go();
    };
    if (!opts.always && !unsaved()) return leaveNow();
    setAsk({ what, yes, detail: opts.detail, go: leaveNow });
  };
  /** A form post's submit: leaves through the form, asking first if it must. */
  const submitting = (what: string, yes: string, opts?: { always?: boolean; detail?: string }) => (e: SubmitEvent) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    leaveBy(
      () => {
        // The question took the menu's place, and the form with it: put it back, out of sight.
        if (!form.isConnected) {
          form.hidden = true;
          document.body.append(form);
        }
        form.submit();
      },
      what,
      yes,
      opts,
    );
  };
  const others = () => props.me.accounts.filter((a) => a.id !== props.me.account.id);
  const login = () => props.me.account.login;
  return (
    <div ref={menu} role="menu" aria-label="Accounts" data-perf="account-menu" {...stylex.attrs(s.menu)}>
      <Show
        when={ask()}
        fallback={
          <>
            <p {...stylex.attrs(s.heading)}>
              Signed in as <strong>{login()}</strong>
            </p>
            <For each={others()}>
              {(a) => (
                <Show
                  when={!a.needs_sign_in}
                  fallback={
                    <a
                      role="menuitem"
                      href={`/auth/login?${new URLSearchParams({ login: a.login, next: here() })}`}
                      {...stylex.attrs(s.item)}
                      onClick={(e) => {
                        e.preventDefault();
                        const to = e.currentTarget.href;
                        leaveBy(() => location.assign(to), `Sign in again as ${a.login}?`, "Sign in again");
                      }}
                    >
                      Sign in again as {a.login}
                    </a>
                  }
                >
                  <form method="post" action="/auth/switch" onSubmit={submitting(`Switch to ${a.login}?`, "Switch")}>
                    <input type="hidden" name="account" value={String(a.id)} />
                    <input type="hidden" name="next" value={here()} />
                    <button type="submit" role="menuitem" {...stylex.attrs(s.item)}>
                      Switch to {a.login}
                    </button>
                  </form>
                </Show>
              )}
            </For>
            <a
              role="menuitem"
              href={`/auth/login?${new URLSearchParams({ add: "1", next: here() })}`}
              {...stylex.attrs(s.item)}
              onClick={(e) => {
                e.preventDefault();
                const to = e.currentTarget.href;
                leaveBy(() => location.assign(to), "Add another account?", "Add an account");
              }}
            >
              Add another account
            </a>
            <hr {...stylex.attrs(s.rule)} />
            <form method="post" action="/auth/logout" onSubmit={submitting(`Sign out of ${login()}?`, "Sign out")}>
              <input type="hidden" name="account" value={String(props.me.account.id)} />
              <input type="hidden" name="next" value={here()} />
              <button type="submit" role="menuitem" {...stylex.attrs(s.item)}>
                Sign out of {login()}
              </button>
            </form>
            <Show when={others().length > 0}>
              <form method="post" action="/auth/logout" onSubmit={submitting("Sign out of every account?", "Sign out of all")}>
                <input type="hidden" name="all" value="1" />
                <input type="hidden" name="next" value={here()} />
                <button type="submit" role="menuitem" {...stylex.attrs(s.item)}>
                  Sign out of all accounts
                </button>
              </form>
            </Show>
            <hr {...stylex.attrs(s.rule)} />
            <form
              method="post"
              action="/auth/disconnect"
              onSubmit={submitting(`Disconnect ${login()} from beghu?`, "Disconnect", {
                always: true,
                detail:
                  "beghu revokes its access on GitHub, deletes its copy of this account's issues and the account's preferences, and signs it out in every browser. It remembers which repos you picked, for if you connect again. Nothing on GitHub is changed.",
              })}
            >
              <input type="hidden" name="account" value={String(props.me.account.id)} />
              <button type="submit" role="menuitem" {...stylex.attrs(s.item, s.danger)}>
                Disconnect beghu…
              </button>
            </form>
          </>
        }
      >
        {(a) => (
          <div role="alertdialog" aria-label={a().what} data-perf="leave-confirm" {...stylex.attrs(s.confirm)}>
            <p {...stylex.attrs(s.question)}>{a().what}</p>
            <Show when={a().detail}>{(d) => <p {...stylex.attrs(s.detail)}>{d()}</p>}</Show>
            <Show when={unsaved()}>
              <p {...stylex.attrs(s.detail)}>This tab has unsaved text, which will be lost.</p>
            </Show>
            <div {...stylex.attrs(s.buttons)}>
              <button type="button" {...stylex.attrs(s.button)} onClick={() => setAsk(undefined)}>
                Cancel
              </button>
              <button type="button" {...stylex.attrs(s.button, s.primary)} onClick={() => a().go()}>
                {a().yes}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

const s = stylex.create({
  menu: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    backgroundColor: colors.pop,
    boxShadow: `0 4px 16px ${colors.popShadow}`,
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    position: "absolute",
    whiteSpace: "nowrap",
    zIndex: 10,
    minWidth: 220,
    right: 0,
    top: "calc(100% + 8px)",
  },
  heading: {
    margin: 0,
    paddingBlock: 6,
    paddingInline: 12,
    color: colors.muted,
  },
  item: {
    font: "inherit",
    borderWidth: 0,
    paddingBlock: 6,
    paddingInline: 12,
    textDecoration: "none",
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.fg,
    cursor: "pointer",
    display: "block",
    textAlign: "start",
    width: "100%",
  },
  danger: {
    color: colors.danger,
  },
  rule: {
    borderWidth: 0,
    marginBlock: 4,
    marginInline: 0,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  confirm: {
    paddingBlock: 8,
    paddingInline: 12,
    whiteSpace: "normal",
    width: 280,
  },
  question: {
    margin: 0,
    fontWeight: 600,
  },
  detail: {
    marginBlock: 6,
    marginInline: 0,
    color: colors.muted,
  },
  buttons: {
    gap: 8,
    display: "flex",
    justifyContent: "flex-end",
    marginTop: 8,
  },
  button: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 10,
    backgroundColor: {
      default: colors.bgRaised,
      ":hover": colors.hover,
    },
    color: colors.fg,
    cursor: "pointer",
  },
  primary: {
    backgroundColor: {
      default: colors.accent,
      ":hover": colors.accent,
    },
    color: colors.accentFg,
  },
});
