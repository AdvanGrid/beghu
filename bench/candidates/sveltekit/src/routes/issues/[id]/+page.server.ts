import { error } from '@sveltejs/kit';
import { getDetail } from '#lib/server/db.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, depends }) => {
	depends('app:issues');
	const issue = getDetail(params.id);
	if (!issue) error(404, 'Not found');
	return { issue };
};
