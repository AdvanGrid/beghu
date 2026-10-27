// Writes: the tab's pending writes, the composer with Close and Reopen, and how writes show. A
// chunk of its own, which the issue panel loads with its composer: until it has loaded the tab
// has made no writes. As it loads it fills in the overlay (overlay.ts) the list, the detail and
// the status slot go through.
//
// A **pending write** lives only in this tab. Each is one op (`POST /api/ops`), shown at once by a
// pure, idempotent apply over whatever the server sent, and marked with a blinking dot:
// - It shows over a read that began before GitHub confirmed it, and stops showing over one that
//   began after, since the server writes GitHub's answer to the mirror before it replies. So a
//   view drops it only once a read that began after the confirmation is on screen, whatever
//   order reads and the reply land in; a confirmed write then asks for such a read itself.
// - It never changes which rows a list holds, their order, or a facet's count: only the row's own
//   fields.
// - A dropped connection resends the same `op_id` (see `sendOp`): nothing is sent to GitHub
//   twice. After 15 s without an answer it shows "still sending…", with no Retry.
// - A **failed write** reverts at once and stays visible until the user retries or dismisses it
//   (or reloads): a close or reopen on its own row, a comment in the thread as "not sent", and a
//   failure on an issue that isn't open in the status slot.
// - A **lost write** (the server lost track of it, or the resends ran out) and a **maybe-posted**
//   comment (GitHub failed on it, answered it unreadably or didn't answer) may have reached GitHub
//   all the same, and say so. Such a comment looks for itself in the thread: one comment by the
//   same account with its text, newer than any it could be confused with, settles it as posted;
//   none, or more than one, and it offers Retry. Until then it offers only Edit.
//
// Leaving the page asks first only while there's unsaved text: a draft, or a comment not sent.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { useLocation } from "@solidjs/router";
import {
  Conflict,
  GitHubDown,
  Gone,
  Lost,
  MaybePosted,
  RateLimited,
  Refused,
  SessionEnded,
  Unreachable,
  getComments,
  getMe,
  issueId,
  sendOp,
  signIn,
  type Comment,
  type IssueDetail,
  type IssueRow,
  type Op,
  type OpReply,
} from "./api";
import { githubDown, reconnecting, refetchShown } from "./live";
import { setOverlay, type ShownComment } from "./overlay";
import { colors } from "./tokens.stylex";

// --- the pending writes --------------------------------------------------------------------------

interface Pending {
  /** The op's id: a resend carries the same one. */
  id: string;
  op: Op;
  /** The issue as the user knows it, for the status slot: `web#12`. */
  ref: string;
  /** The id a pending comment has in the thread until GitHub's comment replaces it: negative,
   * which no real comment's is. */
  commentId: number;
  /** The account that wrote it, for a pending comment's byline. */
  author: string;
  /** Unix seconds, when the user made it. */
  createdAt: number;
  /** The newest comment id the tab had seen on the issue when the user made it. */
  seen: number;
  /** On its way; confirmed by GitHub; or refused, or never arrived. */
  phase: "sending" | "sent" | "failed";
  /** A comment that may have been posted has looked for itself in the thread, and didn't find
   * itself there as one comment. */
  looked?: boolean;
  /** No answer for 15 s. */
  slow: boolean;
  /** When the confirmation came (`performance.now()`): reads that began after it show the write. */
  sentAt?: number;
  reply?: OpReply;
  error?: Error;
}

/** How long a write waits for an answer before it shows "still sending…". */
const SLOW_MS = 15_000;
/**
 * When a comment that may have been posted looks for itself in the thread, counted from when it
 * failed: at 0, 2 and 5 s, while GitHub's webhook for it (about a second behind) may be on its way.
 */
const LOOK_AFTER_MS = [0, 2_000, 5_000];

// The writes and drafts as they are now, for code that acts on them; the signals carry each change
// to what renders them. (A signal read in the same tick as its write still gives the old value.)
let pendingNow: Pending[] = [];
let draftsNow: ReadonlyMap<number, string> = new Map();
const [ops, setOps] = createSignal<Pending[]>(pendingNow);
/** Unsent comment text, per issue. */
const [drafts, setDrafts] = createSignal(draftsNow);
/** How many writes this tab has made: each pending comment's id is the next negative number. */
let writesMade = 0;
/** Per issue, the newest comment id the tab has seen in a detail. */
const newestSeen = new Map<number, number>();
/** The comments this tab's writes turned out to be: a write that may have been posted is none of them. */
const claimed = new Set<number>();

