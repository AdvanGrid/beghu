// What the list's hover cards share with the rows: which card is open, and how a blocker's
// status reads.
import type { Blocker } from "./bindings/Blocker";
import type { IssueRow } from "./api";

/** The open card: a row's labels or blockers, under the cell at `at`. */
export interface CardAt {
  kind: "labels" | "blockers";
  row: IssueRow;
  at: DOMRect;
}

/**
 * Where a blocker stands: itself blocked (`chain`), owned by nobody (`nobody`; a stub's owner is
 * unknown, so never), or neither.
 */
export function blockerStatus(b: Blocker): "chain" | "nobody" | "moving" {
  return b.blocked_by > 0 ? "chain" : !b.assignee && !b.stub ? "nobody" : "moving";
}
