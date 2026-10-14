import { subscribe } from "~/lib/db";

// Server-sent events: the ids of issues that changed, for the client to revalidate.
export function GET() {
  const enc = new TextEncoder();
  let off = () => {};
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(": hi\n\n"));
      off = subscribe((ids) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ ids })}\n\n`)));
    },
    cancel() {
      off();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}
