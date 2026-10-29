// The gates: what a suite measured, the limits in perf-budgets.toml, and the verdict on each.
import { readFileSync } from "node:fs";
import { parse } from "smol-toml";

export type Unit = "ms" | "kb" | "count";

/** One measured value. Timings are the median of their samples. */
export interface Metric {
  value: number;
  unit: Unit;
  samples?: number[];
  /** What to look at when it fails: the requests, statements or frames behind the value. */
  evidence?: string[];
  /** A timing that failed and was measured again: the first run's value (`value` is the re-run's). */
  first?: number;
}

export interface Results {
  suite: string;
  /** Samples tried a second time after failing, by probe. */
  retries?: Record<string, number>;
  scale: string;
  commit: string;
  started: string;
  host: { cpus: number; model: string; load: number[] };
  metrics: Record<string, Metric>;
}

export interface Budget {
  max: number;
  /** The value it was calibrated from. */
  measured: number;
  reason: string;
  /** Over the limit warns, and fails nothing. */
  report_only?: boolean;
  /**
   * What the spec asks for, where the limit is looser (calibrated as measured, the debt named in
   * the reason): over it warns beside the limit, and the limit still catches a regression.
   */
  spec?: number;
}

export interface Budgets {
  scale: string;
  /** `./dev-ctl perf`: a timing more than this fraction slower than local main fails. */
  local: { slower_than: number; floor_ms: number };
  gates: Record<string, Budget>;
}

/** A gate's unit, from its name's last part: `.ms` and `.kb`, else a count. */
export function unitOf(name: string): Unit {
  if (name.endsWith(".ms")) return "ms";
  if (name.endsWith(".kb")) return "kb";
  return "count";
}

/** The suite a gate belongs to: its name's first part. */
export const suiteOf = (name: string) => name.split(".")[0]!;

export function loadBudgets(path: string): Budgets {
  const raw = parse(readFileSync(path, "utf8")) as unknown as {
    meta?: { scale?: string };
    local?: { slower_than?: number; floor_ms?: number };
    gates?: Record<string, Budget>;
  };
  const gates = raw.gates ?? {};
  for (const [name, b] of Object.entries(gates)) {
    if (typeof b.max !== "number" || typeof b.measured !== "number" || typeof b.reason !== "string" || !b.reason.trim()) {
      throw new Error(`${path}: gate ${name} needs max, measured and a reason`);
    }
  }
  return {
    scale: raw.meta?.scale ?? "50k",
    local: { slower_than: raw.local?.slower_than ?? 0.1, floor_ms: raw.local?.floor_ms ?? 0 },
    gates,
  };
}

