// The perf harness's command line.
//
//   run SUITE --bin DIR --web DIR [--scale 50k] [--data DIR] [--out FILE] [--iterations N] [--commit SHA] [--keep-data]
//       One suite (server, load or browser) against a stack started from a release build (`--bin`
//       holds beghu, fake-github and fixture) and a web build (`--web`), on fresh data. Writes the
//       results as JSON and prints the suite's verdicts; exits 1 if a gate fails.
//   report FILE... [--md FILE] [--title T] [--expect SUITE,…]
//       The verdicts on every gate of the suites in the results files, and of each --expect'ed
//       suite (one with no results shows its gates as missing), as a Markdown table (the PR
//       comment) and a summary line; exits 1 if a gate fails.
//   calibrate FILE...
//       Sets every budgeted gate the results files measured to its measured value plus the
//       margin (+15% timings, +5% bytes, counts exact; report-only limits stay), in
//       perf-budgets.toml, keeping comments and reasons. Prints the gates with no budget yet.
//   local [--full] [--fresh] [--build-only] [GLOB...]
//       ./dev-ctl perf (local.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { check, loadBudgets, recalibrate, type Results } from "./gates.ts";
import { local } from "./local.ts";
import { markdown, summaryLine, failed } from "./report.ts";
import { BUDGETS, fixtureFor, ROOT, seed, start } from "./stack.ts";
import { runSuite, results } from "./suite.ts";
import { suiteProbes, SUITES, WARMUP, type SuiteName } from "./suites.ts";

function parse(args: string[], flags: string[], bools: string[] = []) {
  const opts: Record<string, string> = {};
  const set = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (bools.includes(a)) set.add(a);
    else if (flags.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts[a] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  return { opts, set, pos };
}

async function run(args: string[]): Promise<number> {
  const { opts, set, pos } = parse(args, ["--bin", "--web", "--scale", "--data", "--out", "--iterations", "--commit"], ["--keep-data"]);
  const suite = pos[0] as SuiteName;
  if (!SUITES.includes(suite) || !opts["--bin"] || !opts["--web"]) {
    throw new Error(`usage: run ${SUITES.join("|")} --bin DIR --web DIR [--scale 50k] [--data DIR] [--out FILE] [--iterations N]`);
  }
  const budgets = loadBudgets(BUDGETS);
  const scale = opts["--scale"] ?? budgets.scale;
  const commit = opts["--commit"] ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const build = { bin: resolve(opts["--bin"]), web: resolve(opts["--web"]), commit };
  const data = resolve(opts["--data"] ?? join(ROOT, ".dev", "perf", `ci-${suite}`));
  const out = resolve(opts["--out"] ?? join(ROOT, ".dev", "perf", `${suite}.json`));
  mkdirSync(dirname(out), { recursive: true });
  const started = new Date();
  const fixture = fixtureFor(build, scale);
  // Fresh data, unless --keep-data reuses what an earlier run seeded from the same fixture
  // (a quicker rerun locally; the write probes change it a little).
  seed(build, fixture, data, !set.has("--keep-data"));
  const stack = await start(suite, build, fixture, data, `${out}.log`);
  try {
    const { probes, iterations, close } = await suiteProbes(suite, stack);
    try {
      const metrics = await runSuite(probes, budgets, Number(opts["--iterations"] ?? iterations), WARMUP[suite]);
      const r = results(suite, scale, commit, started, metrics);
      writeFileSync(out, JSON.stringify(r, null, 2) + "\n");
      const rows = check([r], budgets);
      console.log(markdown(rows, { title: `${suite} suite`, lines: [] }));
      console.log(summaryLine(rows, (Date.now() - started.getTime()) / 1000));
      return failed(rows).length ? 1 : 0;
    } finally {
      for (const p of probes) await p.done?.();
      await close();
    }
  } finally {
    await stack.stop();
  }
}

function report(args: string[]): number {
  const { opts, pos } = parse(args, ["--md", "--title", "--expect"]);
  // A file a crashed suite never wrote (or an unmatched glob) is skipped: --expect shows it.
  const all = pos.filter((f) => existsSync(f)).map((f) => JSON.parse(readFileSync(f, "utf8")) as Results);
  const expect = opts["--expect"]?.split(",").filter(Boolean) ?? [];
  const rows = check(all, loadBudgets(BUDGETS), [], expect);
  const r0 = all[0];
  const retried = (r: Results) => Object.entries(r.retries ?? {}).map(([p, n]) => `${p} ×${n}`).join(", ");
  const lines = [
    ...(r0 ? [`${r0.scale} fixture, commit \`${r0.commit.slice(0, 12)}\`, median of the samples with one confirming re-run`] : []),
    ...all.map((r) => `${r.suite}: ${r.host.cpus} × ${r.host.model}, load ${r.host.load.join(" ")}${retried(r) ? `; samples retried: ${retried(r)}` : ""}`),
    ...expect.filter((s) => !all.some((r) => r.suite === s)).map((s) => `${s}: **no results** (the suite crashed or was cancelled: see its job)`),
  ];
  const md = markdown(rows, { title: opts["--title"] ?? "Perf gates", lines });
  if (opts["--md"]) writeFileSync(opts["--md"], md);
  console.log(md);
  console.log(summaryLine(rows));
  return failed(rows).length || all.length === 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      return run(args);
    case "report":
      return report(args);
    case "calibrate": {
      const values: Record<string, number> = {};
      for (const f of args) for (const [k, m] of Object.entries((JSON.parse(readFileSync(f, "utf8")) as Results).metrics)) values[k] = m.value;
      const { text, unknown } = recalibrate(readFileSync(BUDGETS, "utf8"), values);
      writeFileSync(BUDGETS, text);
      console.log(`recalibrated ${Object.keys(values).length - unknown.length} gates in perf-budgets.toml; review the diff`);
      if (unknown.length) console.log(`no budget yet (add a section with a reason): ${unknown.join(", ")}`);
      return 0;
    }
    case "local": {
      const { set, pos } = parse(args, [], ["--full", "--fresh", "--build-only"]);
      return local({ full: set.has("--full"), fresh: set.has("--fresh"), buildOnly: set.has("--build-only"), globs: pos });
    }
    default:
      console.error("usage: main.ts run SUITE … | report FILE… | local [--full] [GLOB…]; see the top of perf/harness/src/main.ts");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  },
);
