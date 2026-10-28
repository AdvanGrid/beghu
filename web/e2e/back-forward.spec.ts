// Back and Forward, in a real browser with its back-forward cache on, against the ./dev-ctl
// stack. A page that left on purpose (a sign-out or a switch from the account menu), or whose
// account another tab switched away from, shows nothing of that account when the cache restores
// it, not even for a frame; one whose account is unchanged, left for GitHub, comes back as it was
// with no reload, its stream closed while it was away (spec #86). Each test has its own browser context, so its session touches no
// other test.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bfcache } from "./bfcache";
import { status } from "./stack";

test.use(bfcache);

const account = (page: Page) => page.locator('[data-perf="account"]');
const menu = (page: Page) => page.locator('[data-perf="account-menu"]');
const rows = (page: Page) => page.locator('[data-perf="row"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');

/** A page on "GitHub" (Fake GitHub's stand-in for the web), another site than beghu's. */
const github = () => `${status().urls.fake}/ext/page.html`;

/**
 * Follows a link out to GitHub in this tab. Most of beghu's links to GitHub open a new tab; a
 * stub's opens in this one, as does any link the user opens in place.
 */
async function linkOut(page: Page): Promise<void> {
  const to = github();
  await page.evaluate((url) => location.assign(url), to);
  await page.waitForURL(to);
}

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

/**
 * From now on, what each page the back-forward cache restores shows in each animation frame it
 * renders, once beghu's own `pageshow` handlers have run, as long as it stays: kept in the tab's
 * session storage, which the page loaded in its place can read (`framesShown`).
 */
async function recordFrames(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    addEventListener("pageshow", (e) => {
      if (!e.persisted) return;
      const frame = () => {
        const parts = ['[data-perf="account"]', '[data-perf="banner"]', '[data-perf="row"]'].filter((sel) =>
          [...document.querySelectorAll(sel)].some((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true })),
        );
        const frames = JSON.parse(sessionStorage.getItem("beghuTestFrames") ?? "[]") as string[][];
        sessionStorage.setItem("beghuTestFrames", JSON.stringify([...frames, parts]));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  });
}

/** What the restored pages showed, frame by frame (`recordFrames`). */
function framesShown(page: Page): Promise<string[][]> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("beghuTestFrames") ?? "[]") as string[][]);
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

// The spec's contingency: a restored page might paint for a frame before `pageshow`, which no
// script can see. So a signed-in page blanks on `pagehide` as it goes into the cache, however it
// left (here, a link out): it comes back already blank at `pageshow`, and no frame it renders
// after shows any of the old account.
test("Back to a page whose account another tab switched away from shows nothing of it, at any frame", async ({ context }) => {
  const restored = await recordRestores(context);
  await recordFrames(context);
  const page = await signIn(context, "tomsj", "ilze-k");
  await linkOut(page);

  const other = await context.newPage();
  await other.goto("/");
  await openMenu(other);
  await menu(other).getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await expect(account(other)).toHaveText("tomsj");

  await page.goBack({ waitUntil: "commit" });
  await expect.poll(() => restored).toEqual([[]]);
  // Then loaded afresh, as the browser's active account, having rendered no frame with any of
  // the old account in it (hidden at `pageshow`, it may render none at all before it goes).
  await expect(account(page)).toHaveText("tomsj");
  expect((await framesShown(page)).filter((parts) => parts.length > 0)).toEqual([]);
});

test("Back from a link out to GitHub restores the page as it was, with no reload, and refetches what it shows", async ({ context }) => {
  const restored = await recordRestores(context);
  const page = await signIn(context, "tomsj");
  const id = await rows(page).first().getAttribute("data-id");
  await rows(page).first().click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await page.evaluate(() => ((window as unknown as { beghuTestKept: boolean }).beghuTestKept = true));
  await linkOut(page);

  const documents: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents.push(r.url());
  });
  const refetched = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/issues/${id}`);
  // A restored page fires no `load`.
  await page.goBack({ waitUntil: "commit" });
  // Blank as it went into the cache, shown again at once: its account is unchanged.
  await expect.poll(() => restored).toEqual([[]]);
  await expect(rows(page).first()).toBeVisible();
  // The same document, from the cache: nothing asked of the server for it.
  expect(await page.evaluate(() => (window as unknown as { beghuTestKept?: boolean }).beghuTestKept)).toBe(true);
  expect(documents).toEqual([]);
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  // What it shows may be minutes old: it reads it again, as a stream's reset would have it.
  await refetched;
});

// An open request keeps a page in the cache only for so long: Chrome evicts one whose stream is
// still open after about two minutes away (`outstanding-network-request`), and Back then reloads.
// Each EventSource the page makes is noted; as the page is restored, before beghu's handlers
// run, every one is checked.
test("a page in the back-forward cache holds no stream open, and opens it again as it's restored", async ({ context }) => {
  const restored = await recordRestores(context);
  const atRestore: number[][] = [];
  await context.exposeFunction("beghuTestStreams", (states: number[]) => void atRestore.push(states));
  await context.addInitScript(() => {
    const made: EventSource[] = [];
    const Native = EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        made.push(this);
      }
    };
    (window as unknown as { beghuTestOpen: () => number }).beghuTestOpen = () => made.filter((es) => es.readyState !== EventSource.CLOSED).length;
    addEventListener("pageshow", (e) => {
      if (e.persisted) (window as unknown as { beghuTestStreams: (s: number[]) => void }).beghuTestStreams(made.map((es) => es.readyState));
    });
  });
  const open = (page: Page) => page.evaluate(() => (window as unknown as { beghuTestOpen: () => number }).beghuTestOpen());
  const page = await signIn(context, "tomsj");
  await expect.poll(() => open(page)).toBe(1);

  await linkOut(page);
  await page.goBack({ waitUntil: "commit" });
  await expect.poll(() => restored.length).toBe(1);
  // Every stream the page had was closed while it was away…
  expect(atRestore).toHaveLength(1);
  expect(atRestore[0]!.length).toBeGreaterThan(0);
  expect(atRestore[0]!.every((state) => state === 2)).toBe(true);
  // …and it opens one again.
  await expect.poll(() => open(page)).toBe(1);
  await expect(rows(page).first()).toBeVisible();
});
