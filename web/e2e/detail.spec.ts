// The issue detail panel, in a real browser against the ./dev-ctl stack (1k fixture). The top
// rows of the default list each have exactly 30 comments.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { status } from "./stack";

const panel = (page: Page) => page.locator('[data-perf="panel"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');
const comments = (page: Page) => page.locator('[data-perf="comment"]');
const rows = (page: Page) => page.locator('[data-perf="row"]');

/**
 * Loads `url` and waits for the live stream's opening reset to have been handled (the list's
 * refetch for it is back), so a test's own reads and failures aren't raced by it: the reset
 * refetches the open detail, and retries one that failed (live.ts, IssuePanel.tsx).
 */
async function goto(page: Page, url: string): Promise<void> {
  const opened = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/issues" && r.url().includes("through="));
  await page.goto(url);
  await opened;
}

async function signIn(page: Page, path = "/") {
  // Signing in lands on the list.
  await goto(page, "/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  if (path !== "/") await goto(page, path);
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
async function summary(): Promise<{ stub_ids: number[]; stub_numbers: number[]; unlinked_stubs: number[] }> {
  const { control } = status().urls;
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

test("an issue URL with leading zeros opens that issue, its first fetch the shell's preload", async ({ page }) => {
  await signIn(page);
  const id = await rows(page).first().getAttribute("data-id");
  const api = apiRequests(page);
  await goto(page, `/issues/00${id}`);
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  // The shell's preload, then at most one read again for the live stream's opening reset (a
  // change may have landed before the stream was up): plain if the reset cleared the preload
  // before the panel took it, through its last comment if the panel had it on screen.
  await page.waitForTimeout(1000);
  const reads = api.filter((p) => /^\/api\/issues\/\d+(\?|$)/.test(p));
  expect(reads[0]).toBe(`/api/issues/${id}`);
  expect(reads.length).toBeLessThanOrEqual(2);
  for (const r of reads) expect(r).toMatch(new RegExp(`^/api/issues/${id}(\\?through=|$)`));
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
  await goto(page, `/issues/${id}`);
  const before = await layout();

  // The same issue with every property a different length: closed as not planned, more labels,
  // another assignee, a long milestone, a comment count with more digits. Every read of it, the
  // stream's opening reset's `?through=` one included: a plain read let through would put the
  // issue back as it is.
  await page.route((u) => u.pathname === `/api/issues/${id}`, async (route) => {
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
  const list = (await page.locator('[data-perf="list-pane"]').boundingBox())!;
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
  const listPane = page.locator('[data-perf="list-pane"]');
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
  // A stub a relationship reaches: a mirror holds only those.
  const s = await summary();
  const stub = s.stub_ids[s.stub_numbers.findIndex((n) => !s.unlinked_stubs.includes(n))]!;
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
  await goto(page, `/issues/${id}`);
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
  await goto(page, `/issues/${id}`);
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
  await goto(page, `/issues/${id}`);
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
  // The reload loads the whole app again, which can take seconds on a loaded machine: the
  // failure is due once it has loaded.
  const reloaded = page.waitForEvent("load");
  await row.click();
  await reloaded;
  await expect(page.getByText("Couldn't load this issue")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issues/${id}$`));
  expect(loads).toEqual([`/issues/${id}`]);
  await expect(rows(page).first()).toBeVisible();

  await page.unroute(PANEL_CHUNK);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  expect(loads).toHaveLength(1);
});
