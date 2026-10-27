// The issue detail panel, in a real browser against the ./dev-ctl stack (1k fixture). The top
// rows of the default list each have exactly 30 comments.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const panel = (page: Page) => page.locator('[data-perf="panel"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');
const comments = (page: Page) => page.locator('[data-perf="comment"]');
const rows = (page: Page) => page.locator('[data-perf="row"]');

async function signIn(page: Page, path = "/") {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  if (path !== "/") await page.goto(path);
  await expect(rows(page).first()).toBeVisible();
}

/** The API requests the page makes from now on, as path and query. */
function apiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) seen.push(u.pathname + u.search);
  });
  return seen;
}

/** The fixture generator's summary, next to the fixture the stack's Fake GitHub serves. */
async function summary(): Promise<{ stub_ids: number[] }> {
  const control = `http://127.0.0.1:${process.env.DEV_FAKE_CONTROL_PORT ?? 3101}`;
  const { fixture } = (await (await fetch(`${control}/state`)).json()) as { fixture: string };
  const path = fixture.replace(/mirror-([^/]*)\.db$/, "fixture-$1.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * From now until the detail is up, counts the animation frames that show the placeholder; call
 * the result to read the count.
 */
async function watchPlaceholders(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { placeholders: number };
    w.placeholders = 0;
    const frame = () => {
      if (document.querySelector('[data-perf="detail-loading"]')) w.placeholders++;
      if (!document.querySelector('[data-perf="detail"]')) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return () => page.evaluate(() => (window as unknown as { placeholders: number }).placeholders);
}

/**
 * A live push naming `ids`. TEMPORARY, to be replaced: #90 must swap this for a real push over the
 * live stream (SSE), driven from Fake GitHub, once that stream exists. Until then it calls the
 * function the push will call, `refetchOpenIssue`, on the module instance the app runs, as Vite
 * serves it: once the file has changed, the app imports it with an HMR stamp, after any
 * unstamped copy the shell's modulepreload fetched, so the last fetch is the one. The panel's
 * code must have loaded.
 */
async function push(page: Page, ids: number[]): Promise<void> {
  await page.evaluate(async (ids) => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => new URL(n).pathname === "/src/IssuePanel.tsx")
      .at(-1)!;
    const m = (await import(/* @vite-ignore */ url)) as { refetchOpenIssue(ids: number[]): Promise<void> };
    await m.refetchOpenIssue(ids);
  }, ids);
}

/** Each comment's id and time, in the order shown. */
const shownComments = (page: Page) =>
  comments(page).evaluateAll((els) =>
    els.map((el) => ({ id: Number(el.getAttribute("data-id")), at: el.querySelector("time")!.getAttribute("datetime")! })),
  );

/** A comment's place in its thread, as the API's cursors name it: `<created_at>.<id>`. */
const cursor = (c: { id: number; at: string }) => `${Date.parse(c.at) / 1000}.${c.id}`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
});

test("hovering a row preloads its detail, and the click shows it with no placeholder frame", async ({ page }) => {
  await signIn(page);
  const row = rows(page).nth(2);
  const id = await row.getAttribute("data-id");
  const api = apiRequests(page);

  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  await preloaded;
  // Look at every frame from before the click until the detail is up: none may show the
  // placeholder.
  const placeholders = await watchPlaceholders(page);
  await row.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await expect(page).toHaveURL(new RegExp(`/issues/${id}$`));
  expect(await placeholders()).toBe(0);
  expect(api.filter((p) => p === `/api/issues/${id}`)).toHaveLength(1);
  await expect(row).toHaveAttribute("aria-current", "page");
});

test("a hover longer than a preload lasts still opens the issue with no placeholder frame, then refreshes it", async ({ page }) => {
  await signIn(page);
  const row = rows(page).nth(3);
  const id = await row.getAttribute("data-id");
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  await preloaded;
  // Past the router's 5 s preload window: the preloaded read has expired by the click.
  await page.waitForTimeout(6_000);
  const api = apiRequests(page);
  const placeholders = await watchPlaceholders(page);
  await row.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  expect(await placeholders()).toBe(0);
  // What's shown is refetched behind it, in one request.
  await expect.poll(() => api.filter((p) => p.startsWith(`/api/issues/${id}?`) || p === `/api/issues/${id}`)).toHaveLength(1);
});

