// The title and body editors: a chunk of their own, loaded when one first opens (IssuePanel.tsx).
// Their state is in editing.ts, which says how they behave; edits go out through writes.tsx.
//
// The title edits in a one-line box (Enter saves, Escape cancels), the body in a textarea (Ctrl or
// Cmd+Enter saves, Escape cancels): each a form marked `data-keys="editor"`, which offers
// `saveEdit` and `cancelEdit` (keys.ts) while it holds the focus. A live push that changes the
// field under edit says "Changed since you started editing" at once. A 409 keeps the user's text
// and shows GitHub's beside it, with "Overwrite with mine" (sent again over GitHub's text) and
// "Discard mine" (the editor closes on GitHub's). While writes are paused (a banner shows: the tab
// is stale, or beghu or GitHub can't be reached), Save is disabled, the editor says why, and the
// text stays.
import * as stylex from "@stylexjs/stylex";
import { createMemo, Errored, Loading, onCleanup, onSettled, runWithOwner, Show, untrack } from "solid-js";
import { Changed, SessionEnded, getSource, signIn, type IssueDetail } from "./api";
import type { IssueSource } from "./bindings/IssueSource";
import { closeEditor, editorNow, editorOf, sameText, updateEditor, type Field } from "./editing";
import { touch } from "./keys";
import { writesPaused } from "./live";
import type { ShownDetail } from "./overlay";
import { md } from "./md/tokens.stylex";
import { colors, fonts } from "./tokens.stylex";
import { failure, forget, sendEdit, worded } from "./writes";

/** The longest title GitHub takes, in characters. */
const MAX_TITLE = 256;
/** The longest body GitHub takes, in characters. */
const MAX_BODY = 65_536;

type Props = {
  /** The open issue as the server sent it, for what's on GitHub now. */
  raw: IssueDetail;
  /** The same with the tab's writes on it. */
  d: ShownDetail;
  /** The editor closed or saved: the focus goes back to the issue. */
  done: () => void;
};

/** The title editor of the open issue. */
export function TitleEditor(props: Props) {
  return <EditorForm field="title" {...props} />;
}

/**
 * The body editor of the open issue. Until the user types, it shows the body's Markdown as read
 * from the server as it opened; an editor that has text already (open again after a failure, or
 * on coming back to the issue) reads nothing.
 */
export function BodyEditor(props: Props) {
  const cancel = () => {
    closeEditor(props.raw.id, "body");
    props.done();
  };
  return (
    <Errored
      fallback={(err, reset) => (
        <p {...stylex.attrs(s.failed)} role="alert" data-perf="edit-source-failed">
          Couldn't open the description: {whyNot(err())} ·{" "}
          <button
            type="button"
            {...stylex.attrs(s.link)}
            onClick={() => {
              if (err() instanceof SessionEnded) return signIn();
              reset();
            }}
          >
            Retry
          </button>{" "}
          ·{" "}
          <button type="button" {...stylex.attrs(s.link)} onClick={cancel}>
            Cancel
          </button>
        </p>
      )}
    >
      <Loading
        fallback={
          <p {...stylex.attrs(s.loading)} aria-busy="true">
            Loading…
          </p>
        }
      >
        <SourceForm {...props} />
      </Loading>
    </Errored>
  );
}

function SourceForm(props: Props) {
  const id = untrack(() => props.raw.id);
  // Read once, as the editor opens, and only if it has no text yet.
  const source = createMemo((): IssueSource | undefined | Promise<IssueSource> => (editorNow(id, "body")?.base === undefined ? getSource(id) : undefined));
  return <EditorForm field="body" source={source()} {...props} />;
}

/** Why a read or a write failed, in the server's words where it has some. */
function whyNot(e: unknown): string {
  return worded(e) ? e.message : "something went wrong";
}

/**
 * An edit settled: GitHub has it (the editor closes for good), or it failed (the editor shows
 * how). A 409 brings GitHub's text, and for a body its digest: an "Overwrite with mine" is made
 * over that text, so a later live change is told from it.
 */
