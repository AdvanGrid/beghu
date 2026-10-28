// A relationship's ends as the detail shows them, shared by its lists (Relationships.tsx), the
// relationship picker and the writes code: the open issue as the other end's lists show it, an
// end as a relationship op names it, and an end a pending write shows before GitHub's data has it.
import type { Related } from "./bindings/Related";
import type { RelatedEnd } from "./bindings/RelatedEnd";
import type { ShownDetail } from "./overlay";

/**
 * A relationship's end as a list shows it: GitHub's data, or a pending write's end before GitHub's
 * data has it. Its `id` is `null` only for an issue in a repo beghu doesn't sync that GitHub couldn't
 * be asked about yet (the picker offered it unread): it links out to GitHub, as a stub does, and
 * can't be moved.
 */
export type ShownRelated = Omit<Related, "id"> & { id: number | null };

/** An issue's relationships as the detail shows them: GitHub's, with the tab's pending writes. */
export type ShownRelationships = {
  /** Always one GitHub has shown: a parent is picked by its id. */
  parent: Related | null;
  sub_issues: ShownRelated[];
  blocked_by: ShownRelated[];
  blocking: ShownRelated[];
  relates_to: ShownRelated[];
};

/** The open issue as a relationship list shows it: the other end's lists show it so. */
export function related(d: ShownDetail): Related {
  return {
    id: d.id,
    kind: d.kind,
    owner: d.owner,
    repo: d.repo,
    number: d.number,
    title: d.title,
    state: d.state,
    state_reason: d.state_reason,
    stub: false,
    assignee: d.assignees[0]?.login ?? null,
    blocked_by: d.relationships.blocked_by.filter((b) => b.state === "open").length,
    progress: null,
    pr_status: null,
  };
}

/** An issue as a relationship op names its other end. */
export function endOf(r: { id: number | null; owner: string; repo: string; number: number }): RelatedEnd {
  return { id: r.id, owner: r.owner, repo: r.repo, number: r.number };
}

/** `e` as the user knows it: `web#12`. */
export function refOf(e: { repo: string; number: number }): string {
  return `${e.repo}#${e.number}`;
}

/**
 * End `e` as a list shows it until GitHub's data does: what's known of it (a title, a state, whether
 * it's a stub), nothing else said.
 */
export function standIn(e: RelatedEnd, known: { title?: string | null; state?: string | null; stub?: boolean } = {}): ShownRelated {
  return {
    id: e.id,
    kind: "issue",
    owner: e.owner,
    repo: e.repo,
    number: e.number,
    title: known.title ?? `${e.owner}/${e.repo}#${e.number}`,
    state: known.state ?? "open",
    state_reason: null,
    // An end whose id isn't known yet is one beghu doesn't hold: it shows as a stub would.
    stub: known.stub ?? e.id === null,
    assignee: null,
    blocked_by: 0,
    progress: null,
    pr_status: null,
  };
}

/** Whether `r` is the issue `e` names: by its id, or its place while either has no id. */
export function isEnd(r: ShownRelated, e: RelatedEnd | number): boolean {
  if (typeof e === "number") return r.id === e;
  if (e.id !== null && r.id !== null) return r.id === e.id;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return same(r.owner, e.owner) && same(r.repo, e.repo) && r.number === e.number;
}

/** A list's key for `r`: its id, or its place while it has none. */
export function keyOf(r: ShownRelated): string {
  return r.id !== null ? String(r.id) : `${r.owner}/${r.repo}#${r.number}`.toLowerCase();
}
