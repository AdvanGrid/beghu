// Old IDs forward one step (#150, #168): a selection whose IDs this analysis doesn't have goes
// where the upload's `carried` says they went, with a one-line note, or silently through a schema
// migration's renames (`migratedIds`). Used for a URL's `sel` (an old link, a restored history
// entry) and for "A newer analysis is ready · Show it", which keeps the reader's place.
//
// - renamed or merged: to the new ID;
// - split: to all the new IDs, selected together (the canvas opens down to the level that holds
//   them all);
// - dropped: to the nearest surviving parent, or the top level, with the reason;
// - split to IDs of more than one kind (parts and lines): to those of the kind most of them are,
//   the note naming the others as selectable separately;
// - renamed, merged or split to IDs this analysis doesn't have either: to those of them it has,
//   or, with none, up as for a drop, the note saying where it went wasn't found (one step only:
//   a `now` ID that moved again isn't followed);
// - not there and not carried: the PR, "not found in this analysis". For Show it, which knows the
//   analysis being left, the level above: the nearest parent the newer analysis still has.
import type { Carried } from "../bindings/analysis";
import type { Model } from "./model";
import { candidates, type Sel } from "./state";

export interface Forwarded {
  /** Where the selection lands; undefined for the PR. */
  sel?: Sel;
  /** The one-line note, when it moved and wasn't a migration's rename. */
  note?: string;
}

/** What an ID names: a part (node), a line (edge) or a purpose. */
type Kind = "part" | "line" | "purpose";

function has(m: Model, kind: Kind, id: string): boolean {
  return kind === "part" ? m.nodes.has(id) : kind === "line" ? m.edges.has(id) : m.purposes.has(id);
}

/** What `id` is in `m`, if `m` has it. */
function kindIn(m: Model, id: string): Kind | undefined {
  return m.nodes.has(id) ? "part" : m.edges.has(id) ? "line" : m.purposes.has(id) ? "purpose" : undefined;
}

/** How an ID reads in a note: a part's or purpose's name, a line's ends, else the ID. */
function label(m: Model, id: string): string {
  const e = m.edges.get(id);
  if (e) return `${m.name(e.from)} → ${m.name(e.to)}`;
  return m.purposes.get(id)?.name ?? m.nodes.get(id)?.name ?? id;
}

/**
 * The parents a missing ID most likely had, nearest first: from the analysis being left when
 * there is one, else from the ID itself (node IDs come from paths, `crates-server.src.media`;
 * a sub-purpose's names its parent, `purpose:a/b`; a line's, `e:<from>-><to>:…`, its ends).
 */
function parentsOf(id: string, kind: Kind, before?: Model): string[] {
  if (before) {
    const e = before.edges.get(id);
    if (e) return [e.from, ...before.ancestors(e.from)];
    if (before.nodes.has(id)) return before.ancestors(id);
    const p = before.purposes.get(id)?.parent;
    if (p) return [p];
  }
  if (kind === "purpose") {
    const slash = id.lastIndexOf("/");
    return slash > 0 ? [id.slice(0, slash)] : [];
  }
  if (kind === "line") {
    const ends = /^e:(.+?)->(.+?)(?::.*)?$/.exec(id);
    return ends ? [ends[1]!, ...parentsOf(ends[1]!, "part")] : [];
  }
  const out: string[] = [];
  for (let at = id.lastIndexOf("."); at > 0; at = id.lastIndexOf(".", at - 1)) out.push(id.slice(0, at));
  return out;
}

