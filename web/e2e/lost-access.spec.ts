// Losing access and Disconnect, in a real browser against the ./dev-ctl stack, on the octo-ext
// fixture account, which no other spec signs in as. Serial, after repos.spec.ts
// (playwright.config.ts): a revoke and a Disconnect change the account for every browser.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test.describe.configure({ mode: "serial" });

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

/** A call to Fake GitHub's control port. */
async function fake(path: string, body: unknown): Promise<void> {
  const control = (JSON.parse(devCtl(["status", "--json"])) as { urls: { control: string } }).urls.control;
  const res = await fetch(`${control}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${path}: ${await res.text()}`).toBe(true);
}

const rows = (page: Page) => page.locator('[data-perf="row"]');
const banner = (page: Page) => page.locator('[data-perf="banner"]');
const account = (page: Page) => page.locator('[data-perf="account"]');

/**
 * Signs octo-ext in and waits for its rows and its live stream to be open. Its first sign-in picks
 * its repos (both it can see); a run before this one may have picked them already.
 */
async function signInOcto(page: Page): Promise<void> {
  const streaming = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/stream" && r.status() === 200);
  await page.goto("/auth/login?login=octo-ext");
  await page.waitForURL((u) => u.pathname === "/" || u.pathname === "/repos");
  if (new URL(page.url()).pathname === "/repos") {
    const boxes = page.locator('[data-perf="pick-repo"]').getByRole("checkbox");
    await expect(boxes.first()).toBeVisible();
    for (const box of await boxes.all()) await box.check();
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((u) => u.pathname === "/");
  }
  await expect(account(page)).toHaveText("octo-ext");
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await streaming;
}

/** octo-ext's id, as beghu names it. */
async function octoId(page: Page): Promise<number> {
  const me = (await (await page.request.get("/api/me")).json()) as { account: { id: number } };
  return me.account.id;
}

/** Until beghu answers octo-ext's session signed out: it has marked the account. */
async function untilSignedOut(page: Page): Promise<void> {
  await expect.poll(async () => (await page.request.get("/api/me")).status(), { timeout: 5_000 }).toBe(401);
}

test("a revoke on GitHub asks the open tab to sign in again, and signing in imports afresh", async ({ page }) => {
  await signInOcto(page);
  await fake("/revoke", { login: "octo-ext" });
  await expect(banner(page)).toHaveAttribute("data-banner", "sign_in_again", { timeout: 5_000 });
  await expect(banner(page)).toContainText("GitHub access for this account ended");

  await banner(page).getByRole("link", { name: "Sign in again" }).click();
  // beghu asks GitHub for the same account, which signs straight back in.
  await page.waitForURL((u) => u.pathname === "/");
  await expect(account(page)).toHaveText("octo-ext");
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(banner(page)).toBeHidden();
});

test("signing in again while the lost account's data is still being deleted loads the view once it's ready", async ({ page }) => {
  await signInOcto(page);
  await fake("/revoke", { login: "octo-ext" });
  // Marked: beghu deletes the mirror now, and the sign-in lands while it does. Reads meanwhile
  // answer 503 ("being deleted or rebuilt"), which the tab waits out.
  await untilSignedOut(page);
  await signInOcto(page);
  await expect(page.getByText("Couldn't load this view")).toBeHidden();
  await expect(banner(page)).toBeHidden();
});