/** Whether `name` matches one of `globs` (`*` any run of characters); every name with none. */
export function selected(name: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return true;
  return globs.some((g) => new RegExp(`^${g.split("*").map(escape).join(".*")}$`).test(name));
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export type Verdict = "pass" | "fail" | "warn" | "over-spec" | "unbudgeted" | "missing";

export interface Row {
  gate: string;
  unit: Unit;
  value: number | null;
  limit: number | null;
  /** The spec's value, where the limit is looser. */
  spec?: number;
  verdict: Verdict;
  reason?: string;
  evidence?: string[];
  first?: number;
  /** `./dev-ctl perf`: local main's value, and how much slower this tree is (a fraction). */
  main?: number;
  slower?: number;
}

/**
 * The verdict on every gate of the suites that ran, and of `expect`ed suites whether they ran or
 * not: over a limit fails (warns when report-only), within it but over the spec warns, a value
 * with no budget fails as unbudgeted, and a budget no suite measured fails as missing (a suite
 * that crashed shows as all its gates missing). Gates outside `globs` are left out.
 */
export function check(results: readonly Results[], budgets: Budgets, globs: readonly string[] = [], expect: readonly string[] = []): Row[] {
  const ran = new Set([...results.map((r) => r.suite), ...expect]);
  const measured = new Map<string, Metric>();
  for (const r of results) for (const [k, m] of Object.entries(r.metrics)) measured.set(k, m);
  const names = new Set([...measured.keys(), ...Object.keys(budgets.gates).filter((g) => ran.has(suiteOf(g)))]);
  const rows: Row[] = [];
  for (const gate of [...names].sort()) {
    if (!selected(gate, globs)) continue;
    const m = measured.get(gate);
    const b = budgets.gates[gate];
    const row: Row = { gate, unit: unitOf(gate), value: m?.value ?? null, limit: b?.max ?? null, verdict: "pass" };
    if (m?.evidence) row.evidence = m.evidence;
    if (m?.first !== undefined) row.first = m.first;
    if (b) row.reason = b.reason;
    if (b?.spec !== undefined) row.spec = b.spec;
    if (!m) row.verdict = "missing";
    else if (!b) row.verdict = "unbudgeted";
    else if (m.value > b.max) row.verdict = b.report_only ? "warn" : "fail";
    else if (b.spec !== undefined && m.value > b.spec) row.verdict = "over-spec";
    rows.push(row);
  }
  return rows;
}

/** Whether a gate is a timing: measured again once before it fails. */
export const isTiming = (gate: string) => unitOf(gate) === "ms";

/** The timings over their limits, which a suite measures once more to confirm. */
export function overLimit(metrics: Record<string, Metric>, budgets: Budgets): string[] {
  return Object.entries(metrics)
    .filter(([k, m]) => isTiming(k) && budgets.gates[k] && !budgets.gates[k]!.report_only && m.value > budgets.gates[k]!.max)
    .map(([k]) => k);
}

/** What one response, push or shell may weigh: the first flight (spec #86). */
export const RESPONSE_KB = 14;

/**
 * The limit a measured value calibrates to: +15% for a timing, +5% for bytes (a response's never
 * past 14 KB; the first load's total is a sum, not a response), a count exactly.
 */
export function calibrated(gate: string, value: number): number {
  const unit = unitOf(gate);
  if (unit === "ms") return Math.ceil(value * 1.15 * 10) / 10;
  if (unit === "kb") {
    const kb = Math.ceil(value * 1.05 * 10) / 10;
    return gate === "browser.first-load.kb" ? kb : Math.min(RESPONSE_KB, kb);
  }
  return value;
}

/**
 * The budget file's text with each gate in `values` recalibrated: its `measured` set to the value
 * and its `max` to `calibrated` (a report-only gate keeps its `max`). Comments, reasons and every
 * other line stay as they were. Gates with no section are returned as `unknown`.
 */
export function recalibrate(text: string, values: Record<string, number>): { text: string; unknown: string[] } {
  const lines = text.split("\n");
  const seen = new Set<string>();
  let gate: string | null = null;
  let reportOnly = false;
  const sections: { gate: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[gates\."([^"]+)"\]/.exec(lines[i]!);
    if (m || /^\[/.test(lines[i]!)) {
      if (gate) sections[sections.length - 1]!.end = i;
      gate = m ? m[1]! : null;
      if (gate) sections.push({ gate, start: i, end: lines.length });
    }
  }
  for (const sec of sections) {
    const v = values[sec.gate];
    if (v === undefined) continue;
    seen.add(sec.gate);
    reportOnly = lines.slice(sec.start, sec.end).some((l) => /^report_only\s*=\s*true/.test(l));
    for (let i = sec.start; i < sec.end; i++) {
      if (/^measured\s*=/.test(lines[i]!)) lines[i] = `measured = ${v}`;
      else if (/^max\s*=/.test(lines[i]!) && !reportOnly) lines[i] = `max = ${calibrated(sec.gate, v)}`;
    }
  }
  return { text: lines.join("\n"), unknown: Object.keys(values).filter((g) => !seen.has(g)).sort() };
}
