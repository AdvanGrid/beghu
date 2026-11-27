// The suites CI runs in parallel, each with its probes and how many samples a timing takes. The
// layout suite needs no stack: it runs our layout in this process (layout.ts).
import { browserProbes, launch, prepare } from "./browser.ts";
import { layoutProbes } from "./layout.ts";
import { loadProbe } from "./load.ts";
import { serverProbes } from "./server.ts";
import { ROOT, type Stack } from "./stack.ts";
import type { Probe } from "./suite.ts";

export const SUITES = ["server", "load", "browser", "layout"] as const;

/** The suites that run against a stack (the layout suite runs the engine in-process). */
export const needsStack = (suite: SuiteName) => suite !== "layout";
export type SuiteName = (typeof SUITES)[number];

/** Samples per timing: the median of 10 (the load suite's one sample is 30 s of 20 users). */
export const ITERATIONS: Record<SuiteName, number> = { server: 10, load: 1, browser: 10, layout: 10 };
/**
 * Unrecorded rounds first: the server's warm its caches; the browser suite's context is primed
 * already, and its first samples carry the load's counts. The layout suite's first round warms
 * the engine's code.
 */
export const WARMUP: Record<SuiteName, number> = { server: 1, load: 0, browser: 0, layout: 1 };

export async function suiteProbes(suite: SuiteName, stack: Stack | null): Promise<{ probes: Probe[]; iterations: number; close: () => Promise<void> }> {
  if (suite === "layout") {
    const probes = await layoutProbes(ROOT);
    if (!probes) throw new Error("no layout engine or graphs in this tree (web/src/pr-view/layout/, fixtures/pr-view/layout/)");
    return { probes, iterations: ITERATIONS.layout, close: async () => {} };
  }
  if (!stack) throw new Error(`the ${suite} suite needs a stack`);
  switch (suite) {
    case "server":
      return { probes: await serverProbes(stack), iterations: ITERATIONS.server, close: async () => {} };
    case "load":
      return { probes: [await loadProbe(stack)], iterations: ITERATIONS.load, close: async () => {} };
    case "browser": {
      const browser = await launch();
      const ctx = await prepare(browser, stack);
      return { probes: await browserProbes(ctx), iterations: ITERATIONS.browser, close: () => browser.close() };
    }
  }
}
