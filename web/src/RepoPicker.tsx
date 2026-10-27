// Repo picking: the `/repos` route, in the panel's place beside the list. Its own chunk, loaded
// lazily (router.tsx), so first-load JS doesn't carry it. Every repo the account can see through
// an installation of the App, grouped by owner, each with a checkbox; Save syncs exactly the ones
// ticked. The server writes the pick, then imports what joined and unsyncs what left: rows arrive
// in the list through the live stream, with the status slot counting repos. Like every view, it
// ends with the "Still importing" note while an import runs. A reset push reads the repos again
// (an install's webhook makes its repos visible after the setup URL has sent the browser here).
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, Errored, For, Loading, Show } from "solid-js";
import { query, revalidate, useNavigate } from "@solidjs/router";
import { forgetFailure, request, SessionEnded, signIn } from "./api";
import { StillImporting } from "./WhileImporting";
import { onPush } from "./live";
import type { PickableRepo } from "./bindings/PickableRepo";
import type { RepoPicker } from "./bindings/RepoPicker";
import { Failure } from "./Root";
import { colors } from "./tokens.stylex";

/** Every repo the account can see, whether it's synced, and where installing the App starts. */
const getRepos = query(() => request<RepoPicker>("/api/repos"), "repos");

/** Bumped by every reset push once this chunk has loaded: the picker reads its repos again. */
const [resets, setResets] = createSignal(0);
/** Whether the open picker holds ticks not yet saved: a reset leaves it alone then. */
let holding = () => false;
// Subscribed as the chunk loads, before the picker's first read, so a reset that lands while
// that read is in flight (an install's webhook, just after the setup URL sent the browser here)
// still reads the repos again.
onPush((p) => {
  if (p.kind === "reset" && !holding()) setResets((n) => n + 1);
});

/** Syncs exactly `repos` (ids): the ones added start importing, the ones left out leave. */
function putRepos(repos: number[]): Promise<RepoPicker> {
  return request<RepoPicker>("/api/repos", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repos }),
  });
}

export function RepoPickerPanel() {
  return (
    <section aria-label="Repos" data-perf="repo-picker" {...stylex.attrs(s.panel)}>
      <Errored fallback={(err, reset) => <PickerFailure error={err()} reset={reset} />}>
        <Loading fallback={<div {...stylex.attrs(s.grow)} aria-busy="true" />}>
          <Picker />
        </Loading>
      </Errored>
    </section>
  );
}

