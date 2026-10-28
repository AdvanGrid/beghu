// The create form: the `/new` route, in the panel beside the list (IssuePanel.tsx's `Panel`). Its
// own chunk, loaded lazily (router.tsx), opened by "New issue" beside the presets or the `create`
// key (`c`, FilterBar.tsx). It holds the repo, the title, the body, and the labels, assignees and
// milestone, picked with the detail's pickers (Pickers.tsx, `DraftPicker`), where a pick changes
// only the form.
//
// - The repo is one of the synced repos, archived ones left out. It starts as the view's `repo:`
//   (the first one the form offers), else the last repo an issue was created in on this device,
//   else none: the user picks one.
// - Picks belong to the repo they were made in. If the form's repo changes after (chosen, or the
//   view's default changing), the milestone and assignees go, and only the labels the new repo
//   also has stay: a milestone number or a login means nothing in another repo. If the new repo's
//   labels can't be read, the labels go too, and the form says so. Sending pins the repo: the
//   view's default changing meanwhile doesn't move the form.
// - On a repo where the account has Read, Labels, Assignees and Milestone are disabled where they
//   are, and anything picked stays, greyed and unsent: Read opens an issue with a title and body.
// - Create sends one `create` op. While it's on its way the form is disabled and its button says
//   "Creating…" ("still sending…" after 15 s); once GitHub has made it and the mirror has it, the
//   panel opens the new issue by its id. No row stands in for it meanwhile: the list finds it
//   through the push, like any other new issue.
// - The create carries on if the form closes meanwhile (another issue opened, the form's ×): its
//   state lives with the draft, so the form, opened again, still says "Creating…" and can't send
//   it twice. If it ends while the form is closed, the panel stays where the user went; the status
//   slot says how it ended instead, with Open (the new issue) or Open the form (the failure).
// - A failure keeps every field and says why, with "Try again"; it's never sent again on its own,
//   since GitHub may have made it all the same (a lost create says to check the list).
// - What GitHub silently left out (a label, an assignee, the milestone) shows on the new issue as
//   a failed write on its row, with Retry (writes.tsx, `leftOut`).
// - The form is kept as typed until it's created, across opening issues meanwhile; leaving the page
//   with text in it asks first.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, onCleanup, onSettled, Show, untrack, type Element } from "solid-js";
import { revalidate, useLocation, useNavigate } from "@solidjs/router";
import {
  Conflict,
  GitHubDown,
  Gone,
  Lost,
  MAX_BODY,
  MAX_TITLE,
  NoAccess,
  RateLimited,
  Refused,
  ServerError,
  SessionEnded,
  Switched,
  Unreachable,
  getMe,
  request,
  sendOp,
  signIn,
  type CreateOp,
  type IssueOp,
  type OpReply,
} from "./api";
import type { Label } from "./bindings/Label";
import type { Milestone } from "./bindings/Milestone";
import type { Repo } from "./bindings/Repo";
import type { RepoLabel } from "./bindings/RepoLabel";
import { Avatar, link } from "./bits";
import { Panel } from "./IssuePanel";
import { touch } from "./keys";
import { writesPaused } from "./live";
import { setCreateNote, type Prop } from "./overlay";
import type { Pickable } from "./Pickers";
import { tokenize, queryOf } from "./query";
import { holdsText } from "./unsaved";
import { Failure, reloadOnce } from "./Root";
import { ChunkFailed } from "./router";
import { colors } from "./tokens.stylex";
import type { Look } from "./writes";

