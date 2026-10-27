// Writes in a real browser: comments, close and reopen, sent through the server to Fake GitHub,
// with the pending and failed write UI the tab owns: the pending dot, no flicker back, "still
// sending…", a failed close on its row, a comment "not sent", the status slot and the GitHub
// banner.
//
// After live.spec.ts: writes change the fixture for every tab (playwright.config.ts). As in
// live.spec.ts, every issue written to sits below the default list's top 40 rows (detail.spec.ts
// relies on those) and is left closed, so it's out of the default list again.
//
// Safe side by side, and with `--repeat-each`: each test claims its own issues (claims.ts) and
// sets faults only on their endpoints, removing just those after. A test that changes or reads
// what's shared by every test takes the stack to itself (`@alone`: GitHub marked down for the
// whole server, a facet's count, the list's order), and one that makes GitHub answer 5xx takes
// turns with the others that do (`@5xx`).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, exclusive, fiveHundreds, shared, type Issue, type Row } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));


function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

let control: string;

/** The endpoints this test set faults on, to remove just those afterwards. */
const faulted = new Set<string>();

/** A call to Fake GitHub's control port, which `./dev-ctl fake` also uses. */
async function fake(path: string, body: unknown, method = "POST"): Promise<void> {
  const endpoint = (body as { endpoint?: string } | null)?.endpoint;
  if (path.startsWith("/faults/") && endpoint) faulted.add(endpoint);
  const res = await fetch(`${control}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, `${path}: ${await res.text()}`).toBe(true);
}

/** GitHub's endpoints for a comment on `i`, and for a change to `i` (close, reopen). */
const COMMENTS = (i: Issue) => `POST /repos/${i.owner}/${i.repo}/issues/${i.number}/comments`;
const ISSUE = (i: Issue) => `PATCH /repos/${i.owner}/${i.repo}/issues/${i.number}`;

const fail = (endpoint: string, status: number, count = 1, retry_after?: number) =>
  fake("/faults/fail", { endpoint, status, count, retry_after });

/** Text no other test, here or beside this one, will have used. */
const unique = (what: string) => `${what} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const rows = (page: Page) => page.locator('[data-perf="row"]');
const comments = (page: Page) => page.locator('[data-perf="comment"]');
const badge = (page: Page) => page.locator('[data-perf="badge"]');
const stateNote = (page: Page) => page.locator('[data-perf="state-note"]');
const status = (page: Page) => page.locator('[data-perf="status"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');
const box = (page: Page) => composer(page).locator("textarea");
const button = (page: Page, name: string) => composer(page).getByRole("button", { name, exact: true });
const commentSaying = (page: Page, text: string) => comments(page).filter({ hasText: text });

/** Opens `/issues/:id` and waits for the stream's opening reset to have been handled. */
async function open(page: Page, id: number): Promise<void> {
  const reset = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}` && r.ok());
  await page.goto(`/issues/${id}`);
  await reset;
  await expect(composer(page)).toBeVisible();
}

/**
 * Opens `/issues/:id` inside the app, as a click on a link to it would: unlike a page load, the
 * tab keeps its pending and failed writes.
 */
async function openInApp(page: Page, id: number): Promise<void> {
  await page.evaluate((id) => {
    const a = document.createElement("a");
    a.href = `/issues/${id}`;
    document.body.append(a);
    a.click();
    a.remove();
  }, id);
  await expect(page.locator(`[data-perf="detail"][data-id="${id}"]`)).toBeVisible();
  await expect(composer(page)).toBeVisible();
}

/**
 * Leaves `issue` closed, out of the default list, whatever the test did to it, and waits for
 * beghu to have the close (its webhook comes about a second later), so the next test doesn't
 * pick the issue again.
 */
async function closeForGood(page: Page, issue: { id: number; ref: string }): Promise<void> {
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, {
      timeout: SHOWS_WITHIN_MS,
    })
    .toBe("closed");
}

/**
 * Moves the page's clock past the 9 minutes a write is resent for, then on in steps until `gaveUp`
 * shows. A send whose answer reaches the tab after the jump waits for its next try on the page's
 * clock, which doesn't jump again by itself: without the steps that try comes a real retry-after
 * later.
 */
async function pastNineMinutes(page: Page, gaveUp: () => Promise<boolean>): Promise<void> {
  await page.clock.fastForward("09:10");
  await expect
    .poll(async () => {
      if (await gaveUp()) return true;
      await page.clock.fastForward("00:01");
      return false;
    })
    .toBe(true);
}

test.beforeAll(() => {
  control = (JSON.parse(devCtl(["status", "--json"])) as { urls: { control: string } }).urls.control;
});

let release: (() => void)[] = [];

test.beforeEach(async ({ page }, info) => {
  // Waiting for the lock isn't the test's own time: no timeout while it waits (another test
  // holding the stack alone, or the ones it waits for, can take longer than a test may), then
  // the test's own from when it has the lock.
  const own = info.timeout;
  const waiting = Date.now();
  info.setTimeout(0);
  release = [await (info.tags.includes("@alone") ? exclusive() : shared())];
  if (info.tags.includes("@5xx")) release.push(await fiveHundreds());
  info.setTimeout(own + (Date.now() - waiting));
  faulted.clear();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
});

test.afterEach(async () => {
  try {
    for (const endpoint of faulted) await fake("/faults", { endpoint }, "DELETE");
  } finally {
    for (const r of release.reverse()) r();
  }
});

/** From now on, per animation frame, whether a comment saying `text` has shown `state`; call the result to read it. */
async function watchFor(page: Page, text: string, state: string): Promise<() => Promise<boolean>> {
  await page.evaluate(
    ([text, state]) => {
      const w = window as unknown as { saw: boolean };
      w.saw = false;
      const frame = () => {
        w.saw ||= [...document.querySelectorAll('[data-perf="comment"]')].some((c) => c.textContent?.includes(text) && c.textContent.includes(state));
        if (!w.saw) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    [text, state] as const,
  );
  return () => page.evaluate(() => (window as unknown as { saw: boolean }).saw);
}

/**
 * From now on, per animation frame, how many comments in the thread say `text` and whether one of
 * them is pending; call the result to read the frames since the comment first showed.
 */
async function watchComment(page: Page, text: string): Promise<() => Promise<{ n: number; pending: boolean }[]>> {
  await page.evaluate((text) => {
    const w = window as unknown as { frames: { n: number; pending: boolean }[] };
    w.frames = [];
    const frame = () => {
      const shown = [...document.querySelectorAll('[data-perf="comment"]')].filter((c) => c.textContent?.includes(text));
      if (shown.length || w.frames.length) {
        w.frames.push({ n: shown.length, pending: shown.some((c) => c.querySelector('[data-perf="pending"]')) });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, text);
  return () => page.evaluate(() => (window as unknown as { frames: { n: number; pending: boolean }[] }).frames);
}

test("a comment shows at once as pending, then confirmed, with no flicker while the refetch is held", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    // GitHub takes its time, and every refetch of the detail is held back 2 s more.
    await fake("/faults/latency", { endpoint: COMMENTS(issue), ms: 1500 });
    await page.route(`**/api/issues/${issue.id}?through=*`, async (r) => {
      await new Promise((done) => setTimeout(done, 2000));
      await r.continue();
    });
    const text = unique("Pending then confirmed");
    const frames = await watchComment(page, text);
    await box(page).fill(text);
    await button(page, "Comment").click();

    // At once: in the thread, pending, and the box is empty again.
    const mine = commentSaying(page, text);
    await expect(mine).toHaveCount(1, { timeout: 200 });
    await expect(mine.locator('[data-perf="pending"]')).toBeVisible();
    await expect(box(page)).toHaveValue("");
    // Then GitHub has it, and a read that began after the confirmation shows the real comment.
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).toHaveCount(1);
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);

    const seen = await frames();
    expect(seen.every((f) => f.n === 1), `comments shown per frame: ${seen.map((f) => f.n).join(",")}`).toBe(true);
    // Pending first, then confirmed, and never pending again.
    const flips = seen.filter((f, i) => i > 0 && f.pending !== seen[i - 1]!.pending);
    expect(flips).toEqual([{ n: 1, pending: false }]);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a comment's Markdown shows as typed while it's sending, and rendered once GitHub has it", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  // Any other issue in its repo, to refer to.
  const q = encodeURIComponent(`is:any repo:${issue.repo}`);
  const { rows } = (await (await page.request.get(`/api/issues?q=${q}`)).json()) as { rows: Row[] };
  const other = rows.find((r) => r.id !== issue.id && r.owner === issue.owner && r.repo === issue.repo);
  if (!other) throw new Error(`no other issue in ${issue.owner}/${issue.repo}`);
  try {
    await open(page, issue.id);
    await fake("/faults/latency", { endpoint: COMMENTS(issue), ms: 1500 });
    const text = unique("Rendered");
    await box(page).fill(`${text} **bold**, after #${other.number}`);
    // Sent by its key, as the Comment button sends it.
    await box(page).press("ControlOrMeta+Enter");

    // Sending: the text as typed, with nothing parsed in the browser.
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("**bold**", { timeout: 200 });
    // GitHub has it: the server's rendering, its reference in-app.
    await expect(mine.locator("strong")).toHaveText("bold", { timeout: SHOWS_WITHIN_MS });
    await expect(mine).not.toContainText("**");
    const ref = mine.locator("a[data-ref]");
    await expect(ref).toHaveText(`#${other.number}`);
    await expect(ref).toHaveAttribute("href", `/issues/${other.id}`);
    // And the same once the thread's own read shows the comment.
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine.locator("strong")).toHaveText("bold");
    await expect(mine.locator("a[data-ref]")).toHaveAttribute("href", `/issues/${other.id}`);
  } finally {
    await closeForGood(page, issue);
  }
});

