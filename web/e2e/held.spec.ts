// Held changes in the list (#109), in a real browser: outside edits on Fake GitHub reorder the
// default list (recently updated first, so an edited issue rises to the top), and the list holds
// the move while the user may be about to act, then applies it behind the shift cue.
//
// On the live project's one worker (playwright.config.ts): the edits reorder what every tab shows.
// They only retitle issues in the top 40 rows (one adds a blocker, and takes it off again), which
// keeps their comment counts as the detail tests expect; the ones that close an issue claim one
// below them.
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, listed, unique } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";
import { devCtl } from "./stack";

test.describe.configure({ mode: "serial" });

const PITCH = 34;
const list = (page: Page) => page.locator('[data-perf="list"]');
const rows = (page: Page) => page.locator('[data-perf="row"]');
const row = (page: Page, id: number | string) => page.locator(`[data-perf="row"][data-id="${id}"]`);
const detail = (page: Page) => page.locator('[data-perf="detail"]');

/** The issue at `i` in the list, as the server has it. */
const at = async (page: Page, i: number) => (await listed(page))[i]!;

/** Retitles `issue` from outside, as a teammate would: it rises to the top of the list. */
function retitle(issue: { ref: string }): void {
  devCtl(["fake", "edit", issue.ref, "--title", unique("Moved by a teammate")]);
}

/** The issue row `id` shows, as the server lists it. */
const issueOf = async (page: Page, id: string) => (await listed(page)).find((r) => r.id === Number(id))!;

/** The rows in the DOM, in order, with where each sits from the list's top edge. */
const onScreen = (page: Page) =>
  list(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    return [...el.querySelectorAll<HTMLElement>('[data-perf="row"]')].map((r) => ({
      id: r.dataset.id!,
      y: Math.round(r.getBoundingClientRect().top - top),
    }));
  });

/** Where row `id` sits from the list's top edge. */
const yOf = async (page: Page, id: string | number) => (await onScreen(page)).find((r) => r.id === String(id))?.y;

/** Until no row is animating. */
const settled = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.matches('[data-perf="row"]')).length))
    .toBe(0);

type Cue = { at: number; lines: number; leaving: string[] };
type Watch = { lastMove: number; cueAt?: number; cueLines: number; leaving: string[]; cues: Cue[]; topAt?: number; animated: boolean };

/**
 * From now on, in the page: when the pointer last moved (to new coordinates), when the shift cue
 * first showed (and what it marked), each cue as it showed or changed, when `id` first headed the
 * rows, and whether a row ever animated. Mutation observers time the DOM's changes as they happen;
 * call the result to read them.
 */
