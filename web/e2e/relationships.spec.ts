// Relationships in a real browser: relationships made on Fake GitHub reach the list's rows (the red
// edge, a chip per open blocker, the hover card, progress) and the detail of both ends (the
// parent breadcrumb, Blocks, Relates to, Sub-issues, stubs), with no reload. And the list's
// columns: stacked labels and blockers, widths that follow the list, resizing.
//
// It edits, so it runs after every other spec, serially (playwright.config.ts). Every
// relationship a test makes, it removes again, so the stack is as it found it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { recordPushes, SHOWS_WITHIN_MS, timeFromPush } from "./push";
import { status } from "./stack";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test.describe.configure({ mode: "serial" });

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

interface Unlinked {
  repo: string;
  number: number;
  id: number;
}

/** The fixture generator's summary, next to the fixture the stack's Fake GitHub serves. */
async function summary(): Promise<{ unlinked: Unlinked[]; unlinked_closed: Unlinked[]; stub_numbers: number[]; unlinked_stubs: number[] }> {
  const { control } = status().urls;
  const { fixture } = (await (await fetch(`${control}/state`)).json()) as { fixture: string };
  return JSON.parse(readFileSync(fixture.replace(/mirror-([^/]*)\.db$/, "fixture-$1.json"), "utf8"));
}

const ref = (u: Unlinked) => `${u.repo}#${u.number}`;
const rows = (page: Page) => page.locator('[data-perf="row"]');
const row = (page: Page, id: number | string) => page.locator(`[data-perf="row"][data-id="${id}"]`);

/** Signed in, with the stream's opening refetch done, at `path`. */
async function open(page: Page, path = "/"): Promise<void> {
  await recordPushes(page);
  const live = page.waitForResponse((r) => r.url().includes("through=") && r.ok());
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await live;
  if (path !== "/") await page.goto(path);
  await expect(rows(page).first()).toBeVisible();
}

/** The API requests the page makes from now on. */
function apiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) seen.push(u.pathname + u.search);
  });
  return seen;
}

// The tests leave every issue's `updated_at` as they found it (a relationship doesn't change
// it; closing would), so the list's order holds for the other specs on the next run, and they
// relate only to stubs that other relationships keep alive.
let unlinked: Unlinked[];
let closed: Unlinked[];
let stub: number;
test.beforeAll(async () => {
  const s = await summary();
  ({ unlinked, unlinked_closed: closed } = s);
  stub = s.stub_numbers.find((n) => !s.unlinked_stubs.includes(n))!;
});

test("a dependency made on GitHub marks the row and fills both ends' Blocks sections within 2 s, with no reload", async ({ page }) => {
  await open(page);
  let loads = 0;
  page.on("framenavigated", (f) => f === page.mainFrame() && loads++);
  const top = rows(page).first();
  const id = (await top.getAttribute("data-id"))!;
  const topRef = (await top.locator('[data-perf="ref"]').textContent())!.trim();
  const blocker = unlinked.find((u) => u.repo === "web")!;
  const chipShown = await timeFromPush(
    page,
    id,
    ([id, n]) =>
      [...document.querySelectorAll(`[data-perf="row"][data-id="${id}"] [data-perf="blocker"]`)].some((c) => c.textContent?.includes(`#${n}`)),
    [id, blocker.number] as const,
  );
  try {
    devCtl(["fake", "edit", topRef, "--add-blocked-by", ref(blocker)]);
    const chip = row(page, id).locator('[data-perf="blocker"]', { hasText: `#${blocker.number}` });
    await expect(chip).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await chipShown();
    await expect(row(page, id)).toHaveAttribute("data-blocked", "");
    expect(loads).toBe(0);

    // The blocker's own detail shows what it blocks; the blocked issue's shows its blocker.
    await page.goto(`/issues/${blocker.id}`);
    const blocked = page.locator(`[data-perf="blocking"] [data-perf="block-item"][data-id="${id}"]`);
    await expect(blocked).toBeVisible();
    await blocked.locator("a").click();
    await expect(page.locator('[data-perf="detail"]')).toHaveAttribute("data-id", id);
    await expect(page.locator(`[data-perf="blocked_by"] [data-perf="block-item"][data-id="${blocker.id}"]`)).toBeVisible();
  } finally {
    devCtl(["fake", "edit", topRef, "--remove-blocked-by", ref(blocker)]);
  }
});

