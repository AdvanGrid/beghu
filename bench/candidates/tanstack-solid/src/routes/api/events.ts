import { createFileRoute } from '@tanstack/solid-router'
import { subscribe } from '~/server/mirror.server'

// Server-sent events: one message per change, carrying the ids that changed.
export const Route = createFileRoute('/api/events')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const enc = new TextEncoder()
        let unsubscribe = () => {}
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(': hi\n\n'))
            unsubscribe = subscribe((ids) => controller.enqueue(enc.encode(`data: ${JSON.stringify({ ids })}\n\n`)))
            request.signal.addEventListener('abort', () => unsubscribe())
          },
          cancel: () => unsubscribe(),
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
      },
    },
  },
})
