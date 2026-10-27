// Live updates in a real browser: outside edits on Fake GitHub reach the open list through
// webhooks and the tab's stream, without a reload.
//
// Serial, and the only spec that edits: the edits and webhook faults are global to the stack, so
// it runs after every other spec (playwright.config.ts).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop } from "./claims";
import { recordPushes, SHOWS_WITHIN_MS, timeFromPush } from "./push";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test.describe.configure({ mode: "serial" });

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

let control: string;

/** A call to Fake GitHub's control port, which `./dev-ctl fake` also uses. */
async function fake(path: string, body: unknown, method = "POST"): Promise<void> {
  const res = await fetch(`${control}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${path}: ${await res.text()}`).toBe(true);
}

/** `repo` and `number` of the `i`th row on screen. */
async function rowRef(page: Page, i: number): Promise<{ repo: string; number: number; id: string }> {
  const row = page.locator('[data-perf="row"]').nth(i);
  const ref = /^([\w.-]+)#(\d+)$/.exec((await row.locator('[data-perf="ref"]').textContent())!.trim())!;
  return { repo: ref[1]!, number: Number(ref[2]), id: (await row.getAttribute("data-id"))! };
}

/** Text no other test, here or beside this one, will have used. */
const unique = (what: string) => `${what} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test.beforeAll(() => {
  control = (JSON.parse(devCtl(["status", "--json"])) as { urls: { control: string } }).urls.control;
});

/** The refetch the stream's opening `reset` causes. */
const liveRefetch = (page: Page) => page.waitForResponse((r) => r.url().includes("through=") && r.ok());

test.beforeEach(async ({ page }) => {
  await fake("/faults", {}, "DELETE");
  await recordPushes(page);
  // Signed in, with the stream up and its opening refetch done, so each test's change is the
  // only one.
  const live = liveRefetch(page);
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  await live;
});

test.afterEach(async () => {
  await fake("/faults", {}, "DELETE");
});

test("an outside edit through ./dev-ctl fake edit shows in the open list within 2 s, with no reload", async ({ page }) => {
  let loads = 0;
  page.on("framenavigated", (f) => f === page.mainFrame() && loads++);
  const { repo, number, id } = await rowRef(page, 5);
  const title = unique("Retitled with gh");
  // It moves to the top: it was updated last.
  const onTop = await timeFromPush(
    page,
    id,
    ([id, title]) => {
      const top = document.querySelector('[data-perf="row"]');
      return top?.getAttribute("data-id") === id && !!top.textContent?.includes(title);
    },
    [id, title] as const,
  );

  devCtl(["fake", "edit", `${repo}#${number}`, "--title", title]);
  const top = page.locator('[data-perf="row"]').first();
  await expect(top).toHaveAttribute("data-id", id, { timeout: SHOWS_WITHIN_MS });
  await expect(top).toContainText(title);
  await onTop();
  expect(loads).toBe(0);
});

test("a burst of pushes costs one immediate refetch and one trailing one, and the last push shows", async ({ page }) => {
  // When each push reaches the tab.
  await page.addInitScript(() => {
    const w = window as unknown as { pushes: number[] };
    w.pushes = [];
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("ids", () => w.pushes.push(Date.now()));
      }
    };
  });
  const live = liveRefetch(page);
  await page.reload();
  await live;
  const refs = await Promise.all([1, 2, 3, 4].map((i) => rowRef(page, i)));
  const titles = refs.map((_, i) => unique(`burst ${i}`));
  const refetches: number[] = [];
  let fetched!: () => void;
  const firstFetched = new Promise<void>((r) => (fetched = r));
  // The first refetch answers with the list as it was when it was asked, and only once every
  // push of the burst below has reached the tab: those changes can only show through the
  // refetch after it, however long the burst takes to arrive.
  await page.route("**/api/issues?*through=*", async (route) => {
    const first = refetches.push(Date.now()) === 1;
    const response = await route.fetch();
    if (first) {
      fetched();
      await page.waitForFunction(() => (window as unknown as { pushes: number[] }).pushes.length >= 4, null, {
        timeout: SHOWS_WITHIN_MS,
      });
    }
    await route.fulfill({ response });
  });

  await fake("/edit", { repo: refs[0]!.repo, number: refs[0]!.number, title: titles[0] });
  await firstFetched;
  // The other three land together, as a burst, while that refetch is in flight.
  await fake("/faults/webhooks", { reorder: 3 });
  for (const [i, r] of refs.entries()) if (i > 0) await fake("/edit", { repo: r.repo, number: r.number, title: titles[i] });

  for (const t of titles) await expect(page.getByText(t)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
  // The first refetch went out as soon as its push arrived, not after a debounce.
  const pushes = await page.evaluate(() => (window as unknown as { pushes: number[] }).pushes);
  expect(refetches[0]! - pushes[0]!).toBeLessThan(500);
  // Nothing more is coming: two refetches in all.
  await page.waitForTimeout(1500);
  expect(refetches).toHaveLength(2);
});

