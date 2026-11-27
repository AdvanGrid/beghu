// The PR view's committed analyses on the dev stack (#178): every upload goes through an analysis
// run (start, fetch pr.json to pin, upload), as an agent's does; analyses.db is never seeded.
// What the fixture knows (the recorded versions, the tiles, the control calls that move the
// recorded PR between versions) comes from the fixture crate's `pr-fixtures`.
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.ts";

/** A recorded version (`1`, `2`), a tile (`tiled-1x`, `tiled-3x`) or a case, as `pr-fixtures versions` lists them. */
export interface Version {
  name: string;
  repo: string;
  number: number;
  /** A recorded version's number; a tile has none. */
  version?: number;
  headSha: string;
  analysis: string | null;
  pr: string;
  /** A case uploaded as a later analysis after this recorded version (`<feature>.after-v1.json`, at v2's head). */
  after?: number;
}

/** The cases: hand-written analyses of the recorded PR at v1, or at v2 for one after v1 (fixtures/pr-view/cases/). */
const CASES = join(ROOT, "fixtures", "pr-view", "cases");

/** A case that is a later analysis after v1, as analysis-fixtures names it. */
const AFTER_V1 = ".after-v1";

function cargo(args: string[]): string {
  const r = spawnSync("cargo", ["run", "--quiet", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (r.status !== 0) throw new Error(`cargo run ${args.join(" ")} failed`);
  return r.stdout;
}

/** Every version an upload can name, the tiles written first if this generator hasn't yet. */
export function versions(): Version[] {
  const all = JSON.parse(cargo(["-p", "fixture", "--bin", "pr-fixtures", "--", "versions"])) as Version[];
  const v1 = all.find((v) => v.version === 1);
  const v2 = all.find((v) => v.version === 2);
  if (v1 && existsSync(CASES)) {
    for (const f of readdirSync(CASES).filter((f) => f.endsWith(".json")).sort()) {
      const stem = f.replace(/\.json$/, "");
      const after = stem.endsWith(AFTER_V1) ? 1 : undefined;
      // A later analysis is of a later push: a case after v1 is at v2's head, with v2's pr.json.
      const at = after ? v2 : v1;
      if (!at) continue;
      all.push({ ...at, name: after ? stem.slice(0, -AFTER_V1.length) : stem, version: undefined, analysis: join(CASES, f), after });
    }
  }
  return all;
}

/** The control calls that take recorded PR `number` from version `from` to `to`. */
function moves(number: number, from: number, to: number): { path: string; body: unknown }[] {
  return JSON.parse(cargo(["-p", "fixture", "--bin", "pr-fixtures", "--", "moves", String(number), String(from), String(to)]));
}

/** A browser's session with beghu: its cookies, kept by hand (the session cookie is `Secure`). */
export class Session {
  readonly cookies = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  private take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(at + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(this.base + path, { ...init, headers, redirect: "manual" });
    this.take(res);
    return res;
  }

  /** Signs `login` in through the whole web flow (beghu, Fake GitHub's OAuth, back). */
  async signIn(login: string): Promise<void> {
    let url = `${this.base}/auth/login?login=${encodeURIComponent(login)}`;
    for (let i = 0; i < 10; i++) {
      const res = url.startsWith(this.base) ? await this.fetch(url.slice(this.base.length)) : await fetch(url, { redirect: "manual" });
      await res.arrayBuffer();
      if (res.status < 300 || res.status >= 400) {
        if (res.status !== 200 || !this.cookies.has("beghu_acct")) throw new Error(`signing ${login} in ended at ${url}: ${res.status}`);
        return;
      }
      const to = res.headers.get("location")!;
      url = to.startsWith("/") ? new URL(to, url).toString() : to;
    }
    throw new Error(`signing ${login} in: too many redirects`);
  }

  /** A write from beghu's own page, as the tab on its account. */
  post(path: string): Promise<Response> {
    return this.fetch(path, { method: "POST", headers: { origin: this.base, "x-beghu-account": this.cookies.get("beghu_acct") ?? "" } });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether `login`'s mirror holds `repo` (owner/name) with no import running: what a run on it needs. */
export async function imported(server: string, login: string, repo: string): Promise<boolean> {
  const s = new Session(server);
  await s.signIn(login);
  const res = await s.fetch("/api/me", { headers: { "x-beghu-account": s.cookies.get("beghu_acct") ?? "" } });
  if (res.status !== 200) return false;
  const me = (await res.json()) as { import?: unknown; repos?: { owner: string; name: string }[] };
  return me.import == null && (me.repos ?? []).some((r) => `${r.owner}/${r.name}`.toLowerCase() === repo.toLowerCase());
}

/** A new run on `repo#number`: its token. */
async function startRun(s: Session, repo: string, number: number): Promise<string> {
  const res = await s.post(`/api/${repo}/pulls/${number}/runs`);
  const body = (await res.json().catch(() => null)) as { token?: string; message?: string } | null;
  if (res.status !== 201 || !body?.token) throw new Error(`starting a run on ${repo}#${number}: ${res.status} ${body?.message ?? ""}`);
  return body.token;
}

/** The run's pinned pr.json (its first fetch pins it). */
async function pin(s: Session, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${s.base}/api/runs/${token}/pr.json`);
  if (res.status !== 200) throw new Error(`fetching pr.json: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

async function control(url: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`fake ${path}: ${res.status} ${await res.text()}`);
}

/** The IDs an analysis names, its nodes' and lines', in order. */
function ids(a: { nodes?: { id: string }[]; edges?: { id: string }[] }): string[] {
  return [...(a.nodes ?? []).map((n) => n.id), ...(a.edges ?? []).map((e) => e.id)];
}

/** Whether `login`'s analysis of `v`'s PR is `v`: the same head, nodes and lines. */
async function holds(server: string, login: string, v: Version): Promise<boolean> {
  if (!v.analysis) return false;
  const s = new Session(server);
  await s.signIn(login);
  const [owner, repo] = v.repo.split("/");
  const res = await s.fetch(`/api/${owner}/${repo}/pulls/${v.number}/analysis`);
  if (res.status !== 200) return false;
  const graph = (await res.json()) as { headSha?: string; analysis?: { nodes?: { id: string }[]; edges?: { id: string }[] } };
  const want = JSON.parse(readFileSync(v.analysis, "utf8")) as { nodes?: { id: string }[]; edges?: { id: string }[] };
  return graph.headSha === v.headSha && isDeepStrictEqual(ids(graph.analysis ?? {}), ids(want));
}

export interface Uploaded {
  version: string;
  analysis: string;
  headSha: string;
  warnings: number;
}

/**
 * Uploads `want` as `login` through a run: first brings the PR on Fake GitHub to the state the
 * version was analysed at (the recorded PR moved between versions by the control calls the
 * fixture names; a tile's PR pushed to its head and files), then pins a run whose pr.json is the
 * version's (each edit's webhook takes a moment to reach the mirror, which the run's linked
 * issues come from: a pin that doesn't match yet is superseded by a new run), and uploads the
 * analysis as committed, byte for byte.
 */
export async function upload(server: string, controlUrl: string, login: string, want: Version, all: Version[]): Promise<Uploaded> {
  if (!want.analysis) throw new Error(`${want.name} has no analysis committed`);
  const tile = want.version === undefined && want.name.startsWith("tiled-");
  // A first analysis (v1, or a case not after v1; v1 also goes first for a case after it) can't
  // follow another of the PR's on the same account. Refused before anything moves the PR, so a
  // refusal leaves the stack as it was.
  const first = !tile && want.after === undefined && (want.version === undefined || want.version === 1);
  if (first) {
    const s = new Session(server);
    await s.signIn(login);
    const [owner, repo] = want.repo.split("/");
    const has = await s.fetch(`/api/${owner}/${repo}/pulls/${want.number}/analysis`);
    if (has.status === 200) {
      const other = login === "ilze-k" ? "after ./dev-ctl reset" : "as an account with none (--as ilze-k), or after ./dev-ctl reset";
      throw new Error(
        `${want.version === undefined ? want.name : `v${want.version}`} is a first analysis of ${want.repo}#${want.number}, and ${login} has one already, whose IDs it doesn't carry: upload it ${other}`,
      );
    }
  }
  if (want.after !== undefined) {
    // A later analysis: the one it follows goes first, so its `carried` has the IDs it names;
    // unless the account's analysis is that one already (uploaded earlier, so a view open on it
    // sees this one arrive as a newer analysis).
    const first = all.find((v) => v.number === want.number && v.version === want.after);
    if (!first) throw new Error(`${want.name} follows v${want.after}, which isn't recorded`);
    if (!(await holds(server, login, first))) await upload(server, controlUrl, login, first, all);
  }
  const s = new Session(server);
  await s.signIn(login);
  const expected = JSON.parse(readFileSync(want.pr, "utf8")) as Record<string, unknown>;
  let token = await startRun(s, want.repo, want.number);
  let pinned = await pin(s, token);
  if (pinned.headSha !== want.headSha) {
    if (tile) {
      const files = (expected.files as { path: string; previousPath?: string; status: string; additions: number; deletions: number }[]).map((f) => ({
        filename: f.path,
        previous_filename: f.previousPath ?? null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      const base = (expected.base as { sha: string }).sha;
      await control(controlUrl, "/push", { repo: want.repo, number: want.number, sha: want.headSha, base_sha: base, files });
    } else {
      const now = all.find((v) => v.version !== undefined && v.number === want.number && v.headSha === pinned.headSha);
      if (!now) throw new Error(`${want.repo}#${want.number} is at ${pinned.headSha}, which no recorded version is at: ./dev-ctl reset puts it back`);
      // A case is at a recorded version's head: v1's, or v2's for one after v1.
      const to = want.version ?? all.find((v) => v.version !== undefined && v.number === want.number && v.headSha === want.headSha)!.version!;
      for (const m of moves(want.number, now.version!, to)) await control(controlUrl, m.path, m.body);
    }
  }
  const deadline = Date.now() + 60_000;
  const matches = (p: Record<string, unknown>) =>
    tile ? p.headSha === want.headSha && isDeepStrictEqual(p.files, expected.files) : isDeepStrictEqual(p, expected);
  while (!matches(pinned)) {
    if (Date.now() > deadline) throw new Error(`no run pinned ${want.repo}#${want.number} as ${want.name} has it within 60 s`);
    await sleep(500);
    token = await startRun(s, want.repo, want.number);
    pinned = await pin(s, token);
  }
  const res = await fetch(`${server}/api/runs/${token}/analysis`, {
    method: "POST",
    // The recordings and cases pass the full validator against the real commits (CI's
    // pr-view-fixtures job); a tile's paths are made up.
    headers: { "content-type": "application/json", "beghu-snippets": tile ? "not-checked" : "checked" },
    body: readFileSync(want.analysis),
  });
  const body = (await res.json().catch(() => null)) as { analysis?: string; headSha?: string; warnings?: unknown[]; message?: string; report?: unknown } | null;
  if (res.status !== 201 || !body?.analysis) {
    throw new Error(`uploading ${want.name}: ${res.status} ${body?.message ?? ""}${body?.report ? `\n${JSON.stringify(body.report, null, 2).slice(0, 4000)}` : ""}`);
  }
  // Done, as an agent's run ends once its upload is in: the panel shows the analysis, no agent at work.
  const ended = await fetch(`${s.base}/api/runs/${token}/end`, { method: "POST" });
  if (!ended.ok) throw new Error(`ending the run: ${ended.status} ${await ended.text()}`);
  return { version: want.name, analysis: body.analysis, headSha: body.headSha ?? "", warnings: body.warnings?.length ?? 0 };
}
