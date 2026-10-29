// `./dev-ctl perf`: whether this tree is slower than local `main`, in about a minute.
//
// Both trees are built for release: this one incrementally, main once per commit, in a git
// worktree with its own target dir. Main's worktree, build, fixture and data live under the git
// common dir (`<git-common-dir>/beghu-perf`), shared by every worktree of the repo; ./dev-ctl
// runs this under a host-wide lock, so two runs never build or measure at once. Main uses this
// tree's fixture (perf/data) when the fixture's inputs are the same in both. The two start side
// by side at the budgets' scale, on data seeded once per fixture. A quick set of probes then
// samples both in turn, swapping which goes first, so a busy machine slows both alike: a timing
// fails when this tree's median is more than `[local] slower_than` slower than main's (and slower
// by more than `floor_ms`, below which loopback timings are noise). Bytes and counts are held to
// their budgets as in CI. `--full` runs CI's three suites against this tree alone, at their
// absolute limits. `--build-only` stops once both trees are built and seeded. GLOBs pick gates
// by name (`'server.*'`, `'*.scan'`); a probe runs if any of its gates is picked.
//
// Writes .dev/perf/last.json and last.md, and prints the summary line.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, loadBudgets, selected, unitOf, type Results, type Row } from "./gates.ts";
import { markdown, summaryLine, failed } from "./report.ts";
import { BUDGETS, fixtureFor, ROOT, seed, start, type Build, type Stack } from "./stack.ts";
import { measurePairs, results, runSuite, type Probe } from "./suite.ts";
import { SUITES, suiteProbes, WARMUP } from "./suites.ts";
import { browserProbes, launch, prepare } from "./browser.ts";
import { serverProbes } from "./server.ts";

const OUT = join(ROOT, ".dev", "perf");
const git = (args: string[], cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** Main's worktree, builds, fixtures and data: one copy for every worktree of the repo. */
const SHARED = join(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]), "beghu-perf");
/** What the fixture generator hashes (perf/fixture/build.rs). */
const FIXTURE_INPUTS = ["perf/fixture", "crates/mirror-db/migrations", "crates/mirror-db/queries", "crates/mirror-db/src/lib.rs", "crates/dbrt/src/stats.rs"];

/** The quick set: what most changes move, cheap enough for a minute. */
const QUICK = {
  server: ["server.list", "server.list-label", "server.search", "server.facets", "server.detail", "server.next-page"],
  browser: ["browser.warm", "browser.filter", "browser.open-issue"],
  /** Samples per timing, per tree. */
  serverIterations: 5,
  browserIterations: 4,
};