test("an issue URL with leading zeros opens that issue, its one fetch the shell's preload", async ({ page }) => {
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  const api = apiRequests(page);
  await page.goto(`/issues/00${id}`);
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  expect(api.filter((p) => /^\/api\/issues\/\d+$/.test(p))).toEqual([`/api/issues/${id}`]);
});

test("comments come newest first, 15 at a time: page 2 after paint, later pages near the end", async ({ page }) => {
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  // Pretend the thread goes on past page 2, so a third page is due only near the end.
  let page2Last: string | undefined;
  await page.route(`**/api/issues/${id}/comments?*`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { comments: { id: number; created_at: number }[]; next: string | null };
    if (body.comments.length === 15 && body.next === null) {
      const last = body.comments.at(-1)!;
      page2Last = `${last.created_at}.${last.id}`;
      body.next = page2Last;
    }
    await route.fulfill({ response: res, json: body });
  });
  const api = apiRequests(page);
  await rows(page).first().click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);

  // Page 2 arrives by itself once page 1 has painted.
  await expect(comments(page)).toHaveCount(30);
  const shown = await shownComments(page);
  expect(new Set(shown.map((c) => c.id)).size).toBe(30);
  const keys = shown.map((c) => [Date.parse(c.at), c.id] as const);
  for (let i = 1; i < keys.length; i++) {
    const [a, b] = [keys[i - 1]!, keys[i]!];
    expect(a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]), `newest first at ${i}`).toBe(true);
  }
  const pages = () => api.filter((p) => p.startsWith(`/api/issues/${id}/comments`));
  expect(pages()).toEqual([`/api/issues/${id}/comments?order=newest&after=${cursor(shown[14]!)}`]);
  await expect(page.getByText("Loading more comments…")).toBeAttached();

  // Page 3 waits until the reader nears the end.
  await page.waitForTimeout(500);
  expect(pages()).toHaveLength(1);
  await detail(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect.poll(pages).toHaveLength(2);
  expect(pages()[1]).toBe(`/api/issues/${id}/comments?order=newest&after=${page2Last}`);
  // The real thread ends there: nothing more, and nothing repeated.
  await expect(page.getByText("Loading more comments…")).not.toBeAttached();
  await expect(comments(page)).toHaveCount(30);
});

test("a push for the open issue refetches it in one request, and a new comment is neither skipped nor repeated", async ({ page }) => {
  await signIn(page);
  const id = Number(await rows(page).first().getAttribute("data-id"));
  await rows(page).first().click();
  await expect(comments(page)).toHaveCount(30);
  const before = await shownComments(page);

  // A comment arrived since: the refetch answers with it on top of the loaded thread.
  const arrived = { id: 2_999_999_999, author: { login: "edgars" }, body: "Arrived mid-scroll", created_at: 1_900_000_000, updated_at: 1_900_000_000 };
  await page.route(`**/api/issues/${id}?through=*`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.comments.comments.unshift(arrived);
    d.comment_total += 1;
    await route.fulfill({ response: res, json: d });
  });
  const api = apiRequests(page);
  await push(page, [id]);
  expect(api).toEqual([`/api/issues/${id}?through=${cursor(before.at(-1)!)}`]);
  await expect(comments(page)).toHaveCount(31);
  const after = await shownComments(page);
  expect(after.map((c) => c.id)).toEqual([arrived.id, ...before.map((c) => c.id)]);
});

test("off-screen comments skip rendering until they come near", async ({ page }) => {
  await signIn(page);
  await rows(page).first().click();
  await expect(comments(page)).toHaveCount(30);
  const cv = await comments(page).last().evaluate((el) => getComputedStyle(el).contentVisibility);
  expect(cv).toBe("auto");
  expect(await detail(page).evaluate((el) => getComputedStyle(el).overflowAnchor)).toBe("none");
});

