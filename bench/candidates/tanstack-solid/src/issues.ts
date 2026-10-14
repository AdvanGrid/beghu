// Types, server functions and query options for issues: the whole data path between the
// browser and the mirror.

import { infiniteQueryOptions, queryOptions } from '@tanstack/solid-query'
import { notFound } from '@tanstack/solid-router'
import { createServerFn } from '@tanstack/solid-start'
import * as mirror from '~/server/mirror.server'

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
export type IssueDetail = IssueRow & { body: string; repo_labels: Label[]; comments: Comment[] }

export type Filters = { state: 'open' | 'closed'; labels: string[]; assignees: string[]; q: string }

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Search params are the filter state, so a view is a URL.
export function validateFilters(s: Record<string, unknown>): Filters {
  return {
    state: s.state === 'closed' ? 'closed' : 'open',
    labels: strings(s.labels),
    assignees: strings(s.assignees),
    q: typeof s.q === 'string' ? s.q : '',
  }
}

export const DEFAULT_FILTERS: Filters = { state: 'open', labels: [], assignees: [], q: '' }

export const PAGE = 100

const fetchFacets = createServerFn({ method: 'GET' }).handler(() => mirror.facets)

const fetchIssues = createServerFn({ method: 'GET' })
  .validator((d: { filters: Filters; offset: number }) => d)
  .handler(({ data }) => mirror.listIssues(data.filters, data.offset, PAGE))

const fetchIssue = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(({ data }) => {
    const d = mirror.issueDetail(data)
    if (!d) throw notFound()
    return d
  })

export const addLabel = createServerFn({ method: 'POST' })
  .validator((d: { id: string; name: string }) => d)
  .handler(async ({ data }) => {
    if (!(await mirror.addLabel(data.id, data.name))) throw new Error(`no label ${data.name}`)
    return { ok: true }
  })

export const facetsQuery = () => queryOptions({ queryKey: ['facets'], queryFn: () => fetchFacets(), staleTime: Infinity })

export const issuesQuery = (filters: Filters) =>
  infiniteQueryOptions({
    queryKey: ['issues', filters],
    queryFn: ({ pageParam }) => fetchIssues({ data: { filters, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length < PAGE ? undefined : pages.length * PAGE),
  })

export const issueQuery = (id: string) => queryOptions({ queryKey: ['issue', id], queryFn: () => fetchIssue({ data: id }) })