/** The pickers, loaded the first time one opens, as the detail loads them. */
const DraftPicker = lazy(
  () =>
    import("./Pickers").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the pickers: ${String(e)}`);
    }),
  { export: "DraftPicker" },
);

/** Where the repo the last issue was created in is kept on this device. */
const LAST_REPO = "beghu.create-repo";
/** How long a create waits for an answer before it shows "still sending…". */
const SLOW_MS = 15_000;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * What the form holds. `repo` is the one the user chose; until then the default applies. `picksFor`
 * is the repo the labels, assignees and milestone were picked in.
 */
type Draft = {
  repo?: number;
  picksFor?: number;
  title: string;
  body: string;
  labels: Label[];
  assignees: { login: string }[];
  milestone: Milestone | null;
};

const EMPTY: Draft = { title: "", body: "", labels: [], assignees: [], milestone: null };

// The form as typed, kept in the tab until it's created. (A signal read in the same tick as its
// write still gives the old value: code that acts on the form reads `draftNow`.)
let draftNow = EMPTY;
const [draft, setDraft] = createSignal<Draft>(draftNow);

/** Changes the form, unless a create of it is on its way: the draft is locked meanwhile. */
function change(patch: Partial<Draft>): void {
  if (sending) return;
  draftNow = { ...draftNow, ...patch };
  setDraft(draftNow);
}

// The create on its way, and how the last one ended: kept beside the draft rather than in the form,
// which closes when the user opens something else meanwhile. (`sending` is what code acts on, as
// `draftNow` is.)
let sending = false;
const [creating, setCreating] = createSignal(false);
const [slow, setSlow] = createSignal(false);
const [error, setError] = createSignal<Error>();
/** An issue created while the form was closed: where it went, until it's opened or dismissed. */
const [made, setMade] = createSignal<{ id: number; repo: string }>();
/** Opens a path from the form while it's on screen (the panel is on `/new`); unset otherwise. */
let openFromForm: ((path: string) => void) | undefined;

// The labels of the repo picks moved to are being checked: Create waits for them. `checkingFor`
// is that repo, and `awaiting` the labels the check is for (`follow`).
let checkingFor: number | undefined;
let awaiting: Label[] = [];
const [checking, setChecking] = createSignal(false);
/** The last check couldn't read the repo's labels, so the labels picked were dropped. */
const [dropped, setDropped] = createSignal(false);
/** The form's repo now, while the form is on screen. */
let formRepo: (() => number | undefined) | undefined;

// Text the tab would lose.
holdsText(() => draftNow.title.trim() !== "" || draftNow.body.trim() !== "");

function lastRepo(): number | undefined {
  try {
    const v = Number(localStorage.getItem(LAST_REPO));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function rememberRepo(id: number): void {
  try {
    localStorage.setItem(LAST_REPO, String(id));
  } catch {
    // Storage blocked: the next form starts from the view, or with no repo.
  }
}

/**
 * The repo a new form starts with: the first of the view's `repo:` values that it offers (as the
 * server reads them: `name` or `owner/name`, in any case), else the last repo used, else none.
 */
function defaultRepo(offered: Repo[], search: string): number | undefined {
  for (const t of tokenize(queryOf(search))) {
    if (t.key !== "repo" || !t.value) continue;
    const [owner, name] = t.value.includes("/") ? t.value.split("/", 2) : [undefined, t.value];
    const found = offered.find((r) => same(r.name, name!) && (owner === undefined || same(r.owner, owner)));
    if (found) return found.id;
  }
  const last = lastRepo();
  return offered.some((r) => r.id === last) ? last : undefined;
}

/**
 * Why a create failed, in the server's words where it has some (the API layer's for one beghu never
 * answered). A lost create says only what it is: it may have been made.
 */
function whyFailed(e: Error): string {
  if (e instanceof Lost) return e.message;
  // Their messages are the API layer's, not for the user.
  if (e instanceof NoAccess) return "Couldn't create the issue — you no longer have access to this repo";
  if (e instanceof ServerError) return "Couldn't create the issue — beghu failed on its side; check the list before trying again";
  const known =
    e instanceof Refused ||
    e instanceof RateLimited ||
    e instanceof Conflict ||
    e instanceof GitHubDown ||
    e instanceof Gone ||
    e instanceof Switched ||
    e instanceof Unreachable;
  return `Couldn't create the issue — ${known ? e.message : "Something went wrong"}`;
}

