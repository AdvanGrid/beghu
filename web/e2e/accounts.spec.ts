// Several accounts in one browser, in a real browser against the ./dev-ctl stack: the account
// menu, switching, a side-by-side tab going stale, the banners' order, and signing out. Each test
// has its own browser context (its own session), so switching and signing out touch no other
// test; nothing here changes an account for anyone else (lost-access.spec.ts does, serially).
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { bfcache } from "./bfcache";

// Among the stale-page specs (spec #86): a side-by-side tab sees the switch with the browser's
// back-forward cache on, as a person's browser has it.
test.use(bfcache);

const account = (page: Page) => page.locator('[data-perf="account"]');
const banner = (page: Page) => page.locator('[data-perf="banner"]');
const menu = (page: Page) => page.locator('[data-perf="account-menu"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');
const rows = (page: Page) => page.locator('[data-perf="row"]');

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
  // In dev, StyleX's runtime styles a lazily loaded chunk a moment after it renders: until then
  // the menu sits in the flow under <main>, which takes its clicks. (The build's chunk brings its
  // CSS before it runs.)
  await expect(menu(page)).toHaveCSS("position", "absolute");
}

/** Opens the first issue of the list, with its composer. */
async function openIssue(page: Page): Promise<void> {
  await rows(page).first().click();
  await expect(composer(page)).toBeVisible({ timeout: 15_000 });
}

test("the account menu lists every account, and switching shows the other account at the same URL", async ({ context }) => {
  const page = await signIn(context, "tomsj", "ilze-k");
  await page.goto("/?q=is:open+sort:created-asc");
  await openMenu(page);
  await expect(menu(page)).toContainText("Signed in as ilze-k");
  await menu(page).getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await page.waitForURL((u) => u.pathname === "/" && u.search === "?q=is:open+sort:created-asc");
  await expect(account(page)).toHaveText("tomsj");
  await expect(rows(page).first()).toBeVisible();
  // No banner: this tab made the switch.
  await expect(banner(page)).toBeHidden();
});