test("Disconnect asks first, then ends the session in another browser too", async ({ browser }) => {
  const here = await browser.newContext();
  const elsewhere = await browser.newContext();
  const shared = await browser.newContext();
  try {
    const page = await here.newPage();
    await signInOcto(page);
    const other = await elsewhere.newPage();
    await other.goto("/auth/login?login=octo-ext");
    await other.waitForURL((u) => u.pathname === "/");
    await expect(rows(other).first()).toBeVisible();
    // A third browser holds tomsj too, with octo-ext active.
    const both = await shared.newPage();
    await both.goto("/auth/login?login=tomsj");
    await both.waitForURL((u) => u.pathname === "/");
    await both.goto("/auth/login?login=octo-ext");
    await both.waitForURL((u) => u.pathname === "/");
    await expect(account(both)).toHaveText("octo-ext");
    await expect(rows(both).first()).toBeVisible();

    await account(page).click();
    await page.getByRole("menuitem", { name: "Disconnect beghu…" }).click();
    const ask = page.locator('[data-perf="leave-confirm"]');
    await expect(ask).toContainText("revokes its access on GitHub");
    await expect(ask).toContainText("remembers which repos you picked");
    await ask.getByRole("button", { name: "Disconnect" }).click();
    await page.waitForURL((u) => u.pathname === "/auth/signed-out");

    // The other browser held only octo-ext: its session is over.
    await expect(banner(other)).toHaveAttribute("data-banner", "signed_out", { timeout: 2_000 });
    await other.reload();
    await other.waitForURL(/\/login\/oauth\/authorize\?/);

    // The browser that also held tomsj switches to it; its tab says so. Its hint cookie still
    // names octo-ext until beghu answers it, and a reload lands on tomsj, not on a tab refused
    // as octo-ext.
    await expect(banner(both)).toHaveAttribute("data-banner", "switched", { timeout: 2_000 });
    await both.reload();
    await expect(account(both)).toHaveText("tomsj");
    await expect(rows(both).first()).toBeVisible();
    await expect(banner(both)).toBeHidden();
  } finally {
    await here.close();
    await elsewhere.close();
    await shared.close();
  }
});

test("a tab whose stream reopens after the account lost access asks to sign in again", async ({ page }) => {
  await signInOcto(page);
  // The tab's stream is down while beghu hears of the revoke.
  await page.route("**/api/stream**", (route) => route.abort());
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await fake("/revoke", { login: "octo-ext" });
  await untilSignedOut(page);
  await page.unroute("**/api/stream**");
  await expect(banner(page)).toHaveAttribute("data-banner", "sign_in_again", { timeout: 10_000 });
});

test("a stream something in front of beghu refuses after lost access asks to sign in again, not can't reach", async ({ page }) => {
  await signInOcto(page);
  // A proxy answers the tab's stream with a bare 401, which an EventSource can't read.
  await page.route("**/api/stream**", (route) => route.fulfill({ status: 401, body: "" }));
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await fake("/revoke", { login: "octo-ext" });
  await expect(banner(page)).toHaveAttribute("data-banner", "sign_in_again", { timeout: 10_000 });
});

test("a comment GitHub took whose answer was lost, then Disconnect, shows as maybe sent", async ({ page }) => {
  await signInOcto(page);
  const id = await octoId(page);
  const origin = new URL(page.url()).origin;
  // The last issue of octo-ext's list, left closed afterwards (as writes.spec.ts leaves those).
  const list = (await (await page.request.get("/api/issues")).json()) as { rows: { id: number; owner: string; repo: string; number: number }[] };
  const issue = list.rows.at(-1)!;
  try {
    await page.goto(`/issues/${issue.id}`);
    const composer = page.locator('[data-perf="composer"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });
    let sends = 0;
    await page.route("**/api/ops", async (r) => {
      sends += 1;
      if (sends === 1) {
        // beghu makes the write; the account is disconnected before its answer gets back.
        await r.fetch();
        const res = await page.request.post("/auth/disconnect", { form: { account: String(id) }, headers: { origin }, maxRedirects: 0 });
        expect(res.status()).toBe(303);
        await r.abort("connectionreset");
      } else await r.continue();
    });
    const text = `Sent, then disconnected ${Date.now().toString(36)}`;
    await composer.locator("textarea").fill(text);
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    // The tab's write, as it shows beside the comment GitHub posted: maybe sent, not refused.
    const mine = page.locator('[data-perf="comment"][data-op]').filter({ hasText: text });
    await expect(mine).toContainText("May or may not have been sent; check the thread", { timeout: 10_000 });
    expect(sends).toBe(2);
  } finally {
    devCtl(["fake", "edit", `${issue.owner}/${issue.repo}#${issue.number}`, "--close"]);
  }
});