type Sent = { op_id: string; resend?: boolean };

test("a dropped connection resends the same op_id, and the comment is posted once", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const sent: Sent[] = [];
    await page.route("**/api/ops", async (r) => {
      sent.push(r.request().postDataJSON() as Sent);
      if (sent.length === 1) {
        // beghu gets it, and the answer is lost on the way back.
        await r.fetch();
        await r.abort("connectionreset");
      } else await r.continue();
    });
    const text = unique("Sent through a drop");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.op_id).toBe(sent[0]!.op_id);
    expect(sent.map((s) => s.resend ?? false)).toEqual([false, true]);
    // GitHub's own webhook for it comes and goes: still one.
    await page.waitForTimeout(2000);
    await expect(mine).toHaveCount(1);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a resend beghu has no record of shows as maybe sent, looks in the thread, and offers Retry once it isn't there", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const sent: Sent[] = [];
    await page.route("**/api/ops", async (r) => {
      sent.push(r.request().postDataJSON() as Sent);
      // The first send never arrives: to beghu, as after a restart, the resend is of nothing.
      if (sent.length === 1) await r.abort("connectionreset");
      else await r.continue();
    });
    const text = unique("Lost on the way");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("May or may not have been sent; check the thread");
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(mine.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(mine.getByRole("button", { name: "Discard" })).toBeVisible();
    expect(sent.map((s) => s.resend ?? false)).toEqual([false, true]);
    // Nothing reached GitHub: once it has looked in the thread, Retry sends it, once.
    await mine.getByRole("button", { name: "Retry" }).click({ timeout: SHOWS_WITHIN_MS });
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).not.toContainText("May or may not");
    await expect(mine).toHaveCount(1);
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a comment sent while the browser is offline didn't arrive: it's sent once the tab is back online", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await page.context().setOffline(true);
    const text = unique("Written offline");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toBeVisible();
    await page.waitForTimeout(2500);
    await page.context().setOffline(false);
    // Not "lost": no send while offline reached beghu, so the next one isn't a resend.
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).not.toContainText("May or may not");
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await page.context().setOffline(false);
    await closeForGood(page, issue);
  }
});