test("a side-by-side tab gets the switched banner within a second, freezes Comment and Close, and keeps its draft", async ({ context }) => {
  const stale = await signIn(context, "tomsj", "ilze-k");
  await openIssue(stale);
  const box = composer(stale).locator("textarea");
  await box.fill("half a thought");
  await expect(composer(stale).getByRole("button", { name: "Comment", exact: true })).toBeEnabled();

  const other = await context.newPage();
  await other.goto("/");
  await openMenu(other);
  // Timed from beghu's answer to the switch, not from the click: the other tab's page load in
  // between isn't what's measured.
  const posted = other.waitForResponse((r) => new URL(r.url()).pathname === "/auth/switch");
  // No unsaved text in this tab: it switches without asking.
  await menu(other).getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await posted;
  const switched = Date.now();

  await expect(banner(stale)).toHaveAttribute("data-banner", "switched", { timeout: 1500 });
  expect(Date.now() - switched).toBeLessThan(2000);
  await expect(account(other)).toHaveText("tomsj");
  await expect(banner(stale)).toContainText("This tab is on another account");
  await expect(banner(stale).getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(composer(stale).getByRole("button", { name: "Comment", exact: true })).toBeDisabled();
  await expect(composer(stale).getByRole("button", { name: /^(Close|Reopen) issue$/ })).toBeDisabled();
  await expect(box).toHaveValue("half a thought");
});

test("signing out asks in the app only while the tab holds unsaved text", async ({ context }) => {
  const page = await signIn(context, "tomsj", "ilze-k");
  await openIssue(page);
  await composer(page).locator("textarea").fill("not sent yet");
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign out of ilze-k" }).click();
  const ask = page.locator('[data-perf="leave-confirm"]');
  await expect(ask).toContainText("unsaved text");
  await ask.getByRole("button", { name: "Cancel" }).click();
  await expect(account(page)).toHaveText("ilze-k");

  // With the draft gone, it signs out at once, switching to the account still signed in.
  await page.keyboard.press("Escape");
  await composer(page).locator("textarea").fill("");
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign out of ilze-k" }).click();
  await expect(account(page)).toHaveText("tomsj");
  await openMenu(page);
  await expect(menu(page).getByRole("menuitem", { name: /^Switch to/ })).toHaveCount(0);
});

test("signing out of every account lands on the signed-out page, and a tab left open says so", async ({ context }) => {
  const page = await signIn(context, "tomsj", "ilze-k");
  const left = await context.newPage();
  await left.goto("/");
  await expect(rows(left).first()).toBeVisible();
  await openMenu(page);
  await menu(page).getByRole("menuitem", { name: "Sign out of all accounts" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/signed-out");
  await expect(page.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await expect(banner(left)).toHaveAttribute("data-banner", "signed_out", { timeout: 1500 });
  await expect(banner(left)).toContainText("You signed out in another tab");
  // The tab stays where it is, with its view, until the user picks Sign in.
  await expect(rows(left).first()).toBeVisible();
});

test("one banner at a time: another account, then can't reach beghu, then GitHub unreachable", async ({ page }) => {
  // "Can't reach beghu" waits 15 s.
  test.setTimeout(60_000);
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
  // This tab's stream only: GitHub down as each stream opens, then no stream at all.
  let stream: "github-down" | "none" = "github-down";
  await page.route("**/api/stream**", (route) =>
    stream === "none"
      ? route.abort()
      : route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: 'event: reset\ndata: {}\n\nevent: github\ndata: {"state":"down"}\n\n',
        }),
  );
  await page.reload();
  await expect(banner(page)).toHaveAttribute("data-banner", "github");
  await expect(banner(page)).toContainText("GitHub is unreachable");

  stream = "none";
  await expect(banner(page)).toHaveAttribute("data-banner", "cant_reach", { timeout: 20_000 });
  await expect(banner(page)).toContainText("Can't reach beghu");
  await expect(banner(page)).toHaveCount(1);

  // Another tab switched accounts: the cookie names another, and the tab finds out on focus.
  await page.evaluate(() => {
    document.cookie = "beghu_acct=1; path=/; secure; samesite=lax";
    dispatchEvent(new Event("focus"));
  });
  await expect(banner(page)).toHaveAttribute("data-banner", "switched");
  await expect(banner(page)).toHaveCount(1);
});

test("a read answered signed-out while the tab has an account asks to sign in again, keeping the draft", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await openIssue(page);
  const here = page.url();
  await composer(page).locator("textarea").fill("keep me");
  // Every read from here on is answered signed out, as once the account lost access.
  await page.route("**/api/issues**", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"signed_out","message":"Sign in to continue"}' }),
  );
  const filter = page.locator('[data-perf="filter"]');
  await filter.fill("is:closed");
  await filter.press("Enter");
  await expect(banner(page)).toHaveAttribute("data-banner", "sign_in_again");
  await page.waitForTimeout(1000);
  expect(new URL(page.url()).pathname).toBe(new URL(here).pathname);
  await expect(composer(page).locator("textarea")).toHaveValue("keep me");
});

test("a stale tab's repo picker can't save the ticks it holds", async ({ context }) => {
  const stale = await signIn(context, "tomsj", "ilze-k");
  await stale.goto("/repos");
  const tick = stale.locator('[data-perf="pick-repo"] input').first();
  await tick.click();
  const save = stale.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled();

  const other = await context.newPage();
  await other.goto("/");
  await openMenu(other);
  await menu(other).getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await expect(banner(stale)).toHaveAttribute("data-banner", "switched");
  await expect(save).toBeDisabled();
});

