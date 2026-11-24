// The merge's command line. build.sh puts this after the WASM glue and the inlined module, so
// `merge` and `finish` are in scope.
import { readFileSync } from "node:fs";

const usage = `usage:
  node merge.mjs [--split <split.json>] <skeleton.json> <area.json>... > merged.json
  node merge.mjs --finish <merged.json> > analysis.json

Joins a split run's fragments (the skeleton first, then each area) into one analysis on stdout,
with the seam pass's work left on it as "hints". With --split, every candidate in split.json that
no fragment drew or rejected becomes a "candidate" hint. --finish strips the hints the seam pass
resolved and keeps the rest. The report goes to stderr as JSON: {"errors": [...], "warnings": [...]}.
Exits 1 when there are errors (with --finish, any hint still unresolved).`;

function fail(message) {
  process.stderr.write(`${message}\n\n${usage}\n`);
  process.exitCode = 2;
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return fail("");
  let finishing = false;
  let splitFile;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--finish") finishing = true;
    else if (a === "--split") {
      if (i + 1 >= argv.length) return fail("--split needs a value");
      splitFile = argv[++i];
    } else if (a.startsWith("--")) return fail(`unknown option ${a}`);
    else files.push(a);
  }
  if (finishing && splitFile !== undefined) return fail("--split goes with the merge, not --finish");
  if (finishing ? files.length !== 1 : files.length === 0) return fail(finishing ? "give one merged file" : "give the fragments");
  const texts = files.map((f) => {
    try {
      return readFileSync(f, "utf8");
    } catch (e) {
      throw new Error(`can't read ${f}: ${e.message}`);
    }
  });
  let split;
  if (splitFile !== undefined) {
    try {
      split = readFileSync(splitFile, "utf8");
    } catch (e) {
      throw new Error(`can't read ${splitFile}: ${e.message}`);
    }
  }
  const out = JSON.parse(finishing ? finish(texts[0]) : merge(JSON.stringify(texts), split));
  if (out.analysis !== null) process.stdout.write(`${JSON.stringify(out.analysis, null, 2)}\n`);
  const { errors, warnings } = out.report;
  process.stderr.write(`${JSON.stringify(out.report, null, 2)}\n`);
  const hints = out.analysis?.hints?.length ?? 0;
  process.stderr.write(`${errors.length} errors, ${warnings.length} warnings, ${hints} hints left for the seam pass\n`);
  // Never process.exit(): it can cut piped output short. Node exits once stdout has drained.
  process.exitCode = errors.length ? 1 : 0;
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`merge.mjs: ${e.message}\n`);
  process.exitCode = 2;
}
