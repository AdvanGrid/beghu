import { createServerFn } from '@tanstack/react-start'
import type { Filters } from './types'
import * as db from '#/server/db.server'

export const fetchFacets = createServerFn().handler(() => db.facets)

export const fetchIssues = createServerFn()
  .validator((d: { filters: Filters; offset: number; limit: number }) => d)
  .handler(({ data }) => db.listIssues(data.filters, data.offset, Math.min(data.limit, 500)))

export const fetchIssue = createServerFn()
  .validator((id: string) => id)
  .handler(({ data }) => {
    const issue = db.getIssue(data)
    if (!issue) throw new Error(`issue ${data} not found`)
    return issue
  })

export const addLabel = createServerFn({ method: 'POST' })
  .validator((d: { id: string; name: string }) => d)
  .handler(async ({ data }) => {
    if (!(await db.addLabel(data.id, data.name))) throw new Error(`no label ${data.name}`)
    return { ok: true }
  })
