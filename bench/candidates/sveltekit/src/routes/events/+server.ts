// Server-sent events: the ids each webhook or write touched.
import { changes } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => {
	const encoder = new TextEncoder();
	let onChange: (e: Event) => void;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(': hi\n\n'));
			onChange = (e) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify({ ids: (e as CustomEvent<string[]>).detail })}\n\n`));
			changes.addEventListener('change', onChange);
			request.signal.addEventListener('abort', () => changes.removeEventListener('change', onChange));
		},
		cancel() {
			changes.removeEventListener('change', onChange);
		}
	});
	return new Response(stream, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
	});
};
