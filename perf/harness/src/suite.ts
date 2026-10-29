// Probes and how a suite runs them: round-robin over the probes for N iterations, each timing
// the median of its samples, every other value the largest seen (bytes and counts are the same
// every time on a fixed fixture). A timing over its limit is measured once more, and only that
// confirming run decides it.
import { cpus, loadavg } from "node:os";
import { overLimit, unitOf, type Budgets, type Metric, type Results } from "./gates.ts";
import { median, round } from "./stats.ts";

/** One sample's values by gate name, with what explains any of them. */
export interface Sample {
  values: Record<string, number>;
  evidence?: Record<string, string[]>;
}

export interface Probe {
  /** Its name, and the prefix of most of its gates: `server.list` for `server.list.ms`. */
  name: string;
  /** Every gate a sample of it measures. */
  gates: string[];
  sample(): Promise<Sample>;
  /** Puts back what the samples changed. */
  done?(): Promise<void>;
}

type Collected = Map<string, { values: number[]; evidence: Set<string> }>;

function add(into: Collected, s: Sample): void {
  for (const [k, v] of Object.entries(s.values)) {
    const c = into.get(k) ?? { values: [], evidence: new Set() };
    c.values.push(v);
    for (const e of s.evidence?.[k] ?? []) c.evidence.add(e);
    into.set(k, c);
  }
}

/**
 * Whether a gate takes the median of its samples: a timing, and two counts a busy machine moves
 * now and then (a scan a request waits on a background re-read for, a long task while scrolling),
 * whose regression shows in every sample. Every other value is the same each time on a fixed
 * fixture, and takes the largest.
 */
const byMedian = (gate: string) => unitOf(gate) === "ms" || gate.endsWith(".scan") || gate.endsWith(".long-tasks");

function aggregate(c: Collected): Record<string, Metric> {
  const out: Record<string, Metric> = {};
  for (const [k, { values, evidence }] of c) {
    const unit = unitOf(k);
    const value = byMedian(k) ? median(values) : Math.max(...values);
    const m: Metric = { value: round(value, unit === "count" ? 0 : 2), unit };
    if (unit === "ms") m.samples = values.map((v) => round(v, 2));
    if (evidence.size) m.evidence = [...evidence].slice(0, 8);
    out[k] = m;
  }
  return out;
}

/**
 * One sample, tried again once if it fails: on a busy machine a page can miss a frame deadline
 * or see the list move under it. A second failure stops the suite, with both errors.
 */
/** Samples tried again after failing, by probe, for the results. */
export const retries: Record<string, number> = {};

async function attempt(p: Probe): Promise<Sample> {
  try {
    return await p.sample();
  } catch (first) {
    retries[p.name] = (retries[p.name] ?? 0) + 1;
    console.log(`${p.name}: a sample failed, trying once more: ${(first as Error).message.split("\n")[0]}`);
    try {
      return await p.sample();
    } catch (second) {
      throw new Error(`${p.name} failed twice:\n${(first as Error).message}\n---\n${(second as Error).message}`);
    }
  }
}

/** Samples every probe `iterations` times, round-robin, after `warmup` unrecorded rounds. */
export async function measure(probes: readonly Probe[], iterations: number, warmup = 1): Promise<Record<string, Metric>> {
  const c: Collected = new Map();
  for (let i = 0; i < warmup + iterations; i++) {
    for (const p of probes) {
      const s = await attempt(p);
      if (i >= warmup) add(c, s);
    }
  }
  return aggregate(c);
}

/**
 * Samples each pair's two probes in turn (this tree's, then main's, swapping the order every
 * iteration), so that a busy machine slows both alike.
 */
export async function measurePairs(pairs: readonly [Probe, Probe][], iterations: number, warmup = 1): Promise<[Record<string, Metric>, Record<string, Metric>]> {
  const a: Collected = new Map();
  const b: Collected = new Map();
  for (let i = 0; i < warmup + iterations; i++) {
    for (const [x, y] of pairs) {
      const order: [Probe, Collected][] = i % 2 ? [[y, b], [x, a]] : [[x, a], [y, b]];
      for (const [p, into] of order) {
        const s = await attempt(p);
        if (i >= warmup) add(into, s);
      }
    }
  }
  return [aggregate(a), aggregate(b)];
}

/**
 * Runs a suite's probes, then once more those whose timings are over their limits: the re-run's
 * value stands, with the first run's kept beside it.
 */
export async function runSuite(probes: readonly Probe[], budgets: Budgets, iterations: number, warmup = 1): Promise<Record<string, Metric>> {
  const metrics = await measure(probes, iterations, warmup);
  const over = overLimit(metrics, budgets);
  if (over.length) {
    const again = probes.filter((p) => over.some((g) => p.gates.includes(g)));
    console.log(`confirming ${over.join(", ")}`);
    const second = await measure(again, iterations, 0);
    for (const g of over) {
      if (second[g]) metrics[g] = { ...second[g]!, first: metrics[g]!.value };
    }
  }
  return metrics;
}

export function results(suite: string, scale: string, commit: string, started: Date, metrics: Record<string, Metric>): Results {
  return {
    suite,
    scale,
    commit,
    started: started.toISOString(),
    host: { cpus: cpus().length, model: cpus()[0]?.model ?? "?", load: loadavg().map((l) => round(l, 1)) },
    retries: { ...retries },
    metrics,
  };
}
