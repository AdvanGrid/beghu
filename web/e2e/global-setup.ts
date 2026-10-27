// Before any test: the stack is up, and Vite has compiled the app once.
//
// Vite compiles each module on its first request, and only then. On a fresh `./dev-ctl start`
// every worker's first page load waited on the same compiles (17 s for one load on a loaded
// machine, the panel's code later still), so the first tests to run failed on budgets meant for
// the app, not for the compiler. Loading the list, an issue and every lazily loaded module here
// leaves only warm loads for the tests.
import { chromium } from "@playwright/test";
import { resetClaims } from "./claims";
import { APP, status } from "./stack";

const READY_WITHIN_MS = 120_000;

/** Waits for the stack to be ready and every process to answer; throws if it isn't running. */
async function ready(): Promise<void> {
  const deadline = Date.now() + READY_WITHIN_MS;
  for (;;) {
    let s;
    try {
      s = status();
    } catch {
      throw new Error("the ./dev-ctl stack isn't running: start it with ./dev-ctl start --scale 1k");
    }
    if (s.phase === "ready" && s.up.app && s.up.server && s.up.fake) return;
    if (Date.now() > deadline) throw new Error(`the ./dev-ctl stack isn't ready: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export default async function globalSetup(): Promise<void> {
  // No test is running yet: last run's claims and locks are gone with it.
  resetClaims();
  await ready();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage({ baseURL: APP });
    page.setDefaultTimeout(READY_WITHIN_MS);
    await page.goto("/auth/login?login=tomsj");
    await page.waitForURL((u) => u.pathname === "/");
    const row = page.locator('[data-perf="row"]').first();
    const id = await row.getAttribute("data-id");
    // An issue, with its panel and the composer, both loaded lazily.
    await page.goto(`/issues/${id}`);
    await page.locator('[data-perf="detail"]').waitFor();
    await page.locator('[data-perf="composer"] textarea').waitFor();
    // The other lazily loaded modules, with everything they import.
    await page.evaluate(() =>
      Promise.all(["/src/ListCard.tsx", "/src/Suggestions.tsx", "/src/RepoPicker.tsx", "/src/Importing.tsx"].map((m) => import(m))),
    );
  } finally {
    await browser.close();
  }
}