test("a comment GitHub posted but whose answer was lost finds itself in the thread and settles as posted", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    // GitHub posts it, and its 201 comes back cut short.
    await fake("/faults/rewrite", { endpoint: COMMENTS(issue), raw: "{" });
    const text = unique("Posted, its answer unreadable");
    // Watched every frame: the server's answer can take seconds on a loaded machine, and once it
    // has come, the first look in the thread may find the comment at once, so the state can
    // last a frame.
    const sawMaybe = await watchFor(page, text, "May have been posted");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect.poll(sawMaybe, { timeout: SHOWS_WITHIN_MS }).toBe(true);
    // Its webhook may bring the real comment first, beside it, for a moment.
    await expect(mine.filter({ hasText: "May have been posted" })).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).toHaveCount(1);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0);
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await closeForGood(page, issue);
  }
});

/** As on a page served over plain http from a LAN address: no `crypto.subtle` to hash with. */
async function withoutSubtleCrypto(page: Page): Promise<void> {
  await page.addInitScript(() => Object.defineProperty(crypto, "subtle", { value: undefined }));
}

test("without crypto.subtle, a comment GitHub posted but whose answer was lost still finds itself in the thread", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await withoutSubtleCrypto(page);
    await open(page, issue.id);
    expect(await page.evaluate(() => crypto.subtle)).toBeUndefined();
    await fake("/faults/rewrite", { endpoint: COMMENTS(issue), raw: "{" });
    const text = unique("Posted, unhashed");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("May have been posted");
    // The server named its digest: no hashing needed to find it.
    await expect(mine.filter({ hasText: "May have been posted" })).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).toHaveCount(1);
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await closeForGood(page, issue);
  }
});