/** A pick over the form: what the pickers' op would have done to an issue. */
function picked(d: Draft, op: IssueOp, look?: Look): Partial<Draft> {
  switch (op.kind) {
    case "label_add":
      return d.labels.some((l) => same(l.name, op.label)) ? {} : { labels: [...d.labels, look?.label ?? { name: op.label, color: "ededed" }] };
    case "label_remove":
      return { labels: d.labels.filter((l) => !same(l.name, op.label)) };
    case "assignee_add":
      return d.assignees.some((u) => same(u.login, op.login)) ? {} : { assignees: [...d.assignees, { login: op.login }] };
    case "assignee_remove":
      return { assignees: d.assignees.filter((u) => !same(u.login, op.login)) };
    case "milestone_set":
      if (op.milestone === null) return { milestone: null };
      return { milestone: look?.milestone ?? { number: op.milestone, title: `#${op.milestone}`, state: "open", due_on: null } };
    default:
      return {};
  }
}

/**
 * Moves the form's picks to `repo`, the form's repo now, if they were made in another: the
 * milestone and assignees go, and the labels `repo` also has stay, by its names and colours (all go
 * if its labels can't be read, and the form says so). Create waits for the check.
 */
function follow(repo: number): void {
  const d = draftNow;
  if (sending || d.picksFor === undefined || d.picksFor === repo) return;
  // The labels a check still in flight was for count as picked: moved on again (A to B and back
  // to A), they aren't lost.
  const had = [...awaiting, ...d.labels.filter((l) => !awaiting.some((a) => same(a.name, l.name)))];
  change({ picksFor: repo, labels: [], assignees: [], milestone: null });
  setDropped(false);
  checkingFor = had.length > 0 ? repo : undefined;
  awaiting = had;
  setChecking(had.length > 0);
  if (had.length === 0) return;
  let unread = false;
  request<RepoLabel[]>(`/api/repos/${repo}/labels`)
    .catch((): RepoLabel[] => {
      unread = true;
      return [];
    })
    .then((offered) => {
      // A later move started a check of its own, which ends it.
      if (checkingFor !== repo) return;
      checkingFor = undefined;
      awaiting = [];
      setChecking(false);
      const kept = offered.filter((l) => had.some((h) => same(h.name, l.name))).map((l) => ({ name: l.name, color: l.color }));
      // Picks made meanwhile stay too.
      const added = draftNow.labels.filter((l) => !kept.some((k) => same(k.name, l.name)));
      change({ labels: [...kept, ...added] });
      setDropped(unread);
    });
}

/**
 * Sends the form as a new issue in `r`, once. It ends however the form is by then: open, it opens
 * the new issue (or shows the failure); closed, the status slot says how it went. The repo is
 * pinned to `r` as it goes, so the view's default changing meanwhile can't move the form.
 *
 * Create is disabled (`canCreate`) whenever this wouldn't send; should it be asked anyway, it
 * says why where the form shows: Creating… while one is on its way, the banner while writes are
 * paused (a stale tab, beghu or GitHub out of reach), the button disabled with no title or while labels are checked. Picks still in another
 * repo are moved to `r` (`follow`), which shows as their check.
 */
async function create(r: Repo): Promise<void> {
  const d = draftNow;
  const title = d.title.trim();
  if (sending || checkingFor !== undefined || !title || untrack(writesPaused)) return;
  if (d.picksFor !== undefined && d.picksFor !== r.id) {
    follow(r.id);
    return;
  }
  const read = r.role === "read";
  const op: CreateOp = {
    kind: "create",
    repo: r.id,
    title,
    body: d.body,
    labels: read ? [] : d.labels.map((l) => l.name),
    assignees: read ? [] : d.assignees.map((u) => u.login),
    milestone: read ? null : (d.milestone?.number ?? null),
  };
  change({ repo: r.id });
  sending = true;
  setCreating(true);
  setError(undefined);
  setMade(undefined);
  setCreateNote(undefined);
  const timer = setTimeout(() => setSlow(true), SLOW_MS);
  let reply: OpReply;
  try {
    reply = await sendOp(crypto.randomUUID(), op);
  } catch (e) {
    if (e instanceof SessionEnded) signIn();
    setError(e as Error);
    if (!openFromForm) setCreateNote({ failed: true, Note: CreateNote });
    return;
  } finally {
    clearTimeout(timer);
    sending = false;
    setCreating(false);
    setSlow(false);
    // The pin holds the repo, unless it left the offered ones meanwhile: picks follow the form's
    // repo now, as they would have (`follow` waits while a create is on its way).
    const now = formRepo?.();
    if (now !== undefined) follow(now);
  }
  rememberRepo(r.id);
  draftNow = EMPTY;
  setDraft(EMPTY);
  if (reply.unapplied) {
    const unapplied = reply.unapplied;
    const look = (o: IssueOp): Look | undefined => {
      if (o.kind === "label_add") return { label: d.labels.find((l) => same(l.name, o.label)) };
      if (o.kind === "milestone_set") return { milestone: d.milestone };
      return undefined;
    };
    // Without the writes code, what GitHub left out isn't flagged; the new issue shows what it has.
    await import("./writes").then(({ leftOut }) => leftOut(unapplied, `the new issue in ${r.name}`, look)).catch(() => {});
  }
  if (openFromForm) openFromForm(`/issues/${reply.issue}`);
  else {
    setMade({ id: reply.issue, repo: r.name });
    setCreateNote({ failed: false, Note: CreateNote });
  }
}

