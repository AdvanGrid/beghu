// What the tab's pending writes add over the server's data. The writes code (writes.tsx) is its
// own chunk, which the issue panel loads with its composer; only then can the tab make a write. It
// fills this in as it loads, and the views that show writes (the list's rows, the detail, the
// status slot) go through it. Until then there are no writes, and views show the server's data as
// it came.
import { createSignal, type Element } from "solid-js";
import type { Comment, IssueDetail, IssueRow } from "./api";
import type { User } from "./bindings/User";

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
  /** Under the header: GitHub is unreachable, so writes pause. */
  Banner: () => Element;
  /** Beside the open issue's state: a pending close or reopen, or its failure. */
  StateNote: (p: { issue: number; at: number }) => Element;
  /** On a pending or failed comment: sending, or "not sent" with Retry, Edit and Discard. */
  CommentNote: (p: { op: string; at: number }) => Element;
  /** At the end of a property row: a pending pick's dot, or a failed pick with Retry and Dismiss. */
  PropNote: (p: { issue: number; prop: Prop; at: number }) => Element;
}

const [overlay, setOverlay] = createSignal<Overlay>();
export { overlay, setOverlay };
