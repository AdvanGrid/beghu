import { json } from '@sveltejs/kit';
import { facets } from '#lib/server/db.ts';

export const GET = () => json({ ok: true, labels: facets().labels.length });
