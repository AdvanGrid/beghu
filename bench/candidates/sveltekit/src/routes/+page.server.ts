import { fail } from '@sveltejs/kit';
import { addLabel, facets, listIssues } from '#lib/server/db.ts';
import { filterFromUrl } from '#lib/types.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:issues');
	const filter = filterFromUrl(url.searchParams);
	return { filter, facets: facets(), rows: listIssues(filter) };
};

export const actions: Actions = {
	addLabel: async ({ request }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const name = String(form.get('name'));
		if (!(await addLabel(id, name))) return fail(422, { error: 'no such label' });
	}
};
