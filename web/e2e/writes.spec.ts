// Writes in a real browser: comments, close and reopen, sent through the server to Fake GitHub,
// with the pending and failed write UI the tab owns: the pending dot, no flicker back, "still
// sending…", a failed close on its row, a comment "not sent", the status slot and the GitHub
// banner.
//
// Serial, after live.spec.ts: writes change the fixture for every tab, and faults are global to
// the stack (playwright.config.ts). As in live.spec.ts, every issue written to sits below the
// default list's top 40 rows (detail.spec.ts relies on those) and is left closed, so it's out of
// the default list again.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

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

const COMMENTS = "POST /repos/*/*/issues/*/comments";
const ISSUE = "PATCH /repos/*/*/issues/*";

const fail = (endpoint: string, status: number, count = 1, retry_after?: number) =>
  fake("/faults/fail", { endpoint, status, count, retry_after });

const unique = (what: string) => `${what} ${Date.now().toString(36)}`;

const rows = (page: Page) => page.locator('[data-perf="row"]');
const comments = (page: Page) => page.locator('[data-perf="comment"]');
const badge = (page: Page) => page.locator('[data-perf="badge"]');
const stateNote = (page: Page) => page.locator('[data-perf="state-note"]');
const status = (page: Page) => page.locator('[data-perf="status"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');
const box = (page: Page) => composer(page).locator("textarea");
const button = (page: Page, name: string) => composer(page).getByRole("button", { name, exact: true });
const commentSaying = (page: Page, text: string) => comments(page).filter({ hasText: text });

type Row = { id: number; owner: string; repo: string; number: number; comments: number; state: string; labels: { name: string }[] };

/**
 * Open issues below the default list's top 40 rows, with 1 to 15 comments (one page), and where
 * each sits in the list.
 */
async function issuesBelowTheTop(page: Page): Promise<(Row & { ref: string; index: number })[]> {
  const all: Row[] = [];
  let after: string | null = null;
  do {
    const res = await page.request.get(after ? `/api/issues?after=${after}` : "/api/issues");
    const p = (await res.json()) as { rows: Row[]; next: string | null };
    all.push(...p.rows);
    after = p.next;
  } while (after && all.length < 200);
  return all
    .map((r, index) => ({ ...r, index, ref: `${r.owner}/${r.repo}#${r.number}` }))
    .slice(40)
    .filter((r) => r.comments >= 1 && r.comments <= 15);
}

async function issueBelowTheTop(page: Page): Promise<Row & { ref: string; index: number }> {
  return (await issuesBelowTheTop(page))[0]!;
}

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
    .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, { timeout: 10_000 })
    .toBe("closed");
}

test.beforeAll(() => {
  control = (JSON.parse(devCtl(["status", "--json"])) as { urls: { control: string } }).urls.control;
});

test.beforeEach(async ({ page }) => {
  await fake("/faults", {}, "DELETE");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
});

test.afterEach(async () => {
  await fake("/faults", {}, "DELETE");
});

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
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    // GitHub takes its time, and every refetch of the detail is held back 2 s more.
    await fake("/faults/latency", { endpoint: COMMENTS, ms: 1500 });
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
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
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

type Sent = { op_id: string; resend?: boolean };

test("a dropped connection resends the same op_id, and the comment is posted once", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
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
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
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
  const issue = await issueBelowTheTop(page);
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
    await mine.getByRole("button", { name: "Retry" }).click({ timeout: 10_000 });
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(mine).not.toContainText("May or may not");
    await expect(mine).toHaveCount(1);
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a comment sent while the browser is offline didn't arrive: it's sent once the tab is back online", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
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
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(mine).not.toContainText("May or may not");
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await page.context().setOffline(false);
    await closeForGood(page, issue);
  }
});

