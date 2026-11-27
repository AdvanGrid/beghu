// Diff mode (#194) in a real browser, through the server to Fake GitHub's `userContentEdits`:
// turning it on (−1 → current, a reworded paragraph's words marked), stepping both ends by their
// buttons and keys without crossing, folding unchanged runs, stepping through the changes, Edit
// and another issue turning it off, a PR's description, a version deleted from the history, a
// body never edited, and the history read failing in the post alone.
//
// The fixture's seeded history (crates/fake-github/src/history.rs) is what most tests read: each
// claims the items it reads (claims.ts), so no test beside it edits them. The items are named by
// number (acme/web 3, 8, 18, 33, 48) for what that file's `seed` gives them: `1 + item.id % 3`
// earlier versions, and every third item with three its middle one deleted. A fixture whose ids
// change moves them. The failure test edits
// an issue of its own on GitHub, and fails GitHub's GraphQL for everyone while it runs, so it runs
// alone (`@alone`). The pending-edit test edits its own issue too. Runs with writes.spec.ts
// (playwright.config.ts).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, claimId, exclusive, shared, unique, type Issue } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";
import { status } from "./stack";
import { issueUrl, type Where } from "./urls";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

/** A call to Fake GitHub's control port. */
async function fake(path: string, body: unknown, method = "POST"): Promise<void> {
  const res = await fetch(`${status().urls.control}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, `${path}: ${await res.text()}`).toBe(true);
}

const detail = (page: Page) => page.locator('[data-perf="detail"]');
const toggle = (page: Page) => page.locator('[data-perf="diff-toggle"]');
const diff = (page: Page) => page.locator('[data-perf="body-diff"]');
const blocks = (page: Page) => page.locator('[data-perf="diff-block"]');
const label = (page: Page, end: "from" | "to") => page.locator(`[data-perf="diff-${end}-label"]`);
const stepper = (page: Page, end: "from" | "to", dir: "older" | "newer") => page.locator(`[data-perf="diff-${end}-${dir}"]`);
const hints = (page: Page) => page.locator('[data-perf="hints"]');
/** Diff's chunk and the history read, on a loaded machine. */
const SHOWS_MS = 15_000;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** An item of the fixture's acme repos, claimed for this test: where it is and its id. */
async function item(page: Page, repo: string, number: number, kind: "issue" | "pr" = "issue"): Promise<Where & { id: number }> {
  const res = await page.request.get(`/api/at/acme/${repo}/${number}`);
  expect(res.ok(), `acme/${repo}#${number}`).toBe(true);
  const d = (await res.json()) as { id: number; kind: string };
  expect(d.kind).toBe(kind);
  expect(claimId(d.id), `acme/${repo}#${number} is another test's`).toBe(true);
  return { owner: "acme", repo, number, kind, id: d.id };
}

/** Opens `it` at its URL, then turns Diff on, and waits for the diff (or, with `shows`, that). */
async function openDiff(page: Page, it: Where, shows = diff(page)): Promise<void> {
  await page.goto(issueUrl(it));
  await expect(detail(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(shows).toBeVisible({ timeout: SHOWS_MS });
}

/** Where the ends are, as the diff says: `from → to` in versions back (0 is current). */
async function ends(page: Page): Promise<string> {
  return `${await diff(page).getAttribute("data-from")}→${await diff(page).getAttribute("data-to")}`;
}

let release: (() => void) | undefined;

test.beforeEach(async ({ page }, info) => {
  const own = info.timeout;
  const waiting = Date.now();
  info.setTimeout(0);
  release = await (info.tags.includes("@alone") ? exclusive() : shared());
  info.setTimeout(own + (Date.now() - waiting));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/issues");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
});

test.afterEach(() => release?.());

test("Diff opens on −1 → current with the reworded paragraph's changed words marked; both ends step by buttons and keys, and never cross", async ({ page }) => {
  // Three earlier versions, none deleted: −1 rewords a paragraph.
  const it = await item(page, "web", 33);
  await page.goto(issueUrl(it));
  await detail(page).focus();
  await expect(hints(page)).toContainText("Diff on / off");
  await expect(hints(page)).not.toContainText("Next change");
  await toggle(page).click();
  await expect(diff(page)).toBeVisible({ timeout: SHOWS_MS });
  expect(await ends(page)).toBe("1→0");
  await expect(label(page, "from")).toHaveText("−1");
  await expect(label(page, "to")).toHaveText("current");
  await expect(page.locator('[data-perf="diff-ends"]')).toContainText("−1 by");
  // The current version names who made it, as GitHub's history shows.
  await expect(page.locator('[data-perf="diff-ends"]')).toContainText(/→ current by [\w-]+, .+ ago$/);
  // The reworded paragraph: one removed and one added block, paired, each with its own words
  // marked, and no other change.
  await expect(blocks(page).and(page.locator('[data-kind="del"]'))).toHaveCount(1);
  await expect(blocks(page).and(page.locator('[data-kind="add"]'))).toHaveCount(1);
  await expect(page.locator('[data-perf="diff-block"][data-paired="true"]')).toHaveCount(2);
  await expect(page.locator('[data-kind="del"] del[data-perf="diff-word"]').first()).toBeVisible();
  await expect(page.locator('[data-kind="add"] ins[data-perf="diff-word"]').first()).toBeVisible();
  await expect(page.locator('[data-perf="diff-counts"]')).toHaveText("+1 −1 blocks");
  // Its change keys are offered now.
  await expect(hints(page)).toContainText("Next change");
  // The timeline: four ticks, the ends marked.
  await expect(page.locator('[data-perf="diff-tick"]')).toHaveText(["−3", "−2", "−1", "current"]);
  await expect(page.locator('[data-perf="diff-tick"][data-end="from"]')).toHaveText("−1");
  await expect(page.locator('[data-perf="diff-tick"][data-end="to"]')).toHaveText("current");

  // The older end, by its buttons: back to the oldest, and no further.
  await stepper(page, "from", "older").click();
  await expect(label(page, "from")).toHaveText("−2");
  await stepper(page, "from", "older").click();
  await expect(label(page, "from")).toHaveText("−3");
  await expect(stepper(page, "from", "older")).toBeDisabled();
  await stepper(page, "from", "newer").click();
  await expect(label(page, "from")).toHaveText("−2");
  // The newer end: one older, then it can't reach the older end.
  await stepper(page, "to", "older").click();
  await expect(label(page, "to")).toHaveText("−1");
  await expect(stepper(page, "to", "older")).toBeDisabled();
  await expect(stepper(page, "to", "newer")).toBeEnabled();
  await stepper(page, "to", "newer").click();
  await expect(label(page, "to")).toHaveText("current");
  await expect(stepper(page, "to", "newer")).toBeDisabled();

  // The same by keys, from the issue: [ ] for the older end, { } for the newer.
  await detail(page).focus();
  await page.keyboard.press("[");
  await expect(label(page, "from")).toHaveText("−3");
  await page.keyboard.press("]");
  await page.keyboard.press("]");
  await expect(label(page, "from")).toHaveText("−1");
  // Not onto the newer end.
  await page.keyboard.press("]");
  await expect(label(page, "from")).toHaveText("−1");
  await page.keyboard.press("{");
  await expect(label(page, "to")).toHaveText("current");
  await page.keyboard.press("[");
  await page.keyboard.press("{");
  await expect(label(page, "to")).toHaveText("−1");
  expect(await ends(page)).toBe("2→1");
  await page.keyboard.press("}");
  await expect(label(page, "to")).toHaveText("current");

  // d turns it off, and the body is back.
  await page.keyboard.press("d");
  await expect(diff(page)).toHaveCount(0);
  await expect(page.locator('[data-perf="body"]')).toBeVisible();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(hints(page)).not.toContainText("Next change");
});

test("unchanged runs fold, one at a time or all; ↑ ↓ and n Shift+N step through the changes, outlining the current one", async ({ page }) => {
  const it = await item(page, "web", 3);
  await openDiff(page, it);
  // −3 → current: the reworded paragraph, the dropped note and the paragraph added since.
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  await expect(label(page, "from")).toHaveText("−3");
  const folds = page.locator('[data-perf="diff-fold"]');
  const refolds = page.locator('[data-perf="diff-refold"]');
  const all = page.locator('[data-perf="diff-fold-all"]');
  const n = await folds.count();
  expect(n).toBeGreaterThan(0);
  await expect(folds.first()).toHaveText(/^⋯ \d+ unchanged blocks?$/);
  const shown = await blocks(page).count();

  // One run open, with its bar to fold it again.
  await folds.first().click();
  await expect(folds).toHaveCount(n - 1);
  await expect(refolds).toHaveCount(1);
  await expect(refolds.first()).toHaveText(/^▴ Fold \d+ unchanged blocks?$/);
  expect(await blocks(page).count()).toBeGreaterThan(shown);
  await refolds.first().click();
  await expect(folds).toHaveCount(n);
  await expect(blocks(page)).toHaveCount(shown);

  // Every run, both ways.
  await expect(all).toHaveText("Unfold all");
  await all.click();
  await expect(folds).toHaveCount(0);
  await expect(refolds).toHaveCount(n);
  await expect(all).toHaveText("Fold unchanged");
  await all.click();
  await expect(folds).toHaveCount(n);

  // The changes, by the arrows: from the top, round again, and back.
  const changes = page.locator('[data-perf="diff-change"]');
  const total = await changes.count();
  expect(total).toBeGreaterThan(1);
  const at = page.locator('[data-perf="diff-at"]');
  const current = page.locator('[data-perf="diff-change"][data-current="true"]');
  await expect(at).toHaveText(`– / ${total}`);
  await expect(current).toHaveCount(0);
  await page.locator('[data-perf="diff-next"]').click();
  await expect(at).toHaveText(`1 / ${total}`);
  await expect(current).toHaveAttribute("data-change", "0");
  await expect(current).toHaveCSS("outline-style", "solid");
  await page.locator('[data-perf="diff-prev"]').click();
  await expect(at).toHaveText(`${total} / ${total}`);
  await expect(current).toHaveAttribute("data-change", String(total - 1));
  // And by keys.
  await detail(page).focus();
  await page.keyboard.press("n");
  await expect(at).toHaveText(`1 / ${total}`);
  await page.keyboard.press("n");
  await expect(at).toHaveText(`2 / ${total}`);
  await page.keyboard.press("Shift+N");
  await expect(at).toHaveText(`1 / ${total}`);
  // The header sticks under the title bar while the body scrolls.
  await detail(page).evaluate((el) => (el.scrollTop += 400));
  await expect(page.locator('[data-perf="sticky-head"]')).toBeVisible();
  const head = await page.locator('[data-perf="diff-head"]').boundingBox();
  const top = await detail(page).boundingBox();
  // The sticky title bar's height, `detailBars.titleBar` in web/src/layout.stylex.ts (StyleX's
  // constants don't run outside its compiler, so the spec can't import it).
  expect(Math.round(head!.y - top!.y)).toBe(34);
});

test("Edit leaves Diff for the editor; another issue opens with Diff off; the keys are in the overlay and on the setup page", async ({ page }) => {
  const it = await item(page, "web", 8);
  await openDiff(page, it);
  await page.locator('[data-perf="edit-body"]').click();
  await expect(page.locator('[data-perf="body-editor"]')).toBeVisible({ timeout: SHOWS_MS });
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(diff(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-perf="body-editor"]')).toHaveCount(0);

  // On again, then another issue from the list: it opens with Diff off.
  await toggle(page).click();
  await expect(diff(page)).toBeVisible({ timeout: SHOWS_MS });
  const other = page.locator(`[data-perf="row"]:not([data-id="${it.id}"])`).first();
  const id = await other.getAttribute("data-id");
  await other.click();
  await expect(detail(page)).toHaveAttribute("data-id", id!);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(diff(page)).toHaveCount(0);

  // The `?` overlay lists Diff's keys.
  await detail(page).focus();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help.locator("h3", { hasText: /^Diff$/ })).toBeVisible();
  for (const what of ["Diff on / off", "Older end: older", "Newer end: newer", "Next change", "Previous change"]) await expect(help).toContainText(what);
  await page.keyboard.press("Escape");
  // So does the setup page, to rebind them.
  await page.goto("/prefs");
  for (const what of ["Diff on / off", "Older end: older", "Older end: newer", "Newer end: older", "Newer end: newer", "Next change", "Previous change"]) await expect(page.getByText(what, { exact: true })).toBeVisible();
});

test("a PR's description has Diff too, from its status row and its sticky title bar", async ({ page }) => {
  const it = await item(page, "web", 18, "pr");
  await openDiff(page, it);
  await expect(page.locator('[data-perf="diff-tick"]')).toHaveText(["−3", "−2", "−1", "current"]);
  await expect(page.locator('[data-perf="diff-block"][data-paired="true"]')).toHaveCount(2);
  // Turning it on brought the post up, so the title bar shows, with its own copy of the toggle.
  const sticky = page.locator('[data-perf="diff-toggle-sticky"]');
  await expect(page.locator('[data-perf="sticky-head"]')).toBeVisible();
  await expect(sticky).toBeVisible();
  await expect(sticky).toHaveAttribute("aria-pressed", "true");
  await sticky.click();
  await expect(diff(page)).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
});

test("a version deleted from the history is a greyed tick the steppers skip", async ({ page }) => {
  const it = await item(page, "web", 48);
  await openDiff(page, it);
  const deleted = page.locator('[data-perf="diff-tick"][data-deleted="true"]');
  await expect(deleted).toHaveCount(1);
  await expect(deleted).toHaveText("deleted");
  await expect(deleted).toHaveAttribute("data-age", "2");
  await expect(deleted).toHaveCSS("opacity", "0.5");
  expect(await ends(page)).toBe("1→0");
  await stepper(page, "from", "older").click();
  await expect(label(page, "from")).toHaveText("−3");
  await stepper(page, "from", "newer").click();
  await expect(label(page, "from")).toHaveText("−1");
  // The newer end skips it too: −1 is as far back as it goes below −3.
  await stepper(page, "from", "older").click();
  await stepper(page, "to", "older").click();
  await expect(label(page, "to")).toHaveText("−1");
  await expect(stepper(page, "to", "older")).toBeDisabled();
});

test("a body never edited says so", async ({ page }) => {
  // The fixture seeds history only on items numbered 3, 8, 13, …: the first other one with none.
  let found: Where | undefined;
  for (const number of [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17]) {
    const d = (await (await page.request.get(`/api/at/acme/web/${number}`)).json()) as { id: number; kind: string };
    if (d.kind !== "issue" || !claimId(d.id)) continue;
    const h = (await (await page.request.get(`/api/issues/${d.id}/history`)).json()) as { revisions: unknown[] };
    if (h.revisions.length > 0) continue;
    found = { owner: "acme", repo: "web", number };
    break;
  }
  expect(found, "an acme/web issue never edited").toBeDefined();
  const never = page.locator('[data-perf="diff-never"]');
  await openDiff(page, found!, never);
  await expect(never).toHaveText("This body has never been edited.");
  await expect(page.locator('[data-perf="diff-head"]')).toHaveCount(0);
});

test("Diff can't be turned on while the description's edit is on its way, and can once GitHub has it", async ({ page }) => {
  const issue: Issue = await claimBelowTheTop(page);
  try {
    await page.goto(issueUrl(issue));
    await expect(page.locator('[data-perf="composer"]')).toBeVisible();
    await expect(toggle(page)).toBeEnabled();
    // Slow enough to see the edit pending.
    await fake("/faults/latency", { endpoint: `PATCH /repos/${issue.owner}/${issue.repo}/issues/${issue.number}`, ms: 6000, count: 1 });
    await page.locator('[data-perf="edit-body"]').click();
    const box = page.locator('[data-perf="edit-box"]');
    await expect(box).toBeFocused({ timeout: SHOWS_MS });
    const mine = unique("A description on its way");
    await box.fill(mine);
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.locator('[data-perf="body-editor"]')).toHaveCount(0);
    await expect(page.locator('[data-perf="body"]')).toContainText(mine);
    await expect(toggle(page)).toBeDisabled();
    await expect(toggle(page)).toHaveAttribute("title", "The description's edit is still on its way");
    // Nor by its key.
    await detail(page).focus();
    await page.keyboard.press("d");
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(diff(page)).toHaveCount(0);
    // GitHub has it: Diff is back.
    await expect(toggle(page)).toBeEnabled({ timeout: SHOWS_WITHIN_MS });
    await toggle(page).click();
    await expect(diff(page)).toBeVisible({ timeout: SHOWS_MS });
  } finally {
    await fake("/faults", { endpoint: `PATCH /repos/${issue.owner}/${issue.repo}/issues/${issue.number}` }, "DELETE");
    devCtl(["fake", "edit", issue.ref, "--close"]);
    await expect.poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, { timeout: SHOWS_WITHIN_MS }).toBe("closed");
  }
});

test("the history read failing shows why in the post, with Retry; the body changing on GitHub reads it again, the ends kept", { tag: "@alone" }, async ({ page }) => {
  // An issue of this test's own, edited on GitHub: its history isn't in the mirror for this body.
  const issue: Issue = await claimBelowTheTop(page);
  try {
    const first = unique("First rewrite of the description");
    await fake("/edit", { repo: `${issue.owner}/${issue.repo}`, number: issue.number, body: first });
    await page.goto(issueUrl(issue));
    await expect(page.locator('[data-perf="body"]')).toContainText(first, { timeout: SHOWS_WITHIN_MS });

    // GitHub refuses the history read once.
    await fake("/faults/fail", { endpoint: "POST /graphql", count: 1, status: 403 });
    await toggle(page).click();
    const failed = page.locator('[data-perf="diff-failed"]');
    await expect(failed).toBeVisible({ timeout: SHOWS_MS });
    await expect(failed).toContainText("Couldn't load the earlier versions: GitHub didn't show this body's history");
    // Only the post: the title, the properties and the thread are as they were.
    await expect(page.locator('[data-perf="title"]')).toBeVisible();
    await expect(page.locator('[data-perf="comments"]')).toBeVisible();
    await page.locator('[data-perf="diff-retry"]').click();
    await expect(diff(page)).toBeVisible({ timeout: SHOWS_MS });
    await expect(failed).toHaveCount(0);
    // The body as created, then the rewrite.
    await expect(page.locator('[data-perf="diff-tick"]')).toHaveText(["−1", "current"]);

    // Rewritten again while Diff is open: the history is read again, the newer end stays on
    // current, and the older end keeps its version, now two back.
    const second = unique("Second rewrite of the description");
    await fake("/edit", { repo: `${issue.owner}/${issue.repo}`, number: issue.number, body: second });
    await expect(page.locator('[data-perf="diff-tick"]')).toHaveText(["−2", "−1", "current"], { timeout: SHOWS_WITHIN_MS });
    await expect(label(page, "from")).toHaveText("−2");
    await expect(label(page, "to")).toHaveText("current");
    await expect(page.locator('[data-perf="diff-block"][data-kind="add"]')).toContainText(second);
  } finally {
    await fake("/faults", { endpoint: "POST /graphql" }, "DELETE");
    // Closed, out of the default list again, once beghu has it.
    devCtl(["fake", "edit", issue.ref, "--close"]);
    await expect.poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, { timeout: SHOWS_WITHIN_MS }).toBe("closed");
  }
});
