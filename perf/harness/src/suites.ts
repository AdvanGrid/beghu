// The three suites CI runs in parallel, each with its probes and how many samples a timing takes.
import { browserProbes, launch, prepare } from "./browser.ts";
import { loadProbe } from "./load.ts";
import { serverProbes } from "./server.ts";
import type { Stack } from "./stack.ts";
import type { Probe } from "./suite.ts";

export const SUITES = ["server", "load", "browser"] as const;
export type SuiteName = (typeof SUITES)[number];

/** Samples per timing: the median of 10 (the load suite's one sample is 30 s of 20 users). */
export const ITERATIONS: Record<SuiteName, number> = { server: 10, load: 1, browser: 10 };
/**
 * Unrecorded rounds first: the server's warm its caches; the browser suite's context is primed
 * already, and its first samples carry the load's counts.
 */
export const WARMUP: Record<SuiteName, number> = { server: 1, load: 0, browser: 0 };

export async function suiteProbes(suite: SuiteName, stack: Stack): Promise<{ probes: Probe[]; iterations: number; close: () => Promise<void> }> {
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
