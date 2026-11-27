import { lazy, untrack } from "solid-js";
import { createRouter, intentPreload, tapPreload, type RoutePreloadFunc } from "@solidjs/router";
import { getIssue, getIssueAt, preloadIssue } from "./api";
import { at, atString, idAt } from "./at";

/** A route's code failed to load: offline, or a deploy replaced the build it belongs to. */
export class ChunkFailed extends Error {}

/** The issue panel is its own chunk, kept out of first-load JS. */
const IssuePanel = lazy(
  () =>
    import("./IssuePanel").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the issue panel: ${String(e)}`);
    }),
  { export: "IssuePanel" },
);

/** The create form is its own chunk: it loads when "New issue" (or its key) opens it. */
const CreatePanel = lazy(
  () =>
    import("./CreateIssue").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the create form: ${String(e)}`);
    }),
  { export: "CreatePanel" },
);

/** Repo picking is its own chunk too: a page visited rarely. */
const RepoPickerPanel = lazy(
  () =>
    import("./RepoPicker").catch((e: unknown) => {
      throw new ChunkFailed(`can't load repo picking: ${String(e)}`);
    }),
  { export: "RepoPickerPanel" },
);

/** The account's preferences and the keymap's setup: their own chunk too. */
const PrefsPanel = lazy(
  () =>
    import("./Prefs").catch((e: unknown) => {
      throw new ChunkFailed(`can't load preferences: ${String(e)}`);
    }),
  { export: "PrefsPanel" },
);

/** `/cli/login`, where a `beghu login` is approved: its own chunk too. */
const CliLoginPanel = lazy(
  () =>
    import("./CliLogin").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the CLI's sign-in: ${String(e)}`);
    }),
  { export: "CliLoginPanel" },
);

// The list is the root layout and always mounted, at `/issues` (`/` is the public site's landing
// page, web/site/); the view lives in the query string. An open issue is its own path, GitHub's
// (`/acme/web/issues/12`, `/acme/web/pull/7` for a PR, at.ts), with the view kept in the query
// string, shown in the panel beside the list. Rows are plain <a href>s under the router's one
// delegated click listener; hover and tap preload the panel's code (the router warms a route's
// lazy component itself) and the issue's detail together, so a click finds both ready.
const issue = {
  preload: (({ params, intent }) => {
    const where = at(params.owner ?? "", params.repo ?? "", params.number ?? "");
    const id = untrack(() => idAt(where));
    // An issue the tab hasn't read a row or detail of (a cold load, a link from a post) reads its
    // detail by where it is, and learns its id from that.
    if (id === undefined) void getIssueAt(atString(where));
    else if (intent === "preload") preloadIssue(id);
    else void getIssue(id);
  }) satisfies RoutePreloadFunc,
  component: IssuePanel,
};

export const Router = createRouter({
  routes: [
    { path: "/issues", component: () => null },
    { path: "/:owner/:repo/issues/:number", ...issue },
    { path: "/:owner/:repo/pull/:number", ...issue },
    // The create form opens in the panel, the view kept in the query string.
    { path: "/new", component: CreatePanel },
    // Repo picking takes the panel's place beside the list.
    { path: "/repos", component: RepoPickerPanel },
    // So do the account's preferences.
    { path: "/prefs", component: PrefsPanel },
    // And approving a `beghu login`.
    { path: "/cli/login", component: CliLoginPanel },
  ],
  preloadLinks: [intentPreload(), tapPreload()],
});
