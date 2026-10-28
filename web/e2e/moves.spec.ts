// The rare GitHub events, in a real browser: the open issue deleted or transferred under the
// user, an issue converted to a discussion, a label renamed. Each is made on Fake GitHub with
// `./dev-ctl fake`, whose webhooks bring it, as GitHub's would.
//
// Last, on one worker (playwright.config.ts): a delete or a transfer takes a fixture issue away
// until `./dev-ctl reset`, and a rename reaches every row carrying the label.
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, type Row } from "./claims";
import { recordPushes, SHOWS_WITHIN_MS, timeFromPush } from "./push";
import { devCtl } from "./stack";

const rows = (page: Page) => page.locator('[data-perf="row"]');
const detail = (page: Page) => page.locator('[data-perf="detail"]');
const lost = (page: Page) => page.locator('[data-perf="detail-lost"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');

/** Signed in as tomsj, with the stream's opening refetch done. */
async function signIn(page: Page): Promise<void> {
  await recordPushes(page);
  const live = page.waitForResponse((r) => r.url().includes("through=") && r.ok());
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await live;
  await expect(rows(page).first()).toBeVisible();
}

/** Opens `/issues/:id` inside the app, as a click on a link to it would. */
async function open(page: Page, id: number): Promise<void> {
  await page.evaluate((id) => {
    const a = document.createElement("a");
    a.href = `/issues/${id}`;
    document.body.append(a);
    a.click();
    a.remove();
  }, id);
  await expect(detail(page)).toHaveAttribute("data-id", String(id));
}

const ref = (i: { repo: string; number: number }) => `${i.repo}#${i.number}`;

test("a deleted open issue says so in place, and its draft stays to copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  const issue = await claimBelowTheTop(page);
  await open(page, issue.id);
  // A comment GitHub confirmed is posted, not unsent text: it isn't kept with the draft, even
  // when the issue is deleted before any read of it shows the comment (the detail's reads from
  // the confirmation on are held until then, and answer that the issue is gone).
  const detailPath = new URL(`/api/issues/${issue.id}`, page.url()).pathname;
  let heldRead = false;
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route(
    (u) => u.pathname === detailPath,
    async (route) => {
      heldRead = true;
      await released;
      await route.continue();
    },
  );
  const posted = `Already said ${Date.now().toString(36)}`;
  await composer(page).locator("textarea").fill(posted);
  await composer(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect.poll(() => heldRead, { timeout: SHOWS_WITHIN_MS }).toBe(true);
  const draft = `Half a thought I'd rather not lose ${Date.now().toString(36)}`;
  await composer(page).locator("textarea").fill(draft);

  devCtl(["fake", "edit", ref(issue), "--delete"]);
  await expect.poll(async () => (await page.request.get(detailPath)).status(), { timeout: SHOWS_WITHIN_MS }).toBe(410);
  release();
  await expect(lost(page).getByText("This issue was deleted.", { exact: true })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
  const kept = lost(page).locator('[data-perf="kept-text"] textarea');
  // Only the draft: not the comment GitHub confirmed.
  await expect(kept).toHaveValue(draft);
  await lost(page).getByRole("button", { name: "Copy your text" }).click();
  await expect(lost(page).getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(draft);
});

test("a deleted open issue keeps an open description editor's text to copy", async ({ page }) => {
  await signIn(page);
  const issue = await claimBelowTheTop(page);
  await open(page, issue.id);
  await page.locator('[data-perf="edit-body"]').click();
  const box = page.locator('[data-perf="body-editor"] [data-perf="edit-box"]');
  // The editor's first opening loads its code (compiled on demand by the dev server) and the body.
  await expect(box).toBeFocused({ timeout: 15_000 });
  const mine = `A description I was halfway through ${Date.now().toString(36)}`;
  await box.fill(mine);

  devCtl(["fake", "edit", ref(issue), "--delete"]);
  await expect(lost(page).getByText("This issue was deleted.", { exact: true })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
  await expect(lost(page).locator('[data-perf="kept-text"] textarea')).toHaveValue(mine);
});

test("an open issue transferred to another synced repo says where it went, and opens there with its links", async ({ page }) => {
  await signIn(page);
  const issue = await claimBelowTheTop(page, (r) => r.repo === "web");
  const other = await claimBelowTheTop(page, (r) => r.repo === "api");
  devCtl(["fake", "edit", ref(issue), "--relate", ref(other)]);
  await open(page, issue.id);
  await expect(page.locator(`[data-perf="rel-item"][data-id="${other.id}"]`)).toBeVisible({ timeout: SHOWS_WITHIN_MS });

  const moved = JSON.parse(devCtl(["fake", "transfer", ref(issue), "docs", "--json"])) as { issue: { id: number; number: number } };
  await expect(lost(page).getByText("This issue moved.", { exact: true })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
  await expect(lost(page)).toContainText(`acme/docs#${moved.issue.number} now`);
  await lost(page).getByRole("link", { name: "Open it" }).click();
  await expect(detail(page)).toHaveAttribute("data-id", String(moved.issue.id));
  await expect(page.locator(`[data-perf="rel-item"][data-id="${other.id}"]`)).toBeVisible();
});

test("an issue converted to a discussion shows closed and locked, and keeps its parent", async ({ page }) => {
  await signIn(page);
  const parent = await claimBelowTheTop(page, (r) => r.repo === "web");
  const issue = await claimBelowTheTop(page, (r) => r.repo === "web");
  devCtl(["fake", "edit", ref(parent), "--add-sub-issue", ref(issue)]);
  await open(page, issue.id);
  const crumb = page.locator('[data-perf="parent"]');
  await expect(crumb).toContainText(String(parent.number), { timeout: SHOWS_WITHIN_MS });

  devCtl(["fake", "convert", ref(issue)]);
  await expect(page.locator('[data-perf="badge"]')).toHaveText("Closed", { timeout: SHOWS_WITHIN_MS });
  await expect(page.locator('[data-perf="locked"]')).toHaveText("Locked");
  await expect(crumb).toContainText(String(parent.number));
});

test("a label renamed on GitHub shows on every row carrying it within 2 s of its push", async ({ page }) => {
  await signIn(page);
  const top = ((await (await page.request.get("/api/issues")).json()) as { rows: Row[] }).rows.slice(0, 15);
  // The repo's label that the most rows on screen carry.
  const counts = new Map<string, number>();
  for (const r of top) for (const l of r.labels) counts.set(`${r.repo}\t${l.name}`, (counts.get(`${r.repo}\t${l.name}`) ?? 0) + 1);
  const [key] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
  expect(key, "a label on the rows on screen").toBeDefined();
  const [repo, label] = key!.split("\t") as [string, string];
  const carrying = top.filter((r) => r.repo === repo && r.labels.some((l) => l.name === label)).map((r) => r.id);
  // A name that sorts first, so every row's first label slot shows it.
  const renamed = `aa ${Date.now().toString(36)}`;
  const shown = await timeFromPush(
    page,
    carrying[0]!,
    ([ids, name]) => ids.every((id) => document.querySelector(`[data-perf="row"][data-id="${id}"]`)?.textContent?.includes(name)),
    [carrying, renamed] as [number[], string],
  );
  devCtl(["fake", "label", repo, label, "--rename", renamed]);
  try {
    await shown();
  } finally {
    devCtl(["fake", "label", repo, renamed, "--rename", label]);
  }
  await expect(rows(page).filter({ hasText: renamed })).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
});