test("a push refetches a filtered, sorted view through its last loaded row, in its own sort", async ({ page }) => {
  // Bugs, oldest first: an edit moves nothing in this sort, and the label decides membership.
  const q = "label:bug sort:created-asc";
  const live = liveRefetch(page);
  await page.goto(`/?${new URLSearchParams({ q })}`);
  await live;
  const rows = page.locator('[data-perf="row"]');
  await expect(rows.first()).toBeVisible();
  const before = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  const kept = await rowRef(page, 2);
  const dropped = await rowRef(page, 4);
  const title = unique("Retitled in a filtered view");
  const refetches: URL[] = [];
  page.on("request", (r) => r.url().includes("through=") && refetches.push(new URL(r.url())));

  // One edit keeps its row (in place: this sort doesn't follow updates), one drops the label.
  await fake("/edit", { repo: kept.repo, number: kept.number, title });
  await fake("/edit", { repo: dropped.repo, number: dropped.number, remove_labels: ["bug"] });

  const row = (id: string) => page.locator(`[data-perf="row"][data-id="${id}"]`);
  await expect(row(kept.id)).toContainText(title, { timeout: SHOWS_WITHIN_MS });
  await expect(row(dropped.id)).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
  await expect(rows.nth(2)).toHaveAttribute("data-id", kept.id);
  const after = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  expect(after.slice(0, 6)).toEqual(before.filter((id) => id !== dropped.id).slice(0, 6));
  // Every refetch asked for this view, through the last row the tab had loaded.
  expect(refetches.length).toBeGreaterThanOrEqual(1);
  for (const u of refetches) expect(u.searchParams.get("q")).toBe(q);
});

/** Polls the server (as the tab, without the tab) until `id` heads the list with `title`. */
async function untilInMirror(page: Page, id: string, title: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/issues");
        const { rows } = (await res.json()) as { rows: { id: number; title: string }[] };
        return rows[0] && { id: String(rows[0].id), title: rows[0].title };
      },
      { timeout: SHOWS_WITHIN_MS },
    )
    .toEqual({ id, title });
}

test("a change between the data response and the stream opening shows within 2 s", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const opened: number[] = [];
  await page.route("**/api/stream", async (route) => {
    await held;
    opened.push(Date.now());
    await route.continue();
  });
  const firstPage = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/issues" && !r.url().includes("through="));
  await page.goto("/");
  await firstPage;
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  const { repo, number, id } = await rowRef(page, 3);
  const title = unique("Changed in the gap");

  // The change lands in the mirror while the tab has its rows but no stream: its push is lost.
  await fake("/edit", { repo, number, title });
  await untilInMirror(page, id, title);
  await expect(page.getByText(title)).toHaveCount(0);
  release();
  // Opening the stream is a reset, which refetches.
  const top = page.locator('[data-perf="row"]').first();
  await expect(top).toHaveAttribute("data-id", id, { timeout: 2000 });
  await expect(top).toContainText(title);
  expect(Date.now() - opened[0]!).toBeLessThanOrEqual(2000);
});

