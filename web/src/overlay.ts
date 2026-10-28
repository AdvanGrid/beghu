// What the tab's pending writes add over the server's data. The writes code (writes.tsx) is its
// own chunk, which the issue panel loads with its composer; only then can the tab make a write. It
// fills this in as it loads, and the views that show writes (the list's rows, the detail, the
// status slot) go through it. Until then there are no writes, and views show the server's data as
// it came.
import { createSignal, flush, type Element } from "solid-js";
import { cookieAccount, tabAccount } from "./account";
import type { Comment, IssueDetail, IssueRow } from "./api";
import type { User } from "./bindings/User";
import type { Field } from "./editing";

/** A property row of the detail that a pick changes. */
export type Prop = "labels" | "assignees" | "milestone";

/**
 * A comment as the thread shows it: as the server rendered it (a write's comment GitHub has
 * carries the write's `op_id`), or a pending or failed write's comment GitHub doesn't have, which
 * shows its text as typed, plain.
 */
export type ShownComment =
  | (Comment & { op?: string })
  | { op: string; id: number; author: User; typed: string; created_at: number; updated_at: number };

/** The detail as it shows, the tab's pending comments among its own. */
export type ShownDetail = Omit<IssueDetail, "comments"> & {
  comments: Omit<IssueDetail["comments"], "comments"> & { comments: ShownComment[] };
  /** A pending body edit's text, as typed, until GitHub's reply renders it. */
  typedBody?: string;
};

export interface Overlay {
  /** A list row with the tab's pending writes on it; `at` is when its page's read began. */
  rowWithWrites(r: IssueRow, at: number): IssueRow;
  /** The list now shows a page whose read began at `at`. */
  listShown(at: number): void;
  /** The detail with the tab's pending writes on it; its comments are `ShownComment`s. Pure. */
  detailWithWrites(d: IssueDetail, at: number): ShownDetail;
  /** The detail of `issue` now shows a read that began at `at`. */
  detailShown(issue: number, at: number): void;
  /** The status slot's content. */
  Status: () => Element;
  /** Beside the open issue's state: a pending close or reopen, or its failure. */
  StateNote: (p: { issue: number; at: number }) => Element;
  /** On a pending or failed comment: sending, or "not sent" with Retry, Edit and Discard. */
  CommentNote: (p: { op: string; at: number }) => Element;
  /** At the end of a property row: a pending pick's dot, or a failed pick with Retry and Dismiss. */
  PropNote: (p: { issue: number; prop: Prop; at: number }) => Element;
  /** Beside the title or body: a pending edit's dot. */
  EditNote: (p: { issue: number; field: Field; at: number }) => Element;
}

const [overlay, setOverlay] = createSignal<Overlay>();
export { overlay, setOverlay };

/**
 * The create form's word on a create that ended while the form was closed (CreateIssue.tsx), until
 * it's dismissed or the form opens again: `failed`, it's a failure, and shows among the failed
 * writes; made, it's a quiet state, below them.
 */
export type CreateNote = { failed: boolean; Note: () => Element };
const [createNote, setCreateNote] = createSignal<CreateNote>();
export { createNote, setCreateNote };

/**
 * The tab is leaving on purpose (a sign-out or a switch, confirmed if it held unsaved text): the
 * whole app blanks, header and banners included, so the page the back-forward cache keeps (and
 * every frame of it restored) never shows the old account, and leaving doesn't ask again.
 */
const [leaving, setLeaving] = createSignal(false);
export { leaving };
export function leave(): void {
  setLeaving(true);
  // Blank now, before the navigation that follows can freeze the page as it was.
  flush();
}
// Back to a page that left on purpose but whose account is unchanged (the post failed, say): it
// shows again. One whose account the browser no longer has active stays blank, and reloads
// (account.ts).
addEventListener("pageshow", (e) => {
  if (e.persisted && cookieAccount() === tabAccount()) setLeaving(false);
});
