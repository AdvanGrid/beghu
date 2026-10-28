// Held changes in the list (#109) after Back: a page the back-forward cache restores refetches as
// its stream opens again, and the order that refetch brings applies at once, with no shift cue:
// the user wasn't on the page while it changed, as on a page that loads afresh.
//
// With the live project (playwright.config.ts): its edit reorders what every tab shows. It only
// retitles an issue in the top 40 rows, as held.spec.ts does.
import { expect, test, type Page } from "@playwright/test";
import { bfcache } from "./bfcache";
import { listed, unique } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";
import { devCtl, status } from "./stack";

test.use(bfcache);

const rows = (page: Page) => page.locator('[data-perf="row"]');

test("Back to the list after the order changed meanwhile shows the new order at once, with no cue", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
  const issue = (await listed(page))[5]!;
  await page.mouse.move(5, 5);
  // From now on, in the page (kept through the cache): whether a cue ever shows.
  await page.evaluate(() => {
    const w = window as unknown as { cued?: boolean };
    w.cued = false;
    const list = document.querySelector('[data-perf="list"]')!;
    new MutationObserver(() => (w.cued ||= !!list.querySelector('[data-perf="cue-line"], [data-cue="leave"]'))).observe(list, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-cue"],
    });
  });

  // Out to "GitHub" in this tab; meanwhile a teammate's edit takes the issue to the top.
  const out = `${status().urls.fake}/ext/page.html`;
  await page.evaluate((url) => location.assign(url), out);
  await page.waitForURL(out);
  devCtl(["fake", "edit", issue.ref, "--title", unique("Moved while away")]);
  await expect.poll(async () => (await listed(page))[0]?.id, { timeout: SHOWS_WITHIN_MS }).toBe(issue.id);

  await page.goBack({ waitUntil: "commit" });
  await expect(rows(page).first()).toHaveAttribute("data-id", String(issue.id), { timeout: SHOWS_WITHIN_MS });
  // Restored, not loaded again: the page's own state is still there; and no cue showed.
  expect(await page.evaluate(() => (window as unknown as { cued?: boolean }).cued)).toBe(false);
});