const BINARIES = ["beghu", "fake-github", "fixture"];

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): void {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (in ${cwd})`);
}

/** A hash of every file under `dir` (skipping build output and dependencies). */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (["node_modules", "dist", "test-results", "playwright-report"].includes(name)) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p.slice(dir.length)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 16);
}

/**
 * Builds the tree at `src` (release binaries into `target`, copied out; the web build when its
 * sources changed) into `dest`. Main gets a target dir of its own: cargo names a workspace
 * member's artifacts by its path inside the workspace, so two checkouts sharing one would take
 * each other's crates for fresh.
 */
function buildTree(src: string, dest: string, commit: string, target: string): Build {
  const bin = join(dest, "bin");
  const web = join(dest, "web");
  console.log(`building ${src === ROOT ? "this tree" : `main (${commit.slice(0, 10)})`}`);
  sh("cargo", ["build", "--release", "--locked", "--quiet", "-p", "beghu", "-p", "fake-github", "-p", "fixture"], src, {
    CARGO_TARGET_DIR: target,
  });
  mkdirSync(bin, { recursive: true });
  // Through a rename: a binary a running stack has open can't be written over.
  for (const b of BINARIES) {
    copyFileSync(join(target, "release", b), join(bin, `${b}.new`));
    renameSync(join(bin, `${b}.new`), join(bin, b));
  }
  const webSrc = join(src, "web");
  const hash = treeHash(webSrc);
  const mark = join(dest, "web.hash");
  if (!existsSync(mark) || readFileSync(mark, "utf8") !== hash) {
    if (src !== ROOT) mainDependencies(webSrc);
    sh(process.execPath, [join(webSrc, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn", "--outDir", web, "--emptyOutDir"], webSrc);
    writeFileSync(mark, hash);
  }
  return { bin, web, commit };
}

/**
 * Main's web dependencies, checked on every build: this tree's (a link to them) while the
 * lockfiles agree, else its own (`npm ci`), redone whenever its lockfile changes.
 */
function mainDependencies(webSrc: string): void {
  const lock = readFileSync(join(webSrc, "package-lock.json"));
  const want = readFileSync(join(ROOT, "web", "package-lock.json")).equals(lock) ? "link" : createHash("sha256").update(lock).digest("hex");
  const mark = join(webSrc, ".perf-deps");
  const nm = join(webSrc, "node_modules");
  if (existsSync(mark) && readFileSync(mark, "utf8") === want && existsSync(join(nm, "vite"))) return;
  rmSync(nm, { recursive: true, force: true });
  if (want === "link") symlinkSync(join(ROOT, "web", "node_modules"), nm);
  else sh("npm", ["ci", "--no-audit", "--no-fund"], webSrc);
  writeFileSync(mark, want);
}

/** Local main, built in a worktree, cached by commit. */
function buildMain(): Build {
  const sha = git(["rev-parse", "main"]);
  const dest = join(SHARED, "main", sha.slice(0, 12));
  if (BINARIES.every((b) => existsSync(join(dest, "bin", b))) && existsSync(join(dest, "web", "index.html"))) {
    return { bin: join(dest, "bin"), web: join(dest, "web"), commit: sha };
  }
  const src = join(SHARED, "main-src");
  if (!existsSync(join(src, ".git"))) {
    rmSync(src, { recursive: true, force: true });
    git(["worktree", "add", "--quiet", "--detach", src, sha]);
  } else {
    git(["checkout", "--quiet", "--detach", "--force", sha], src);
  }
  // Older builds of main go: one is kept.
  rmSync(join(SHARED, "main"), { recursive: true, force: true });
  return buildTree(src, dest, sha, join(SHARED, "main-target"));
}

function write(rows: Row[], meta: { title: string; lines: string[]; vsMain?: boolean }, extra: Record<string, unknown>, seconds: number): number {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "last.json"), JSON.stringify({ ...extra, rows, seconds: Math.round(seconds) }, null, 2) + "\n");
  writeFileSync(join(OUT, "last.md"), markdown(rows, meta));
  const bad = failed(rows);
  for (const r of bad) {
    console.log(`  ${r.gate}: ${r.value}${r.main !== undefined ? ` vs main ${r.main}` : ""}${r.limit !== null ? ` (limit ${r.limit})` : ""}`);
    for (const e of r.evidence ?? []) console.log(`    ${e}`);
  }
  console.log(summaryLine(rows, seconds));
  console.log(`details: ${join(OUT, "last.md").slice(ROOT.length + 1)}`);
  return bad.length ? 1 : 0;
}

export async function local(opts: { full: boolean; fresh: boolean; buildOnly: boolean; globs: string[] }): Promise<number> {
  const t0 = Date.now();
  const budgets = loadBudgets(BUDGETS);
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]) !== "";
  const head = buildTree(ROOT, join(OUT, "head"), commit, join(ROOT, "target"));
  const headFixture = fixtureFor(head, budgets.scale);

  if (opts.full) {
    // CI's suites, one after another, against this tree alone; their writes leave the data
    // changed, so the next run seeds it again.
    const all: Results[] = [];
    for (const suite of SUITES) {
      if (!selectedSuite(suite, opts.globs)) continue;
      const data = join(OUT, "head", "data");
      seed(head, headFixture, data, true);
      const stack = await start(`head-${suite}`, head, headFixture, data, join(OUT, `${suite}.log`));
      try {
        const { probes, iterations, close } = await suiteProbes(suite, stack);
        const picked = probes.filter((p) => selectedProbe(p, opts.globs));
        try {
          console.log(`${suite}: ${picked.map((p) => p.name).join(", ")}`);
          all.push(results(suite, budgets.scale, commit, new Date(), await runSuite(picked, budgets, iterations, WARMUP[suite])));
        } finally {
          for (const p of probes) await p.done?.();
          await close();
        }
      } finally {
        await stack.stop();
        rmSync(join(data, "seeded.json"), { force: true });
      }
    }
    const rows = check(all, budgets, opts.globs).filter((r) => r.verdict !== "missing" || opts.globs.length === 0);
    return write(rows, { title: "Perf gates (--full, absolute limits)", lines: [`this tree: \`${commit.slice(0, 12)}\`${dirty ? " + uncommitted changes" : ""}, ${budgets.scale}`] }, { mode: "full", commit, dirty, results: all }, (Date.now() - t0) / 1000);
  }

  const main = buildMain();
  // This tree's fixture when its inputs are the same on main; else main's own, in a dir of its
  // own (the generator keeps only its latest fixtures there).
  const sameFixture = spawnSync("git", ["diff", "--quiet", "main", "--", ...FIXTURE_INPUTS], { cwd: ROOT }).status === 0;
  const mainFixture = sameFixture ? headFixture : fixtureFor(main, budgets.scale, join(SHARED, "fixtures"));
  const ready = Date.now();
  seed(head, headFixture, join(OUT, "head", "data"), opts.fresh);
  seed(main, mainFixture, join(SHARED, "data"), opts.fresh);
  const built = Math.round((Date.now() - t0) / 1000);
  if (opts.buildOnly) {
    console.log(`built and seeded in ${built} s`);
    return 0;
  }
  console.log(`built in ${built} s (seeding ${Math.round((Date.now() - ready) / 1000)} s); starting both stacks`);
  const measuring = Date.now();
  const starting = Date.now();
  const [a, b] = await Promise.all([
    start("head", head, headFixture, join(OUT, "head", "data"), join(OUT, "head.log")),
    start("main", main, mainFixture, join(SHARED, "data"), join(OUT, "main.log")),
  ]);
  console.log(`  stacks up: ${Math.round((Date.now() - starting) / 1000)} s`);
  let rows: Row[];
  try {
    const [ha, hb] = await quick(a, b, opts.globs, 1);
    rows = compare(ha, hb, budgets, opts.globs);
    // A timing that came out slower is measured once more, twice as long, and that decides it.
    const slow = rows.filter((r) => r.verdict === "fail" && r.slower !== undefined).map((r) => r.gate);
    if (slow.length) {
      console.log(`confirming ${slow.join(", ")}`);
      const [ca, cb] = await quick(a, b, slow, 2);
      for (const g of slow) {
        if (!ca[g] || !cb[g]) continue;
        ha[g] = { ...(ca[g] as object), first: (ha[g] as { value: number }).value };
        hb[g] = cb[g];
      }
      rows = compare(ha, hb, budgets, opts.globs);
    }
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
  console.log(`measured in ${Math.round((Date.now() - measuring) / 1000)} s`);
  return write(
    rows,
    {
      title: "Perf vs local main (quick)",
      lines: [
        `this tree: \`${commit.slice(0, 12)}\`${dirty ? " + uncommitted changes" : ""}; main: \`${main.commit.slice(0, 12)}\`; ${budgets.scale}`,
        `timings fail more than ${budgets.local.slower_than * 100}% (and ${budgets.local.floor_ms} ms) slower than main; bytes and counts against perf-budgets.toml`,
      ],
      vsMain: true,
    },
    { mode: "quick", commit, dirty, main: main.commit },
    (Date.now() - t0) / 1000,
  );
}

