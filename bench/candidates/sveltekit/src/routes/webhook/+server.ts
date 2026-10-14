import { json } from '@sveltejs/kit';
import { applyWebhook } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	applyWebhook(request.headers.get('x-github-event'), await request.json());
	return json({ ok: true }, { status: 202 });
};
