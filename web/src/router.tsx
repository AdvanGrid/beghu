import { createRouter, intentPreload, tapPreload } from "@solidjs/router";

// The list is the root layout and always mounted; the view lives in the query string. An open
// issue is its own path (`/issues/:id`, with the view kept in the query string), shown beside the
// list once the detail panel lands. Rows are plain <a href>s under the router's one delegated
// click listener; hover and tap preload.
export const Router = createRouter({
  routes: [
    { path: "/", component: () => null },
    { path: "/issues/:id", component: () => null },
  ],
  preloadLinks: [intentPreload(), tapPreload()],
});
