// Account preferences in a real browser against the ./dev-ctl stack (1k fixture): comment order
// from the detail, and the keymap's setup page (/prefs): rebinding, swaps, refusals, sequences,
// and other tabs following through the `prefs` push. Device preferences (theme, widths) shared
// across tabs through `storage`.
//
// Preferences are tomsj's, whom every other spec signs in as: this spec runs on its own, after
// the rest (playwright.config.ts), and puts them back to the defaults around each test.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const rows = (page: Page) => page.locator('[data-perf="row"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');
const prefs = (page: Page) => page.locator('[data-perf="prefs"]');
const order = (page: Page) => page.locator('[data-perf="comment-order"]');
const firstComment = (page: Page) => page.locator('[data-perf="comments"] [data-perf="comment"]').first();
const keysOf = (page: Page, action: string) => prefs(page).locator(`[data-perf="key-row"][data-action="${action}"] [data-perf="keys"]`);
const rowId = async (page: Page, i: number) => Number(await rows(page).nth(i).getAttribute("data-id"));
const rowOf = (page: Page, id: number) => page.locator(`[data-perf="row"][data-id="${id}"]`);

/**
 * Two issues at the top of the default list (in view from its first frame) with two comments or
 * more, rows apart: neither is the other's neighbour, which the list preloads on its own.
 */
async function twoTopIssues(page: Page): Promise<[{ id: number }, { id: number }]> {
  const res = await page.request.get("/api/issues");
  const p = (await res.json()) as { rows: { id: number; comments: number }[] };
  const top = p.rows.slice(0, 14).map((r, index) => ({ ...r, index })).filter((r) => r.comments >= 2);
  const other = top.find((r) => r.index >= top[0]!.index + 3);
  if (!other) throw new Error("no two issues with comments at the top of the list, rows apart");
  return [top[0]!, other];
}

/** Puts tomsj's account preferences back to the defaults, from `page` (signed in as tomsj). */
async function resetPrefs(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const account = /(?:^|;\s*)beghu_acct=(\d+)/.exec(document.cookie)![1]!;
    const send = (body: unknown) =>
      fetch("/api/prefs", { method: "PATCH", headers: { "content-type": "application/json", "x-beghu-account": account }, body: JSON.stringify(body) });
    const me = (await (await fetch("/api/me", { headers: { "x-beghu-account": account } })).json()) as { keymap: Record<string, string> };
    for (const action of Object.keys(me.keymap)) await send({ field: "key", action, binding: null });
    await send({ field: "comment_order", value: "newest" });
  });
}

