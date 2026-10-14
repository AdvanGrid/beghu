export type Filters = {
  state: 'open' | 'closed'
  label: string[]
  assignee: string[]
  q: string
}

export type Label = { name: string; color: string }

export type IssueRow = {
  id: string
  number: number
  title: string
  state: 'open' | 'closed'
  updated_at: string
  comments_count: number
  repo: string
  labels: Label[]
  assignees: string[]
}

export type Comment = { id: string; body: string; created_at: string; author: string | null }

export type IssueDetail = IssueRow & {
  body: string
  repo_labels: Label[]
  comments: Comment[]
}

export function validateFilters(search: Record<string, unknown>): Filters {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    state: search.state === 'closed' ? 'closed' : 'open',
    label: strings(search.label),
    assignee: strings(search.assignee),
    q: typeof search.q === 'string' ? search.q : '',
  }
}
