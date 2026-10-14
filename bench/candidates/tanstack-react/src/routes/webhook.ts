import { createFileRoute } from '@tanstack/react-router'
import { applyWebhook } from '#/server/db.server'

export const Route = createFileRoute('/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        applyWebhook(request.headers.get('x-github-event'), await request.json())
        return Response.json({ ok: true }, { status: 202 })
      },
    },
  },
})