/** A tab of `context` signed in as tomsj, on `url`, with the list shown. */
async function tab(context: BrowserContext, url = "/"): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/auth/login?login=tomsj&next=${encodeURIComponent(url)}`);
  await page.waitForURL((u) => u.pathname === new URL(url, "http://x").pathname);
  await expect(rows(page).first()).toBeVisible();
  return page;
}

/** Waits for `page` to read `/api/me` again: a `prefs` push reached it. */
const rereadsMe = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === "/api/me" && r.ok());

/**
 * Records `keys` for `action` on the setup page: Change, then each key pressed. A single key
 * waits out the moment the recorder gives a second one, to make a sequence.
 */
async function record(page: Page, label: string, ...keys: string[]): Promise<void> {
  await prefs(page).getByRole("button", { name: `Change ${label}`, exact: true }).click();
  const recorder = prefs(page).locator('[data-perf="recorder"]');
  await expect(recorder).toBeFocused();
  for (const k of keys) await page.keyboard.press(k);
  await expect(recorder).toBeHidden({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await resetPrefs(page);
});

test.afterEach(async ({ page }) => {
  await resetPrefs(page);
});

test("comment order re-sorts this tab at once, other tabs on their next open, and a reload shows it with no flash", async ({ context }) => {
  const a = await tab(context);
  const [issue, other] = await twoTopIssues(a);
  const b = await tab(context, `/issues/${issue.id}`);
  await a.goto(`/issues/${issue.id}`);
  await expect(order(a)).toHaveAttribute("data-order", "newest");
  const newest = await firstComment(a).getAttribute("data-id");

  // The other tab preloads the next issue it opens, by a hover, before the change.
  const preloaded = b.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${other.id}`);
  await rowOf(b, other.id).hover();
  await preloaded;

  const heard = rereadsMe(b);
  await order(a).click();
  await expect(order(a)).toHaveAttribute("data-order", "oldest");
  await expect(order(a)).toHaveText(/oldest first/);
  await expect(firstComment(a)).not.toHaveAttribute("data-id", newest!);
  const oldest = await firstComment(a).getAttribute("data-id");

  // The other tab heard, and keeps the thread as it shows it.
  await heard;
  await expect(order(b)).toHaveAttribute("data-order", "newest");
  await expect(firstComment(b)).toHaveAttribute("data-id", newest!);
  // The next issue it opens in the app comes oldest first, the preloaded one too, and so does this
  // one opened again.
  await rowOf(b, other.id).click();
  await expect(detail(b)).toHaveAttribute("data-id", String(other.id));
  await expect(order(b)).toHaveAttribute("data-order", "oldest");
  await rowOf(b, issue.id).click();
  await expect(detail(b)).toHaveAttribute("data-id", String(issue.id));
  await expect(firstComment(b)).toHaveAttribute("data-id", oldest!);

  // A fresh load: the thread is oldest first from its first frame.
  const c = await context.newPage();
  await c.addInitScript(() => {
    const seen: string[] = ((window as unknown as { orders: string[] }).orders = []);
    new MutationObserver(() => {
      const o = document.querySelector<HTMLElement>('[data-perf="comment-order"]')?.dataset.order;
      if (o && seen.at(-1) !== o) seen.push(o);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await c.goto(`/issues/${issue.id}`);
  await expect(firstComment(c)).toHaveAttribute("data-id", oldest!);
  expect(await c.evaluate(() => (window as unknown as { orders: string[] }).orders)).toEqual(["oldest"]);
});

test("a key rebound on the setup page works at once, and in another tab through the prefs push", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  const other = await tab(context);
  await expect(keysOf(setup, "next")).toHaveText("j");

  const heard = rereadsMe(other);
  await record(setup, "Next issue", "n");
  await expect(keysOf(setup, "next")).toHaveText("n");
  await heard;

  const first = await rowId(other, 0);
  await other.keyboard.press("j");
  await expect(detail(other)).toBeHidden();
  await other.keyboard.press("n");
  await expect(detail(other)).toHaveAttribute("data-id", String(first));
  // The `?` overlay shows it too.
  await other.keyboard.press("?");
  await expect(other.getByRole("dialog", { name: "Keyboard shortcuts" }).locator("tr", { hasText: "Next issue" })).toContainText("n");
});

test("a sequence under way finishes on the keymap it started on, then the new one takes effect", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  const other = await tab(context);
  const [first, second] = [await rowId(other, 0), await rowId(other, 1)];
  let heard = rereadsMe(other);
  await record(setup, "Next issue", "g", "j");
  await expect(keysOf(setup, "next")).toHaveText("g j");
  await heard;

  // The keymap changes while the other tab is in the middle of the sequence: its read of the new
  // one is held until the sequence has started, then lets through.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  await other.route("**/api/me", async (route) => {
    asked();
    await held;
    await route.continue();
  });
  heard = rereadsMe(other);
  await record(setup, "Next issue", "n");
  await expect(keysOf(setup, "next")).toHaveText("n");
  await asking;
  await other.keyboard.press("g");
  release();
  await heard;
  await other.unroute("**/api/me");
  // Its second key, on the map it started on.
  await other.keyboard.press("j");
  await expect(detail(other)).toHaveAttribute("data-id", String(first));
  // From then on, the new map.
  await other.keyboard.press("n");
  await expect(detail(other)).toHaveAttribute("data-id", String(second));
  await other.keyboard.press("g");
  await other.keyboard.press("j");
  await expect(other).toHaveURL(new RegExp(`/issues/${second}$`));
});

