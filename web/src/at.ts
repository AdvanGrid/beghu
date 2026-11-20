// Where GitHub has an issue or PR (its owner, repo and number), which is what its URL in beghu
// names, as GitHub's does: `/acme/web/issues/12`, or `/acme/web/pull/7` for a PR, with the list's
// view in the query string. A teammate can open a URL someone sent them; the issue's database id,
// which the API and the tab's own bookkeeping go by, never shows in one. Focus view names its
// root the same way (`?focus=acme/web/12`).
//
// The tab learns each issue's id from the rows and details it reads, so a URL it opens from the
// list finds its id at once. One it doesn't know yet (a cold load, a link from a post) reads its
// detail by where it is (`/api/at/acme/web/12`), and learns the id from that.
import { createSignal } from "solid-js";

/** An issue or PR by where GitHub has it. */
export type At = { owner: string; repo: string; number: number };

/** An issue or PR as rows and details carry it: its id, what it is, and where it is. */
export type Located = At & { id: number; kind: string };

/** An issue's path in the app: `/acme/web/issues/12`, or `/pull/` for a PR, as on GitHub. */
export function issuePath(i: At & { kind: string }): string {
  return `/${i.owner}/${i.repo}/${i.kind === "pr" ? "pull" : "issues"}/${i.number}`;
}

/** Where an issue is, as Focus view's `?focus=` and the detail cache name it: `acme/web/12`. */
export function atString(a: At): string {
  return `${a.owner}/${a.repo}/${a.number}`;
}

/** The issue a string of `atString`'s form names. Its number is digits, leading zeros dropped. */
export function parseAt(s: string | null | undefined): At | undefined {
  const m = s ? /^([^/]+)\/([^/]+)\/(\d+)$/.exec(s) : null;
  return m ? at(m[1], m[2], m[3]) : undefined;
}

/** The issue an app path names (`/acme/web/issues/12`, `/acme/web/pull/7`), if it's an issue's. */
export function atOfPath(path: string): At | undefined {
  const m = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([^/]+)$/.exec(path);
  return m ? at(decode(m[1]), decode(m[2]), m[3]) : undefined;
}

/**
 * The issue the route's params name. A number that isn't digits names no issue: NaN, which the
 * server answers Gone for, as for any number the mirror doesn't hold.
 */
export function at(owner: string, repo: string, number: string): At {
  return { owner, repo, number: /^\d+$/.test(number) ? Number(number) : NaN };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** GitHub's names are case-insensitive: `Acme/Web/12` is `acme/web/12`. */
const keyOf = (a: At) => atString(a).toLowerCase();

const ids = new Map<string, number>();
const located = new Map<number, Located>();
/** Bumped as the tab learns an issue it didn't know, for what waits on its id. */
const [learned, setLearned] = createSignal(0);

/** For rows and details the tab read: their ids, by where each is, and the other way. */
export function learn(items: Iterable<Located>): void {
  let added = false;
  for (const i of items) {
    const key = keyOf(i);
    if (ids.get(key) !== i.id) {
      // A transferred issue keeps its id under a new place: its old one names another.
      const was = located.get(i.id);
      if (was && keyOf(was) !== key) ids.delete(keyOf(was));
      ids.set(key, i.id);
      added = true;
    }
    located.set(i.id, { id: i.id, kind: i.kind, owner: i.owner, repo: i.repo, number: i.number });
  }
  if (added) setLearned((n) => n + 1);
}

/** The id of the issue at `a`, once the tab knows it. Reactive: it follows what the tab learns. */
export function idAt(a: At): number | undefined {
  learned();
  return ids.get(keyOf(a));
}

/** The issue with id `id`'s path with `search`, if the tab has read it. */
export function pathOf(id: number, search = ""): string | undefined {
  const i = located.get(id);
  return i && issuePath(i) + search;
}

/** Where the issue with id `id` is, in `atString`'s form, if the tab has read it. */
export function atOf(id: number): string | undefined {
  const i = located.get(id);
  return i && atString(i);
}

/** Whether the issue with id `id` is the one `s` names (`atString`'s form). */
export function isAt(id: number | undefined, s: string | undefined): boolean {
  const i = id === undefined ? undefined : located.get(id);
  const a = parseAt(s);
  return i !== undefined && a !== undefined && keyOf(i) === keyOf(a);
}