function commit(next: Pending[]): void {
  pendingNow = next;
  setOps(next);
}

function find(id: string): Pending | undefined {
  return pendingNow.find((p) => p.id === id);
}

function patch(id: string, change: Partial<Pending>): void {
  commit(pendingNow.map((p) => (p.id === id ? { ...p, ...change } : p)));
}

function drop(id: string): void {
  commit(pendingNow.filter((p) => p.id !== id));
}

function setDraft(issue: number, text: string): void {
  const next = new Map(draftsNow);
  if (text) next.set(issue, text);
  else next.delete(issue);
  draftsNow = next;
  setDrafts(next);
}

/**
 * Makes a write and sends it. A close or reopen supersedes the issue's earlier failed ones: the
 * user has chosen its state again.
 */
function write(op: Op, ref: string, author: string): void {
  const p: Pending = {
    id: crypto.randomUUID(),
    op,
    ref,
    commentId: -++writesMade,
    author,
    createdAt: Math.floor(Date.now() / 1000),
    seen: newestSeen.get(op.issue) ?? 0,
    phase: "sending",
    slow: false,
  };
  const superseded = (q: Pending) => op.kind !== "comment" && q.op.kind !== "comment" && q.op.issue === op.issue && q.phase === "failed";
  commit([...pendingNow.filter((q) => !superseded(q)), p]);
  setTimeout(() => {
    if (find(p.id)?.phase === "sending") patch(p.id, { slow: true });
  }, SLOW_MS);
  void send(p.id);
}

/** Sends write `id` and settles it: confirmed, or failed with how. */
async function send(id: string): Promise<void> {
  const p = find(id)!;
  try {
    confirm(id, await sendOp(p.id, p.op));
  } catch (e) {
    if (e instanceof SessionEnded) signIn();
    patch(id, { phase: "failed", error: e as Error });
    if (p.op.kind === "comment" && howFailed(find(id)!).unsure) void lookInThread(id);
  }
}

/** GitHub has write `id`: a read that begins now shows it; until one is on screen, the write shows over it. */
function confirm(id: string, reply: OpReply): void {
  const p = find(id);
  if (!p) return;
  if (reply.comment) claimed.add(reply.comment.id);
  patch(id, { phase: "sent", sentAt: performance.now(), reply, error: undefined });
  refetchShown([p.op.issue]);
}

/**
 * For a comment that may have been posted: looks for it in the thread, newest first, a few times
 * while GitHub's webhook may still be on its way. It can only be a comment by the same account
 * with the same text, newer than the newest the server had as it was sent (or, for a lost write,
 * the newest this tab had seen when the user made it), and not one another of this tab's writes
 * turned out to be. Exactly one such comment is it: it settles as posted. None, or more than one
 * (which can't be told apart), and it offers Retry.
 */
async function lookInThread(id: string): Promise<void> {
  let waited = 0;
  for (const at of LOOK_AFTER_MS) {
    await new Promise((r) => setTimeout(r, at - waited));
    waited = at;
    const p = find(id);
    if (p?.phase !== "failed" || p.op.kind !== "comment") return;
    const { issue, body } = p.op;
    const after = (p.error instanceof MaybePosted ? p.error.after : undefined) ?? p.seen;
    try {
      const page = await getComments(issue, "newest");
      const could = page.comments.filter((c) => c.id > after && !claimed.has(c.id) && c.author?.login === p.author && c.body === body);
      if (could.length === 1) return confirm(id, { issue, comment: could[0]! });
      if (could.length > 1) break;
    } catch {
      // The next look, or Retry.
    }
  }
  if (find(id)?.phase === "failed") patch(id, { looked: true });
}

/** Sends a failed write again, as a new op: the server remembers the old one's failure. */
function retry(p: Pending): void {
  drop(p.id);
  write(p.op, p.ref, p.author);
}

/** Whether `p` shows over a read that began at `at`. */
function shows(p: Pending, at: number): boolean {
  return p.phase === "sending" || (p.phase === "sent" && at < p.sentAt!);
}

