// PROTOTYPE (PR view). Checks an analysis against schema.ts and the code it cites:
//   node validate.ts <analysis.json> <prep dir with base/, head/ and pr.json>
// Exits 1 on errors; warnings (judging or comparing words) don't fail it but should be fixed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis, Change, FacetAssignment, Question } from "./schema.ts";

const [file, dir] = process.argv.slice(2);
if (!file || !dir) {
  console.error("usage: node validate.ts <analysis.json> <prep dir>");
  process.exit(2);
}
const a = JSON.parse(readFileSync(file, "utf8")) as Analysis;
const pr = JSON.parse(readFileSync(join(dir, "pr.json"), "utf8")) as { files: { path: string }[] };
const errors: string[] = [];
const warnings: string[] = [];
const err = (m: string) => errors.push(m);

const CHANGES: Change[] = ["added", "removed", "modified", "unchanged"];
const ids = new Map<string, string>();
function unique(kind: string, id: string) {
  if (ids.has(id)) err(`${kind} ${id}: id already used by a ${ids.get(id)}`);
  ids.set(id, kind);
}
for (const k of ["facets", "nodes", "edges", "boundaries", "scenarios", "claims"] as const) {
  if (!Array.isArray(a[k])) err(`${k} missing`);
}
a.nodes.forEach((n) => unique("node", n.id));
a.edges.forEach((e) => unique("edge", e.id));
a.boundaries.forEach((b) => unique("boundary", b.id));
a.scenarios.forEach((s) => unique("scenario", s.id));
const claims = new Map(a.claims.map((c) => [c.id, c]));
a.claims.forEach((c) => unique("claim", c.id));
const nodes = new Map(a.nodes.map((n) => [n.id, n]));
const edges = new Map(a.edges.map((e) => [e.id, e]));
const boundaries = new Set(a.boundaries.map((b) => b.id));
const facets = new Map(a.facets.map((f) => [f.id, f]));
const used = new Set<string>();

function refs(where: string, list: string[] | undefined, need = true) {
  if (!list || (need && list.length === 0)) err(`${where}: no claims`);
  for (const c of list ?? []) {
    if (!claims.has(c)) err(`${where}: unknown claim ${c}`);
    used.add(c);
  }
}
function change(where: string, c: Change) {
  if (!CHANGES.includes(c)) err(`${where}: change "${c}" isn't one of ${CHANGES.join(", ")}`);
}
function facetsOf(where: string, list: FacetAssignment[], appliesTo: "node" | "edge") {
  for (const f of list) {
    const def = facets.get(f.facet);
    if (!def) {
      err(`${where}: unknown facet ${f.facet}`);
      continue;
    }
    if (def.appliesTo !== appliesTo) err(`${where}: facet ${f.facet} applies to ${def.appliesTo}s`);
    if (!def.multi && f.values.length > 1) err(`${where}: facet ${f.facet} takes one value`);
    for (const v of [...f.values, ...(f.was ?? [])]) {
      if (!def.values.some((x) => x.id === v)) err(`${where}: facet ${f.facet} has no value ${v}`);
    }
    refs(`${where} facet ${f.facet}`, f.claims);
  }
}
function questions(where: string, list: Question[]) {
  for (const q of list) {
    refs(`${where} "${q.q}"`, q.claims);
    words(`${where} answer "${q.q}"`, q.a);
  }
}

