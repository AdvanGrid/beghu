import { createFileRoute } from '@tanstack/solid-router'

export const Route = createFileRoute('/_app/')({
  component: () => <p class="p-4 text-sm text-zinc-500 dark:text-zinc-400">Pick an issue.</p>,
})