async function watch(page: Page, id: number): Promise<() => Promise<Watch>> {
  await page.evaluate((id) => {
    const w: Watch = { lastMove: -Infinity, cueLines: 0, leaving: [], cues: [], animated: false };
    (window as unknown as { held: Watch }).held = w;
    let at = { x: NaN, y: NaN };
    addEventListener(
      "pointermove",
      (e) => {
        if (e.clientX === at.x && e.clientY === at.y) return;
        at = { x: e.clientX, y: e.clientY };
        w.lastMove = performance.now();
      },
      true,
    );
    const list = document.querySelector('[data-perf="list"]')!;
    let shownCue = "";
    new MutationObserver(() => {
      const lines = list.querySelectorAll('[data-perf="cue-line"]').length;
      const leaving = [...list.querySelectorAll<HTMLElement>('[data-cue="leave"]')].map((r) => r.dataset.id!);
      if (w.cueAt === undefined && (lines || leaving.length)) {
        w.cueAt = performance.now();
        w.cueLines = lines;
        w.leaving = leaving;
      }
      const sig = lines || leaving.length ? `${lines}|${leaving.join()}` : "";
      if (sig && sig !== shownCue) w.cues.push({ at: performance.now(), lines, leaving });
      shownCue = sig;
      if (w.topAt === undefined && list.querySelector('[data-perf="row"]')?.getAttribute("data-id") === String(id)) w.topAt = performance.now();
    }).observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-cue", "data-id"] });
    const frame = () => {
      w.animated ||= document.getAnimations().some((a) => (a.effect as KeyframeEffect | null)?.target?.matches('[data-perf="row"]'));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, id);
  return () => page.evaluate(() => (window as unknown as { held: Watch }).held);
}

/** Moves the pointer to a spot over the list's rows and back, as a hand on the mouse does. */
async function wiggle(page: Page): Promise<void> {
  const box = (await list(page).boundingBox())!;
  const x = box.x + box.width / 2 + Math.round(Math.random() * 20);
  await page.mouse.move(x, box.y + 3 * PITCH + 10);
}

/** Puts the pointer outside the list, over the page's header. */
const pointerAway = (page: Page) => page.mouse.move(5, 5);

/**
 * Keeps the pointer moving over the list's rows (or at `spot`), as a hand on the mouse does, until the result is
 * called: between two spots, so no move repeats the last one's coordinates.
 */
async function keepMoving(page: Page, spot?: { x: number; y: number }): Promise<() => Promise<void>> {
  const box = (await list(page).boundingBox())!;
  const { x, y } = spot ?? { x: box.x + box.width / 2, y: box.y + 3 * PITCH + 10 };
  let on = true;
  let i = 0;
  await page.mouse.move(x, y);
  const loop = (async () => {
    while (on) {
      await page.mouse.move(x + (++i % 2) * 7, y);
      await page.waitForTimeout(150);
    }
  })();
  return async () => {
    on = false;
    await loop;
  };
}

/** The ids of the rows in the DOM, in order. */
const order = async (page: Page) => (await onScreen(page)).map((r) => r.id);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const live = page.waitForResponse((r) => r.url().includes("through=") && r.ok());
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
  // The stream's opening refetch is done: each test's change is the only one.
  await live;
});

test("with the pointer moving over the list, an outside reorder doesn't move rows; after 5 s of rest it applies behind the cue", async ({ page }) => {
  // The pointer moves from here until the rest begins, setup included.
  const stop = await keepMoving(page);
  const before = await order(page);
  const issue = await at(page, 5);
  const id = issue.id;
  const read = await watch(page, id);
  retitle(issue);

  // Its new title shows in place at once; the row stays where it was while the pointer moves.
  await expect(row(page, id)).toContainText("Moved by a teammate", { timeout: SHOWS_WITHIN_MS });
  await page.waitForTimeout(2000);
  expect(await order(page)).toEqual(before);
  expect((await read()).cueAt).toBeUndefined();

  // At rest, it applies: the cue first (an outline where it leaves, a line where it arrives).
  await stop();
  await expect(rows(page).first()).toHaveAttribute("data-id", String(id), { timeout: SHOWS_WITHIN_MS });
  const w = await read();
  expect(w.cueAt! - w.lastMove, "ms from the pointer's last move to the cue").toBeGreaterThanOrEqual(5000);
  expect(w.leaving).toEqual([String(id)]);
  expect(w.cueLines).toBe(1);
  expect(w.topAt! - w.cueAt!, "ms the cue showed").toBeGreaterThanOrEqual(690);
  expect(w.animated).toBe(true);
  await settled(page);
  // The rows above it moved down one; the rows below it stayed.
  expect((await order(page)).slice(0, 8)).toEqual([String(id), ...before.slice(0, 5), ...before.slice(6, 8)]);
});

