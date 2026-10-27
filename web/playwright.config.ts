// The browser suite: full Chromium (new headless mode) against a running `./dev-ctl` stack in
// fixture mode. Start it first (`./dev-ctl start --scale 1k`); BEGHU_APP_URL points at its app
// (default http://localhost:5173, or set DEV_APP_PORT as for ./dev-ctl).
import { defineConfig } from "@playwright/test";

const app = process.env.BEGHU_APP_URL ?? `http://localhost:${process.env.DEV_APP_PORT ?? 5173}`;

export default defineConfig({
  testDir: "e2e",
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
    { name: "browser", testIgnore: /(live|relationships|writes|repos)\.spec\.ts$/ },
    // The specs that edit (live.spec.ts, relationships.spec.ts, writes.spec.ts, repos.spec.ts):
    // their edits reach every signed-in tab, push refetches and reorder the list; writes.spec.ts
    // sets faults for the whole stack, and repos.spec.ts slows GraphQL (the read-backs' too) and
    // installs the App, which has every account re-read its repos. So they run once the rest are
    // done, one after the other, never beside anything else.
    { name: "live", testMatch: /live\.spec\.ts$/, dependencies: ["browser"] },
    { name: "relationships", testMatch: /relationships\.spec\.ts$/, dependencies: ["live"] },
    { name: "writes", testMatch: /writes\.spec\.ts$/, dependencies: ["relationships"] },
    { name: "repos", testMatch: /repos\.spec\.ts$/, dependencies: ["writes"] },
  ],
});