test("without crypto.subtle, a write beghu never answered can't look for itself, so it never offers Retry", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await withoutSubtleCrypto(page);
    await page.clock.install();
    await open(page, issue.id);
    await page.route("**/api/ops", (r) => r.abort("connectionreset"));
    const text = unique("Never answered, unhashed");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await page.clock.fastForward("09:10");
    await expect(mine).toContainText("May or may not have been sent; check the thread");
    // Past every look in the thread (each scheduled once the last one's read is back): whether it
    // was posted stays unknown, and Retry could post it twice.
    for (let i = 0; i < 4; i++) {
      await page.clock.fastForward("00:03");
      await page.waitForTimeout(500);
    }
    await expect(mine.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(mine.getByRole("button", { name: "Discard" })).toBeVisible();
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a second +1 GitHub fails on never takes the first one for itself: it offers Retry", { tag: "@5xx" }, async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const text = unique("+1");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).toHaveCount(1);
    // The same text again, and GitHub fails on it without posting it.
    await fail(COMMENTS(issue), 502);
    await box(page).fill(text);
    await button(page, "Comment").click();
    const unsure = mine.filter({ hasText: "May have been posted" });
    await expect(unsure).toHaveCount(1);
    await expect(unsure.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await expect(mine).toHaveCount(2);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a maybe-posted comment two newer comments could be stays unsure, with Retry", { tag: "@5xx" }, async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const text = unique("Said twice");
    const said = async () => {
      const res = await page.request.get(`/api/issues/${issue.id}/comments?order=newest`);
      // A one-line comment renders to one paragraph.
      const said = JSON.stringify([["p", 0, text]]);
      return ((await res.json()) as { comments: { body: unknown }[] }).comments.filter((c) => JSON.stringify(c.body) === said).length;
    };
    await fail(COMMENTS(issue), 502);
    await page.route("**/api/ops", async (r) => {
      const res = await r.fetch();
      // After GitHub failed on it, two comments with its text by the same account land.
      devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "tomsj"]);
      devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "tomsj"]);
      await expect.poll(said, { timeout: SHOWS_WITHIN_MS }).toBe(2);
      await r.fulfill({ response: res });
    });
    await box(page).fill(text);
    await button(page, "Comment").click();
    const unsure = commentSaying(page, text).filter({ hasText: "May have been posted" });
    await expect(unsure.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 20_000 });
    await expect(unsure).toHaveCount(1);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write whose 2xx answer comes back cut short is resent, and joins the write beghu made", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const sent: Sent[] = [];
    await page.route("**/api/ops", async (r) => {
      sent.push(r.request().postDataJSON() as Sent);
      if (sent.length === 1) {
        // beghu posts it; its answer is cut short on the way back.
        await r.fetch();
        await r.fulfill({ status: 200, contentType: "application/json", body: '{"issue": 1, "comm' });
      } else await r.continue();
    });
    const text = unique("Answer cut short");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).not.toContainText("Not sent");
    expect(sent.map((s) => s.resend ?? false)).toEqual([false, true]);
    expect(sent[1]!.op_id).toBe(sent[0]!.op_id);
    await page.waitForTimeout(2000);
    await expect(mine).toHaveCount(1);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write whose answer a proxy drops without a body is resent, not failed", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const sent: Sent[] = [];
    await page.route("**/api/ops", async (r) => {
      sent.push(r.request().postDataJSON() as Sent);
      if (sent.length === 1) {
        // beghu gets it; the proxy in front times out and answers 408 with no body.
        await r.fetch();
        await r.fulfill({ status: 408, body: "" });
      } else await r.continue();
    });
    const text = unique("Through a proxy timeout");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).not.toContainText("Not sent");
    expect(sent.map((s) => s.resend ?? false)).toEqual([false, true]);
    expect(sent[1]!.op_id).toBe(sent[0]!.op_id);
    await page.waitForTimeout(2000);
    await expect(mine).toHaveCount(1);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a comment longer than GitHub takes can't be typed, and one that gets through is refused with no Retry", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await expect(box(page)).toHaveAttribute("maxlength", "65536");
    // One the box let through all the same (another client, an older tab): beghu's 400 says why.
    await page.route("**/api/ops", async (r) => {
      const req = r.request().postDataJSON() as { op: { body: string } };
      req.op.body = "x".repeat(65_537);
      await r.continue({ postData: JSON.stringify(req) });
    });
    const text = unique("Too long");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("Not sent — A comment can be at most 65,536 characters long, as on GitHub");
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(mine.getByRole("button", { name: "Edit" })).toBeVisible();
  } finally {
    await closeForGood(page, issue);
  }
});