test("a killed stream shows reconnecting… after 3 s, retries every second, and reconnecting refetches", async ({ page }) => {
  // Keep a handle on the tab's EventSources, to cut the live one as a dropped connection would.
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const all: EventSource[] = [];
    (window as unknown as { streams: EventSource[] }).streams = all;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        all.push(this);
      }
    };
  });
  const live = liveRefetch(page);
  await page.reload();
  await live;
  const status = page.getByRole("status");
  const { repo, number, id } = await rowRef(page, 2);
  const title = unique("Changed while the stream was down");

  // beghu stays unreachable for new streams, and the open one drops.
  const attempts: number[] = [];
  await page.route("**/api/stream", (route) => {
    attempts.push(Date.now());
    return route.abort("connectionrefused");
  });
  await page.evaluate(() => {
    const es = (window as unknown as { streams: EventSource[] }).streams.at(-1)!;
    es.dispatchEvent(new Event("error"));
  });
  const dropped = Date.now();
  await page.waitForTimeout(2000);
  await expect(status).not.toContainText("reconnecting…");
  await expect(status).toContainText("reconnecting…", { timeout: 2500 });
  expect(Date.now() - dropped).toBeGreaterThanOrEqual(2900);
  // The tab retries by itself, about once a second.
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  for (const [a, b] of attempts.slice(1).map((t, i) => [attempts[i]!, t] as const)) {
    expect(b - a).toBeGreaterThanOrEqual(900);
    expect(b - a).toBeLessThan(1600);
  }

  // Changed while the tab can't hear about it.
  await fake("/edit", { repo, number, title });
  await untilInMirror(page, id, title);
  await expect(page.getByText(title)).toHaveCount(0);

  const refetched = liveRefetch(page);
  await page.unroute("**/api/stream");
  await refetched;
  await expect(status).not.toContainText("reconnecting…");
  await expect(page.locator('[data-perf="row"]').first()).toHaveAttribute("data-id", id);
  await expect(page.locator('[data-perf="row"]').first()).toContainText(title);
});

test("a failed refetch leaves the rows on screen", async ({ page }) => {
  const rows = page.locator('[data-perf="row"]');
  const before = await rows.allTextContents();
  const { repo, number } = await rowRef(page, 4);
  const failed = page.waitForEvent("requestfailed", (r) => r.url().includes("through="));
  await page.route("**/api/issues?*through=*", (route) => route.abort("connectionfailed"));

  await fake("/edit", { repo, number, title: unique("Not shown yet") });
  await failed;
  await page.waitForTimeout(300);
  expect(await rows.allTextContents()).toEqual(before);
  await expect(page.getByText("Couldn't load this view")).toHaveCount(0);

  // The next push refetches again, and that one lands.
  await page.unroute("**/api/issues?*through=*");
  const title = unique("Shown now");
  await fake("/edit", { repo, number, title });
  await expect(rows.first()).toContainText(title, { timeout: SHOWS_WITHIN_MS });
});

test("a page that loads during a refetch is never shown and then dropped", async ({ page }) => {
  const list = page.locator('[data-perf="list"]');
  // Every row count the list shows, in order.
  await list.evaluate((el) => {
    const w = window as unknown as { counts: number[] };
    w.counts = [Number(el.getAttribute("data-perf-rows"))];
    new MutationObserver(() => w.counts.push(Number(el.getAttribute("data-perf-rows")))).observe(el, {
      attributes: true,
      attributeFilter: ["data-perf-rows"],
    });
  });
  const loaded = Number(await list.getAttribute("data-perf-rows"));
  // The next page waits until a refetch has started, then lands while it's in flight.
  let refetchStarted!: () => void;
  const started = new Promise<void>((r) => (refetchStarted = r));
  await page.route("**/api/issues?*through=*", async (route) => {
    refetchStarted();
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  let paging!: () => void;
  const pageAsked = new Promise<void>((r) => (paging = r));
  await page.route("**/api/issues?*after=*", async (route) => {
    paging();
    await started;
    await route.continue();
  });

  // Taken before the scroll: the list renders only the rows on screen, and an issue below the top
  // 40 rows would rise to the top with fewer than the 30 comments detail.spec.ts relies on.
  const { repo, number } = await rowRef(page, 3);
  await list.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await pageAsked;
  const refetched = liveRefetch(page);
  await fake("/edit", { repo, number, title: unique("Edited while paging") });

  // Once the refetch has landed, both its rows and the next page's are on screen.
  await refetched;
  await expect(list).toHaveAttribute("data-perf-rows", String(2 * loaded), { timeout: 3000 });
  const counts = await page.evaluate(() => (window as unknown as { counts: number[] }).counts);
  expect(counts.every((n, i) => i === 0 || n >= counts[i - 1]!), `row counts: ${counts.join(" → ")}`).toBe(true);
});

// The open issue's detail. These edit for real, so they live here rather than in detail.spec.ts.
// The detail tests rely on the default list's top 40 rows having exactly 30 comments each: an
// edit there only retitles, and a comment goes to an issue further down, which the test then
// closes, so it leaves the default list again.

const detail = (page: Page) => page.locator('[data-perf="detail"]');
const comments = (page: Page) => page.locator('[data-perf="comment"]');

/** The API requests the page makes from now on, as path and query. */
function apiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) seen.push(u.pathname + u.search);
  });
  return seen;
}

