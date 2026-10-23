import { createRouter, defineRoute, intentPreload, tapPreload } from '@solidjs/router';
import { getIssue } from './api';
import { IssueRoute, NewIssue } from './Issue';
import { Placeholder } from './detail/layouts';

// The list is the root layout and always mounted; the filter lives in the query string. The open
// issue is its own path, rendered where the variant puts the detail. Hover or tap on a row preloads
// its detail, comments included, so it opens with no placeholder.
export const Router = createRouter({
  routes: [
    { path: '/', component: Placeholder },
    { path: '/new', component: NewIssue },
    defineRoute({ path: '/issues/:id', preload: ({ params }) => void getIssue(Number(params.id)), component: IssueRoute }),
  ],
  preloadLinks: [intentPreload(), tapPreload()],
});
