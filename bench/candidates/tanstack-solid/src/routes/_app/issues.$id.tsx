// The open issue: body, comments, label chips, and an optimistic "add label".

import { createFileRoute } from '@tanstack/solid-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query'
import { For, Show } from 'solid-js'
import { addLabel, issueQuery, type IssueDetail, type Label } from '~/issues'

export const Route = createFileRoute('/_app/issues/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(issueQuery(params.id)),
  component: IssuePanel,
})

function IssuePanel() {
  const params = Route.useParams()
  const issue = useQuery(() => issueQuery(params().id))
  const queryClient = useQueryClient()

  const add = useMutation(() => ({
    mutationFn: (label: Label) => addLabel({ data: { id: params().id, name: label.name } }),
    onMutate: async (label: Label) => {
      const key = issueQuery(params().id).queryKey
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (d) => d && { ...d, labels: [...d.labels, label] })
      return { previous, key }
    },
    onError: (_err, _label, ctx) => ctx && queryClient.setQueryData(ctx.key, ctx.previous),
    onSettled: (_data, _err, _label, ctx) => ctx && queryClient.invalidateQueries({ queryKey: ctx.key }),
  }))

  return (
    <Show when={issue.data}>
      {(d) => <Issue issue={d()} onAdd={(l) => add.mutate(l)} />}
    </Show>
  )
}

function Issue(props: { issue: IssueDetail; onAdd: (l: Label) => void }) {
  const missing = () => {
    const have = new Set(props.issue.labels.map((l) => l.name))
    return props.issue.repo_labels.filter((l) => !have.has(l.name))
  }
  return (
    <article data-bench="detail" data-id={props.issue.id} class="flex flex-col gap-3 p-4">
      <h2 class="text-lg font-semibold">
        <span class="mr-2 text-zinc-500 dark:text-zinc-400">
          {props.issue.repo}#{props.issue.number}
        </span>
        {props.issue.title}
      </h2>
      <div class="flex flex-wrap gap-1">
        <For each={props.issue.labels}>
          {(l) => (
            <span
              data-bench="label"
              data-value={l.name}
              class="rounded-full bg-zinc-200 px-2 py-0.5 text-xs text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
            >
              {l.name}
            </span>
          )}
        </For>
      </div>
      <div class="flex flex-wrap items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        Add:
        <For each={missing()}>
          {(l) => (
            <button
              data-bench="add-label"
              data-value={l.name}
              onClick={() => props.onAdd(l)}
              class="rounded border border-zinc-300 px-2 py-0.5 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {l.name}
            </button>
          )}
        </For>
      </div>
      <pre data-bench="body" class="whitespace-pre-wrap font-sans text-sm text-zinc-800 dark:text-zinc-200">
        {props.issue.body}
      </pre>
      <For each={props.issue.comments}>
        {(c) => (
          <div data-bench="comment" class="rounded border border-zinc-200 p-3 dark:border-zinc-800">
            <div class="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
              {c.author} · {c.created_at}
            </div>
            <pre class="whitespace-pre-wrap font-sans text-sm text-zinc-800 dark:text-zinc-200">{c.body}</pre>
          </div>
        )}
      </For>
    </article>
  )
}
