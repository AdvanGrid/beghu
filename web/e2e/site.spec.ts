// The public site (web/site/): prerendered pages with no app code, `/` the landing page whether
// signed in or not, and its way into the app at `/issues`.
import { expect, test, type Page } from "@playwright/test";

/** The scripts a page loaded, beyond the inline theme script. */
function scriptsLoaded(page: Page): string[] {
  const loaded: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") loaded.push(r.url());
  });
  return loaded;
}

test("the landing page is whole HTML with no app code, and every page names itself", async ({ page }) => {
  const loaded = scriptsLoaded(page);
  const res = await page.goto("/");
  // The text is in the document the server sent, not put there by a script.
  expect(await res!.text()).toContain("GitHub issues, without the wait.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("GitHub issues, without the wait.");
  expect(loaded).toEqual([]);
  await expect(page.locator("#root")).toHaveCount(0);

  for (const [path, title] of [
    ["/pricing", "Pricing · beghu"],
    ["/privacy", "Privacy policy · beghu"],
    ["/terms", "Terms of use · beghu"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(new URL(canonical!).pathname).toBe(path);
  }
});

test("the landing page follows the theme the app set", async ({ page }) => {
  await page.goto("/");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => localStorage.setItem("beghu.theme", "dark"));
  await page.reload();
  const dark = await bg();
  await page.evaluate(() => localStorage.setItem("beghu.theme", "light"));
  await page.reload();
  expect(await bg()).not.toBe(dark);
});

test("Sign in with GitHub signs in and lands on the list; signed in, Open beghu opens it and / is still the landing page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.waitForURL(/\/login\/oauth\/authorize\?/);
  await page.getByRole("link", { name: /^tomsj/ }).click();
  await page.waitForURL((u) => u.pathname === "/issues");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Open beghu" }).click();
  await page.waitForURL((u) => u.pathname === "/issues");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();

  await page.goto("/");
  await expect(page).toHaveURL((u) => u.pathname === "/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("GitHub issues, without the wait.");
});