/**
 * The status slot's word on a create that ended while the form was closed: the new issue, with
 * Open, or the failure, with Open the form (which keeps the draft, and says why). Dismiss clears it.
 */
function CreateNote() {
  const location = useLocation();
  const dismiss = () => {
    setCreateNote(undefined);
    setMade(undefined);
  };
  return (
    <span data-perf="create-status">
      <Show
        when={made()}
        fallback={
          <Show when={error()}>
            {(e) => (
              <>
                <span {...stylex.attrs(s.failed)}>{whyFailed(e())}</span> ·{" "}
                <a href={`/new${location.search}`} noscroll {...stylex.attrs(link.button)}>
                  Open the form
                </a>{" "}
                ·{" "}
                <button type="button" {...stylex.attrs(link.button)} onClick={dismiss}>
                  Dismiss
                </button>
              </>
            )}
          </Show>
        }
      >
        {(m) => (
          <>
            Created the issue in {m().repo} ·{" "}
            <a href={`/issues/${m().id}${location.search}`} noscroll {...stylex.attrs(link.button)} onClick={dismiss}>
              Open
            </a>{" "}
            ·{" "}
            <button type="button" {...stylex.attrs(link.button)} onClick={dismiss}>
              Dismiss
            </button>
          </>
        )}
      </Show>
    </span>
  );
}

export function CreatePanel() {
  return (
    <Panel label="New issue" perf="create">
      <Errored fallback={(err, reset) => <FormFailure error={err()} reset={reset} />}>
        <Loading fallback={<div {...stylex.attrs(s.grow)} aria-busy="true" />}>
          <Form />
        </Loading>
      </Errored>
    </Panel>
  );
}

/** The account's repos didn't load: says so, with Retry (or, signed out, goes to sign in). */
function FormFailure(props: { error: unknown; reset: () => void }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.notice)} role="alert">
        Couldn't load your repos ·{" "}
        <button
          type="button"
          {...stylex.attrs(link.button)}
          onClick={() => {
            void revalidate(getMe.key);
            props.reset();
          }}
        >
          Retry
        </button>
      </p>
    </Failure>
  );
}

