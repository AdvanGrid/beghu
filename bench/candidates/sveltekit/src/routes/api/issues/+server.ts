// Rows as JSON: a new first page after a filter change or live update, and further pages on scroll.
import { json } from '@sveltejs/kit';
import { listIssues } from '#lib/server/db.ts';
import { MORE, filterFromUrl } from '#lib/types.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) => {
	const offset = Number(url.searchParams.get('offset') ?? 0);
	const limit = Math.min(Number(url.searchParams.get('limit') ?? MORE), MORE);
	return json(listIssues(filterFromUrl(url.searchParams), offset, limit));
};