test("nothing in the panel moves when a value changes length", async ({ page }) => {
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  const layout = async () => {
    await expect(detail(page)).toHaveAttribute("data-id", id!);
    return detail(page).evaluate((el) => {
      const box = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
      const badge = box('[data-perf="badge"]');
      return {
        badge: [badge.left, badge.width],
        ref: box('[data-perf="badge"] + span').left,
        title: box("h2").top,
        keys: [...el.querySelectorAll("dt")].map((d) => [d.getBoundingClientRect().left, d.getBoundingClientRect().top]),
        values: [...el.querySelectorAll("dd")].map((d) => d.getBoundingClientRect().left),
        order: box('[data-perf="comment-order"]').left,
      };
    });
  };
  await page.goto(`/issues/${id}`);
  const before = await layout();

  // The same issue with every property a different length: closed as not planned, more labels,
  // another assignee, a long milestone, a comment count with more digits.
  await page.route(`**/api/issues/${id}`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.state = "closed";
    d.state_reason = "not_planned";
    d.labels = [...d.labels, { name: "x", color: "888888" }].slice(0, 3);
    d.assignees = [{ login: "z" }];
    d.milestone = { title: "A milestone with a rather long name", state: "open", due_on: null };
    d.comment_total = 1234;
    await route.fulfill({ response: res, json: d });
  });
  await page.reload();
  await expect(page.locator('[data-perf="badge"]')).toHaveText(/Not planned/);
  expect(await layout()).toEqual(before);
});

test("below 900 px the panel sits under the list, 40% list to 60% issue", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await signIn(page);
  await rows(page).first().click();
  await expect(detail(page)).toBeVisible();
  const list = (await page.locator('[data-perf="list"]').locator("xpath=../..").boundingBox())!;
  const issue = (await panel(page).boundingBox())!;
  expect(issue.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  expect(issue.width).toBe(800);
  expect(list.height / (list.height + issue.height)).toBeCloseTo(0.4, 1);
  await expect(page.locator('[data-perf="divider"]')).toHaveCount(0);
});

test("the divider resizes, keeps 360 px either side, and is remembered on this device", async ({ page }) => {
  await signIn(page);
  await rows(page).first().click();
  await expect(detail(page)).toBeVisible();
  const divider = page.locator('[data-perf="divider"]');
  const listPane = page.locator('[data-perf="list"]').locator("xpath=../..");
  // The panel sizes itself only once it has measured the room it shares with the list (its
  // largest width, 1400 - 4 - 360, says so); a drag or a box read before that would see the
  // placeholder width and a divider about to move.
  const measured = () => expect(divider).toHaveAttribute("aria-valuemax", "1036");
  // Drags the divider to `x` and waits for the panel to take the width that leaves, before any
  // box is read.
  const dragTo = async (x: number, width: number) => {
    const d = (await divider.boundingBox())!;
    await page.mouse.move(d.x + d.width / 2, d.y + 200);
    await page.mouse.down();
    await page.mouse.move(x, d.y + 200, { steps: 5 });
    await page.mouse.up();
    await expect(divider).toHaveAttribute("aria-valuenow", String(width));
  };

  await measured();
  await dragTo(100, 1036);
  expect((await listPane.boundingBox())!.width).toBe(360);
  await dragTo(1350, 360);
  expect((await panel(page).boundingBox())!.width).toBe(360);
  await dragTo(900, 500);
  const width = (await panel(page).boundingBox())!.width;
  expect(width).toBe(500);

  await page.reload();
  await expect(detail(page)).toBeVisible();
  await measured();
  expect((await panel(page).boundingBox())!.width).toBe(width);
});

test("a deleted issue shows its in-place state, and the list stays usable", async ({ page }) => {
  await signIn(page, "/issues/1");
  await expect(panel(page).getByText("This issue was deleted")).toBeVisible();
  const row = rows(page).first();
  const id = await row.getAttribute("data-id");
  await row.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
});

test("an issue outside the synced repos says so in place, with a link out to GitHub", async ({ page }) => {
  const stub = (await summary()).stub_ids[0]!;
  await signIn(page, `/issues/${stub}`);
  await expect(panel(page).getByText("This issue is in a repo that isn't synced.")).toBeVisible();
  await expect(panel(page).getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
    "href",
    /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/,
  );
  await expect(rows(page).first()).toBeVisible();
});

