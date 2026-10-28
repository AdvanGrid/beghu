// Chromium with its back-forward cache as a person's has it, for the specs about stale pages
// (spec #86, docs/research/spa-shell-deploy-and-sign-in.md). Playwright launches Chromium with
// `--disable-back-forward-cache` and `--disable-field-trial-config`, which keep every page out of
// the cache; full Chromium in new headless mode (the suite's channel) without them, and with the
// cache's features on, restores pages as desktop Chrome does. Use it per file, with `test.use`.
import type { PlaywrightWorkerOptions } from "@playwright/test";

export const bfcache = {
  launchOptions: {
    ignoreDefaultArgs: ["--disable-back-forward-cache", "--disable-field-trial-config"],
    args: ["--enable-features=BackForwardCache,ProactivelySwapBrowsingInstance"],
  },
} satisfies Pick<PlaywrightWorkerOptions, "launchOptions">;