function settled(issue: number, field: Field, op: string, error?: Error): void {
  if (editorNow(issue, field)?.op !== op) return;
  if (!error) return closeEditor(issue, field);
  if (error instanceof Changed) return updateEditor(issue, field, { saving: false, error, theirs: error.current, digest: error.digest });
  updateEditor(issue, field, { saving: false, error, theirs: undefined });
}

/** Status-bar Retry sent a failed edit again as `op`: the editor waits on it, hidden. */
function resent(issue: number, field: Field, op: string): void {
  updateEditor(issue, field, { op, saving: true, error: undefined, theirs: undefined });
}

function EditorForm(props: Props & { field: Field; source?: IssueSource }) {
  const issue = () => props.raw.id;
  const field = untrack(() => props.field);
  const e = () => editorOf(issue(), field);
  /** What the editor opened with: a body's, the source read, until the user types. */
  const base = () => e()?.base ?? props.source?.body ?? "";
  const text = () => e()?.text ?? props.source?.body ?? "";
  const theirs = () => e()?.theirs;
  const conflict = () => theirs() !== undefined;
  /** The field changed on GitHub since the editor opened: a live push brought it. */
  const changed = () => {
    if (conflict()) return false;
    if (field === "title") return props.d.title !== base();
    const digest = e()?.digest ?? props.source?.body_digest;
    return digest !== undefined && props.raw.body_digest !== digest;
  };
  const why = () => {
    const op = e()?.op;
    if (op === undefined || conflict()) return undefined;
    return failure(op)?.why ?? (e()?.error ? whyNot(e()!.error) : undefined);
  };
  const blank = () => field === "title" && !text().trim();

  const setText = (t: string) => {
    const now = editorNow(issue(), field);
    if (now?.base !== undefined) return updateEditor(issue(), field, { text: t });
    // The first keystroke in a body editor pins what it opened with.
    updateEditor(issue(), field, { text: t, base: props.source?.body ?? "", digest: props.source?.body_digest });
  };
  const close = () => {
    const r = editorNow(issue(), field);
    if (r?.op) forget(r.op);
    closeEditor(issue(), field);
    props.done();
  };
  /** Save, or "Overwrite with mine" after a 409: over GitHub's text then. */
  const save = () => {
    const r = editorNow(issue(), field);
    if (!r || r.saving || writesPaused()) return;
    const mine = r.text ?? props.source?.body ?? "";
    const opened = r.base ?? props.source?.body ?? "";
    if (field === "title" && !mine.trim()) return;
    // Nothing changed: nothing to send.
    if (r.theirs === undefined && sameText(field, mine, opened)) return close();
    const over = r.theirs ?? opened;
    if (r.op) forget(r.op);
    const op = field === "title" ? ({ kind: "title_edit", issue: issue(), new: mine, base: over } as const) : ({ kind: "body_edit", issue: issue(), new: mine, base: over } as const);
    const id = sendEdit(op, props.d, { sent: (id) => resent(op.issue, field, id), settled: (id, error) => settled(op.issue, field, id, error) });
    updateEditor(issue(), field, { op: id, saving: true, error: undefined, theirs: undefined, text: mine, base: over, digest: r.digest ?? props.source?.body_digest });
    props.done();
  };

  // While the focus is in the editor, its keys are on offer: save, and Escape to cancel.
  let offers: (() => void)[] = [];
  const offer = () => {
    // Outside any owner: an event handler's offers go when the focus leaves, not with a scope.
    if (offers.length === 0) offers = runWithOwner(null, () => [touch("saveEdit", save), touch("cancelEdit", close)]);
  };
  const withdraw = () => {
    for (const w of offers) w();
    offers = [];
  };
  onCleanup(withdraw);

  let form!: HTMLFormElement;
  let box!: HTMLInputElement | HTMLTextAreaElement;
  onSettled(() => {
    if (!editorNow(issue(), field)?.focus) return;
    updateEditor(issue(), field, { focus: false });
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });

  const what = field === "title" ? "title" : "description";
  return (
    <form
      ref={form}
      data-keys="editor"
      data-perf={`${field}-editor`}
      aria-label={`Edit the ${what}`}
      {...stylex.attrs(s.form, field === "title" && s.titleForm)}
      onSubmit={(ev) => {
        ev.preventDefault();
        save();
      }}
      onFocusIn={offer}
      onFocusOut={(ev) => {
        if (!form.contains(ev.relatedTarget as Node | null)) withdraw();
      }}
    >
      <Show when={changed()}>
        <p role="status" data-perf="edit-changed" {...stylex.attrs(s.changed)}>
          Changed since you started editing
        </p>
      </Show>
      <Show when={conflict()}>
        <div role="alert" data-perf="edit-conflict">
          <p {...stylex.attrs(s.changed)}>Someone changed the {what} on GitHub since you started editing. Theirs:</p>
          <div {...stylex.attrs(s.theirs, field === "body" && s.theirsBody)} data-perf="edit-theirs">
            {theirs() || <span {...stylex.attrs(s.empty)}>No {what}</span>}
          </div>
          <p {...stylex.attrs(s.label, field === "body" && s.onTint)}>Yours:</p>
        </div>
      </Show>
      <Show
        when={field === "title"}
        fallback={
          <textarea
            ref={(el) => (box = el)}
            value={text()}
            maxlength={MAX_BODY}
            rows={10}
            aria-label="Description"
            data-perf="edit-box"
            {...stylex.attrs(s.box, s.body)}
            onInput={(ev) => setText(ev.currentTarget.value)}
          />
        }
      >
        <input
          ref={(el) => (box = el)}
          type="text"
          value={text()}
          maxlength={MAX_TITLE}
          aria-label="Title"
          data-perf="edit-box"
          {...stylex.attrs(s.box, s.title)}
          onInput={(ev) => setText(ev.currentTarget.value)}
        />
      </Show>
      <Show when={why()}>
        {(w) => (
          <p role="alert" data-perf="edit-failed" {...stylex.attrs(s.failed)}>
            Couldn't save the {what} — {w()}
          </p>
        )}
      </Show>
      <Show when={writesPaused()}>
        <p role="status" data-perf="edit-paused" {...stylex.attrs(s.changed)}>
          Saving is paused while the banner above shows; your text is kept.
        </p>
      </Show>
      <div {...stylex.attrs(s.actions)}>
        <Show
          when={conflict()}
          fallback={
            <>
              <button type="button" {...stylex.attrs(s.button)} onClick={close}>
                Cancel
              </button>
              <button type="submit" {...stylex.attrs(s.button, s.primary)} disabled={writesPaused() || blank()}>
                Save
              </button>
            </>
          }
        >
          <button type="button" {...stylex.attrs(s.button)} onClick={close}>
            Discard mine
          </button>
          <button type="submit" {...stylex.attrs(s.button, s.primary)} disabled={writesPaused() || blank()}>
            Overwrite with mine
          </button>
        </Show>
      </div>
    </form>
  );
}

