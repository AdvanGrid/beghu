// Further pages of the list, fetched as the user scrolls.
import { json } from '@sveltejs/kit';
import { listIssues } from '#lib/server/db.ts';
import { filterFromUrl } from '#lib/types.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) =>
	json(listIssues(filterFromUrl(url.searchParams), Number(url.searchParams.get('offset') ?? 0)));