test("the pointer moving on a hover card over the list is still on the list: the change waits", async ({ page }) => {
  // The issue at row 5 gets a blocker, so its row has a chip to hover (its order stays).
  const issue = await at(page, 5);
  const blocker = await at(page, 45);
  // Its chip (the row may have others).
  const ours = () => row(page, issue.id).locator('[data-perf="blocker"]').filter({ hasText: new RegExp(`#${blocker.number}\\b`) });
  devCtl(["fake", "edit", issue.ref, "--add-blocked-by", blocker.ref]);
  try {
    const chip = ours();
    await expect(chip).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    // Over the chip, then onto the card it opens, moving on it.
    await chip.hover();
    const card = page.locator('[data-perf="card"]');
    await expect(card).toBeVisible();
    const box = (await card.boundingBox())!;
    const stop = await keepMoving(page, { x: box.x + 20, y: box.y + 10 });
    const before = await order(page);
    const read = await watch(page, issue.id);
    retitle(issue);
    await expect(row(page, issue.id)).toContainText("Moved by a teammate", { timeout: SHOWS_WITHIN_MS });
    await page.waitForTimeout(2000);
    await expect(card).toBeVisible();
    expect(await order(page)).toEqual(before);
    expect((await read()).cueAt).toBeUndefined();
    // Resting on the card, it applies.
    await stop();
    await expect(rows(page).first()).toHaveAttribute("data-id", String(issue.id), { timeout: SHOWS_WITHIN_MS });
    const w = await read();
    expect(w.cueAt! - w.lastMove, "ms from the pointer's last move to the cue").toBeGreaterThanOrEqual(5000);
  } finally {
    devCtl(["fake", "edit", issue.ref, "--remove-blocked-by", blocker.ref]);
    // Its push is in before the next test starts.
    await expect(ours()).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
  }
});

test("a change in the top half moves the top edge, one in the bottom half the bottom edge, and one off screen doesn't shift the viewport", async ({ page }) => {
  await pointerAway(page);
  await list(page).evaluate((el, y) => (el.scrollTop = y), 10 * PITCH);
  await expect.poll(async () => (await onScreen(page)).some((r) => r.y === 0)).toBe(true);
  const height = await list(page).evaluate((el) => el.clientHeight);

  // Top half: the second row on screen goes to the top of the list. The row above it is pulled
  // down; the rows below it stay.
  let shown = (await onScreen(page)).filter((r) => r.y >= 0);
  let moved = shown[1]!.id;
  let above = shown[0]!;
  let below = shown[4]!;
  retitle(await issueOf(page, moved));
  await expect(row(page, moved)).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
  await settled(page);
  expect(await yOf(page, below.id)).toBe(below.y);
  expect(await yOf(page, above.id)).toBe(above.y + PITCH);

  // Bottom half: the third row from the bottom goes. The rows above it stay; the row below it
  // is pulled up.
  shown = (await onScreen(page)).filter((r) => r.y >= 0 && r.y + PITCH <= height);
  const n = shown.length;
  moved = shown[n - 3]!.id;
  retitle(await issueOf(page, moved));
  above = shown[n - 6]!;
  below = shown[n - 2]!;
  await expect(row(page, moved)).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
  await settled(page);
  expect(await yOf(page, above.id)).toBe(above.y);
  expect(await yOf(page, below.id)).toBe(below.y - PITCH);

  // Off screen (below the window, to the top of the list, above it): nothing on screen moves, and
  // it isn't held, even with the pointer moving over the list.
  await wiggle(page);
  const still = await onScreen(page);
  const top = await list(page).evaluate((el) => el.scrollTop);
  const lastShown = (await listed(page)).findIndex((r) => r.id === Number(still.at(-1)!.id));
  const read = await watch(page, -1);
  retitle(await at(page, lastShown + 3));
  await expect.poll(() => list(page).evaluate((el) => el.scrollTop), { timeout: SHOWS_WITHIN_MS }).toBe(top + PITCH);
  await wiggle(page);
  expect((await onScreen(page)).filter((r) => r.y >= 0 && r.y < height)).toEqual(still.filter((r) => r.y >= 0 && r.y < height));
  expect((await read()).cueAt).toBeUndefined();
});

