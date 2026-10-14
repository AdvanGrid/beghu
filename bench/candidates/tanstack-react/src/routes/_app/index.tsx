import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/')({
  component: () => <p className="text-zinc-500 dark:text-zinc-400">Pick an issue.</p>,
})
