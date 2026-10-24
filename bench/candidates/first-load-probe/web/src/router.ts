import { createRouter, defineRoute, intentPreload, tapPreload } from '@solidjs/router';
import { getIssue } from './api';
import { IssueRoute } from './Issue';

// The list is the root layout and always mounted; the filter lives in the query string. The open
// issue is its own path, rendered into the detail pane. Hover or tap on a row preloads its detail.
export const Router = createRouter({
  routes: [
    { path: '/', component: () => null },
    defineRoute({ path: '/issues/:id', preload: ({ params }) => void getIssue(Number(params.id)), component: IssueRoute }),
  ],
  preloadLinks: [intentPreload(), tapPreload()],
});
