// The filter bar in a real browser against the ./dev-ctl stack: what it sends while typing, its
// lazy counts, the URL and history, the sort dropdown, and the pulse on a slow view.
import { expect, test, type Page } from "@playwright/test";

/** The `q` of every list page the tab asks for from now on. */
function listQueries(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/issues" && !u.searchParams.has("after")) seen.push(u.searchParams.get("q") ?? "(none)");
  });
  return seen;
}

const q = (page: Page) => new URL(page.url()).searchParams.get("q");

test.beforeEach(async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
});

test("a qualifier applies only once it's complete: `crash label` searches until the colon", async ({ page }) => {
  const sent = listQueries(page);
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" crash label:bug", { delay: 40 });
  await expect.poll(() => q(page)).toBe("is:open crash");
  // While `label:…` was being typed, no request carried it; the words before it searched.
  expect(sent.filter((s) => s.includes("label:"))).toEqual([]);
  expect(sent).toContain("is:open crash label");

  // Enter takes the highlighted value: now it filters.
  await expect(page.getByRole("listbox", { name: "Suggestions" }).getByRole("option", { name: /label:bug/ })).toBeVisible();
  await box.press("Enter");
  await expect.poll(() => q(page)).toBe("is:open crash label:bug");
  await expect(box).toHaveValue("is:open crash label:bug ");
  const rows = page.locator('[data-perf="row"]');
  await expect(rows.first()).toBeVisible();
  // Every row carries the label.
  const labels = await rows.evaluateAll((els) =>
    els.map((el) => [...el.querySelectorAll("span[title]")].map((l) => l.getAttribute("title"))),
  );
  for (const l of labels) expect(l).toContain("bug");
});

test("suggestion counts are fetched only for a value list that stays open", async ({ page }) => {
  const counts: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/facets/")) counts.push(r.url());
  });
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await box.click();
  await box.press("End");

  // Opened, then closed 150 ms after its values showed, timed in the page so a busy machine
  // can't stretch it past the wait: the counts' timer starts as the values show, and a timer due
  // sooner always fires first. No counts, however long it then stays shut.
  const shown = await box.evaluate(async (el: HTMLInputElement) => {
    const options = () => [...document.querySelectorAll('[data-perf="suggestions"] [role="option"]')];
    const valuesShown = () => options().some((o) => /^label:\w/.test(o.textContent ?? ""));
    el.value += " label:";
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    // The DOM change that shows the values, seen in the same task (a mutation observer runs
    // before any timer).
    await new Promise<void>((resolve) => {
      if (valuesShown()) return resolve();
      const seen = new MutationObserver(() => {
        if (!valuesShown()) return;
        seen.disconnect();
        resolve();
      });
      seen.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await new Promise((r) => setTimeout(r, 150));
    const texts = options().map((o) => o.textContent ?? "");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return texts;
  });
  expect(shown.some((o) => o.startsWith("label:bug"))).toBe(true);
  await expect(suggestions).toBeHidden();
  await page.waitForTimeout(1500);
  expect(counts).toEqual([]);

  // Left open: one fetch for the label list, and the counts show beside the values. (The counts
  // query alone took over 4 s on a loaded machine: no budget here, only that they come.)
  await box.pressSequentially("b");
  const bug = suggestions.getByRole("option", { name: /label:bug/ });
  await expect(bug.locator('[data-perf="count"]')).toHaveText(/^\d+$/, { timeout: 15_000 });
  expect(counts).toHaveLength(1);
  expect(new URL(counts[0]!).pathname).toBe("/api/facets/label/counts");
  expect(new URL(counts[0]!).searchParams.get("q")).toBe("is:open");
  // Typing on within the same list doesn't fetch again.
  await box.pressSequentially("u");
  await page.waitForTimeout(1500);
  expect(counts).toHaveLength(1);
});

