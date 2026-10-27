// Signing in and the first view of the list, in a real browser against the ./dev-ctl stack.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROW = 34;

/** Signs `login` in by picking it on Fake GitHub's account page, from wherever the app sent us. */
async function pickAccount(page: Page, login: string) {
  await page.waitForURL(/\/login\/oauth\/authorize\?/);
  await page.getByRole("link", { name: new RegExp(`^${login}`) }).click();
}

test("a signed-out visit gets a 401, goes to sign in once, and lands back on the same URL", async ({ page }) => {
  const apiStatuses: number[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) apiStatuses.push(r.status());
  });
  const signIns: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && new URL(r.url()).pathname === "/auth/login") signIns.push(r.url());
  });

  await page.goto("/issues/1?from=e2e");
  await pickAccount(page, "tomsj");
  await page.waitForURL((u) => u.pathname === "/issues/1" && u.search === "?from=e2e");

  expect(apiStatuses).toContain(401);
  expect(signIns).toHaveLength(1);
  expect(new URL(signIns[0]!).searchParams.get("next")).toBe("/issues/1?from=e2e");
  await expect(page.locator('[data-perf="account"]')).toHaveText("tomsj");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();

  // The session cookie is __Host- prefixed, and Chrome takes it over dev's plain http://localhost.
  const sid = (await page.context().cookies()).find((c) => c.name === "__Host-beghu_sid");
  expect(sid).toMatchObject({ path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
});

test("while sign-in is on its way the page offers an external sign-in link, and leaves only once", async ({ page }) => {
  const signIns: string[] = [];
  await page.route("**/auth/login**", (route) => {
    signIns.push(route.request().url());
    // A 204 leaves the page where it is, as a slow or blocked sign-in would.
    return route.fulfill({ status: 204 });
  });
  await page.goto("/");
  // Read straight from the DOM: the locator API would wait for the 204 navigation to finish.
  const rels = () =>
    page.evaluate(() => [...document.querySelectorAll('a[href^="/auth/"]')].map((a) => a.getAttribute("rel")));
  await expect.poll(rels).toEqual(["external"]);
  await page.waitForTimeout(500);
  expect(signIns).toHaveLength(1);
});

test("the URL ./dev-ctl login prints signs that user in", async ({ page }) => {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  const out = execFileSync(`${ROOT}/dev-ctl`, ["login", "ilze-k", "--json"], { env, encoding: "utf8" });
  const { url } = JSON.parse(out) as { url: string };
  await page.goto(url);
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="account"]')).toHaveText("ilze-k");
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth/login?login=tomsj");
    await page.waitForURL((u) => u.pathname === "/");
    await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  });

  test("the list renders only the rows on screen, 34 px each, in strict columns", async ({ page }) => {
    const list = page.locator('[data-perf="list"]');
    const rows = page.locator('[data-perf="row"]');
    const height = (await list.boundingBox())!.height;
    // On screen, plus a small overscan either side.
    const most = Math.ceil(height / ROW) + 2 * 6 + 1;
    const loaded = Number(await list.getAttribute("data-perf-rows"));
    expect(loaded).toBe(100);
    const rendered = await rows.count();
    expect(rendered).toBeLessThanOrEqual(most);
    expect(rendered).toBeLessThan(loaded);

    // Every row is 34 px, and each column starts at the same x on every row.
    const shapes = await rows.evaluateAll((els) =>
      els.map((el) => ({
        h: el.getBoundingClientRect().height,
        xs: [...el.children].map((c) => Math.round(c.getBoundingClientRect().left)),
      })),
    );
    for (const s of shapes) {
      expect(s.h).toBe(ROW);
      expect(s.xs).toEqual(shapes[0]!.xs);
    }

    // Scrolling swaps rows in and out, keeps the DOM small, and loads the next page near the end.
    const firstId = await rows.first().getAttribute("data-id");
    await list.evaluate((el) => el.scrollTo(0, 80 * 34));
    await expect(rows.first()).not.toHaveAttribute("data-id", firstId!);
    await expect(list).toHaveAttribute("data-perf-rows", "200");
    expect(await rows.count()).toBeLessThanOrEqual(most);
  });

  test("a load fetches /api/me and its list page once each (the shell's preloads), then opens the stream", async ({ page }) => {
    const api: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) api.push(u.pathname + u.search);
    });
    const unused: string[] = [];
    page.on("console", (m) => /preload/i.test(m.text()) && unused.push(m.text()));
    await page.goto("/?view=e2e");
    await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
    // Chrome warns about an unused preload a few seconds after load.
    await page.waitForTimeout(3500);
    // The stream's opening reset refetches the list (`through=`), as may pushes from edits
    // elsewhere; those are the live path's, not the first load's.
    const live = api.filter((u) => u.includes("through="));
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(api.filter((u) => !live.includes(u)).sort()).toEqual(["/api/issues?view=e2e", "/api/me", "/api/stream"]);
    expect(unused).toEqual([]);
  });

  test("a list that fails to load says so, and Retry loads it", async ({ page }) => {
    await page.route("**/api/issues**", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.reload();
    await expect(page.getByText("Couldn't load this view")).toBeVisible();
    await page.unroute("**/api/issues**");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  });

  test("light, dark and system themes switch every colour and stick across reloads", async ({ page }) => {
    const bg = () =>
      page.locator('[data-perf="list"]').evaluate((el) => getComputedStyle(el.closest("main")!.parentElement!).backgroundColor);
    const scheme = () => page.evaluate(() => document.documentElement.style.colorScheme);

    await page.getByRole("button", { name: "Dark" }).click();
    expect(await scheme()).toBe("dark");
    const dark = await bg();
    await page.getByRole("button", { name: "Light" }).click();
    expect(await scheme()).toBe("light");
    const light = await bg();
    expect(dark).not.toBe(light);

    await page.reload();
    await expect(page.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "true");
    expect(await bg()).toBe(light);

    await page.getByRole("button", { name: "System" }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await bg()).toBe(dark);
    await page.emulateMedia({ colorScheme: "light" });
    expect(await bg()).toBe(light);
  });
});
