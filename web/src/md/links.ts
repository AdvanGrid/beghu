// The link resolver: the one place a reference or URL in a body or comment becomes a link. An
// issue or PR the viewer's mirror holds (the `refs` map the server sends beside the AST) opens
// in-app, where the router's hover preload warms it; every other issue reference goes to GitHub,
// even one GitHub may not have; users and teams always go to GitHub.
import type { RefTarget } from "../bindings/RefTarget";
import type { MediaLinks } from "./media";

/** A post's place (CONTEXT.md): the issue or PR it belongs to, as the server's `markdown::Place`. */
export type Place = {
  /** Its repo: a reference to an issue there shows as `#n`. */
  owner: string;
  repo: string;
  number: number;
};

/** What the links and media in the posts being shown resolve against. */
export type Links = MediaLinks & {
  /** The posts' place. */
  place: Place;
  /** The list's view, kept on an in-app link (`?…`, or empty). */
  search: string;
  /** What the mirror holds at `owner/repo#n`, lowercased: the refs map. */
  refs: (key: string) => RefTarget | undefined;
};

/** Where an issue reference goes. */
export type IssueLink =
  /** In the mirror: its in-app route, and what the link shows of it. */
  | { inApp: true; href: string; label: string; target: RefTarget }
  /** Anywhere else: GitHub. */
  | { inApp: false; href: string; label: string };

/** The `refs` map's key for an issue: the server builds it the same way (crates/md-ast). */
export function refKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`.toLowerCase();
}

function sameRepo({ place }: Links, owner: string, repo: string): boolean {
  return refKey(owner, repo, 0) === refKey(place.owner, place.repo, 0);
}

/**
 * An issue or PR by repo and number, or one of its comments: `#n (comment)`, as GitHub words it.
 * In-app, the link opens the issue, or scrolls to the comment if it is on the page (walker.ts).
 */
export function issueLink(links: Links, owner: string, repo: string, number: number, comment?: number): IssueLink {
  const label = `${sameRepo(links, owner, repo) ? `#${number}` : `${owner}/${repo}#${number}`}${comment === undefined ? "" : " (comment)"}`;
  const target = links.refs(refKey(owner, repo, number));
  if (target) return { inApp: true, href: `/issues/${target.id}${links.search}`, label, target };
  // GitHub redirects /issues/n to /pull/n for a PR.
  const fragment = comment === undefined ? "" : `#issuecomment-${comment}`;
  return { inApp: false, href: `https://github.com/${owner}/${repo}/issues/${number}${fragment}`, label };
}

export function userUrl(login: string): string {
  return `https://github.com/${login}`;
}

/** A team's page on GitHub, from its `org/team`, or undefined if it isn't one. */
export function teamUrl(orgTeam: string): string | undefined {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_-]+)$/.exec(orgTeam);
  return m ? `https://github.com/orgs/${m[1]}/teams/${m[2]}` : undefined;
}

const GITHUB_ITEM = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)\/?(?:#issuecomment-(\d+))?$/;

/**
 * Where a link written in a post goes: its own URL, unless it points at an issue or PR the mirror
 * holds, or at a comment on one, which opens in-app (`comment`: the comment it points at).
 */
export function linkHref(links: Links, href: string): { href: string; inApp: boolean; comment?: number } {
  const m = GITHUB_ITEM.exec(href);
  const target = m && links.refs(refKey(m[1]!, m[2]!, Number(m[3])));
  if (!target) return { href, inApp: false };
  return { href: `/issues/${target.id}${links.search}`, inApp: true, comment: m[4] === undefined ? undefined : Number(m[4]) };
}

/**
 * A URL the browser may follow from a post, or undefined. The server already sanitised it; this
 * is the walker's own check. `#fragment` links stay on the page; anything else must be absolute
 * http(s), or mailto where `mail` allows it.
 */
export function safeUrl(raw: string, opts: { fragment?: boolean; mail?: boolean } = {}): string | undefined {
  if (raw.startsWith("#")) return opts.fragment ? raw : undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const ok = url.protocol === "https:" || url.protocol === "http:" || (opts.mail === true && url.protocol === "mailto:");
  return ok ? url.href : undefined;
}
