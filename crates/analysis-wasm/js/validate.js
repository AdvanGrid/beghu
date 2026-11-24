// The validator's command line. build.sh puts this after the WASM glue and the inlined module, so
// `validate` and `check_split` are in scope.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const usage = `usage:
  node validate.mjs <analysis.json> <base dir> <head dir> [--pr <pr.json>] [--previous <dir>]
  node validate.mjs <skeleton.json> <base dir> <head dir> --split <split.json> [--pr <pr.json>]

Checks an analysis against schema.ts and the two checkouts, and prints the report as JSON:
{"errors": [{"path", "rule", "message"}], "warnings": [...]}. Exits 1 when there are errors.
  --pr <pr.json>      the run's pr.json: every changed file must be placed (and, with --split,
                      owned by exactly one area)
  --previous <dir>    the folder holding the run's previous-ids.json and vocabulary.json; with
                      neither file in it, there is no previous analysis and carried must be empty
  --split <split.json> check the split instead (check-split): the first file is the skeleton`;

function fail(message) {
  process.stderr.write(`${message}\n\n${usage}\n`);
  process.exitCode = 2;
}

function readJson(path, what) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`can't read ${what} ${path}: ${e.message}`);
  }
}

function main(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return fail("");
    if (a === "--pr" || a === "--previous" || a === "--split") {
      if (i + 1 >= argv.length) return fail(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      return fail(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 3) return fail("give the analysis, the base checkout and the head checkout");
  const [file, base, head] = positional;
  const changedFiles = flags.pr ? JSON.parse(readJson(flags.pr, "pr.json")).files.map((f) => f.path) : null;
  let out;
  if (flags.split) {
    out = JSON.parse(check_split(readJson(file, "the skeleton"), readJson(flags.split, "split.json"), JSON.stringify(changedFiles)));
  } else {
    const options = {};
    if (changedFiles) options.changedFiles = changedFiles;
    if (flags.previous) {
      const ids = tryRead(join(flags.previous, "previous-ids.json"));
      const vocabulary = tryRead(join(flags.previous, "vocabulary.json"));
      if (ids === undefined && vocabulary === undefined) options.previous = null;
      else if (ids === undefined || vocabulary === undefined)
        return fail(`${flags.previous} holds only one of previous-ids.json and vocabulary.json`);
      else options.previous = { ids: JSON.parse(ids), vocabulary: JSON.parse(vocabulary) };
    }
    out = JSON.parse(validate(readJson(file, "the analysis"), JSON.stringify(options), checkouts({ base, head })));
  }
  const { errors, warnings } = out.report;
  process.stdout.write(`${JSON.stringify(out.report, null, 2)}\n`);
  const counts = out.counts
    ? ` (${Object.entries(out.counts).map(([k, n]) => `${n} ${k}`).join(", ")})`
    : "";
  process.stderr.write(`${errors.length} errors, ${warnings.length} warnings${counts}\n`);
  // Never process.exit(): it can cut a piped report short. Node exits once stdout has drained.
  process.exitCode = errors.length ? 1 : 0;
}

function tryRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The reader the crate calls: repo-relative paths inside each checkout, nothing outside it. */
function checkouts(roots) {
  const at = (side, path) => {
    const root = roots[side];
    const full = join(root, path);
    const rel = relative(root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return full;
  };
  return {
    read(side, path) {
      const p = at(side, path);
      try {
        return p === undefined ? undefined : readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    kind(side, path) {
      const p = at(side, path);
      try {
        return p === undefined ? undefined : statSync(p).isDirectory() ? "dir" : "file";
      } catch {
        return undefined;
      }
    },
    subdirs(side, path) {
      const p = at(side, path);
      try {
        if (p === undefined) return undefined;
        const dirs = readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        return JSON.stringify(dirs);
      } catch {
        return undefined;
      }
    },
  };
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`validate.mjs: ${e.message}\n`);
  process.exitCode = 2;
}