/** The close or reopen writes on `issue` showing over a read from `at`, applied in order. */
function withState<T extends { id: number; state: string; state_reason: string | null }>(x: T, at: number): T {
  let out = x;
  for (const p of ops()) {
    if (p.op.issue !== x.id || !shows(p, at)) continue;
    if (p.op.kind === "close") out = { ...out, state: "closed", state_reason: p.op.reason };
    else if (p.op.kind === "reopen") out = { ...out, state: "open", state_reason: "reopened" };
  }
  return out;
}

/** When the list and the open detail last showed a read: a confirmed write goes once neither is older. */
let listAt = -Infinity;
let detailAt: { issue: number; at: number } | undefined;
let sweeping = false;

/** Drops the confirmed writes every view has caught up with. */
function sweep(): void {
  if (sweeping) return;
  sweeping = true;
  queueMicrotask(() => {
    sweeping = false;
    const behind = (p: Pending) => listAt < p.sentAt! || (detailAt?.issue === p.op.issue && detailAt.at < p.sentAt!);
    if (pendingNow.some((p) => p.phase === "sent" && !behind(p))) commit(pendingNow.filter((p) => p.phase !== "sent" || behind(p)));
  });
}

function rowWithWrites(r: IssueRow, at: number): IssueRow {
  return withState(r, at);
}

function listShown(at: number): void {
  listAt = Math.max(listAt, at);
  sweep();
}

function detailShown(issue: number, at: number): void {
  detailAt = { issue, at };
  sweep();
}

function detailWithWrites(d: IssueDetail, at: number): IssueDetail {
  for (const c of d.comments.comments) if (c.id > (newestSeen.get(d.id) ?? 0)) newestSeen.set(d.id, c.id);
  const out = withState(d, at);
  const real = new Set(d.comments.comments.map((c) => c.id));
  const mine: ShownComment[] = [];
  for (const p of ops()) {
    if (p.op.kind !== "comment" || p.op.issue !== d.id) continue;
    // Once the thread has the real comment, it shows instead, whatever the read's age.
    const confirmed = p.reply?.comment;
    if (confirmed && real.has(confirmed.id)) continue;
    if (p.phase !== "failed" && !shows(p, at)) continue;
    mine.push({ ...pendingComment(p), op: p.id });
  }
  if (mine.length === 0) return out;
  const comments: ShownComment[] =
    d.comment_order === "newest" ? [...mine.reverse(), ...d.comments.comments] : [...d.comments.comments, ...mine];
  return { ...out, comments: { ...d.comments, comments } };
}

function pendingComment(p: Pending): Comment {
  const body = p.op.kind === "comment" ? p.op.body : "";
  return { id: p.commentId, author: { login: p.author }, body, created_at: p.createdAt, updated_at: p.createdAt };
}

// Text the tab would lose: a draft, or a comment GitHub never got.
addEventListener("beforeunload", (e) => {
  const unsent = pendingNow.some((p) => p.op.kind === "comment" && p.phase === "failed");
  if (unsent || [...draftsNow.values()].some((t) => t.trim())) e.preventDefault();
});

// --- how writes show ------------------------------------------------------------------------------

const VERB: Record<Op["kind"], string> = { comment: "comment on", close: "close", reopen: "reopen" };

const NOUN: Record<Op["kind"], string> = { comment: "Comment", close: "Close", reopen: "Reopen" };

/**
 * How a failed write reads. `unsure`: it may have reached GitHub after all (a lost write, or a
 * maybe-posted comment), and says to check. `why`: the message, which the server words for the
 * user (the API layer for a write beghu never answered). `retry`: sending it again can work; a
 * comment that may be there offers it only once it has looked in the thread and isn't there.
 */
function howFailed(p: Pending): { unsure: boolean; why: string; retry: boolean } {
  const e = p.error;
  const unsure = e instanceof Lost || e instanceof MaybePosted;
  const known =
    unsure ||
    e instanceof Gone ||
    e instanceof Refused ||
    e instanceof RateLimited ||
    e instanceof Conflict ||
    e instanceof GitHubDown ||
    e instanceof Unreachable;
  const retry = e instanceof Refused ? e.retry : !(unsure && p.op.kind === "comment" && !p.looked);
  return { unsure, why: known ? e.message : "Something went wrong", retry };
}

