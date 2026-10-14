import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useMutationState, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { issueQuery } from '#/lib/queries'
import { addLabel } from '#/lib/issues.functions'
import type { Label } from '#/lib/types'

export const Route = createFileRoute('/_app/issues/$id')({
  loader: ({ context: { queryClient }, params }) => queryClient.ensureQueryData(issueQuery(params.id)),
  component: Detail,
})

function Detail() {
  const { id } = Route.useParams()
  const { data: issue } = useSuspenseQuery(issueQuery(id))
  const queryClient = useQueryClient()
  const key = issueQuery(id).queryKey

  // Optimistic "via the UI": the pending label renders straight from the mutation's variables,
  // with no await before the first paint (the cache variant awaits cancelQueries first).
  const add = useMutation({
    mutationKey: ['add-label', id],
    mutationFn: (label: Label) => addLabel({ data: { id, name: label.name } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })
  const pending = useMutationState({
    filters: { mutationKey: ['add-label', id], status: 'pending' },
    select: (m) => m.state.variables as Label,
  })
  const labels = [...issue.labels, ...pending.filter((p) => !issue.labels.some((l) => l.name === p.name))]

  const have = new Set(labels.map((l) => l.name))
  return (
    <article data-bench="detail" data-id={issue.id}>
      <h2 className="mb-2 text-lg font-semibold">
        <span className="text-zinc-500 dark:text-zinc-400">
          {issue.repo}#{issue.number}{' '}
        </span>
        {issue.title}
      </h2>
      <div className="mb-2 flex flex-wrap gap-1">
        {labels.map((l) => (
          <span key={l.name} data-bench="label" data-value={l.name} className="rounded-full border border-zinc-200 px-2 dark:border-zinc-800">
            {l.name}
          </span>
        ))}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        Add:
        {issue.repo_labels
          .filter((l) => !have.has(l.name))
          .map((l) => (
            <button
              key={l.name}
              data-bench="add-label"
              data-value={l.name}
              onClick={() => add.mutate(l)}
              className="rounded border border-zinc-200 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              {l.name}
            </button>
          ))}
      </div>
      <div data-bench="body" className="whitespace-pre-wrap">
        {issue.body}
      </div>
      {issue.comments.map((c) => (
        <div key={c.id} data-bench="comment" className="border-t border-zinc-200 py-2 dark:border-zinc-800">
          <div className="text-zinc-500 dark:text-zinc-400">
            {c.author} · {c.created_at}
          </div>
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      ))}
    </article>
  )
}
