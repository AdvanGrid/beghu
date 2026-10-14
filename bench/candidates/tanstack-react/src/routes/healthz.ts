import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/healthz')({
  server: { handlers: { GET: () => Response.json({ ok: true }) } },
})