const JUDGING =
  /\b(should|shouldn't|could instead|consider|recommend|better|worse|risky|risk of|concern|smell|clean|messy|well[- ]designed|poorly|similar to|overlaps?|duplicates?|duplicated|same as|mirrors|redundant)\b/i;
function words(where: string, text: string | undefined) {
  const m = text && JUDGING.exec(text);
  if (m) warnings.push(`${where}: "${m[0]}" judges or compares: describe instead`);
}

for (const f of a.facets) {
  unique("facet", f.id);
  if (f.values.length < 2) err(`facet ${f.id}: fewer than two values`);
  for (const v of f.values) if (v.prefix.length < 1 || v.prefix.length > 4) err(`facet ${f.id} value ${v.id}: prefix must be 1–4 characters`);
}

const placed = new Map<string, string>();
for (const n of a.nodes) {
  const w = `node ${n.id}`;
  change(w, n.change);
  if (n.parent !== undefined && !nodes.has(n.parent)) err(`${w}: unknown parent ${n.parent}`);
  if (n.zone !== undefined && !boundaries.has(n.zone)) err(`${w}: unknown zone ${n.zone}`);
  if (n.change !== "unchanged" && !n.changeSummary) err(`${w}: changed but no changeSummary`);
  if (n.paths.length === 0 && n.kind !== "external" && n.kind !== "actor" && n.kind !== "system") err(`${w}: no paths`);
  words(`${w} summary`, n.summary);
  words(`${w} changeSummary`, n.changeSummary);
  for (const r of n.responsibilities) {
    change(`${w} responsibility ${r.id}`, r.change);
    refs(`${w} responsibility ${r.id}`, r.claims);
    words(`${w} responsibility`, r.text);
  }
  facetsOf(w, n.facets, "node");
  questions(w, n.questions);
  for (const f of n.files) {
    if (placed.has(f.path)) err(`file ${f.path}: in both ${placed.get(f.path)} and ${n.id}`);
    placed.set(f.path, n.id);
  }
}
for (const n of a.nodes) {
  const seen = new Set<string>();
  for (let p: string | undefined = n.id; p !== undefined; p = nodes.get(p)?.parent) {
    if (seen.has(p)) {
      err(`node ${n.id}: parent cycle`);
      break;
    }
    seen.add(p);
  }
}
for (const f of pr.files) if (!placed.has(f.path)) err(`file ${f.path}: changed in the PR but in no node's files`);
// Changed means its own code changed: some PR file under its paths or a child's.
const kids = new Map<string, string[]>();
for (const n of a.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
const prPaths = pr.files.map((f) => f.path);
const ownCode = (id: string): boolean => {
  const n = nodes.get(id)!;
  const under = (p: string) => prPaths.some((f) => f === p.replace(/\/$/, "") || f.startsWith(`${p.replace(/\/$/, "")}/`));
  return n.files.length > 0 || n.paths.some(under) || (kids.get(id) ?? []).some(ownCode);
};
for (const n of a.nodes) {
  if (n.change !== "unchanged" && !ownCode(n.id)) err(`node ${n.id}: marked ${n.change}, but no file the PR changed is under its paths or its children's: only its connections changed, so it stays unchanged`);
}

for (const e of a.edges) {
  const w = `edge ${e.id}`;
  if (!nodes.has(e.from)) err(`${w}: unknown from ${e.from}`);
  if (!nodes.has(e.to)) err(`${w}: unknown to ${e.to}`);
  change(w, e.change);
  for (const b of e.crosses) if (!boundaries.has(b)) err(`${w}: unknown boundary ${b}`);
  refs(w, e.claims);
  facetsOf(w, e.facets, "edge");
  questions(w, e.questions);
  words(`${w} label`, e.label);
}
for (const b of a.boundaries) refs(`boundary ${b.id}`, b.claims);
for (const s of a.scenarios) {
  s.steps.forEach((st, i) => {
    const w = `scenario ${s.id} step ${i + 1}`;
    if (!nodes.has(st.from)) err(`${w}: unknown from ${st.from}`);
    if (!nodes.has(st.to)) err(`${w}: unknown to ${st.to}`);
    if (st.edge !== undefined && !edges.has(st.edge)) err(`${w}: unknown edge ${st.edge}`);
    change(w, st.change);
    refs(w, st.claims);
  });
}

const files = new Map<string, string[] | null>();
function lines(side: string, path: string): string[] | null {
  const key = `${side}/${path}`;
  if (!files.has(key)) {
    try {
      files.set(key, readFileSync(join(dir, side, path), "utf8").split("\n"));
    } catch {
      files.set(key, null);
    }
  }
  return files.get(key)!;
}
const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n").trim();
for (const c of a.claims) {
  const w = `claim ${c.id}`;
  words(w, c.text);
  if (!used.has(c.id)) warnings.push(`${w}: nothing refers to it`);
  if (c.status === "supported" && c.evidence.length === 0) err(`${w}: supported but no evidence`);
  if (c.status === "undetermined" && !c.lookedAt) err(`${w}: undetermined but no lookedAt`);
  for (const ev of c.evidence) {
    const at = `${w} ${ev.side}:${ev.path}:${ev.start}-${ev.end}`;
    const file = lines(ev.side, ev.path);
    if (!file) {
      err(`${at}: no such file`);
      continue;
    }
    if (ev.start < 1 || ev.end < ev.start || ev.end > file.length) {
      err(`${at}: lines out of range (file has ${file.length})`);
      continue;
    }
    if (ev.end - ev.start >= 25) err(`${at}: more than 25 lines`);
    if (norm(file.slice(ev.start - 1, ev.end).join("\n")) !== norm(ev.snippet)) err(`${at}: snippet doesn't match the file's lines`);
  }
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);
console.log(
  `${a.nodes.length} nodes, ${a.edges.length} edges, ${a.claims.length} claims, ${a.scenarios.length} scenarios, ${a.facets.length} facets: ${errors.length} errors, ${warnings.length} warnings`,
);
process.exit(errors.length ? 1 : 0);