test("a comment GitHub fails on may have been posted: it says to check the thread, and offers Retry once it isn't there", { tag: "@5xx" }, async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(COMMENTS(issue), 502);
    const text = unique("Maybe posted");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("May have been posted; check the thread");
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
    // It looks in the thread: not there, so Retry.
    await expect(mine.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    // Edit puts the text back, for the user to send again.
    await mine.getByRole("button", { name: "Edit" }).click();
    await expect(box(page)).toHaveValue(text);
    await expect(box(page)).toBeFocused();
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write beghu doesn't answer for 9 minutes stops being resent and shows as maybe sent", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await page.clock.install();
    await open(page, issue.id);
    let sends = 0;
    await page.route("**/api/ops", async (r) => {
      sends++;
      await r.abort("connectionreset");
    });
    const text = unique("Never answered");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect.poll(() => sends).toBeGreaterThan(0);
    const maybeSent = "May or may not have been sent; check the thread";
    await pastNineMinutes(page, async () => (await mine.allTextContents()).some((t) => t.includes(maybeSent)));
    await expect(mine).toContainText(maybeSent);
    const after = sends;
    await page.clock.fastForward("01:00");
    await page.waitForTimeout(500);
    expect(sends).toBe(after);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write beghu keeps turning away as busy stops after 9 minutes and fails with Retry", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await page.clock.install();
    await open(page, issue.id);
    let sends = 0;
    await page.route("**/api/ops", async (r) => {
      sends++;
      await r.fulfill({
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
        body: JSON.stringify({ error: "unavailable", message: "beghu is restarting" }),
      });
    });
    await button(page, "Close issue").click();
    await expect.poll(() => sends).toBeGreaterThan(0);
    // beghu never started it: not lost, just not sent.
    const notSent = "Couldn't close — beghu was busy, so this change wasn't sent";
    await pastNineMinutes(page, async () => (await stateNote(page).allTextContents()).some((t) => t.includes(notSent)));
    await expect(stateNote(page)).toContainText(notSent);
    await expect(stateNote(page).getByRole("button", { name: "Retry" })).toBeVisible();
    const after = sends;
    await page.clock.fastForward("01:00");
    await page.waitForTimeout(500);
    expect(sends).toBe(after);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a close GitHub refuses reverts with Retry and Dismiss on its row, and Retry closes it", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(ISSUE(issue), 403);
    await button(page, "Close issue").click();
    // The role allows it: GitHub just didn't apply it.
    await expect(stateNote(page)).toContainText("Couldn't close — GitHub didn't apply this change");
    await expect(badge(page)).toHaveText("Open");
    // Its row only: not the status slot, which is for issues that aren't open.
    await expect(status(page)).not.toContainText("Couldn't");

    await stateNote(page).getByRole("button", { name: "Retry" }).click();
    await expect(badge(page)).toHaveText("Closed");
    await expect(stateNote(page)).not.toContainText("Couldn't");
    await expect(button(page, "Reopen issue")).toBeEnabled({ timeout: 5000 });
  } finally {
    await closeForGood(page, issue);
  }
});