/** A failed write in a line, on `ref` if given: what didn't happen, or what may have. */
function failedLine(p: Pending, ref?: string): string {
  const f = howFailed(p);
  if (f.unsure) return `${NOUN[p.op.kind]}${ref === undefined ? "" : ` on ${ref}`} — ${f.why}`;
  return `Couldn't ${VERB[p.op.kind]}${ref === undefined ? "" : ` ${ref}`} — ${f.why}`;
}

function Dot() {
  return <span {...stylex.attrs(s.dot)} data-perf="pending" aria-label="Sending" />;
}

/**
 * Retry when sending again can work, Edit with `edit`, Open with `open` (a link to the issue), and
 * Dismiss (Discard for a comment), as small text buttons.
 */
function Actions(props: { p: Pending; open?: string; edit?: () => void }) {
  return (
    <>
      <Show when={howFailed(props.p).retry}>
        {" · "}
        <button type="button" {...stylex.attrs(s.link)} disabled={githubDown()} onClick={() => retry(props.p)}>
          Retry
        </button>
      </Show>
      <Show when={props.edit}>
        {(edit) => (
          <>
            {" · "}
            <button type="button" {...stylex.attrs(s.link)} onClick={() => edit()()}>
              Edit
            </button>
          </>
        )}
      </Show>
      <Show when={props.open}>
        {(href) => (
          <>
            {" · "}
            <a href={href()} noscroll {...stylex.attrs(s.link)}>
              Open
            </a>
          </>
        )}
      </Show>
      {" · "}
      <button type="button" {...stylex.attrs(s.link)} onClick={() => drop(props.p.id)}>
        {props.p.op.kind === "comment" ? "Discard" : "Dismiss"}
      </button>
    </>
  );
}

/** Beside the open issue's state: a dot while its close or reopen is pending, or its failure. */
function StateNote(props: { issue: number; at: number }) {
  const last = createMemo(() => ops().findLast((p) => p.op.issue === props.issue && p.op.kind !== "comment"));
  return (
    <span id={`state-note-${props.issue}`} {...stylex.attrs(s.note, s.restOfRow)} data-perf="state-note">
      <Show when={last()}>
        {(p) => (
          <Show when={p().phase === "failed"} fallback={<Show when={shows(p(), props.at)}>
            <Dot />
          </Show>}>
            <span {...stylex.attrs(s.failed, s.clip)} title={howFailed(p()).why}>
              {failedLine(p())}
            </span>
            <Actions p={p()} />
          </Show>
        )}
      </Show>
    </span>
  );
}

/** The longest comment GitHub takes, in characters. */
const MAX_COMMENT = 65_536;

/** The open issue's comment box, for Edit to put a comment's text back in. */
let composerBox: HTMLTextAreaElement | undefined;

/** On a pending comment: a dot ("still sending…" after 15 s); on a failed one, "not sent". */
function CommentNote(props: { op: string; at: number }) {
  const p = () => ops().find((p) => p.id === props.op);
  const edit = (p: Pending) => () => {
    if (p.op.kind !== "comment") return;
    const now = draftsNow.get(p.op.issue)?.trim();
    setDraft(p.op.issue, now ? `${now}\n\n${p.op.body}` : p.op.body);
    drop(p.id);
    composerBox?.focus();
  };
  return (
    <Show when={p()}>
      {(p) => (
        <span {...stylex.attrs(s.note)} data-perf="comment-note">
          <Show when={p().phase === "failed"} fallback={<>
            <Dot />
            <Show when={p().slow && p().phase === "sending"}>still sending…</Show>
          </>}>
            <span {...stylex.attrs(s.failed)}>{howFailed(p()).unsure ? howFailed(p()).why : `Not sent — ${howFailed(p()).why}`}</span>
            <Actions p={p()} edit={edit(p())} />
          </Show>
        </span>
      )}
    </Show>
  );
}

/**
 * The status slot (a live region). Failed writes on issues that aren't open come first and never
 * time out: one shows whole, with Retry, Open and Dismiss; two or more collapse to "n changes
 * failed", which opens the list. The quiet states (sending, reconnecting) show alone, or behind an
 * icon beside a failure, which shows them; hidden, their text is still there for screen readers.
 */
