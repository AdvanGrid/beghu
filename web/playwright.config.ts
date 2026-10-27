// The browser suite: full Chromium (new headless mode) against a running `./dev-ctl` stack in
// fixture mode. Start it first (`./dev-ctl start --scale 1k`); BEGHU_APP_URL points at its app
// (default http://localhost:5173, or set DEV_APP_PORT as for ./dev-ctl).
import { defineConfig } from "@playwright/test";

const app = process.env.BEGHU_APP_URL ?? `http://localhost:${process.env.DEV_APP_PORT ?? 5173}`;

export default defineConfig({
  testDir: "e2e",
  // Waits for the stack, and has Vite compile the app before the first test (e2e/global-setup.ts).
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: app,
    // Full Chromium rather than the headless shell.
    channel: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "browser", testIgnore: /(live|relationships|writes|pickers|repos|sync)\.spec\.ts$/ },
    // The specs that edit (live.spec.ts, relationships.spec.ts, writes.spec.ts, pickers.spec.ts,
    // repos.spec.ts, sync.spec.ts):
    // their edits reach every signed-in tab, push refetches and reorder the list; writes.spec.ts
    // sets faults for the whole stack, and repos.spec.ts slows GraphQL (the read-backs' too) and
    // installs the App, which has every account re-read its repos; sync.spec.ts marks accounts for
    // a resync and sweeps their repos. So they run once the rest are done, one after the other,
    // never beside anything else.
    //
    // Their tests wait on outside edits (Fake GitHub's webhook, then the server's mirror write) on
    // top of their own steps, and a test's cleanup waits for its close to land: one delivery's
    // apply took 11 s while the disk was stalled. So they get 60 s rather than 30.
    //
    // live, relationships and repos watch what every tab shares (the list's order, its top rows)
    // and so run on one worker, `--repeat-each` copies included. writes.spec.ts is safe side by
    // side, and so is pickers.spec.ts: their tests claim their own issues and take a lock for
    // stack-wide state (claims.ts).
    { name: "live", testMatch: /live\.spec\.ts$/, dependencies: ["browser"], timeout: 60_000, workers: 1 },
    { name: "relationships", testMatch: /relationships\.spec\.ts$/, dependencies: ["live"], timeout: 60_000, workers: 1 },
    { name: "writes", testMatch: /writes\.spec\.ts$/, dependencies: ["relationships"], timeout: 60_000 },
    { name: "pickers", testMatch: /pickers\.spec\.ts$/, dependencies: ["writes"], timeout: 60_000 },
    { name: "repos", testMatch: /repos\.spec\.ts$/, dependencies: ["pickers"], workers: 1 },
    { name: "sync", testMatch: /sync\.spec\.ts$/, dependencies: ["repos"], timeout: 60_000 },
  ],
});