test("the blockers' hover card lists each open blocker's title, owner and status with no fetch", async ({ page }) => {
  await open(page);
  const top = rows(page).first();
  const id = (await top.getAttribute("data-id"))!;
  const topRef = (await top.locator('[data-perf="ref"]').textContent())!.trim();
  const [a, b, c] = unlinked.filter((u) => u.repo === "web").slice(1, 4) as [Unlinked, Unlinked, Unlinked];
  try {
    // Two blockers, the second itself blocked.
    devCtl(["fake", "edit", topRef, "--add-blocked-by", ref(a)]);
    devCtl(["fake", "edit", topRef, "--add-blocked-by", ref(b)]);
    devCtl(["fake", "edit", ref(b), "--add-blocked-by", ref(c)]);
    const chips = row(page, id).locator('[data-perf="blocker"]');
    await expect(chips.filter({ hasText: `#${b.number}` })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    // The read-backs settle.
    await page.waitForTimeout(2500);
    const seen = apiRequests(page);
    await chips.filter({ hasText: `#${b.number}` }).hover();
    const card = page.locator('[data-perf="card"]');
    await expect(card).toBeVisible();
    const items = card.locator('[data-perf="card-blocker"]');
    await expect(items.filter({ hasText: `web#${a.number}` })).toBeVisible();
    await expect(items.filter({ hasText: `web#${b.number}` })).toContainText("itself blocked by 1");
    // Only the row's own preload (hovering a row preloads its issue); the card fetched nothing.
    expect(seen.filter((p) => p !== `/api/issues/${id}`)).toEqual([]);
  } finally {
    devCtl(["fake", "edit", ref(b), "--remove-blocked-by", ref(c)]);
    devCtl(["fake", "edit", topRef, "--remove-blocked-by", ref(a)]);
    devCtl(["fake", "edit", topRef, "--remove-blocked-by", ref(b)]);
  }
});

test("the detail shows the parent with its progress, sub-issues with x of y done, and a stub as not synced ↗", async ({ page }) => {
  const [parent, me, child] = unlinked.filter((u) => u.repo === "web").slice(4, 7) as [Unlinked, Unlinked, Unlinked];
  const other = closed[0]!;
  const sdk = `partner-sdk#${stub}`;
  try {
    devCtl(["fake", "edit", ref(parent), "--add-sub-issue", ref(me)]);
    devCtl(["fake", "edit", ref(me), "--add-sub-issue", ref(child)]);
    devCtl(["fake", "edit", ref(me), "--add-sub-issue", ref(other), "--relate", sdk]);
    await open(page, `/issues/${me.id}`);
    const crumb = page.locator('[data-perf="parent"]');
    // The parent's progress counts every descendant: me, child and the closed one.
    await expect(crumb).toContainText("1/3", { timeout: SHOWS_WITHIN_MS });
    await expect(crumb.locator("a")).toHaveAttribute("href", `/issues/${parent.id}`);
    const subs = page.locator('[data-perf="sub-issues"]');
    await expect(subs.locator('[data-perf="sub-progress"]')).toHaveText("1 of 2 done");
    await expect(subs.locator('[data-perf="rel-item"]')).toHaveCount(2);
    const related = page.locator('[data-perf="relates"] [data-perf="rel-item"]');
    await expect(related).toContainText("not synced");
    await expect(related.locator("a")).toHaveAttribute("href", new RegExp(`^https://github.com/acme/partner-sdk/issues/${stub}$`));
    await expect(related.locator("a")).toContainText("↗");
  } finally {
    devCtl(["fake", "edit", ref(me), "--remove-sub-issue", ref(other), "--unrelate", sdk]);
    devCtl(["fake", "edit", ref(me), "--remove-sub-issue", ref(child)]);
    devCtl(["fake", "edit", ref(parent), "--remove-sub-issue", ref(me)]);
  }
});

test("a cross-repo relationship shows on both ends within 2 s", async ({ page }) => {
  const me = unlinked.find((u) => u.repo === "web")!;
  const far = unlinked.find((u) => u.repo === "api")!;
  await open(page, `/issues/${me.id}`);
  // On screen as the shift cue in the empty Blocks section's spot (#110), or once it has opened.
  const blockerShown = await timeFromPush(
    page,
    me.id,
    (far) =>
      !!document.querySelector(`[data-perf="blocked_by"] [data-perf="block-item"][data-id="${far}"]`) ||
      document.querySelector('[data-unit="blocks"] [data-perf="cue-line"]')?.textContent === "blocker added",
    far.id,
  );
  try {
    devCtl(["fake", "edit", ref(me), "--add-blocked-by", ref(far)]);
    await expect(page.locator(`[data-perf="blocked_by"] [data-perf="block-item"][data-id="${far.id}"]`)).toBeVisible({
      timeout: SHOWS_WITHIN_MS,
    });
    await blockerShown();
    await page.locator(`[data-perf="blocked_by"] [data-perf="block-item"][data-id="${far.id}"] a`).click();
    await expect(page.locator(`[data-perf="blocking"] [data-perf="block-item"][data-id="${me.id}"]`)).toBeVisible();
  } finally {
    devCtl(["fake", "edit", ref(me), "--remove-blocked-by", ref(far)]);
  }
});

test("a hover card whose code fails to load leaves the list as it was, and the next hover loads it", async ({ page }) => {
  // At this width the labels cell holds two, so rows with three or more show "+n" and a card.
  await page.setViewportSize({ width: 860, height: 800 });
  const chunk = /\/ListCard[.-]/;
  await page.route(chunk, (r) => r.abort());
  await open(page);
  const crowded = page.locator('[data-perf="labels"]').filter({ hasText: /\+\d+$/ }).first();
  await crowded.hover();
  // The failure lands in the card's own boundary, which goes once the pointer leaves.
  const failed = page.locator('[data-perf="card-failed"]');
  await expect(failed).toBeAttached();
  await page.mouse.move(1, 1);
  await expect(failed).not.toBeAttached();
  await expect(crowded).toBeVisible();
  await expect(page.locator('[data-perf="card"]')).toHaveCount(0);

  await page.unroute(chunk);
  await crowded.hover();
  await expect(page.locator('[data-perf="card"]')).toBeVisible();
});

test("labels and blockers gain stacked columns as the list widens; a column resizes by its edge and double-click resets it", async ({ page }) => {
  const width = async (col: string) => (await page.locator(`[data-perf="list-head"] [data-col="${col}"]`).boundingBox())!.width;
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page);
  // The list is the whole width with no issue open.
  expect([await width("labels"), await width("blockers")]).toEqual([192, 100]);
  await page.setViewportSize({ width: 1300, height: 800 });
  await expect.poll(() => width("blockers")).toBe(200);
  await page.setViewportSize({ width: 1900, height: 800 });
  await expect.poll(async () => [await width("labels"), await width("blockers")]).toEqual([288, 300]);

  // At the narrowest labels cell (one column of two slots), a row with three or more labels shows
  // one, then "+n".
  await page.setViewportSize({ width: 860, height: 800 });
  await expect.poll(() => width("labels")).toBe(96);
  const crowded = page.locator('[data-perf="labels"]').filter({ hasText: /\+\d+$/ }).first();
  await expect(crowded).toBeVisible();
  await expect(crowded.locator(":scope > span")).toHaveCount(2);

  // Drag the Issue column's left edge 60 px left: it's 60 px wider, and stays so after a reload.
  const before = await width("ref");
  const grip = page.locator('[data-perf="list-head"] [data-col="ref"] [data-perf="col-grip"]');
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await width("ref")).toBe(before + 60);
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  expect(await width("ref")).toBe(before + 60);
  await grip.dblclick();
  expect(await width("ref")).toBe(before);
});

test("a stored column width that isn't a number is dropped, and one out of range is clamped", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("beghu.list-columns", JSON.stringify({ ref: "wide", progress: true, labels: 5000, who: -3 }));
  });
  await open(page);
  const width = async (col: string) => (await page.locator(`[data-perf="list-head"] [data-col="${col}"]`).boundingBox())!.width;
  // ref and progress take their automatic widths at this list width; labels and who their
  // largest and smallest.
  expect([await width("ref"), await width("progress"), await width("labels"), await width("who")]).toEqual([104, 52, 640, 24]);
});