test("at scroll position 0, an arrival at row 0 shows and pushes the rows down", async ({ page }) => {
  await pointerAway(page);
  const before = await onScreen(page);
  const issue = await at(page, 30);
  const id = issue.id;
  const read = await watch(page, id);
  retitle(issue);
  await expect(rows(page).first()).toHaveAttribute("data-id", String(id), { timeout: SHOWS_WITHIN_MS });
  expect((await read()).cueLines).toBe(1);
  await settled(page);
  expect(await list(page).evaluate((el) => el.scrollTop)).toBe(0);
  const after = await onScreen(page);
  expect(after[0]).toEqual({ id: String(id), y: 0 });
  // Every row that was on screen is one row lower.
  for (const r of before.slice(0, 10)) expect(after.find((a) => a.id === r.id)?.y).toBe(r.y + PITCH);
});

test("j and k step from the selected issue's place after it moves", async ({ page }) => {
  await rows(page).nth(3).click();
  const id = await rows(page).nth(3).getAttribute("data-id");
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await pointerAway(page);
  retitle(await issueOf(page, id!));
  await expect(rows(page).first()).toHaveAttribute("data-id", id!, { timeout: SHOWS_WITHIN_MS });
  await settled(page);
  const second = await rows(page).nth(1).getAttribute("data-id");
  await page.keyboard.press("j");
  await expect(detail(page)).toHaveAttribute("data-id", second!);
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
});

test("when the selected issue is closed under is:open, the selection moves to the issue that took its row, and stays while the panel holds a draft", async ({ page }) => {
  const count = async () => Number(await list(page).getAttribute("data-perf-rows"));
  // Below the top 40, in the first page.
  const issue = await claimBelowTheTop(page, (r) => r.index < 90);
  await page.goto(`/issues/${issue.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(issue.id));
  await expect(rows(page).first()).toBeVisible();
  const ids = await listed(page);
  const next = ids[ids.findIndex((r) => r.id === issue.id) + 1]!.id;
  const loaded = await count();
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect(detail(page)).toHaveAttribute("data-id", String(next), { timeout: SHOWS_WITHIN_MS });
  await expect(page).toHaveURL(new RegExp(`/issues/${next}$`));
  expect(await count()).toBe(loaded - 1);

  // With a draft in the panel, it stays on the closed issue.
  const kept = await claimBelowTheTop(page, (r) => r.index < 90);
  await page.goto(`/issues/${kept.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(kept.id));
  await expect(rows(page).first()).toBeVisible();
  const draft = unique("Half a reply");
  await page.locator('[data-perf="composer"] textarea').fill(draft);
  const now = await count();
  devCtl(["fake", "edit", kept.ref, "--close"]);
  await expect.poll(count, { timeout: SHOWS_WITHIN_MS }).toBe(now - 1);
  await page.waitForTimeout(1000);
  await expect(detail(page)).toHaveAttribute("data-id", String(kept.id));
  await expect(page).toHaveURL(new RegExp(`/issues/${kept.id}$`));
  await expect(page.locator('[data-perf="composer"] textarea')).toHaveValue(draft);
});

test("with reduced motion, a held change swaps in after a still mark, unanimated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pointerAway(page);
  const issue = await at(page, 6);
  const id = issue.id;
  const read = await watch(page, id);
  retitle(issue);
  await expect(rows(page).first()).toHaveAttribute("data-id", String(id), { timeout: SHOWS_WITHIN_MS });
  const w = await read();
  expect(w.leaving).toEqual([String(id)]);
  expect(w.topAt! - w.cueAt!, "ms the still mark showed").toBeGreaterThanOrEqual(890);
  await page.waitForTimeout(500);
  expect((await read()).animated).toBe(false);
});

