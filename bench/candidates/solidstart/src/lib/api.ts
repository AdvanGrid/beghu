// The router's query/action wrappers around the server functions: cached, deduplicated, and
// revalidated by key when a live change arrives.

import { action, query } from "@solidjs/router";
import type { Filter } from "./db";
import * as server from "./server";

export type { Filter, Row, Detail, Label } from "./db";

export const PAGE = 50;

export const facets = query(() => server.getFacets(), "facets");
export const issues = query((filter: Filter, page: number) => server.getIssues(filter, page * PAGE, PAGE), "issues");
export const issue = query((id: string) => server.getIssue(id), "issue");

export const addLabel = action(async (id: string, name: string) => {
  await server.addLabel(id, name);
}, "addLabel");