test("the close/reopen key closes the open issue as completed, and then reopens it, as the buttons do", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    // The issue's write keys need the focus in it.
    await page.keyboard.press("o");
    await page.keyboard.press("Shift+X");
    await expect(badge(page)).toHaveText("Closed");
    await expect(button(page, "Reopen issue")).toBeEnabled({ timeout: 5000 });
    await page.keyboard.press("Shift+X");
    await expect(badge(page)).toHaveText("Open");
    await expect(button(page, "Close issue")).toBeEnabled({ timeout: 5000 });
  } finally {
    await closeForGood(page, issue);
  }
});

test("a comment GitHub refuses stays in the thread as not sent, with Retry, Edit and Discard", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(COMMENTS(issue), 422, 2);
    const text = unique("Refused at first");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("Not sent — GitHub couldn't apply this change");

    // Edit puts the text back in the box.
    await mine.getByRole("button", { name: "Edit" }).click();
    await expect(mine).toHaveCount(0);
    await expect(box(page)).toHaveValue(text);
    await button(page, "Comment").click();
    await expect(mine).toContainText("Not sent");
    // Discard drops it.
    await mine.getByRole("button", { name: "Discard" }).click();
    await expect(mine).toHaveCount(0);

    // Retry sends it again, and GitHub takes it this time.
    await box(page).fill(text);
    await fail(COMMENTS(issue), 422);
    await button(page, "Comment").click();
    await expect(mine).toContainText("Not sent");
    await mine.getByRole("button", { name: "Retry" }).click();
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(mine).not.toContainText("Not sent");
    await expect(mine).toHaveCount(1);
  } finally {
    await closeForGood(page, issue);
  }
});

test("after 3 GitHub 5xx in a row, one close's tries, the banner pauses writes and keeps the text, until GitHub is back", { tag: "@alone" }, async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    // One close meets a 500, and so do both its retries.
    await fail(ISSUE(issue), 500, 3);
    await button(page, "Close issue").click();
    const banner = page.locator('[data-perf="banner"]');
    await expect(banner).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(stateNote(page)).toContainText("Couldn't close");
    const text = unique("Kept while GitHub is down");
    await box(page).fill(text);
    await expect(button(page, "Comment")).toBeDisabled();
    await expect(button(page, "Close issue")).toBeDisabled();
    await expect(composer(page).getByRole("button", { name: "More ways to close" })).toBeDisabled();
    await expect(box(page)).toHaveValue(text);

    // The server probes GitHub every 10 s: one probe, and room for a stalled machine.
    await expect(banner).toBeHidden({ timeout: 10_000 + SHOWS_WITHIN_MS });
    await expect(button(page, "Comment")).toBeEnabled();
    await expect(box(page)).toHaveValue(text);
    await composer(page).getByRole("button", { name: "More ways to close" }).click();
    await composer(page).getByRole("menuitem", { name: "Close as completed" }).click();
    await expect(badge(page)).toHaveText("Closed");
  } finally {
    await closeForGood(page, issue);
  }
});

test("failures on issues that aren't open show in the status slot with Retry and Open", async ({ page }) => {
  const [first, second] = [await claimBelowTheTop(page), await claimBelowTheTop(page)];
  try {
    for (const issue of [first!, second!]) await fail(ISSUE(issue), 403);
    for (const issue of [first!, second!]) {
      await openInApp(page, issue.id);
      await button(page, "Close issue").click();
      await expect(stateNote(page)).toContainText("Couldn't close");
    }
    // On the second issue, the first one's failure is off screen.
    await expect(status(page)).toContainText(`Couldn't close ${first!.repo}#${first!.number}`);
    // Back to the list: both collapse to a count, which opens the list of them.
    await page.getByRole("link", { name: "Close the issue" }).click();
    await status(page).getByRole("button", { name: "2 changes failed" }).click();
    const failures = page.locator('[data-perf="failure"]');
    await expect(failures).toHaveCount(2);
    await failures.filter({ hasText: `${second!.repo}#${second!.number}` }).getByRole("link", { name: "Open" }).click();
    await expect(page).toHaveURL(new RegExp(`/issues/${second!.id}$`));
    await expect(stateNote(page)).toContainText("Couldn't close");
    // The open issue's failure is on its row; the other one is in the slot.
    await expect(status(page)).toContainText(`Couldn't close ${first!.repo}#${first!.number}`);
    await status(page).getByRole("button", { name: "Retry" }).click();
    await expect(status(page)).not.toContainText("Couldn't", { timeout: 5000 });
    await stateNote(page).getByRole("button", { name: "Retry" }).click();
    await expect(badge(page)).toHaveText("Closed");
  } finally {
    await closeForGood(page, first!);
    await closeForGood(page, second!);
  }
});