/** A probe runs when one of its gates is picked. */
const selectedProbe = (p: Probe, globs: string[]) => p.gates.some((g) => selected(g, globs));
/** A suite runs when a gate of its could be picked: one whose glob could match a name in it. */
const selectedSuite = (suite: string, globs: string[]) => globs.length === 0 || globs.some((g) => selected(suite, [g.split(".")[0]!]));

/** The quick probes on both stacks, sampled in turn: this tree's metrics and main's. */
async function quick(a: Stack, b: Stack, globs: string[], times: number): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const pick = (ps: Probe[], names: string[]) => names.map((n) => ps.find((p) => p.name === n)!).filter((p) => selectedProbe(p, globs));
  const [sa, sb] = await Promise.all([serverProbes(a, { quick: true }), serverProbes(b, { quick: true })]);
  const server = pick(sa, QUICK.server).map((p, i) => [p, pick(sb, QUICK.server)[i]!] as [Probe, Probe]);
  console.log(`server: ${server.map(([p]) => p.name).join(", ")}`);
  let t = Date.now();
  const [ma, mb] = server.length ? await measurePairs(server, QUICK.serverIterations * times, 2) : [{}, {}];
  console.log(`  server probes: ${Math.round((Date.now() - t) / 1000)} s`);
  t = Date.now();
  // No browser when no gate of its could be picked.
  if (globs.length && !globs.some((g) => g.startsWith("browser") || g.startsWith("*"))) {
    for (const p of [...sa, ...sb]) await p.done?.();
    return [ma, mb];
  }
  const browser = await launch();
  try {
    const [ca, cb] = await Promise.all([prepare(browser, a, { quick: true }), prepare(browser, b, { quick: true })]);
    const [ba, bb] = await Promise.all([browserProbes(ca), browserProbes(cb)]);
    const pairs = pick(ba, QUICK.browser).map((p, i) => [p, pick(bb, QUICK.browser)[i]!] as [Probe, Probe]);
    console.log(`browser: ${pairs.map(([p]) => p.name).join(", ")}`);
    console.log(`  browser ready: ${Math.round((Date.now() - t) / 1000)} s`);
    t = Date.now();
    const [xa, xb] = pairs.length ? await measurePairs(pairs, QUICK.browserIterations * times, 0) : [{}, {}];
    console.log(`  browser probes: ${Math.round((Date.now() - t) / 1000)} s`);
    return [{ ...ma, ...xa }, { ...mb, ...xb }];
  } finally {
    for (const p of [...sa, ...sb]) await p.done?.();
    await browser.close();
  }
}

/**
 * This tree against main: a timing by how much slower it is, anything else against its budget.
 * A main without a metric (it predates the gate) leaves only the budget.
 */
function compare(head: Record<string, unknown>, main: Record<string, unknown>, budgets: ReturnType<typeof loadBudgets>, globs: string[]): Row[] {
  const r = (m: Record<string, unknown>, suite: string) => ({ suite, scale: budgets.scale, commit: "", started: "", host: { cpus: 0, model: "", load: [] }, metrics: m }) as Results;
  const rows = check([r(head, "server"), r(head, "browser")], budgets, globs).filter((x) => x.value !== null);
  for (const row of rows) {
    if (unitOf(row.gate) !== "ms") continue;
    const m = (main[row.gate] as { value: number } | undefined)?.value;
    if (m === undefined || row.value === null) continue;
    row.main = m;
    row.slower = row.value / m - 1;
    row.limit = null;
    const over = row.slower > budgets.local.slower_than && row.value - m > budgets.local.floor_ms;
    row.verdict = over ? "fail" : "pass";
  }
  return rows;
}