test("at the 360 px minimum a long repo name is cut short, and the status row keeps its actions", async ({ page }) => {
  // The narrowest panel there is: any kept width below it clamps to 360 px.
  await page.addInitScript(() => localStorage.setItem("beghu.detail-width", "1"));
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  await page.route(`**/api/issues/${id}`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.repo = "a-repository-with-an-unusually-long-name-indeed";
    await route.fulfill({ response: res, json: d });
  });
  await page.goto(`/issues/${id}`);
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  const box = (await panel(page).boundingBox())!;
  expect(box.width).toBe(360);
  const status = page.locator('[data-perf="badge"]').locator("xpath=..");
  expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  for (const name of ["Close the issue", "GitHub ↗"]) {
    const a = (await panel(page).getByRole("link", { name }).boundingBox())!;
    expect(a.x + a.width, name).toBeLessThanOrEqual(box.x + box.width);
  }
});

test("a detail that fails to load offers Retry, which loads it", async ({ page }) => {
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  await page.route(`**/api/issues/${id}`, (r) => r.fulfill({ status: 500, body: "{}" }));
  await page.goto(`/issues/${id}`);
  await expect(panel(page).getByText("Couldn't load this issue")).toBeVisible();
  await page.unroute(`**/api/issues/${id}`);
  await panel(page).getByRole("button", { name: "Retry" }).click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
});

/** From now on, every title the detail shows, in order; call the result to read them. */
async function watchTitles(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { titles: string[] };
    w.titles = [];
    const frame = () => {
      const t = document.querySelector('[data-perf="detail"] h2')?.textContent;
      if (t && w.titles.at(-1) !== t) w.titles.push(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return () => page.evaluate(() => (window as unknown as { titles: string[] }).titles);
}

test("a revisit shows the issue as it is now, never what an earlier visit fetched", async ({ page }) => {
  await signIn(page);
  const [x, y] = [rows(page).nth(4), rows(page).nth(5)];
  const id = await x.getAttribute("data-id");
  await x.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  const was = (await detail(page).locator("h2").textContent())!;
  await y.click();
  await expect(detail(page)).not.toHaveAttribute("data-id", id!);

  // Past the router's preload window, the issue is renamed; the revisit's read is slow.
  await page.waitForTimeout(5_500);
  await page.route(`**/api/issues/${id}`, async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    const res = await route.fetch();
    const d = await res.json();
    d.title = "Renamed since the last visit";
    await route.fulfill({ response: res, json: d });
  });
  const titles = await watchTitles(page);
  await x.click();
  await expect(detail(page).locator("h2")).toHaveText("Renamed since the last visit");
  expect(await titles()).not.toContain(was);
});

test("a long-hovered issue whose refresh fails drops what it showed and offers Retry", async ({ page }) => {
  await signIn(page);
  const row = rows(page).nth(6);
  const id = await row.getAttribute("data-id");
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  await preloaded;
  await page.waitForTimeout(6_000);
  await page.route(`**/api/issues/${id}`, (r) => r.fulfill({ status: 500, body: "{}" }));
  await row.click();
  await expect(panel(page).getByText("Couldn't load this issue")).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await page.unroute(`**/api/issues/${id}`);
  await panel(page).getByRole("button", { name: "Retry" }).click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  // Retry opens it as any click does: page 2 follows the first paint.
  await expect(comments(page)).toHaveCount(30);
});

test("a push for an issue whose detail failed to load acts as Retry", async ({ page }) => {
  await signIn(page);
  const id = Number(await rows(page).first().getAttribute("data-id"));
  await page.route(`**/api/issues/${id}`, (r) => r.fulfill({ status: 500, body: "{}" }));
  await page.goto(`/issues/${id}`);
  await expect(panel(page).getByText("Couldn't load this issue")).toBeVisible();
  await page.unroute(`**/api/issues/${id}`);
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await push(page, [id]);
  await expect(detail(page)).toHaveAttribute("data-id", String(id));
  expect(errors).toEqual([]);
});

test("a push naming a hovered issue makes its click read it afresh", async ({ page }) => {
  await signIn(page);
  await rows(page).first().click();
  await expect(detail(page)).toBeVisible();
  const row = rows(page).nth(7);
  const id = Number(await row.getAttribute("data-id"));
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  const was = ((await (await preloaded).json()) as { title: string }).title;
  await page.route(`**/api/issues/${id}`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.title = "Renamed by the push";
    await route.fulfill({ response: res, json: d });
  });
  await push(page, [id]);
  const titles = await watchTitles(page);
  await row.click();
  await expect(detail(page).locator("h2")).toHaveText("Renamed by the push");
  expect(await titles()).not.toContain(was);
});

