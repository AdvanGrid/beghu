import { createRouter, defineRoute, intentPreload, tapPreload } from '@solidjs/router';
import { lazy } from 'solid-js';
import { getIssue } from './api';

// As axum-solid2-router, but the detail is a lazy chunk, so an open tab has to fetch a hashed
// asset of its own build after a deploy.
const IssueRoute = lazy(() => import('./Issue').then((m) => ({ default: m.IssueRoute })));

export const Router = createRouter({
  routes: [
    { path: '/', component: () => null },
    defineRoute({ path: '/issues/:id', preload: ({ params }) => void getIssue(Number(params.id)), component: IssueRoute }),
  ],
  preloadLinks: [intentPreload(), tapPreload()],
});