test("a key pressed during the cue cancels it and holds the change again; it applies after the rest that follows", async ({ page }) => {
  await pointerAway(page);
  const before = await order(page);
  const issue = await at(page, 5);
  const id = issue.id;
  const read = await watch(page, id);
  // The moment the cue shows, a key (outside a text field) puts the user in intent mode.
  const pressedAt = await page.evaluateHandle(() => {
    const list = document.querySelector('[data-perf="list"]')!;
    const when = { at: undefined as number | undefined };
    const seen = new MutationObserver(() => {
      if (!list.querySelector('[data-perf="cue-line"]')) return;
      seen.disconnect();
      when.at = performance.now();
      dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
    });
    seen.observe(list, { subtree: true, childList: true });
    return when;
  });
  retitle(issue);
  await expect.poll(async () => (await pressedAt.evaluate((w) => w.at)) !== undefined, { timeout: SHOWS_WITHIN_MS }).toBe(true);
  // The cue is gone, and nothing moved.
  await expect(list(page).locator('[data-perf="cue-line"]')).toHaveCount(0);
  await expect(list(page).locator('[data-cue="leave"]')).toHaveCount(0);
  expect(await order(page)).toEqual(before);
  await page.waitForTimeout(1500);
  expect(await order(page)).toEqual(before);
  // 5 s after the key, the cue shows again, and the change applies behind it.
  await expect(rows(page).first()).toHaveAttribute("data-id", String(id), { timeout: SHOWS_WITHIN_MS });
  const w = await read();
  const key = (await pressedAt.evaluate((w) => w.at))!;
  expect(w.cues.length, "cues shown").toBe(2);
  expect(w.cues[1]!.at - key, "ms from the key to the second cue").toBeGreaterThanOrEqual(5000);
  expect(w.topAt! - w.cues[1]!.at, "ms the second cue showed").toBeGreaterThanOrEqual(690);
});

test("a change that arrives during the cue restarts it with both, and they apply as one batch", async ({ page }) => {
  // Open issue B, so a push naming it refetches the panel: that's how the test knows it came.
  const [a, b] = [await at(page, 5), await at(page, 8)];
  await row(page, b.id).click();
  await expect(detail(page)).toHaveAttribute("data-id", String(b.id));
  await pointerAway(page);
  const read = await watch(page, b.id);
  // The list's first refetch (after A's change) is held until B's change has reached the tab.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const first = new Promise<void>((r) => (reached = r));
  let n = 0;
  await page.route(
    (u) => u.pathname === "/api/issues" && u.searchParams.has("through"),
    async (route) => {
      if (n++ > 0) return route.continue();
      const response = await route.fetch();
      reached();
      await gate;
      await route.fulfill({ response });
    },
  );
  retitle(a);
  await first;
  const panelRefetch = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/issues/${b.id}`, { timeout: SHOWS_WITHIN_MS });
  retitle(b);
  await panelRefetch;
  // A's refetch lands: its cue shows; the one after it, with B, lands mid-cue.
  release();
  await expect(rows(page).first()).toHaveAttribute("data-id", String(b.id), { timeout: SHOWS_WITHIN_MS });
  await page.unroute(() => true);
  const w = await read();
  expect(w.cues.map((c) => c.leaving)).toEqual([[String(a.id)], [String(a.id), String(b.id)]]);
  expect(w.cues[1]!.at - w.cues[0]!.at, "ms into the first cue that the second showed").toBeLessThan(690);
  expect(w.topAt! - w.cues[1]!.at, "ms the restarted cue showed").toBeGreaterThanOrEqual(690);
  await settled(page);
  expect((await order(page)).slice(0, 2)).toEqual([String(b.id), String(a.id)]);
});

test("when the selected issue's row is on screen and it's closed under is:open, the cue marks it and the selection goes to the row that took its place", async ({ page }) => {
  const issue = await claimBelowTheTop(page, (r) => r.index < 90);
  await page.goto(`/issues/${issue.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(issue.id));
  await expect(rows(page).first()).toBeVisible();
  await pointerAway(page);
  // Its row a few rows from the window's top.
  await list(page).evaluate((el, y) => (el.scrollTop = y), (issue.index - 4) * PITCH);
  await expect(row(page, issue.id)).toBeInViewport();
  await expect(row(page, issue.id)).toHaveAttribute("aria-selected", "true");
  const y = await yOf(page, issue.id);
  // In the window's top half, its removal moves the top edge: the row above slides down into its
  // place.
  const ids = await listed(page, issue.index + 2);
  const taker = ids[issue.index - 1]!.id;
  const read = await watch(page, -1);
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect(detail(page)).toHaveAttribute("data-id", String(taker), { timeout: SHOWS_WITHIN_MS });
  expect((await read()).leaving).toEqual([String(issue.id)]);
  await expect(row(page, issue.id)).toHaveCount(0);
  await settled(page);
  await expect(row(page, taker)).toHaveAttribute("aria-selected", "true");
  expect(await yOf(page, taker)).toBe(y);
});