test("a hover read still on its way when a push names its issue is never shown", async ({ page }) => {
  await signIn(page);
  await rows(page).first().click();
  await expect(detail(page)).toBeVisible();
  const row = rows(page).nth(8);
  const id = Number(await row.getAttribute("data-id"));
  // The hover's read is held until the push has gone by; any later read sees the push's change.
  let reads = 0;
  let was: string | undefined;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/issues/${id}`, async (route) => {
    const first = reads++ === 0;
    if (first) await held;
    const res = await route.fetch();
    const d = await res.json();
    if (first) was = d.title;
    else d.title = "Renamed by the push";
    await route.fulfill({ response: res, json: d });
  });
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  await expect.poll(() => reads).toBe(1);
  await push(page, [id]);
  release();
  await preloaded;
  // Past the router's 5 s preload window, where only a remembered read could show at once.
  await page.waitForTimeout(6_000);
  const titles = await watchTitles(page);
  await row.click();
  await expect(detail(page).locator("h2")).toHaveText("Renamed by the push");
  expect(was).toBeDefined();
  expect(await titles()).not.toContain(was);
});

test("another view on an open issue's URL forgets what a hover fetched", async ({ page }) => {
  await signIn(page);
  await rows(page).first().click();
  await expect(detail(page)).toBeVisible();
  const id = Number(await rows(page).nth(9).getAttribute("data-id"));
  const row = page.locator(`[data-perf="row"][data-id="${id}"]`);
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  const was = ((await (await preloaded).json()) as { title: string }).title;
  // Off the list, so its new rows aren't hovered, and past the router's 5 s preload window.
  await page.mouse.move(1300, 500);
  await page.waitForTimeout(6_000);
  await page.route(`**/api/issues/${id}`, async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.title = "Renamed since the hover";
    await route.fulfill({ response: res, json: d });
  });
  // Only the query string changes, as a back or forward between views would (the router reads
  // the URL on popstate). The list ignores a parameter it doesn't know.
  await page.evaluate(() => {
    history.pushState(null, "", `${location.pathname}?view=other`);
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(row).toHaveAttribute("href", `/issues/${id}?view=other`);
  const titles = await watchTitles(page);
  await row.click();
  await expect(detail(page).locator("h2")).toHaveText("Renamed since the hover");
  expect(await titles()).not.toContain(was);
});

/** The issue panel's code, as Vite serves it in dev. */
const PANEL_CHUNK = "**/src/IssuePanel.tsx*";

test("an issue URL's shell modulepreloads the panel's code, and the list's doesn't", async ({ request }) => {
  const tag = '<link rel="modulepreload" crossorigin href="/src/IssuePanel.tsx">';
  expect(await (await request.get("/issues/1")).text()).toContain(tag);
  expect(await (await request.get("/")).text()).not.toContain("modulepreload");
});

test("while the panel's code is on its way, the list is already usable", async ({ page }) => {
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(PANEL_CHUNK, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/issues/${id}`);
  await expect(rows(page).first()).toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  release();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
});

test("panel code that fails to load reloads the URL once, then offers Retry, the list usable throughout", async ({ page }) => {
  await signIn(page);
  const row = rows(page).first();
  const id = await row.getAttribute("data-id");
  await page.route(PANEL_CHUNK, (r) => r.abort());
  const loads: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname);
  });
  // The hover's preload fails silently; the click's navigation fails, and reloads the target.
  await row.click();
  await expect(page.getByText("Couldn't load this issue")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issues/${id}$`));
  expect(loads).toEqual([`/issues/${id}`]);
  await expect(rows(page).first()).toBeVisible();

  await page.unroute(PANEL_CHUNK);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  expect(loads).toHaveLength(1);
});
