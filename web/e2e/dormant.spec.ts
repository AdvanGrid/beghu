// A dormant account's return, as the status slot says it, in a real browser against the
// ./dev-ctl stack. The server's side (an account unused for 30 days goes dormant, and its next
// use re-imports it with `away` set on the import's status) is tested through its HTTP surface
// (crates/server/tests/dormancy.rs), where 30 days can be a few seconds; the dev stack keeps the
// real 30 days. So the stream here is answered with the status such a re-import sends, and the
// test checks what the tab makes of it.
import { expect, test } from "@playwright/test";

/** The stream's opening events, with the status of a re-import after time away. */
const AWAY = [
  "event: reset\ndata: {}\n\n",
  `event: status\ndata: ${JSON.stringify({
    import: { phase: "open_issues", done: 1, of: 3, waiting: null, failed: [], retry_at: null, away: true },
    sync: null,
  })}\n\n`,
  `event: github\ndata: ${JSON.stringify({ state: "up" })}\n\n`,
].join("");

test("an account back from dormancy says it's re-importing because the user was away", async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();

  await page.route("**/api/stream?*", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" }, body: AWAY }),
  );
  await page.reload();
  const status = page.locator('[data-perf="status"]');
  await expect(status).toHaveText("Re-importing — you've been away a while · open issues… 1 of 3 repos");
  await expect(page.locator('[data-perf="list-pane"] [data-perf="still-importing"]')).toBeVisible();
});