function Form() {
  const location = useLocation();
  const navigate = useNavigate();
  const me = createMemo(() => getMe());
  /** The repos a new issue can go in: the synced ones, but not those archived. */
  const offered = createMemo(() => me().repos.filter((r) => !r.archived));
  const repo = createMemo((): Repo | undefined => {
    const chosen = draft().repo;
    const id = offered().some((r) => r.id === chosen) ? chosen : defaultRepo(offered(), location.search);
    return offered().find((r) => r.id === id);
  });
  /** Read opens an issue with a title and body only. */
  const limited = () => repo()?.role === "read";
  /** Several owners: the repo is named in full. */
  const full = () => new Set(offered().map((r) => r.owner)).size > 1;
  const repoName = (r: Repo) => (full() ? `${r.owner}/${r.name}` : r.name);

  const [picking, setPicking] = createSignal<Prop>();
  let title!: HTMLInputElement;
  // On screen, the form opens the issue a create made; and a create that ended while it was
  // closed shows here now rather than in the status slot.
  openFromForm = (path) => navigate(path + location.search);
  formRepo = () => untrack(repo)?.id;
  onCleanup(() => {
    openFromForm = undefined;
    formRepo = undefined;
  });
  onSettled(() => {
    setCreateNote(undefined);
    title.focus();
  });

  // Picks follow the form's repo.
  createEffect(
    () => repo()?.id,
    (id) => {
      if (id !== undefined) follow(id);
    },
  );

  // Picks still in another repo are on their way to this one (`follow`).
  const picksHere = () => draft().picksFor === undefined || draft().picksFor === repo()?.id;
  const canCreate = () => repo() !== undefined && draft().title.trim() !== "" && !creating() && !checking() && picksHere() && !writesPaused();
  const submit = () => {
    const r = repo();
    if (!r) return;
    setPicking(undefined);
    void create(r);
  };
  // The keys that open a row's picker, as on an issue (keys.ts).
  const offer = (prop: Prop) =>
    touch(prop, () => {
      if (!limited() && !creating()) setPicking(prop);
    });
  offer("labels");
  offer("assignees");
  offer("milestone");

  const setOpen = (prop: Prop) => (open: boolean) => setPicking(open ? prop : undefined);
  const pick = (op: IssueOp, look?: Look) => change({ ...picked(draftNow, op, look), picksFor: repo()?.id });
  const pickable = (): Pickable => ({ id: 0, repo_id: repo()?.id ?? 0, labels: draft().labels, assignees: draft().assignees, milestone: draft().milestone });

  return (
    <form
      {...stylex.attrs(s.form)}
      data-perf="create-form"
      aria-busy={creating() ? "true" : "false"}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {/* Everything in the form is disabled while it's on its way. */}
      <fieldset disabled={creating()} {...stylex.attrs(s.fields)}>
        <div {...stylex.attrs(s.top)}>
          <h2 {...stylex.attrs(s.heading)}>New issue</h2>
          <span {...stylex.attrs(s.spacer)} />
          <a href={`/${location.search}`} noscroll {...stylex.attrs(s.close)} aria-label="Close the form" title="Close">
            ×
          </a>
        </div>
        <label {...stylex.attrs(s.field)}>
          <span {...stylex.attrs(s.label)}>Repo</span>
          <select
            {...stylex.attrs(s.input)}
            data-perf="create-repo"
            onChange={(e) => change({ repo: Number(e.currentTarget.value) || undefined })}
          >
            <Show when={repo() === undefined}>
              {/* Enabled: a select can't show a disabled option as its value. */}
              <option value="" selected>
                Choose a repo
              </option>
            </Show>
            <For each={offered()} keyed={(r) => r.id}>
              {(r) => (
                // Each option says whether it's chosen: the select's own value is set before its
                // options are there.
                <option value={r().id} selected={r().id === repo()?.id}>
                  {repoName(r())}
                </option>
              )}
            </For>
          </select>
        </label>
        <label {...stylex.attrs(s.field)}>
          <span {...stylex.attrs(s.label)}>Title</span>
          <input
            ref={title}
            type="text"
            {...stylex.attrs(s.input)}
            data-perf="create-title"
            required
            maxlength={MAX_TITLE}
            value={draft().title}
            onInput={(e) => change({ title: e.currentTarget.value })}
          />
        </label>
        <dl {...stylex.attrs(s.props)}>
          <PropRow prop="assignees" title="Assignees" disabled={limited()} open={picking() === "assignees"} setOpen={setOpen("assignees")} pickable={pickable()} onPick={pick}>
            <For each={draft().assignees} keyed={(u) => u.login} fallback={<span {...stylex.attrs(s.muted)}>No one</span>}>
              {(u) => (
                <span {...stylex.attrs(s.person)} data-perf="assignee">
                  <Avatar login={u().login} />
                  {u().login}
                </span>
              )}
            </For>
          </PropRow>
          <PropRow prop="labels" title="Labels" disabled={limited()} open={picking() === "labels"} setOpen={setOpen("labels")} pickable={pickable()} onPick={pick}>
            <For each={draft().labels} keyed={(l) => l.name} fallback={<span {...stylex.attrs(s.muted)}>None</span>}>
              {(l) => (
                <span {...stylex.attrs(s.pill)} data-perf="label">
                  <span {...stylex.attrs(s.dot(`#${l().color}`))} />
                  {l().name}
                </span>
              )}
            </For>
          </PropRow>
          <PropRow prop="milestone" title="Milestone" disabled={limited()} open={picking() === "milestone"} setOpen={setOpen("milestone")} pickable={pickable()} onPick={pick}>
            <Show when={draft().milestone} fallback={<span {...stylex.attrs(s.muted)}>None</span>}>
              {(m) => <span data-perf="milestone-title">{m().title}</span>}
            </Show>
          </PropRow>
        </dl>
        {/* One line, always there, so the role note moves nothing when the repo changes. */}
        <p {...stylex.attrs(s.roleLine)} data-perf="create-role">
          <Show when={limited() && repo()}>{(r) => <>You have Read on {r().name}: labels, assignees and milestone won't be sent.</>}</Show>
        </p>
        <label {...stylex.attrs(s.field, s.grow)}>
          <span {...stylex.attrs(s.label)}>Description</span>
          <textarea
            {...stylex.attrs(s.input, s.body)}
            data-perf="create-body"
            maxlength={MAX_BODY}
            rows={10}
            value={draft().body}
            onInput={(e) => change({ body: e.currentTarget.value })}
          />
        </label>
      </fieldset>
      <div {...stylex.attrs(s.actions)}>
        <span {...stylex.attrs(s.note)} role="status" data-perf="create-note">
          <Show when={made()}>
            {(m) => (
              <span data-perf="create-made">
                Created the issue in {m().repo} ·{" "}
                <a href={`/issues/${m().id}${location.search}`} noscroll {...stylex.attrs(link.button)} onClick={() => setMade(undefined)}>
                  Open
                </a>
              </span>
            )}
          </Show>
          <Show when={error()}>
            {(e) => (
              <span {...stylex.attrs(s.failed)} data-perf="create-failed">
                {whyFailed(e())} ·{" "}
                <button type="button" {...stylex.attrs(link.button)} disabled={!canCreate()} onClick={submit}>
                  Try again
                </button>
              </span>
            )}
          </Show>
          <Show when={slow()}>still sending…</Show>
          <Show when={dropped() && !error()}>
            <span data-perf="create-dropped">Couldn't read this repo's labels, so the labels picked were dropped.</span>
          </Show>
        </span>
        <button type="submit" {...stylex.attrs(s.button, s.primary)} data-perf="create-submit" disabled={!canCreate()}>
          {creating() ? "Creating…" : "Create issue"}
        </button>
      </div>
    </form>
  );
}

/**
 * One of the form's property rows, as the detail has them: its name, which opens its picker (and
 * is disabled where it is on a Read repo, its values kept, greyed), then the values picked.
 */
function PropRow(props: {
  prop: Prop;
  title: string;
  disabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  pickable: Pickable;
  onPick: (op: IssueOp, look?: Look) => void;
  children: Element;
}) {
  let button: HTMLButtonElement | undefined;
  const close = (refocus: boolean) => {
    props.setOpen(false);
    if (refocus) button?.focus();
  };
  return (
    <>
      <dt {...stylex.attrs(s.key)}>
        <button
          ref={button}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={props.open ? "true" : "false"}
          data-perf={`pick-${props.prop}`}
          disabled={props.disabled}
          {...stylex.attrs(s.keyButton)}
          onClick={() => props.setOpen(!props.open)}
        >
          {props.title}
        </button>
      </dt>
      <dd {...stylex.attrs(s.value, props.disabled && s.unsent)} data-perf={props.prop} data-unsent={props.disabled ? "true" : undefined}>
        {props.children}
        <Show when={props.open && !props.disabled}>
          <Errored fallback={(err, reset) => <PickerFailure error={err()} reset={reset} />}>
            <Loading>
              <DraftPicker prop={props.prop} d={props.pickable} onPick={props.onPick} onClose={close} opener={button} />
            </Loading>
          </Errored>
        </Show>
      </dd>
    </>
  );
}

/** The pickers' code didn't load: the URL reloads once, then it says so with Retry. */
function PickerFailure(props: { error: unknown; reset: () => void }) {
  const location = useLocation();
  const chunk = untrack(() => props.error instanceof ChunkFailed);
  const reloading = chunk && reloadOnce(location.pathname + location.search + location.hash);
  return (
    <Show when={!reloading}>
      <span {...stylex.attrs(s.muted)} role="alert">
        Couldn't load the picker ·{" "}
        <button type="button" {...stylex.attrs(link.button)} onClick={() => props.reset()}>
          Retry
        </button>
      </span>
    </Show>
  );
}

// Every value here is one the app already uses where it could be: StyleX's one stylesheet is
// first-load CSS.
const s = stylex.create({
  form: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  fields: {
    margin: 0,
    borderWidth: 0,
    gap: 10,
    paddingBlock: 12,
    paddingInline: 16,
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    overflowY: "auto",
  },
  top: {
    alignItems: "center",
    display: "flex",
  },
  heading: {
    margin: 0,
    fontSize: 18,
    fontWeight: 600,
  },
  spacer: {
    flexGrow: 1,
  },
  close: {
    textDecoration: "none",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
    fontSize: 12,
  },
  field: {
    gap: 4,
    display: "flex",
    flexDirection: "column",
  },
  label: {
    color: colors.muted,
    fontSize: 12,
  },
  input: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 10,
    backgroundColor: colors.bg,
    color: colors.fg,
  },
  body: {
    flexGrow: 1,
    resize: "vertical",
    minHeight: 160,
  },
  grow: {
    flexGrow: 1,
  },
  props: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: "88px minmax(0, 1fr)",
  },
  key: {
    paddingBlock: 4,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "20px",
  },
  // A row's name as the button that opens its picker: it reads as the name, with a hover.
  keyButton: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: {
      default: null,
      ":disabled": "line-through",
    },
    backgroundColor: "transparent",
    color: {
      default: colors.muted,
      ":disabled": colors.muted,
      ":hover": colors.fg,
    },
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    textAlign: "start",
  },
  value: {
    margin: 0,
    gap: 4,
    paddingBlock: 4,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    position: "relative",
    minHeight: 20,
    minWidth: 0,
  },
  // Picked on a Read repo: kept, greyed, and not sent.
  unsent: {
    color: colors.muted,
  },
  roleLine: {
    margin: 0,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "16px",
    minHeight: 16,
  },
  person: {
    gap: 5,
    alignItems: "center",
    display: "inline-flex",
    paddingInlineEnd: 6,
  },
  pill: {
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 5,
    paddingInline: 7,
    alignItems: "center",
    display: "inline-flex",
    fontSize: 11.5,
    height: 18,
  },
  // A dynamic style sets only `color`, painted through currentColor: see the list's label dot
  // (IssueList.tsx) for why.
  dot: (color: string) => ({
    borderRadius: "50%",
    backgroundColor: "currentColor",
    color,
    flexShrink: 0,
    height: 8,
    width: 8,
  }),
  muted: {
    color: colors.muted,
  },
  actions: {
    gap: 8,
    paddingBlock: 12,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    flexShrink: 0,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  note: {
    overflow: "hidden",
    color: colors.muted,
    flexGrow: 1,
    fontSize: 12,
    minWidth: 0,
  },
  failed: {
    color: colors.danger,
  },
  notice: {
    margin: 0,
    padding: 24,
    color: colors.muted,
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
    flexShrink: 0,
    opacity: {
      default: null,
      ":disabled": 0.5,
    },
  },
  primary: {
    backgroundColor: {
      default: colors.accent,
      ":hover": colors.accent,
    },
    color: colors.accentFg,
  },
});