const s = stylex.create({
  form: {
    gap: 6,
    display: "flex",
    flexDirection: "column",
  },
  // In the title's place, at its inset.
  titleForm: {
    paddingInline: 16,
    paddingBottom: 12,
  },
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
  title: {
    fontSize: 16,
    fontWeight: 600,
  },
  body: {
    fontFamily: fonts.mono,
    fontSize: 13,
    resize: "vertical",
  },
  changed: {
    margin: 0,
    color: colors.warn,
    fontSize: 12,
    fontWeight: 600,
  },
  label: {
    margin: 0,
    color: colors.muted,
    fontSize: 12,
    paddingTop: 6,
  },
  theirs: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    paddingInline: 10,
    backgroundColor: colors.bgRaised,
    color: colors.fg,
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    marginTop: 4,
  },
  // A body's Markdown, as GitHub has it: scrolls past a screenful.
  theirsBody: {
    fontFamily: fonts.mono,
    fontSize: 13,
    maxHeight: 240,
    overflowY: "auto",
  },
  empty: {
    color: colors.muted,
  },
  failed: {
    margin: 0,
    color: colors.danger,
    fontSize: 12,
  },
  // The body's editor is on its post's tint, where the app's muted (4.47:1) falls short of 4.5:1.
  loading: {
    margin: 0,
    color: md.muted,
  },
  onTint: {
    color: md.muted,
  },
  actions: {
    gap: 8,
    display: "flex",
    justifyContent: "flex-end",
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