test("a comment GitHub posted but whose answer was lost finds itself in the thread and settles as posted", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    // GitHub posts it, and its 201 comes back cut short.
    await fake("/faults/rewrite", { endpoint: COMMENTS, raw: "{" });
    const text = unique("Posted, its answer unreadable");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("May have been posted");
    // Its webhook may bring the real comment first, beside it, for a moment.
    await expect(mine.filter({ hasText: "May have been posted" })).toHaveCount(0, { timeout: 10_000 });
    await expect(mine).toHaveCount(1);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0);
    expect(Number(await mine.getAttribute("data-id"))).toBeGreaterThan(0);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a second +1 GitHub fails on never takes the first one for itself: it offers Retry", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    const text = unique("+1");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(mine).toHaveCount(1);
    // The same text again, and GitHub fails on it without posting it.
    await fail(COMMENTS, 502);
    await box(page).fill(text);
    await button(page, "Comment").click();
    const unsure = mine.filter({ hasText: "May have been posted" });
    await expect(unsure).toHaveCount(1);
    await expect(unsure.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 10_000 });
    await expect(mine).toHaveCount(2);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a maybe-posted comment two newer comments could be stays unsure, with Retry", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    const text = unique("Said twice");
    const said = async () => {
      const res = await page.request.get(`/api/issues/${issue.id}/comments?order=newest`);
      return ((await res.json()) as { comments: { body: string }[] }).comments.filter((c) => c.body === text).length;
    };
    await fail(COMMENTS, 502);
    await page.route("**/api/ops", async (r) => {
      const res = await r.fetch();
      // After GitHub failed on it, two comments with its text by the same account land.
      devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "tomsj"]);
      devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "tomsj"]);
      await expect.poll(said, { timeout: 10_000 }).toBe(2);
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
  const issue = await issueBelowTheTop(page);
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
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
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
  const issue = await issueBelowTheTop(page);
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
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
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
  const issue = await issueBelowTheTop(page);
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

test("a comment GitHub fails on may have been posted: it says to check the thread, and offers Retry once it isn't there", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(COMMENTS, 502);
    const text = unique("Maybe posted");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(mine).toContainText("May have been posted; check the thread");
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
    // It looks in the thread: not there, so Retry.
    await expect(mine.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 10_000 });
    // Edit puts the text back, for the user to send again.
    await mine.getByRole("button", { name: "Edit" }).click();
    await expect(box(page)).toHaveValue(text);
    await expect(box(page)).toBeFocused();
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write beghu doesn't answer for 9 minutes stops being resent and shows as maybe sent", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
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
    await page.clock.fastForward("09:10");
    await expect(mine).toContainText("May or may not have been sent; check the thread");
    const after = sends;
    await page.clock.fastForward("01:00");
    await page.waitForTimeout(500);
    expect(sends).toBe(after);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write beghu keeps turning away as busy stops after 9 minutes and fails with Retry", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
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
    await page.clock.fastForward("09:10");
    // beghu never started it: not lost, just not sent.
    await expect(stateNote(page)).toContainText("Couldn't close — beghu was busy, so this change wasn't sent");
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
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(ISSUE, 403);
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

test("a comment GitHub refuses stays in the thread as not sent, with Retry, Edit and Discard", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(COMMENTS, 422, 2);
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
    await fail(COMMENTS, 422);
    await button(page, "Comment").click();
    await expect(mine).toContainText("Not sent");
    await mine.getByRole("button", { name: "Retry" }).click();
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(mine).not.toContainText("Not sent");
    await expect(mine).toHaveCount(1);
  } finally {
    await closeForGood(page, issue);
  }
});