function Picker() {
  const navigate = useNavigate();
  // Read again on every reset (the push cleared the query cache, so this fetches).
  const data = createMemo(() => (resets(), getRepos()));
  // The pick starts as what's synced, and starts again whenever the repos are read afresh.
  const [picked, setPicked] = createSignal<ReadonlySet<number>>(() => synced(data()));
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const owners = createMemo(() => groupByOwner(data().repos));
  const changed = () => {
    const was = synced(data());
    const now = picked();
    return was.size !== now.size || [...now].some((id) => !was.has(id));
  };
  holding = () => changed() || saving();
  const toggle = (id: number, on: boolean) => {
    const next = new Set(picked());
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await putRepos([...picked()]);
      void revalidate(getRepos.key);
      navigate("/");
    } catch (e) {
      // The pick stays as ticked, for Retry.
      if (e instanceof SessionEnded) signIn();
      else setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div {...stylex.attrs(s.scroller)}>
      <div {...stylex.attrs(s.head)}>
        <h2 {...stylex.attrs(s.title)}>Synced repos</h2>
        <a href="/" {...stylex.attrs(s.close)} aria-label="Close" title="Close">
          ×
        </a>
      </div>
      <p {...stylex.attrs(s.intro)}>
        beghu copies the issues and PRs of the repos you pick. Adding one imports it; removing one takes its rows out of beghu (GitHub keeps
        them).
      </p>
      <Show
        when={data().repos.length > 0}
        fallback={<p {...stylex.attrs(s.intro)}>None of your accounts or organizations has beghu installed on a repo you can see.</p>}
      >
        <For each={owners()} keyed={(o) => o.owner}>
          {(o) => (
            <fieldset {...stylex.attrs(s.group)}>
              <legend {...stylex.attrs(s.owner)}>{o().owner}</legend>
              <For each={o().repos} keyed={(r) => r.id}>
                {(r) => (
                  <label {...stylex.attrs(s.repo)} data-perf="pick-repo" data-repo={`${r().owner}/${r().name}`}>
                    <input
                      type="checkbox"
                      checked={picked().has(r().id)}
                      disabled={saving()}
                      onChange={(e) => toggle(r().id, e.currentTarget.checked)}
                      {...stylex.attrs(s.check)}
                    />
                    <span {...stylex.attrs(s.name)}>{r().name}</span>
                    <span {...stylex.attrs(s.meta)}>
                      {r().private ? "private" : "public"}
                      {r().role ? ` · ${r().role}` : ""}
                      {r().archived ? " · archived" : ""}
                      {r().importing ? " · importing…" : ""}
                    </span>
                  </label>
                )}
              </For>
            </fieldset>
          )}
        </For>
      </Show>
      <div {...stylex.attrs(s.actions)}>
        <button type="button" {...stylex.attrs(s.save)} disabled={saving() || !changed()} onClick={() => void save()}>
          {saving() ? "Saving…" : "Save"}
        </button>
        <a href="/" {...stylex.attrs(s.link)}>
          Cancel
        </a>
        <Show when={failed()}>
          <span role="alert" {...stylex.attrs(s.error)}>
            Couldn't save your repos ·{" "}
            <button type="button" {...stylex.attrs(s.link)} onClick={() => void save()}>
              Retry
            </button>
          </span>
        </Show>
      </div>
      <Show when={data().install_url}>
        {(url) => (
          <p {...stylex.attrs(s.intro)}>
            Missing a repo?{" "}
            <a href={url()} rel="external" {...stylex.attrs(s.link)}>
              Install beghu on another account ↗
            </a>
          </p>
        )}
      </Show>
      <StillImporting />
    </div>
  );
}

function synced(p: RepoPicker): ReadonlySet<number> {
  return new Set(p.repos.filter((r) => r.synced).map((r) => r.id));
}

function groupByOwner(repos: PickableRepo[]): { owner: string; repos: PickableRepo[] }[] {
  const by = new Map<string, PickableRepo[]>();
  for (const r of repos) by.set(r.owner, [...(by.get(r.owner) ?? []), r]);
  return [...by].map(([owner, repos]) => ({ owner, repos }));
}

function PickerFailure(props: { error: unknown; reset: () => void }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.intro)} role="alert">
        Couldn't load your repos ·{" "}
        <button
          type="button"
          {...stylex.attrs(s.link)}
          onClick={() => {
            forgetFailure(getRepos);
            props.reset();
          }}
        >
          Retry
        </button>
      </p>
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
  intro: {
    margin: 0,
    paddingInline: 16,
    color: colors.muted,
    paddingBottom: 12,
  },
  group: {
    margin: 0,
    borderWidth: 0,
    paddingBlock: 8,
    paddingInline: 16,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  owner: {
    padding: 0,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    paddingBottom: 4,
  },
  repo: {
    gap: 8,
    alignItems: "center",
    cursor: "pointer",
    display: "flex",
    height: 30,
  },
  check: {
    margin: 0,
    accentColor: colors.accent,
  },
  name: {
    fontWeight: 600,
  },
  meta: {
    color: colors.muted,
    fontSize: 12,
  },
  actions: {
    gap: 12,
    paddingBlock: 12,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  save: {
    font: "inherit",
    borderColor: colors.accent,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 14,
    backgroundColor: colors.accent,
    color: colors.accentFg,
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    fontWeight: 600,
    opacity: {
      default: 1,
      ":disabled": 0.5,
    },
  },
  error: {
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
