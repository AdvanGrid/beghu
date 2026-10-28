// Back and Forward to a page that left on purpose (a sign-out or a switch from the account menu),
// in a real browser against the ./dev-ctl stack: the page the back-forward cache restores shows
// nothing of the account it left, not even for a frame (spec #86). Each test has its own browser
// context, so its session touches no other test.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Playwright turns the back-forward cache off; these tests are about the pages it restores.
test.use({ launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] } });

const account = (page: Page) => page.locator('[data-perf="account"]');
const menu = (page: Page) => page.locator('[data-perf="account-menu"]');
const rows = (page: Page) => page.locator('[data-perf="row"]');

/** Signs `logins` in, in order, in `context`: its session holds them all, the last active. */
async function signIn(context: BrowserContext, ...logins: string[]): Promise<Page> {
  const page = await context.newPage();
  for (const login of logins) {
    await page.goto(`/auth/login?login=${login}`);
    await page.waitForURL((u) => u.pathname === "/");
  }
  await expect(account(page)).toHaveText(logins.at(-1)!);
  await expect(rows(page).first()).toBeVisible();
  return page;
}

async function openMenu(page: Page): Promise<void> {
  await account(page).click();
  await expect(menu(page)).toBeVisible();
}

/**
 * From now on, what each page the back-forward cache restores shows as it's restored, before
 * beghu's own handlers run: which parts of the app (the header's account, a banner, the list) can
 * be seen. Pages only ever restored from the cache are listed.
 */
async function recordRestores(context: BrowserContext): Promise<string[][]> {
  const seen: string[][] = [];
  await context.exposeFunction("beghuTestRestored", (parts: string[]) => void seen.push(parts));
  await context.addInitScript(() => {
    addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      const parts = ['[data-perf="account"]', '[data-perf="banner"]', '[data-perf="row"]'].filter((sel) =>
        [...document.querySelectorAll(sel)].some((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true })),
      );
      (window as unknown as { beghuTestRestored: (p: string[]) => void }).beghuTestRestored(parts);
    });
  });
  return seen;
}

test("Back after signing out never shows the account that signed out", async ({ context }) => {
  const restored = await recordRestores(context);
  const page = await signIn(context, "tomsj", "ilze-k");
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign out of all accounts" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/signed-out");

  // Restored from the cache blank, then loaded afresh, which goes to sign in: the old account
  // never shows.
  await page.goBack({ waitUntil: "commit" });
  await expect.poll(() => restored).toEqual([[]]);
  await page.waitForURL((u) => u.pathname !== "/" && u.pathname !== "/auth/signed-out");
});

test("Back after a switch never shows the account switched from", async ({ context }) => {
  const restored = await recordRestores(context);
  const page = await signIn(context, "tomsj", "ilze-k");
  await page.goto("/?q=is:open");
  await expect(rows(page).first()).toBeVisible();
  await openMenu(page);
  // Chromium keeps a page in the cache only when the navigation that leaves it goes to another
  // URL, and a switch comes back to the same one; so this one lands on another view.
  await menu(page)
    .locator('input[name="next"]')
    .evaluateAll((inputs) => inputs.forEach((i) => ((i as HTMLInputElement).value = "/?q=is:closed")));
  await menu(page).getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await page.waitForURL((u) => u.search === "?q=is:closed");
  await expect(account(page)).toHaveText("tomsj");

  // Back to the page that was ilze-k's: restored blank, then loaded afresh as tomsj.
  await page.goBack({ waitUntil: "commit" });
  await expect.poll(() => restored).toEqual([[]]);
  await expect(account(page)).toHaveText("tomsj");
});
