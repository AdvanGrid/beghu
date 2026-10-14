// Rows per page: the first screen plus a little, so loads and filter changes render few rows.
export const PAGE = 25;

export type Label = { name: string; color: string };

export type Row = {
	id: string;
	number: number;
	title: string;
	state: 'open' | 'closed';
	updated_at: string;
	comments_count: number;
	repo: string;
	labels: Label[];
	assignees: string[];
};

export type Comment = { id: string; body: string; created_at: string; author: string | null };

export type Detail = Row & { body: string; repo_labels: Label[]; comments: Comment[] };

export type Filter = { state: 'open' | 'closed'; labels: string[]; assignees: string[]; q: string };

export function filterFromUrl(params: URLSearchParams): Filter {
	return {
		state: params.get('state') === 'closed' ? 'closed' : 'open',
		labels: params.getAll('label'),
		assignees: params.getAll('assignee'),
		q: params.get('q') ?? ''
	};
}

export function filterToParams(f: Filter): URLSearchParams {
	const p = new URLSearchParams();
	if (f.state !== 'open') p.set('state', f.state);
	for (const l of f.labels) p.append('label', l);
	for (const a of f.assignees) p.append('assignee', a);
	if (f.q) p.set('q', f.q);
	return p;
}
