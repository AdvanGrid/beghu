"use server";
// Server functions. The "use server" file directive turns every export into an RPC endpoint, so
// the client bundle never sees ./db.

import * as db from "./db";
import type { Filter } from "./db";

export async function getFacets() {
  return db.facets();
}

export async function getIssues(filter: Filter, offset: number, limit: number) {
  return db.listIssues(filter, offset, limit);
}

export async function getIssue(id: string) {
  return db.detail(id);
}

export async function addLabel(id: string, name: string) {
  await db.addLabel(id, name);
}