test("a read of the keymap that lands after a newer one leaves the newer in effect", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  const other = await tab(context);
  // The other tab's first read after the change is answered, then held back until a later read
  // has landed.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let asked!: () => void;
  const asking = new Promise<void>((r) => (asked = r));
  let reads = 0;
  await other.route("**/api/me", async (route) => {
    if (++reads > 1) return route.continue();
    const answer = await route.fetch();
    asked();
    await held;
    await route.fulfill({ response: answer });
  });
  await record(setup, "Next issue", "n");
  await asking;
  const newer = rereadsMe(other);
  await record(setup, "Next issue", "u");
  await expect(keysOf(setup, "next")).toHaveText("u");
  await newer;
  const older = rereadsMe(other);
  release();
  await older;
  await other.unroute("**/api/me");

  // The older read said `n`: the tab keeps `u`, as the `?` overlay shows.
  const first = await rowId(other, 0);
  await other.keyboard.press("u");
  await expect(detail(other)).toHaveAttribute("data-id", String(first));
  await other.keyboard.press("?");
  await expect(other.getByRole("dialog", { name: "Keyboard shortcuts" }).locator("tr", { hasText: "Next issue" })).toContainText("u");
});

test("binding a key another action has offers a swap", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  await record(setup, "Next issue", "k");
  const swap = prefs(setup).locator('[data-perf="key-swap"]');
  await expect(swap).toContainText("k is Previous issue's. Swap, and Previous issue gets j?");
  await expect(swap.getByRole("button", { name: "Swap" })).toBeFocused();
  // Cancel leaves both as they were.
  await swap.getByRole("button", { name: "Cancel" }).click();
  await expect(swap).toBeHidden();
  await expect(keysOf(setup, "next")).toHaveText("j");
  await expect(keysOf(setup, "previous")).toHaveText("k");

  await record(setup, "Next issue", "k");
  await swap.getByRole("button", { name: "Swap" }).click();
  await expect(keysOf(setup, "next")).toHaveText("k");
  await expect(keysOf(setup, "previous")).toHaveText("j");
  // Stored: a fresh load has them.
  await setup.reload();
  await expect(keysOf(setup, "next")).toHaveText("k");
  await expect(keysOf(setup, "previous")).toHaveText("j");
  const first = await rowId(setup, 0);
  await setup.keyboard.press("k");
  await expect(detail(setup)).toHaveAttribute("data-id", String(first));
});

test("leaving the recorder after a sequence's first key drops that key, and another row's recording goes on", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  const recorderOf = (action: string) => prefs(setup).locator(`[data-perf="key-row"][data-action="${action}"] [data-perf="recorder"]`);
  await prefs(setup).getByRole("button", { name: "Change Next issue", exact: true }).click();
  await expect(recorderOf("next")).toBeFocused();
  await setup.keyboard.press("g");
  await expect(keysOf(setup, "next")).toContainText("…");
  // Another row's Change, while `g` waits for a second key.
  await prefs(setup).getByRole("button", { name: "Change Previous issue", exact: true }).click();
  await expect(recorderOf("previous")).toBeFocused();
  // Past the moment a second key would have had: nothing was stored, and the new recording waits.
  await setup.waitForTimeout(2_000);
  await expect(recorderOf("previous")).toBeFocused();
  await expect(keysOf(setup, "next")).toHaveText("j");
  await setup.keyboard.press("u");
  await expect(recorderOf("previous")).toBeHidden({ timeout: 5_000 });
  await expect(keysOf(setup, "previous")).toHaveText("u");
  await expect(keysOf(setup, "next")).toHaveText("j");
  await setup.reload();
  await expect(keysOf(setup, "next")).toHaveText("j");
});

test("a key two actions have is refused, naming both, and nothing changes", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  await record(setup, "Next issue", "g", "i");
  await record(setup, "Previous issue", "g", "p");
  // `g` alone is in the way of both sequences.
  await record(setup, "Into the issue", "g");
  await expect(prefs(setup).locator('[data-perf="key-refused"]')).toHaveText("g can't be bound: Next issue and Previous issue have it; change one of them first.");
  await expect(keysOf(setup, "next")).toHaveText("g i");
  await expect(keysOf(setup, "previous")).toHaveText("g p");
  await expect(keysOf(setup, "openIssue")).toHaveText("o");
});

