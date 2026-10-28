import { lazy } from "solid-js";
import { createRouter, intentPreload, tapPreload } from "@solidjs/router";
import { getIssue, issueId, preloadIssue } from "./api";

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

// The list is the root layout and always mounted; the view lives in the query string. An open
// issue is its own path (`/issues/:id`, with the view kept in the query string), shown in the
// panel beside the list. Rows are plain <a href>s under the router's one delegated click
// listener; hover and tap preload the panel's code (the router warms a route's lazy component
// itself) and the issue's detail together, so a click finds both ready.
export const Router = createRouter({
  routes: [
    { path: "/", component: () => null },
    {
      path: "/issues/:id",
      preload: ({ params, intent }) => {
        const id = issueId(params.id);
        if (intent === "preload") preloadIssue(id);
        else void getIssue(id);
      },
      component: IssuePanel,
    },
    // The create form opens in the panel, the view kept in the query string.
    { path: "/new", component: CreatePanel },
    // Repo picking takes the panel's place beside the list.
    { path: "/repos", component: RepoPickerPanel },
  ],
  preloadLinks: [intentPreload(), tapPreload()],
});