test("the URL holds the query; Back and Forward refill the bar, and typing adds no history", async ({ page }) => {
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await page.getByRole("button", { name: "PRs" }).click();
  await expect.poll(() => q(page)).toBe("is:pr is:open");
  await expect(page.getByRole("button", { name: "PRs" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Assigned to me" }).click();
  await expect.poll(() => q(page)).toBe("is:open assignee:me");
  const entries = await page.evaluate(() => history.length);

  await box.click();
  await box.press("End");
  await box.pressSequentially(" crash", { delay: 40 });
  await expect.poll(() => q(page)).toBe("is:open assignee:me crash");
  expect(await page.evaluate(() => history.length)).toBe(entries);

  await page.goBack();
  await expect.poll(() => q(page)).toBe("is:pr is:open");
  await expect(box).toHaveValue("is:pr is:open");
  await page.goForward();
  await expect.poll(() => q(page)).toBe("is:open assignee:me crash");
  await expect(box).toHaveValue("is:open assignee:me crash");

  // A reload shows the same view.
  await page.reload();
  await expect(box).toHaveValue("is:open assignee:me crash");
});

test("the sort dropdown and the sort: token follow each other", async ({ page }) => {
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const sort = page.getByRole("combobox", { name: "Sort" });
  await expect(sort).toHaveValue("updated");

  await sort.selectOption("created-asc");
  await expect.poll(() => q(page)).toBe("is:open sort:created-asc");
  await expect(box).toHaveValue("is:open sort:created-asc");
  await expect(page.getByText("Opened", { exact: true })).toBeVisible();

  await box.click();
  await box.fill("is:open sort:comments ");
  await box.press("End");
  await box.press("Space");
  await expect(sort).toHaveValue("comments");
  await sort.selectOption("updated");
  await expect.poll(() => q(page)).toBe("is:open");
});

test("a view that takes over 200 ms pulses the list over the old rows, and a stale fetch never ends it", async ({ page }) => {
  const list = page.locator('[data-perf="list-frame"]');
  // Two slow views: the second is asked for while the first is still loading, and lands after it.
  // Held here, in the browser: `./dev-ctl fake latency` slows Fake GitHub, but the list reads
  // the server's mirror and never calls GitHub, so only a hold in front of `/api/issues` can
  // make a view slow. Each is held for the other rather than for a fixed time, so the order
  // holds however long the steps between take on a busy machine.
  let askedNewer!: () => void;
  const newerAsked = new Promise<void>((r) => (askedNewer = r));
  let olderLanded!: () => void;
  const olderIn = new Promise<void>((r) => (olderLanded = r));
  await page.route("**/api/issues?*", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q");
    if (q === "is:open assignee:me") {
      await newerAsked;
      await route.fulfill({ response: await route.fetch() });
      olderLanded();
    } else if (q === "is:pr is:open") {
      askedNewer();
      const response = await route.fetch();
      await olderIn;
      await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  });
  // Timed in the page, so a busy test machine doesn't blur the 200 ms: each click, and each
  // change of the list's busy state.
  await list.evaluate((el) => {
    const w = window as unknown as { log: [string, number][] };
    w.log = [];
    document.addEventListener("click", () => w.log.push(["click", performance.now()]), true);
    new MutationObserver(() => w.log.push([`busy:${el.getAttribute("aria-busy")}`, performance.now()])).observe(el, {
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
  });
  const before = await page.locator('[data-perf="row"]').first().getAttribute("data-id");

  await page.getByRole("button", { name: "Assigned to me" }).click();
  await expect(list).toHaveAttribute("aria-busy", "true");
  // The old rows stay while it waits.
  await expect(page.locator('[data-perf="row"]').first()).toHaveAttribute("data-id", before!);
  await page.getByRole("button", { name: "PRs" }).click();
  await expect(list).not.toHaveAttribute("aria-busy", "true", { timeout: 10_000 });
  await expect(page.locator('[data-perf="row"]').first()).toHaveAttribute("href", /q=is%3Apr\+is%3Aopen/);

  const { log, landed } = await page.evaluate(() => ({
    log: (window as unknown as { log: [string, number][] }).log,
    landed: Object.fromEntries(
      performance
        .getEntriesByType("resource")
        .filter((e) => e.name.includes("/api/issues?q="))
        .map((e) => [new URL(e.name).searchParams.get("q"), (e as PerformanceResourceTiming).responseEnd]),
    ),
  }));
  const clicks = log.filter(([e]) => e === "click").map(([, t]) => t);
  const busy = log.filter(([e]) => e.startsWith("busy:"));
  // One pulse: on once, 200 ms or more after the first click, off once, after the newer view
  // landed. The older view landed in between and didn't end it.
  expect(busy.map(([e]) => e)).toEqual(["busy:true", "busy:null"]);
  const [[, on], [, off]] = busy as [[string, number], [string, number]];
  expect(on - clicks[0]!).toBeGreaterThanOrEqual(200);
  expect(on - clicks[0]!).toBeLessThan(1000);
  const older = landed["is:open assignee:me"]!;
  const newer = landed["is:pr is:open"]!;
  expect(older).toBeGreaterThan(on);
  expect(older).toBeLessThan(newer);
  expect(off).toBeGreaterThanOrEqual(newer);
});

test("steady typing pulses 200 ms after the list began waiting, not only once typing stops", async ({ page }) => {
  // Every view but the first is slow, so each keystroke starts a new wait before the last ends.
  await page.route("**/api/issues?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") !== "is:open") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const box = page.getByRole("combobox", { name: "Filter issues" });
  // Clicking the box puts the default view's query in the URL (`/` becomes `/?q=is:open`): a view
  // of its own, which pulses if it takes over 200 ms. It lands before the typing starts, so the
  // pulse watched below is the typing's.
  const settled = page.waitForEvent("requestfinished", (r) => {
    const u = new URL(r.url());
    return u.pathname === "/api/issues" && u.searchParams.get("q") === "is:open";
  });
  await box.click();
  await box.press("End");
  await settled;
  await expect(page.locator('[data-perf="list-frame"]')).not.toHaveAttribute("aria-busy", "true");
  // A keystroke every 100 ms, timed in the page, with when the list first went busy. Watched
  // from the list's column, which outlives any element inside it. Typing goes on until a
  // keystroke has followed the pulse (at most 10 s of it), so a loaded machine that starts the
  // first slow view late can't end the typing before the pulse is due.
  const t = await box.evaluate(async (el: HTMLInputElement) => {
    const busy = () => document.querySelector('[data-perf="list-frame"]')?.getAttribute("aria-busy") === "true";
    let on: number | undefined;
    new MutationObserver(() => {
      if (on === undefined && busy()) on = performance.now();
    }).observe(document.querySelector("main")!, {
      attributes: true,
      attributeFilter: ["aria-busy"],
      childList: true,
      subtree: true,
    });
    const words = " crash dark theme";
    let last = performance.now();
    for (let i = 0; i < 100 && !(on !== undefined && on < last); i++) {
      el.value += words[i % words.length];
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      last = performance.now();
      await new Promise((r) => setTimeout(r, 100));
    }
    return { last, on };
  });
  // The list began waiting when it asked for the first slow view: its request's start, known
  // once it has landed.
  const firstSlow = () =>
    page.evaluate(() =>
      Math.min(
        ...performance
          .getEntriesByType("resource")
          .filter((e) => {
            const u = new URL(e.name);
            return u.pathname === "/api/issues" && !u.searchParams.has("after") && u.searchParams.get("q") !== "is:open";
          })
          .map((e) => e.startTime),
      ),
    );
  await expect.poll(firstSlow, { timeout: 10_000 }).toBeLessThan(Infinity);
  const waiting = await firstSlow();
  expect(t.on).toBeDefined();
  expect(t.on! - waiting).toBeGreaterThanOrEqual(200);
  expect(t.on!).toBeLessThan(t.last);
});

test("type: suggests the issue types, and filters by one", async ({ page }) => {
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" type:");
  await expect(suggestions.getByRole("option")).toHaveText([/^type:Bug/, /^type:Feature/, /^type:Task/]);
  await box.pressSequentially("fe");
  await box.press("Enter");
  await expect.poll(() => q(page)).toBe("is:open type:Feature");
});

test("suggestions that fail to load say so in the list, and Retry loads them; the list is unharmed", async ({ page }) => {
  // The facets fail on this load (the shell's preload too), then work again.
  let failing = true;
  await page.route("**/api/facets", (r) => (failing ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  await page.reload();
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" label:");
  // Beside the list, not among its options.
  const notice = page.getByRole("status").filter({ hasText: "Couldn't load suggestions" });
  await expect(notice).toBeVisible();
  failing = false;
  await notice.getByRole("button", { name: "Retry" }).click();
  await expect(suggestions.getByRole("option", { name: /label:bug/ })).toBeVisible();
  await expect(notice).toBeHidden();
  await expect(box).toBeFocused();
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
});

test("counts that fail to load say so, and Retry fetches them", async ({ page }) => {
  let failing = true;
  await page.route("**/api/facets/*/counts?*", (r) => (failing ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" label:b");
  const notice = page.getByRole("status").filter({ hasText: "Couldn't load counts" });
  await expect(notice).toBeVisible();
  // The values are still there to pick.
  await expect(suggestions.getByRole("option", { name: /label:bug/ })).toBeVisible();
  failing = false;
  await notice.getByRole("button", { name: "Retry" }).click();
  const bug = suggestions.getByRole("option", { name: /label:bug/ });
  await expect(bug.locator('[data-perf="count"]')).toHaveText(/^\d+$/);
  await expect(notice).toBeHidden();
});

test("counts that failed load when the same list opens again, and the failure notice goes", async ({ page }) => {
  let failing = true;
  await page.route("**/api/facets/*/counts?*", (r) => (failing ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const suggestions = page.getByRole("listbox", { name: "Suggestions" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" label:b");
  const notice = page.getByRole("status").filter({ hasText: "Couldn't load counts" });
  await expect(notice).toBeVisible();
  await box.press("Escape");
  await expect(suggestions).toBeHidden();
  failing = false;
  // A failed read stays in the router's query cache for 5 s: past that, the same list asks again.
  await page.waitForTimeout(5_500);
  await box.pressSequentially("u");
  const bug = suggestions.getByRole("option", { name: /label:bug/ });
  await expect(bug.locator('[data-perf="count"]')).toHaveText(/^\d+$/);
  await expect(notice).toBeHidden();
});

test("a preset keeps the sort, and shows as pressed under any sort", async ({ page }) => {
  const sort = page.getByRole("combobox", { name: "Sort" });
  await sort.selectOption("created-asc");
  await expect.poll(() => q(page)).toBe("is:open sort:created-asc");
  await expect(page.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "PRs" }).click();
  await expect.poll(() => q(page)).toBe("is:pr is:open sort:created-asc");
  await expect(page.getByRole("button", { name: "PRs" })).toHaveAttribute("aria-pressed", "true");
  await expect(sort).toHaveValue("created-asc");
});

test("the suggestions load on focus without moving anything on the page", async ({ page }) => {
  const box = page.getByRole("combobox", { name: "Filter issues" });
  const where = () =>
    page.evaluate(() =>
      ["[data-perf=filter]", "[data-perf=sort]", '[role="group"][aria-label="Presets"]', "[data-perf=list-frame]"].map((sel) => {
        const r = document.querySelector(sel)!.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      }),
    );
  const before = await where();
  await box.click();
  await box.press("End");
  await box.pressSequentially(" la");
  await expect(page.getByRole("listbox", { name: "Suggestions" }).getByRole("option").first()).toBeVisible();
  expect(await where()).toEqual(before);
});

test("Enter right after typing a word searches for the word, while views are still loading", async ({ page }) => {
  // Every view takes 300 ms, so from the click's own view (it puts `?q=is:open` in the URL) one
  // is always loading while the word is typed, and the bar's state is held behind them.
  await page.route("**/api/issues?q=*", async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.continue();
  });
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" spinner");
  await box.press("Enter");
  // Not a value from the list as it was at the click ("is:open"), in place of the word.
  await expect(box).toHaveValue("is:open spinner");
  await expect.poll(() => q(page)).toBe("is:open spinner");
});
