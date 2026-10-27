// What the specs that edit share across Playwright's workers: the fixture issues they write to,
// and the stack-wide state some of them change. Files under this checkout's .dev/e2e, which
// global-setup.ts empties before each run: each issue is claimed by one test, and a lock lets
// tests run side by side unless one needs the stack to itself.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const DIR = fileURLToPath(new URL("../../.dev/e2e", import.meta.url));
const CLAIMS = join(DIR, "claims");
/** One file per test holding the lock shared. */
const READERS = join(DIR, "readers");
/** A directory, made by the one test holding the lock exclusively; its `pid` file says whose. */
const WRITER = join(DIR, "writer");
/** A directory: made by a test while it makes GitHub answer 5xx (see `fiveHundreds`). */
const FIVE_HUNDREDS = join(DIR, "5xx");

/** Empties the claims and the lock: before a run, when no test is running. */
export function resetClaims(): void {
  rmSync(DIR, { recursive: true, force: true });
  for (const d of [CLAIMS, READERS]) mkdirSync(d, { recursive: true });
}

/** Claims `id` for this test; false if another test has it. */
function claim(id: number): boolean {
  try {
    closeSync(openSync(join(CLAIMS, String(id)), "wx"));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export type Row = {
  id: number;
  owner: string;
  repo: string;
  number: number;
  comments: number;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[];
};
export type Issue = Row & { ref: string; index: number };

/**
 * Open issues below the default list's top 40 rows (the browser specs rely on those), with 1 to
 * 15 comments (one page), and where each sits in the list: of its first `depth` rows (a test
 * after a few issues of one repo looks further).
 */
export async function issuesBelowTheTop(page: Page, depth = 200): Promise<Issue[]> {
  const all: Row[] = [];
  let after: string | null = null;
  do {
    const res = await page.request.get(after ? `/api/issues?after=${after}` : "/api/issues");
    const p = (await res.json()) as { rows: Row[]; next: string | null };
    all.push(...p.rows);
    after = p.next;
  } while (after && all.length < depth);
  return all
    .map((r, index) => ({ ...r, index, ref: `${r.owner}/${r.repo}#${r.number}` }))
    .slice(40)
    .filter((r) => r.comments >= 1 && r.comments <= 15);
}

/**
 * The first issue below the top (and passing `fits`) that no other test has claimed, claimed for
 * this one: tests running side by side, or one run's `--repeat-each` copies, never share one.
 */
export async function claimBelowTheTop(page: Page, fits: (r: Issue) => boolean = () => true, depth?: number): Promise<Issue> {
  const issue = (await issuesBelowTheTop(page, depth)).find((r) => fits(r) && claim(r.id));
  if (!issue) throw new Error("no unclaimed issue below the top of the default list");
  return issue;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes `dir` if the worker that made it has gone (a crash mid-test). */
function dropIfStale(dir: string): void {
  try {
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    if (pid && !alive(pid)) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Not there, or still being made.
  }
}

/** Makes `dir` as this worker's mutex, waiting while another worker has it. */
async function mutex(dir: string): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      dropIfStale(dir);
      await sleep(100);
    }
  }
}

let readers = 0;

/** Holds the lock beside other tests, waiting while one holds it exclusively. */
export async function shared(): Promise<() => void> {
  const me = join(READERS, `${process.pid}-${++readers}`);
  for (;;) {
    dropIfStale(WRITER);
    if (!existsSync(WRITER)) {
      writeFileSync(me, "");
      // A writer that came in meanwhile waits for this file to go, or this one backs off.
      if (!existsSync(WRITER)) return () => rmSync(me, { force: true });
      rmSync(me, { force: true });
    }
    await sleep(100);
  }
}

/** Holds the lock alone: no other test runs until it's released. */
export async function exclusive(): Promise<() => void> {
  const release = await mutex(WRITER);
  for (;;) {
    const left = readdirSync(READERS).filter((f) => alive(Number(f.split("-")[0])));
    if (left.length === 0) return release;
    await sleep(100);
  }
}

/**
 * Held while a test makes GitHub answer 5xx: three in a row, from any call, mark GitHub down for
 * the whole server (crates/server/src/github.rs), and tests side by side each failing one call
 * could add up to three.
 */
export function fiveHundreds(): Promise<() => void> {
  return mutex(FIVE_HUNDREDS);
}