test("a stale tab that opens another issue says why it can't, and its draft stays to copy", async ({ context }) => {
  const stale = await signIn(context, "tomsj", "ilze-k");
  await openIssue(stale);
  const drafted = stale.url();
  await composer(stale).locator("textarea").fill("don't strand me");
  const page = (await (await stale.request.get("/api/issues?q=sort:created-asc")).json()) as { rows: { id: number }[] };
  const unread = page.rows.at(-1)!.id;
  const prs = (await (await stale.request.get(`/api/issues?q=${encodeURIComponent("is:pr sort:created-asc")}`)).json()) as { rows: { id: number }[] };
  const unreadPr = prs.rows.at(-1)!.id;

  const other = await context.newPage();
  await other.goto("/");
  await openMenu(other);
  await menu(other).getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await expect(banner(stale)).toHaveAttribute("data-banner", "switched");

  // Another issue, one the tab hasn't read (nor preloaded): beghu answers it as the browser's
  // other account, so the tab can't show it.
  const openInApp = (id: number) =>
    stale.evaluate((id) => {
      const a = document.createElement("a");
      a.href = `/issues/${id}`;
      document.body.append(a);
      a.click();
      a.remove();
    }, id);
  await openInApp(unread);
  const notice = stale.locator('[data-perf="detail-stale"]');
  await expect(notice).toContainText("This tab is on another account");
  await expect(stale.getByText("Couldn't load this issue")).toBeHidden();
  // A PR's panel says the same.
  const refused = stale.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${unreadPr}`);
  await openInApp(unreadPr);
  expect((await refused).status()).toBe(409);
  await expect(notice).toContainText("This tab is on another account");
  await expect(stale.getByText("Couldn't load this issue")).toBeHidden();
  // Back to the issue that couldn't load, then on back to the drafted one.
  await stale.goBack();

  // Back to the drafted one: its draft is there, in the composer or (if it can't load either)
  // kept to copy.
  await stale.goBack();
  await stale.waitForURL(drafted);
  await expect(stale.locator('[data-perf="composer"] textarea, [data-perf="kept-text"] textarea').first()).toHaveValue("don't strand me");
});

test("reads beghu answers busy (503) while the account's data is made ready are waited out, not failed", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  // The first two answers of each read: busy, as while a mirror is deleted or rebuilt.
  const busy = new Map<string, number>();
  await page.route(/\/api\/(me|issues)(\?|$)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const n = busy.get(path) ?? 0;
    if (n >= 2) return route.continue();
    busy.set(path, n + 1);
    await route.fulfill({
      status: 503,
      headers: { "retry-after": "1" },
      contentType: "application/json",
      body: '{"error":"unavailable","message":"this account\'s data is being deleted or rebuilt"}',
    });
  });
  await page.reload();
  await expect(page.locator('[data-perf="getting-ready"]')).toHaveText("Getting this account ready…");
  await expect(rows(page).first()).toBeVisible({ timeout: 15_000 });
  await expect(account(page)).toHaveText("tomsj");
  await expect(page.getByText("Couldn't load this view")).toBeHidden();
  await expect(page.locator('[data-perf="getting-ready"]')).toBeHidden();
});

test("a stale tab's title editor keeps the text, can't save it, and says why", async ({ context }) => {
  const stale = await signIn(context, "ilze-k", "tomsj");
  await openIssue(stale);
  await stale.locator('[data-perf="detail"]').focus();
  await stale.keyboard.press("e");
  const editor = stale.locator('[data-perf="title-editor"]');
  const box = editor.locator('[data-perf="edit-box"]');
  await expect(box).toBeFocused({ timeout: 15_000 });
  await box.fill("A title not saved yet");
  await expect(editor.getByRole("button", { name: "Save" })).toBeEnabled();

  const other = await context.newPage();
  await other.goto("/");
  await openMenu(other);
  await menu(other).getByRole("menuitem", { name: "Switch to ilze-k" }).click();
  await expect(banner(stale)).toHaveAttribute("data-banner", "switched");
  await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(editor.locator('[data-perf="edit-paused"]')).toContainText("Saving is paused");
  // Enter doesn't send it either.
  await box.press("Enter");
  await expect(box).toHaveValue("A title not saved yet");
});