test("j while the list checks a selected issue that left steps from where it was, not from an overscan row", async ({ page }) => {
  const issue = await claimBelowTheTop(page, (r) => r.index < 90);
  await page.goto(`/issues/${issue.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(issue.id));
  await expect(rows(page).first()).toBeVisible();
  await pointerAway(page);
  await list(page).evaluate((el, y) => (el.scrollTop = y), (issue.index - 4) * PITCH);
  // Its row has the focus: the list has it.
  await row(page, issue.id).click();
  await expect(row(page, issue.id)).toBeFocused();
  await pointerAway(page);
  const ids = await listed(page, issue.index + 2);
  const after = ids[issue.index + 1]!.id;
  // The check of whether the issue is gone (a read of it) takes 4 s.
  await page.route(
    (u) => u.pathname === `/api/issues/${issue.id}`,
    async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    },
  );
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect(row(page, issue.id)).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
  await page.keyboard.press("j");
  await expect(detail(page)).toHaveAttribute("data-id", String(after));
  await expect(row(page, after)).toHaveAttribute("aria-selected", "true");
  await page.unroute(() => true);
});

test("a parent set from an issue's panel is a write to the parent, yet the selection stays on the issue when it then leaves the view", async ({ page }) => {
  const count = async () => Number(await list(page).getAttribute("data-perf-rows"));
  const child = await claimBelowTheTop(page, (r) => r.index < 90);
  // Any issue of its repo, from further down: the parent need not be on screen.
  const parent = await claimBelowTheTop(page, (r) => r.repo === child.repo && r.owner === child.owner, 600);
  await page.goto(`/issues/${child.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(child.id));
  await expect(page.locator('[data-perf="composer"]')).toBeVisible();
  const setParent = page.locator('[data-perf="add-parent"]');
  test.skip((await setParent.count()) === 0, "the claimed issue already has a parent");
  try {
    // `+ Set parent`: the write's issue is the parent (a sub-issue added to it).
    await setParent.click();
    const picker = page.locator('[data-perf="relationship-picker"]');
    await picker.locator("input").fill(`#${parent.number}`);
    await picker.locator(`[data-perf="relationship-option"][data-ref="${parent.repo}#${parent.number}"]`).click();
    await expect(page.locator('[data-perf="detail"] [data-perf="parent"]')).toContainText(`#${parent.number}`);
    await expect(page.locator('[data-perf="links"] [data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await pointerAway(page);
    const now = await count();
    devCtl(["fake", "edit", child.ref, "--close"]);
    await expect.poll(count, { timeout: SHOWS_WITHIN_MS }).toBeLessThan(now);
    await expect(row(page, child.id)).toHaveCount(0);
    await page.waitForTimeout(1000);
    // The user acted on this issue from its panel: the selection stays on it.
    await expect(detail(page)).toHaveAttribute("data-id", String(child.id));
    await expect(page).toHaveURL(new RegExp(`/issues/${child.id}$`));
  } finally {
    devCtl(["fake", "edit", parent.ref, "--remove-sub-issue", child.ref]);
  }
});
