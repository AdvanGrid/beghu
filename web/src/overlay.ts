// What the tab's pending writes add over the server's data. The writes code (writes.tsx) is its
// own chunk, which the issue panel loads with its composer; only then can the tab make a write. It
// fills this in as it loads, and the views that show writes (the list's rows, the detail, the
// status slot) go through it. Until then there are no writes, and views show the server's data as
// it came.
import { createSignal, flush, type Element } from "solid-js";
import { cookieAccount, tabAccount } from "./account";
import type { Comment, IssueDetail, IssueRow } from "./api";
import type { Related } from "./bindings/Related";
import type { User } from "./bindings/User";
import type { Field } from "./editing";
import type { ShownRelationships } from "./related";

/** A property row of the detail whose picker picks one value at a time. */
export type PickProp = "labels" | "assignees" | "milestone";

/** A property row of the detail that a write changes; `links` holds the relationship writes' marker. */
export type Prop = PickProp | "links";

/**
 * A comment as the thread shows it: as the server rendered it (a write's comment GitHub has
 * carries the write's `op_id`), or a pending or failed write's comment GitHub doesn't have, which
 * shows its text as typed, plain.
 */
export type ShownComment =
  | (Comment & { op?: string })
  | { op: string; id: number; author: User; typed: string; created_at: number; updated_at: number };

/** The detail as it shows, the tab's pending comments among its own. */
export type ShownDetail = Omit<IssueDetail, "comments" | "relationships"> & {
  comments: Omit<IssueDetail["comments"], "comments"> & { comments: ShownComment[] };
  /** Its relationships, with the tab's pending relationship writes. */
  relationships: ShownRelationships;
  /** A pending body edit's text, as typed, until GitHub's reply renders it. */
  typedBody?: string;
};

/**
 * A sub-issue move a pending write makes, as Tree mode shows it: `child` goes under `parent` (none:
 * it has no parent any more), after the sibling `after`, first (`null`), or last (`undefined`).
 */
export type SubMove = { child: number; parent: number | null; after: number | null | undefined };

export interface Overlay {
  /** A list row with the tab's pending writes on it; `at` is when its page's read began. */
  rowWithWrites(r: IssueRow, at: number): IssueRow;
  /** The list (or the tree) now shows a page whose read began at `at`. */
  listShown(at: number): void;
  /** The sub-issue moves of the tab's pending writes, over a tree read that began at `at`. */
  subMoves(at: number): SubMove[];
  /** The detail with the tab's pending writes on it; its comments are `ShownComment`s. Pure. */
  detailWithWrites(d: IssueDetail, at: number): ShownDetail;
  /** The detail of `issue` now shows a read that began at `at`. */
  detailShown(issue: number, at: number): void;
  /**
   * Whether the panel on `issue` is in use, so the list's selection stays on it when it leaves the
   * list: it holds unsaved text of the issue's (a draft, a comment GitHub never got, a title or
   * body editor's text), or the user wrote to the issue from it and the write didn't fail, which
   * is what took it out of the list.
   */
  keepsSelection(issue: number): boolean;
  /** The panel now shows `issue` (an issue or a PR), or is closed. */
  panelOn(issue: number | undefined): void;
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
 * The issue `+ Create a new sub-issue` opened the create form from (Relationships.tsx): the form
 * takes it once as the new issue's parent (CreateIssue.tsx).
 */
const [newSubIssueOf, setNewSubIssueOf] = createSignal<Related>();
export { newSubIssueOf, setNewSubIssueOf };

/**
 * The tab is leaving on purpose (a sign-out or a switch, confirmed if it held unsaved text): the
 * whole app blanks, header and banners included, so the page the back-forward cache keeps (and
 * every frame of it restored) never shows the old account, and leaving doesn't ask again. A
 * signed-in page going into the back-forward cache any other way blanks too (below).
 */
const [leaving, setLeaving] = createSignal(false);
export { leaving };
export function leave(): void {
  setLeaving(true);
  // Blank now, before the navigation that follows can freeze the page as it was.
  flush();
}
// A signed-in page going into the back-forward cache blanks as well, however it left (a link out,
// a typed URL): the account may change before it comes back, and no test can see whether Chrome
// paints a restored page before `pageshow` (the spec's contingency, decided the conservative way).
addEventListener("pagehide", (e) => {
  if (!e.persisted || tabAccount() === undefined || leaving()) return;
  setLeaving(true);
  flush();
});
// Back to a page whose account is unchanged (a link out, or a sign-out whose post failed): it
// shows again before its first frame. One whose account the browser no longer has active stays
// blank, and reloads (account.ts).
addEventListener("pageshow", (e) => {
  if (!e.persisted || cookieAccount() !== tabAccount()) return;
  setLeaving(false);
  flush();
});