/** The list's own refetch for a push or the stream's opening reset (not the detail's). */
const listRefetch = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === "/api/issues" && r.url().includes("through=") && r.ok());

/** An open issue below the default list's top 40 rows, with 1 to 15 comments, claimed for this test. */
const issueBelowTheTop = (page: Page) => claimBelowTheTop(page);

/**
 * Leaves `issue` closed, out of the default list, and waits for beghu to have the close (its
 * webhook comes about a second later), so the next test can't pick the issue again.
 */
async function closeForGood(page: Page, issue: { id: number; ref: string }): Promise<void> {
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, {
      timeout: SHOWS_WITHIN_MS,
    })
    .toBe("closed");
}

/** Each comment's id and time, in the order shown. */
const shownComments = (page: Page) =>
  comments(page).evaluateAll((els) =>
    els.map((el) => ({ id: Number(el.getAttribute("data-id")), at: el.querySelector("time")!.getAttribute("datetime")! })),
  );

/** A comment's place in its thread, as the API's cursors name it: `<created_at>.<id>`. */
const cursor = (c: { id: number; at: string }) => `${Date.parse(c.at) / 1000}.${c.id}`;

/** From now on, every title the detail shows, in order; call the result to read them. */
async function watchTitles(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { titles: string[] };
    w.titles = [];
    const frame = () => {
      const t = document.querySelector('[data-perf="detail"] [data-perf="title"]')?.textContent;
      if (t && w.titles.at(-1) !== t) w.titles.push(t);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  return () => page.evaluate(() => (window as unknown as { titles: string[] }).titles);
}

test("a comment made on GitHub shows in the open issue within 2 s, in one request through its last loaded comment", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  const opened = listRefetch(page);
  await page.goto(`/issues/${issue.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(issue.id));
  await expect(comments(page)).toHaveCount(issue.comments);
  // The new stream's opening reset has been handled: any refetch it caused has gone out.
  await opened;
  const before = await shownComments(page);
  const api = apiRequests(page);
  const text = unique("Commented with gh");
  try {
    // Newest first: it arrives on top, and nothing loaded is skipped or repeated.
    const onTop = await timeFromPush(
      page,
      issue.id,
      (text) => !!document.querySelector('[data-perf="comment"]')?.textContent?.includes(text),
      text,
    );
    devCtl(["fake", "edit", issue.ref, "--comment", text]);
    await expect(comments(page).first()).toContainText(text, { timeout: SHOWS_WITHIN_MS });
    await onTop();
    const after = await shownComments(page);
    expect(after.slice(1)).toEqual(before);
    // One push, one request; give a stray second one time to show.
    await page.waitForTimeout(1000);
    expect(api.filter((p) => p.startsWith(`/api/issues/${issue.id}`))).toEqual([
      `/api/issues/${issue.id}?through=${cursor(before.at(-1)!)}`,
    ]);
  } finally {
    // Out of the default list again: it rose to the top with few comments.
    await closeForGood(page, issue);
  }
});

/** Waits `n` frames. */
const frames = (page: Page, n: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        const next = (left: number) => (left === 0 ? done() : requestAnimationFrame(() => next(left - 1)));
        next(n);
      }),
    n,
  );

test("a match that a push brings to the open issue later never scrolls it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const issue = await issueBelowTheTop(page);
  const word = `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto(`/issues/${issue.id}?q=` + encodeURIComponent(`is:open ${word}`));
  await expect(detail(page)).toHaveAttribute("data-id", String(issue.id));
  // Its one page of comments is in, with no match: the opening reads have settled.
  await expect(comments(page)).toHaveCount(issue.comments);
  await frames(page, 5);
  const marks = detail(page).locator('[data-perf="match"]');
  await expect(marks).toHaveCount(0);
  // A body whose last line has the word, far below the fold.
  const body = [...Array(80).keys()].map((i) => `Filler line ${i}.`).join("\n\n") + `\n\nThe ${word} at the end.`;
  try {
    devCtl(["fake", "edit", issue.ref, "--body", body]);
    await expect(marks).toHaveCount(1, { timeout: 10_000 });
    await frames(page, 10);
    await expect(marks).not.toBeInViewport();
    expect(await detail(page).evaluate((el) => el.scrollTop)).toBe(0);
  } finally {
    // Out of the default list again: it rose to the top.
    await closeForGood(page, issue);
  }
});

test("a push for an issue whose detail failed to load acts as Retry", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  await page.route(`**/api/issues/${issue.id}`, (r) => r.fulfill({ status: 500, body: "{}" }));
  // The new stream's opening reset retries too: let it fail before the read can succeed.
  const opened = listRefetch(page);
  await page.goto(`/issues/${issue.id}`);
  await opened;
  await expect(page.locator('[data-perf="panel"]').getByText("Couldn't load this issue")).toBeVisible();
  await page.unroute(`**/api/issues/${issue.id}`);
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  const text = unique("Commented after a failure");
  try {
    devCtl(["fake", "edit", issue.ref, "--comment", text]);
    await expect(detail(page)).toHaveAttribute("data-id", String(issue.id), { timeout: SHOWS_WITHIN_MS });
    await expect(comments(page).first()).toContainText(text);
    expect(errors).toEqual([]);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a push naming a hovered issue makes its click read it afresh", async ({ page }) => {
  const rows = page.locator('[data-perf="row"]');
  await rows.first().click();
  await expect(detail(page)).toBeVisible();
  const { repo, number, id } = await rowRef(page, 7);
  const row = page.locator(`[data-perf="row"][data-id="${id}"]`);
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  const was = ((await (await preloaded).json()) as { title: string }).title;
  const title = unique("Renamed by the push");
  await fake("/edit", { repo, number, title });
  // The push has reached the tab: the list shows it.
  await expect(row).toContainText(title, { timeout: SHOWS_WITHIN_MS });
  const titles = await watchTitles(page);
  await row.click();
  await expect(detail(page).locator('[data-perf="title"]')).toHaveText(title);
  expect(await titles()).not.toContain(was);
});

test("a hover read still on its way when a push names its issue is never shown", async ({ page }) => {
  const rows = page.locator('[data-perf="row"]');
  await rows.first().click();
  await expect(detail(page)).toBeVisible();
  const { repo, number, id } = await rowRef(page, 8);
  const row = page.locator(`[data-perf="row"][data-id="${id}"]`);
  // The hover's read is answered before the edit, then held until its push has gone by.
  let reads = 0;
  let was: string | undefined;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/issues/${id}`, async (route) => {
    const first = reads++ === 0;
    const res = await route.fetch();
    if (first) {
      was = ((await res.json()) as { title: string }).title;
      await held;
    }
    await route.fulfill({ response: res });
  });
  const preloaded = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  await row.hover();
  await expect.poll(() => was).toBeDefined();
  const title = unique("Renamed while a read was on its way");
  await fake("/edit", { repo, number, title });
  await expect(row).toContainText(title, { timeout: SHOWS_WITHIN_MS });
  release();
  await preloaded;
  // Past the router's 5 s preload window, where only a remembered read could show at once.
  await page.waitForTimeout(6_000);
  const titles = await watchTitles(page);
  await row.click();
  await expect(detail(page).locator('[data-perf="title"]')).toHaveText(title);
  expect(await titles()).not.toContain(was);
});