/** "a", "a and b", "a, b and c". */
function words(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

/** One ID, forwarded: the IDs it lands on (none: dropped or unknown) and its note. */
function one(id: string, kind: Kind, m: Model, before?: Model): { ids: string[]; kind: Kind; note?: string; up?: string } {
  if (has(m, kind, id)) return { ids: [id], kind };
  const migrated = m.g.migratedIds.find((r) => r.old === id);
  if (migrated && kindIn(m, migrated.new) !== undefined) return { ids: [migrated.new], kind: kindIn(m, migrated.new)! };
  const c: Carried | undefined = m.a.carried.find((x) => x.was === id);
  const was = before ? label(before, id) : id;
  // The nearest parent that's still here, for a drop or a move to nowhere here.
  const up = () => parentsOf(id, kind, before).find((p) => kindIn(m, p) !== undefined && !(kindIn(m, p) === "part" && m.nodes.get(p)?.kind === "system"));
  if (c && c.kind !== "dropped") {
    // A selection holds one kind: the one most of `now` is here, the first on a tie.
    const kinds = c.now.map((n) => kindIn(m, n));
    const count = (k: Kind) => kinds.filter((x) => x === k).length;
    const k = kinds.reduce<Kind | undefined>((best, x) => (x !== undefined && (best === undefined || count(x) > count(best)) ? x : best), undefined);
    const here = c.now.filter((_, i) => k !== undefined && kinds[i] === k);
    const apart = c.now.filter((n, i) => kinds[i] !== undefined && !here.includes(n));
    const missing = c.now.filter((_, i) => kinds[i] === undefined);
    if (here.length > 0) {
      const names = here.map((n) => label(m, n));
      const how = c.kind === "renamed" ? `was renamed to ${names[0]}` : c.kind === "merged" ? `was merged into ${names[0]}` : `was split into ${words(names)}`;
      const asides = [
        ...(apart.length ? [`${words(apart.map((n) => label(m, n)))}, also from it, can be selected separately`] : []),
        ...(missing.length ? [`${words(missing)} not found in this analysis`] : []),
      ];
      const rest = asides.length ? ` (${asides.join("; ")})` : "";
      return { ids: here, kind: k!, note: `${was} ${how}: ${c.reason}${rest}` };
    }
    const where = c.kind === "renamed" ? "renamed to" : c.kind === "merged" ? "merged into" : "split into";
    return { ids: [], kind, up: up(), note: `${was} was ${where} ${words(c.now)}, not found in this analysis` };
  }
  if (c) return { ids: [], kind, up: up(), note: `${was} was dropped: ${c.reason}` };
  if (before) return { ids: [], kind, up: up(), note: `${was} isn't in the newer analysis` };
  return { ids: [], kind, note: `${was} was not found in this analysis` };
}

/** `sel` against `m` (and, for Show it, the analysis being left, `before`). */
export function forward(sel: Sel | undefined, m: Model, before?: Model): Forwarded {
  if (!sel) return {};
  const gone = before ? "isn't in the newer analysis" : "was not found in this analysis";
  switch (sel.kind) {
    case "part":
    case "line":
    case "purpose": {
      const got = sel.ids.map((id) => one(id, sel.kind, m, before));
      const notes = got.map((g) => g.note).filter((n): n is string => n !== undefined);
      const note = notes.length ? notes.join(" · ") : undefined;
      const landed = got.filter((g) => g.ids.length > 0);
      const kind = landed[0]?.kind;
      if (kind !== undefined && landed.every((g) => g.kind === kind)) {
        const all = [...new Set(landed.flatMap((g) => g.ids))];
        return { sel: { kind, ids: all }, note };
      }
      // Nothing landed: up to the nearest parent still here, or the PR.
      const up = got.find((g) => g.up !== undefined)?.up;
      const upKind = up === undefined ? undefined : kindIn(m, up);
      if (up !== undefined && upKind !== undefined) return { sel: { kind: upKind, ids: [up] }, note: `${note}; showing ${label(m, up)}` };
      return { note: note && `${note}; showing the PR` };
    }
    case "conflict": {
      // Conflicts don't carry between runs.
      const id = candidates("conflict", sel.id).find((x) => m.conflicts.has(x));
      if (id !== undefined) return { sel: { kind: "conflict", id } };
      const was = before?.conflicts.get(sel.id)?.question ?? `Conflict ${sel.id}`;
      return { note: `${was} ${gone}; showing the PR` };
    }
    case "step": {
      const scenario = candidates("step", sel.scenario).find((x) => m.scenarios.has(x));
      const sc = scenario === undefined ? undefined : m.scenarios.get(scenario);
      if (sc && sel.n <= sc.steps.length) return { sel: { kind: "step", scenario: sc.id, n: sel.n } };
      const title = sc?.title ?? before?.scenarios.get(sel.scenario)?.title ?? sel.scenario;
      return { note: `Step ${sel.n} of ${title} ${gone}; showing the PR` };
    }
    case "unclaimed":
      return m.a.unclaimed.length > 0 ? { sel } : { note: "No changed part serves no purpose in this analysis; showing the PR" };
    case "group":
      return { sel };
    case "boundary":
      return m.boundaries.has(sel.id) ? { sel } : { note: `The boundary ${sel.id} ${gone}; showing the PR` };
  }
}