test("after 3 GitHub 5xx in a row, one close's tries, the banner pauses writes and keeps the text, until GitHub is back", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    // One close meets a 500, and so do both its retries.
    await fail(ISSUE, 500, 3);
    await button(page, "Close issue").click();
    const banner = page.locator('[data-perf="banner"]');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toHaveAttribute("role", "alert");
    await expect(stateNote(page)).toContainText("Couldn't close");
    const text = unique("Kept while GitHub is down");
    await box(page).fill(text);
    await expect(button(page, "Comment")).toBeDisabled();
    await expect(button(page, "Close issue")).toBeDisabled();
    await expect(composer(page).getByRole("button", { name: "More ways to close" })).toBeDisabled();
    await expect(box(page)).toHaveValue(text);

    // The server probes GitHub every 10 s.
    await expect(banner).toBeHidden({ timeout: 15_000 });
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
  const [first, second] = await issuesBelowTheTop(page);
  try {
    await fail(ISSUE, 403, 2);
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
  const [first, second] = await issuesBelowTheTop(page);
  try {
    await fail(ISSUE, 403);
    await openInApp(page, first!.id);
    await button(page, "Close issue").click();
    await expect(stateNote(page)).toContainText("Couldn't close");
    await openInApp(page, second!.id);
    await expect(status(page)).toContainText(`Couldn't close ${first!.repo}#${first!.number}`);
    // A write on its way: the failure stays, and the sending state is behind its icon.
    await fake("/faults/latency", { endpoint: COMMENTS, ms: 4000 });
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
    await expect(commentSaying(page, text).locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(icon).toHaveCount(0);
  } finally {
    await closeForGood(page, first!);
    await closeForGood(page, second!);
  }
});

test("a failure in the status slot never times out", async ({ page }) => {
  const [first, second] = await issuesBelowTheTop(page);
  try {
    await page.clock.install();
    await fail(ISSUE, 403);
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
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fail(ISSUE, 429, 1, 60);
    await button(page, "Close issue").click();
    await expect(stateNote(page)).toContainText("Couldn't close — GitHub's rate limit: try again in 60 s");
    await expect(badge(page)).toHaveText("Open");
  } finally {
    await closeForGood(page, issue);
  }
});

test("a write with no answer for 15 s shows still sending, with no Retry, then lands", async ({ page }) => {
  test.slow();
  const issue = await issueBelowTheTop(page);
  try {
    await open(page, issue.id);
    await fake("/faults/latency", { endpoint: COMMENTS, ms: 17_000 });
    const text = unique("Slow to send");
    await box(page).fill(text);
    await button(page, "Comment").click();
    const mine = commentSaying(page, text);
    await expect(status(page)).toHaveText("sending 1 change…");
    await expect(mine).toContainText("still sending…", { timeout: 16_000 });
    await expect(status(page)).toHaveText("still sending…");
    await expect(mine.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(mine).not.toContainText("still sending");
  } finally {
    await closeForGood(page, issue);
  }
});

test("a pending close shows on its row but never moves, adds or removes a row", async ({ page }) => {
  const issue = await issueBelowTheTop(page);
  try {
    // An issue on screen in the list: scroll it into the list's window.
    await page.goto(`/issues/${issue.id}`);
    await expect(composer(page)).toBeVisible();
    const row = page.locator(`[data-perf="row"][data-id="${issue.id}"]`);
    // The list renders only the rows in its window: bring the issue's row into it (34 px rows).
    await page.locator('[data-perf="list"]').evaluate((el, y) => el.scrollTo(0, y), issue.index * 34 - 100);
    await expect(row).toBeVisible();
    const order = () => rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-id")));
    const before = await order();
    const count = await page.locator('[data-perf="list"]').getAttribute("data-perf-rows");

    await fake("/faults/latency", { endpoint: ISSUE, ms: 3000 });
    await button(page, "Close issue").click();
    await expect(row.getByRole("img", { name: "Closed as completed" })).toBeVisible();
    await expect(badge(page)).toHaveText("Closed");
    expect(await order()).toEqual(before);
    await expect(page.locator('[data-perf="list"]')).toHaveAttribute("data-perf-rows", count!);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a pending close changes no facet's count", async ({ page }) => {
  // Spec #86: ops never change list membership, order or facet counts. The default view is
  // `is:open`, so a close, once GitHub has it, takes the issue out of its label's count; while
  // it's pending the count stays as the server has it.
  const issue = (await issuesBelowTheTop(page)).find((r) => r.labels.some((l) => /^[\w-]+$/.test(l.name)))!;
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

    await fake("/faults/latency", { endpoint: ISSUE, ms: 8000 });
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
  const issue = await issueBelowTheTop(page);
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