function Status() {
  const location = useLocation();
  const open = () => issueId(/^\/issues\/([^/]+)$/.exec(location.pathname)?.[1]);
  const failed = createMemo(() => ops().filter((p) => p.phase === "failed" && p.op.issue !== open()));
  const sending = createMemo(() => ops().filter((p) => p.phase === "sending"));
  const quiet = () => {
    const n = sending().length;
    if (n > 0) return sending().some((p) => p.slow) ? "still sending…" : `sending ${n} ${n === 1 ? "change" : "changes"}…`;
    return reconnecting() ? "reconnecting…" : undefined;
  };
  const [listing, setListing] = createSignal(false);
  const [showQuiet, setShowQuiet] = createSignal(false);
  const line = (p: Pending) => (
    <>
      <span {...stylex.attrs(s.failed)}>{failedLine(p, p.ref)}</span>
      <Actions p={p} open={`/issues/${p.op.issue}${location.search}`} />
    </>
  );
  return (
    <Show when={failed().length > 0} fallback={quiet()}>
      <Show when={failed().length > 1} fallback={line(failed()[0]!)}>
        <span {...stylex.attrs(s.split)}>
        <button type="button" {...stylex.attrs(s.link, s.failed)} aria-expanded={listing() ? "true" : "false"} onClick={() => setListing((v) => !v)}>
          {failed().length} changes failed
        </button>
        <Show when={listing()}>
          <span {...stylex.attrs(s.menu)} data-perf="failures">
            <For each={failed()} keyed={(p) => p.id}>
              {(p) => (
                <span {...stylex.attrs(s.failure)} data-perf="failure">
                  {line(p())}
                </span>
              )}
            </For>
          </span>
        </Show>
        </span>
      </Show>
      <Show when={quiet()}>
        {(q) => (
          <span {...stylex.attrs(s.quiet)} data-perf="quiet">
            <button
              type="button"
              {...stylex.attrs(s.link, s.icon)}
              aria-label={q()}
              title={q()}
              aria-expanded={showQuiet() ? "true" : "false"}
              onClick={() => setShowQuiet((v) => !v)}
            >
              ⋯
            </button>
            <span {...stylex.attrs(!showQuiet() && s.visuallyHidden)}>{q()}</span>
          </span>
        )}
      </Show>
    </Show>
  );
}

/**
 * While the server finds GitHub unreachable, a banner says so under the header. Comment, Close and
 * Reopen are disabled meanwhile, and the composer keeps its text. (The tab's other banners, for
 * an account switch and for beghu itself being unreachable, come later and go before this one.)
 */
function Banner() {
  return (
    <Show when={githubDown()}>
      <p role="alert" data-perf="banner" {...stylex.attrs(s.banner)}>
        GitHub is unreachable. Writes are paused until it's back; your text is kept.
      </p>
    </Show>
  );
}

/**
 * The pinned composer under the detail: the comment box, Comment, and Close (as completed, or
 * as not planned from its menu) or Reopen. While GitHub is unreachable, Comment, Close and
 * Reopen are disabled and the text stays. A button stays disabled while its write is pending.
 */