test("a failure in the status slot collapses the quiet states behind an icon that shows them", async ({ page }) => {
  const [first, second] = [await claimBelowTheTop(page), await claimBelowTheTop(page)];
  try {
    await fail(ISSUE(first!), 403);
    await openInApp(page, first!.id);
    await button(page, "Close issue").click();
    await expect(stateNote(page)).toContainText("Couldn't close");
    await openInApp(page, second!.id);
    await expect(status(page)).toContainText(`Couldn't close ${first!.repo}#${first!.number}`);
    // A write on its way: the failure stays, and the sending state is behind its icon.
    await fake("/faults/latency", { endpoint: COMMENTS(second!), ms: 4000 });
    const text = unique("Sent beside a failure");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const icon = status(page).getByRole("button", { name: "sending 1 change…" });
    await expect(icon).toBeVisible();
    await expect(status(page)).toContainText(`Couldn't close ${first!.repo}#${first!.number}`);
    // The status slot is a live region: the quiet state is in its text, for screen readers.
    await expect(status(page)).toContainText("sending 1 change…");
    // A target of at least 24 px.
    const target = (await icon.boundingBox())!;
    expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(24);
    await icon.click();
    await expect(status(page)).toContainText("sending 1 change…");
    await expect(commentSaying(page, text).locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(icon).toHaveCount(0);
  } finally {
    await closeForGood(page, first!);
    await closeForGood(page, second!);
  }
});

test("a failure in the status slot never times out", async ({ page }) => {
  const [first, second] = [await claimBelowTheTop(page), await claimBelowTheTop(page)];
  try {
    await page.clock.install();
    await fail(ISSUE(first!), 403);
    await openInApp(page, first!.id);
    await button(page, "Close issue").click();
    await expect(stateNote(page)).toContainText("Couldn't close");
    await openInApp(page, second!.id);
    const line = `Couldn't close ${first!.repo}#${first!.number}`;
    await expect(status(page)).toContainText(line);
    await page.clock.fastForward("30:00");
    await expect(status(page)).toContainText(line);
  } finally {
    await closeForGood(page, first!);
    await closeForGood(page, second!);
  }
});

test("a rate limit longer than beghu waits out says when to try again", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(ISSUE(issue), 429, 1, 60);
    await button(page, "Close issue").click();
    await expect(stateNote(page)).toContainText("Couldn't close — GitHub's rate limit: try again in 60 s");
    await expect(badge(page)).toHaveText("Open");
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write with no answer for 15 s shows still sending, with no Retry, then lands", async ({ page }) => {
  test.slow();
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    // GitHub holds the comment 22 s: past the tab's 15 s, with room for a loaded machine to show
    // "still sending…" before it lands, and inside the server's 30 s for a write.
    await fake("/faults/latency", { endpoint: COMMENTS(issue), ms: 22_000 });
    const text = unique("Slow to send");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(status(page)).toHaveText("sending 1 change…");
    await expect(mine).toContainText("still sending…", { timeout: 20_000 });
    await expect(status(page)).toHaveText("still sending…");
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(mine).not.toContainText("still sending");
  } finally {
    await closeForGood(page, issue);
  }
});

test("a pending close shows on its row but never moves, adds or removes a row", { tag: "@alone" }, async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    // An issue on screen in the list: scroll it into the list's window.
    await page.goto(`/issues/${issue.id}`);
    await expect(composer(page)).toBeVisible();
    // No more pages from here on: a scroll near the end of the loaded rows loads the next page,
    // which adds rows whenever it lands, before or after the count below is read.
    await page.route("**/api/issues?*after=*", () => new Promise<void>(() => {}));
    const row = page.locator(`[data-perf="row"][data-id="${issue.id}"]`);
    // The list renders only the rows in its window: bring the issue's row into it (34 px rows).
    await page.locator('[data-perf="list"]').evaluate((el, y) => el.scrollTo(0, y), issue.index * 34 - 100);
    await expect(row).toBeVisible();
    const order = () => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));
    const before = await order();
    const count = await page.locator('[data-perf="list"]').getAttribute("data-perf-rows");

    await fake("/faults/latency", { endpoint: ISSUE(issue), ms: 3000 });
    await button(page, "Close issue").click();
    await expect(row.getByRole("img", { name: "Closed as completed" })).toBeVisible();
    await expect(badge(page)).toHaveText("Closed");
    expect(await order()).toEqual(before);
    await expect(page.locator('[data-perf="list"]')).toHaveAttribute("data-perf-rows", count!);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await closeForGood(page, issue);
  }
});

