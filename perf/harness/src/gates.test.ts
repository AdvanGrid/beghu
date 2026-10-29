// The verdicts the CI summary and ./dev-ctl perf give, from results and budgets.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { check, loadBudgets, recalibrate, type Budgets, type Results } from "./gates.ts";

const results = (suite: string, metrics: Record<string, number>): Results => ({
  suite,
  scale: "50k",
  commit: "abc",
  started: "",
  host: { cpus: 1, model: "", load: [] },
  metrics: Object.fromEntries(Object.entries(metrics).map(([k, value]) => [k, { value, unit: "ms" as const }])),
});

const budgets: Budgets = {
  scale: "50k",
  local: { slower_than: 0.1, floor_ms: 1 },
  gates: {
    "server.list.ms": { max: 10, measured: 8.7, reason: "r" },
    "server.list.scan": { max: 0, measured: 0, reason: "r" },
    "browser.first-load.kb": { max: 48, measured: 66, reason: "r", report_only: true },
    "load.p95.ms": { max: 100, measured: 87, reason: "r" },
    "server.facets.scan": { max: 37467, measured: 37467, reason: "r", spec: 0 },
  },
};

const verdicts = (rows: ReturnType<typeof check>) => Object.fromEntries(rows.map((r) => [r.gate, r.verdict]));

test("a value over its limit fails, at it passes, and over a report-only limit warns", () => {
  const rows = check([results("server", { "server.list.ms": 10, "server.list.scan": 1 }), results("browser", { "browser.first-load.kb": 66 })], budgets);
  assert.deepEqual(verdicts(rows), {
    "browser.first-load.kb": "warn",
    "server.facets.scan": "missing",
    "server.list.ms": "pass",
    "server.list.scan": "fail",
  });
});

test("a measured gate with no budget fails, as does a budget its suite didn't measure; a suite that didn't run is left out", () => {
  const rows = check([results("server", { "server.list.ms": 5, "server.new.ms": 1 })], budgets);
  assert.deepEqual(verdicts(rows), {
    "server.facets.scan": "missing",
    "server.list.ms": "pass",
    "server.list.scan": "missing",
    "server.new.ms": "unbudgeted",
  });
});

test("within a limit looser than the spec warns as over spec; past the limit it still fails", () => {
  const at = check([results("server", { "server.facets.scan": 37467 })], budgets, ["server.facets.*"]);
  assert.deepEqual(verdicts(at), { "server.facets.scan": "over-spec" });
  const more = check([results("server", { "server.facets.scan": 37468 })], budgets, ["server.facets.*"]);
  assert.deepEqual(verdicts(more), { "server.facets.scan": "fail" });
});

test("an expected suite with no results shows its budgets as missing", () => {
  const rows = check([results("server", { "server.list.ms": 5, "server.list.scan": 0, "server.facets.scan": 0 })], budgets, [], ["server", "load"]);
  assert.equal(verdicts(rows)["load.p95.ms"], "missing");
  assert.equal(verdicts(rows)["server.list.ms"], "pass");
});

test("globs pick the gates", () => {
  const rows = check([results("server", { "server.list.ms": 50, "server.list.scan": 0 })], budgets, ["server.list.*n"]);
  assert.deepEqual(verdicts(rows), { "server.list.scan": "pass" });
});

test("every budget needs a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "budgets-"));
  const path = join(dir, "b.toml");
  writeFileSync(path, '[gates."server.list.ms"]\nmax = 1\nmeasured = 1\nreason = ""\n');
  assert.throws(() => loadBudgets(path), /server\.list\.ms needs max, measured and a reason/);
  writeFileSync(path, '[local]\nslower_than = 0.1\n[gates."server.list.ms"]\nmax = 1\nmeasured = 0.9\nreason = "why"\n');
  assert.equal(loadBudgets(path).gates["server.list.ms"]!.max, 1);
});

test("recalibrating sets the measured value and its margin, keeps reasons and report-only limits, and names gates with no budget", () => {
  const text = [
    "# a comment",
    '[gates."server.list.ms"]',
    "max = 1",
    "measured = 1",
    'reason = "why"',
    "",
    '[gates."server.list.kb"]',
    "max = 1",
    "measured = 1",
    'reason = "why"',
    "",
    '[gates."server.list.scan"]',
    "max = 1",
    "measured = 1",
    'reason = "why"',
    "",
    '[gates."browser.first-load.kb"]',
    "max = 48",
    "measured = 60",
    "report_only = true",
    'reason = "later"',
    "",
  ].join("\n");
  const out = recalibrate(text, { "server.list.ms": 10, "server.list.kb": 4, "server.list.scan": 3, "browser.first-load.kb": 66, "server.new.ms": 2 });
  assert.equal(
    out.text,
    text
      .replace('ms"]\nmax = 1\nmeasured = 1', 'ms"]\nmax = 11.5\nmeasured = 10')
      .replace('list.kb"]\nmax = 1\nmeasured = 1', 'list.kb"]\nmax = 4.2\nmeasured = 4')
      .replace('scan"]\nmax = 1\nmeasured = 1', 'scan"]\nmax = 3\nmeasured = 3')
      .replace("measured = 60", "measured = 66"),
  );
  assert.deepEqual(out.unknown, ["server.new.ms"]);
});