export function Composer(props: { d: IssueDetail }) {
  const me = createMemo(() => getMe());
  const issue = () => props.d.id;
  const ref = () => `${props.d.repo}#${props.d.number}`;
  const text = () => drafts().get(issue()) ?? "";
  const inFlight = (kinds: readonly Op["kind"][]) => ops().some((p) => p.phase === "sending" && p.op.issue === issue() && kinds.includes(p.op.kind));
  /** A close or reopen of this issue is on its way. */
  const changingState = () => inFlight(["close", "reopen"]);
  /** A comment on this issue is on its way. */
  const commenting = () => inFlight(["comment"]);
  const [menu, setMenu] = createSignal(false);
  const author = () => {
    try {
      return me().account.login;
    } catch {
      return "you";
    }
  };
  const comment = () => {
    const body = draftsNow.get(issue()) ?? "";
    const sending = pendingNow.some((p) => p.phase === "sending" && p.op.kind === "comment" && p.op.issue === issue());
    if (!body.trim() || githubDown() || sending) return;
    write({ kind: "comment", issue: issue(), body }, ref(), author());
    setDraft(issue(), "");
  };
  const setState = (op: Op) => {
    setMenu(false);
    write(op, ref(), author());
  };
  let box!: HTMLTextAreaElement;
  onCleanup(() => {
    if (composerBox === box) composerBox = undefined;
  });
  return (
    <div {...stylex.attrs(s.composer)} data-perf="composer">
      <textarea
        ref={(el) => {
          box = el;
          composerBox = el;
        }}
        value={text()}
        maxlength={MAX_COMMENT}
        {...stylex.attrs(s.box)}
        aria-label="Comment"
        placeholder="Leave a comment"
        rows={3}
        onInput={(e) => setDraft(issue(), e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            comment();
          }
        }}
      />
      <div {...stylex.attrs(s.actions)}>
        <Show
          when={props.d.state === "open"}
          fallback={
            <button type="button" {...stylex.attrs(s.button)} disabled={githubDown() || changingState()} onClick={() => setState({ kind: "reopen", issue: issue() })}>
              Reopen issue
            </button>
          }
        >
          <span {...stylex.attrs(s.split)}>
            <button
              type="button"
              {...stylex.attrs(s.button)}
              disabled={githubDown() || changingState()}
              onClick={() => setState({ kind: "close", issue: issue(), reason: "completed" })}
            >
              Close issue
            </button>
            <button
              type="button"
              {...stylex.attrs(s.button)}
              aria-label="More ways to close"
              aria-expanded={menu() ? "true" : "false"}
              disabled={githubDown() || changingState()}
              onClick={() => setMenu((v) => !v)}
            >
              ▾
            </button>
            <Show when={menu()}>
              <span {...stylex.attrs(s.menu)} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  {...stylex.attrs(s.button)}
                  disabled={githubDown() || changingState()}
                  onClick={() => setState({ kind: "close", issue: issue(), reason: "completed" })}
                >
                  Close as completed
                </button>
                <button
                  type="button"
                  role="menuitem"
                  {...stylex.attrs(s.button)}
                  disabled={githubDown() || changingState()}
                  onClick={() => setState({ kind: "close", issue: issue(), reason: "not_planned" })}
                >
                  Close as not planned
                </button>
              </span>
            </Show>
          </span>
        </Show>
        <span {...stylex.attrs(s.spacer)} />
        <button type="button" {...stylex.attrs(s.button, s.primary)} disabled={!text().trim() || githubDown() || commenting()} onClick={comment}>
          Comment
        </button>
      </div>
    </div>
  );
}

setOverlay({ rowWithWrites, listShown, detailWithWrites, detailShown, Status, Banner, StateNote, CommentNote });

const blink = stylex.keyframes({
  "50%": { opacity: 0.25 },
});

const s = stylex.create({
  dot: {
    borderRadius: "50%",
    animationDuration: "1s",
    animationIterationCount: "infinite",
    animationName: {
      default: blink,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    backgroundColor: colors.accent,
    display: "inline-block",
    flexShrink: 0,
    height: 8,
    width: 8,
  },
  note: {
    gap: 4,
    alignItems: "center",
    display: "inline-flex",
    fontSize: 12,
    paddingInlineStart: 8,
    minWidth: 0,
  },
  // In the status row: the room the row has left, and no more.
  restOfRow: {
    flexBasis: 0,
    flexGrow: 1,
  },
  clip: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  failed: {
    color: colors.danger,
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
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
  },
  failure: {
    paddingBlock: 4,
    paddingInline: 10,
  },
  // Beside a failure in the status slot: the quiet state, behind its icon.
  quiet: {
    gap: 4,
    display: "inline-flex",
    paddingInlineStart: 8,
  },
  icon: {
    textDecoration: "none",
    minHeight: 24,
    minWidth: 24,
  },
  // Out of sight, still read out.
  visuallyHidden: {
    overflow: "hidden",
    clipPath: "inset(50%)",
    position: "absolute",
    whiteSpace: "nowrap",
    height: 1,
    width: 1,
  },
  composer: {
    gap: 8,
    paddingBlock: 12,
    paddingInline: 16,
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  // Every value here is one the app already uses: StyleX's one stylesheet is first-load CSS.
  box: {
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
  actions: {
    gap: 8,
    alignItems: "center",
    display: "flex",
  },
  split: {
    display: "inline-flex",
    position: "relative",
  },
  // Above what opens it: the close menu, and the list of failed writes.
  menu: {
    borderColor: colors.line,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    backgroundColor: colors.bgRaised,
    display: "flex",
    flexDirection: "column",
    position: "absolute",
    whiteSpace: "nowrap",
    bottom: "100%",
    left: 0,
  },
  spacer: {
    flexGrow: 1,
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