test("a pending comment changes no search's rows or their matched icons", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  const word = `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try {
    devCtl(["fake", "edit", issue.ref, "--title", `Searched for ${word}`]);
    await page.goto(`/issues/${issue.id}?q=` + encodeURIComponent(`is:open ${word}`));
    await expect(composer(page)).toBeVisible();
    const row = page.locator(`[data-perf="row"][data-id="${issue.id}"]`);
    const matched = row.locator('[data-perf="matched"]');
    await expect(matched).toHaveAttribute("data-fields", "title", { timeout: SHOWS_WITHIN_MS });
    await expect(rows(page)).toHaveCount(1);

    // A comment with the word, held at GitHub: pending in the thread, and the row as it was.
    await fake("/faults/latency", { endpoint: COMMENTS(issue), ms: 3000 });
    const text = `Pending ${word}`;
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await expect(matched).toHaveAttribute("data-fields", "title");
      await expect(rows(page)).toHaveCount(1);
      await page.waitForTimeout(200);
    }
    await expect(mine.locator('[data-perf="pending"]')).toBeVisible();
  } finally {
    await closeForGood(page, issue);
  }
});

test("a pending close changes no facet's count", { tag: "@alone" }, async ({ page }) => {
  // Spec #86: ops never change list membership, order or facet counts. The default view is
  // `is:open`, so a close, once GitHub has it, takes the issue out of its label's count; while
  // it's pending the count stays as the server has it.
  const issue = await claimBelowTheTop(page, (r) => r.labels.some((l) => /^[\w-]+$/.test(l.name)));
  const label = issue.labels.find((l) => /^[\w-]+$/.test(l.name))!.name;
  const filter = page.getByRole("combobox", { name: "Filter issues" });
  /** The label's count in the open view, as the filter bar's suggestions show it. */
  const labelCount = async () => {
    await filter.click();
    await filter.press("End");
    await filter.pressSequentially(` label:${label}`);
    const option = page
      .getByRole("listbox", { name: "Suggestions" })
      .getByRole("option", { name: new RegExp(`label:${label}\\b`) })
      .first();
    const count = option.locator('[data-perf="count"]');
    await expect(count).toHaveText(/^[\d,]+$/);
    return count.textContent();
  };
  try {
    await page.goto(`/issues/${issue.id}`);
    await expect(composer(page)).toBeVisible();
    const before = await labelCount();
    // Back to the issue with the filter as the URL has it.
    await page.goto(`/issues/${issue.id}`);
    await expect(composer(page)).toBeVisible();
    const row = page.locator(`[data-perf="row"][data-id="${issue.id}"]`);
    await page.locator('[data-perf="list"]').evaluate((el, y) => el.scrollTo(0, y), issue.index * 34 - 100);
    await expect(row).toBeVisible();

    await fake("/faults/latency", { endpoint: ISSUE(issue), ms: 8000 });
    await button(page, "Close issue").click();
    await expect(row.getByRole("img", { name: "Closed as completed" })).toBeVisible();
    expect(await labelCount()).toBe(before);
    // Still pending: GitHub hasn't had the close yet, so the server still has the issue open.
    const now = (await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string };
    expect(now.state).toBe("open");
  } finally {
    await closeForGood(page, issue);
  }
});

test("leaving asks first only while there's unsaved text", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  for (const unsaved of [false, true]) {
    await open(page, issue.id);
    if (unsaved) await box(page).fill("Half a thought");
    // A click first: browsers only ask on pages the user has interacted with.
    await box(page).click();
    let asked = false;
    const onDialog = (d: { type(): string; accept(): Promise<void> }) => {
      asked ||= d.type() === "beforeunload";
      void d.accept();
    };
    page.on("dialog", onDialog);
    await page.goto("about:blank");
    page.off("dialog", onDialog);
    expect(asked).toBe(unsaved);
  }
});