test("keys the browser keeps are refused with the reason, and the binding stays", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  const refused = prefs(setup).locator('[data-perf="key-refused"]');
  for (const [key, shown, why] of [
    ["Control+w", "Ctrl+W", "The browser keeps this key"],
    ["Control+t", "Ctrl+T", "The browser keeps this key"],
    ["Control+n", "Ctrl+N", "The browser keeps this key"],
    ["Control+l", "Ctrl+L", "The browser keeps this key"],
    ["Control+Tab", "Ctrl+Tab", "The browser keeps this key"],
    ["Tab", "Tab", "Tab moves the focus"],
  ] as const) {
    await record(setup, "Next issue", key);
    await expect(refused).toHaveText(`${shown} can't be bound: ${why}.`);
    await expect(keysOf(setup, "next")).toHaveText("j");
  }
  // A plain key for an action that only works while typing.
  await record(setup, "Send comment", "s");
  await expect(refused).toHaveText("s can't be bound: This works while you type: it needs Ctrl or Cmd.");
  // A sequence starting with a key the list keeps: it would never get past that key there.
  await record(setup, "Next issue", "End", "j");
  await expect(refused).toHaveText("End j can't be bound: The list keeps the arrow keys, Home and End.");
  await expect(keysOf(setup, "next")).toHaveText("j");
});

test("an Alt binding is matched by the key's place, and Reset and Unbind work", async ({ context }) => {
  const setup = await tab(context, "/prefs");
  await record(setup, "Next issue", "Alt+n");
  await expect(keysOf(setup, "next")).toHaveText("Alt+N");
  const first = await rowId(setup, 0);
  await setup.keyboard.press("Alt+n");
  await expect(detail(setup)).toHaveAttribute("data-id", String(first));

  await setup.goto("/prefs");
  await prefs(setup).getByRole("button", { name: "Reset Next issue to GitHub's" }).click();
  await expect(keysOf(setup, "next")).toHaveText("j");
  await prefs(setup).getByRole("button", { name: "Unbind Next issue" }).click();
  await expect(keysOf(setup, "next")).toHaveText("unbound");
  await setup.reload();
  await expect(keysOf(setup, "next")).toHaveText("unbound");
});

test("a default an account already gave another action starts unbound, and the account keeps its key", async ({ context }) => {
  // As if a newer build had made `j` the default of an action the account had bound `j` to:
  // the account's own binding, set directly.
  const setup = await tab(context, "/prefs");
  await setup.evaluate(async () => {
    const account = /(?:^|;\s*)beghu_acct=(\d+)/.exec(document.cookie)![1]!;
    await fetch("/api/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-beghu-account": account },
      body: JSON.stringify({ field: "key", action: "focusFilter", binding: "j" }),
    });
  });
  await setup.reload();
  await expect(keysOf(setup, "focusFilter")).toHaveText("j");
  await expect(keysOf(setup, "next")).toHaveText("unbound");
  await setup.keyboard.press("j");
  await expect(setup.getByRole("combobox", { name: "Filter issues" })).toBeFocused();
});

test("theme and widths are this browser's, and reach its other tabs", async ({ context }) => {
  const a = await tab(context);
  const id = await rowId(a, 0);
  const b = await tab(context, `/issues/${id}`);
  await a.goto(`/issues/${id}`);
  await a.locator('[data-theme-choice="dark"]').click();
  await expect(b.locator("html")).toHaveAttribute("data-theme", "dark");
  await a.locator('[data-theme-choice="system"]').click();
  await expect(b.locator("html")).toHaveAttribute("data-theme", "system");

  // The divider dragged in one tab moves in the other.
  const panel = (p: Page) => p.locator('[data-perf="panel"]');
  const width = async (p: Page) => (await panel(p).boundingBox())!.width;
  const before = await width(b);
  const handle = (await a.locator('[data-perf="divider"]').boundingBox())!;
  await a.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await a.mouse.down();
  await a.mouse.move(handle.x - 120, handle.y + 100, { steps: 5 });
  await a.mouse.up();
  const after = await width(a);
  expect(Math.abs(after - before)).toBeGreaterThan(60);
  await expect.poll(() => width(b)).toBeCloseTo(after, 0);
  await a.locator('[data-perf="divider"]').dblclick();
});
