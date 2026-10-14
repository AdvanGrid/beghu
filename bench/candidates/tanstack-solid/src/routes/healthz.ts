import { createFileRoute } from '@tanstack/solid-router'

export const Route = createFileRoute('/healthz')({
  server: { handlers: { GET: () => Response.json({ ok: true }) } },
})
