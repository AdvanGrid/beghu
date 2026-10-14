import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import type { Filters } from './types'
import { fetchFacets, fetchIssue, fetchIssues } from './issues.functions'

export const PAGE = 50

export const facetsQuery = () => queryOptions({ queryKey: ['facets'], queryFn: () => fetchFacets(), staleTime: Infinity })

export const issuesQuery = (filters: Filters) =>
  infiniteQueryOptions({
    queryKey: ['issues', filters],
    queryFn: ({ pageParam }) => fetchIssues({ data: { filters, offset: pageParam, limit: PAGE } }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length < PAGE ? undefined : pages.length * PAGE),
  })

export const issueQuery = (id: string) => queryOptions({ queryKey: ['issue', id], queryFn: () => fetchIssue({ data: id }) })
