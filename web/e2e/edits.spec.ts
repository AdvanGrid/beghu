// Title and body editing in a real browser, through the server to Fake GitHub: Enter, Escape and
// Ctrl or Cmd+Enter; the edit shown at once with a pending dot; "Changed since you started
// editing" when a live push changes the field under edit; a 409 keeping the user's text with
// GitHub's beside it, then "Overwrite with mine" or "Discard mine"; and the leave prompt for an
// open editor, but not for an edit on its way.
//
// Runs with writes.spec.ts (playwright.config.ts): each test claims its own issues below the
// default list's top rows (claims.ts) and leaves them closed, out of the default list again.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, shared, type Issue } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

let control: string;
/** The endpoints this test set faults on, to remove just those afterwards. */
const faulted = new Set<string>();

async function fake(path: string, body: unknown, method = "POST"): Promise<void> {
  const endpoint = (body as { endpoint?: string } | null)?.endpoint;
  if (path.startsWith("/faults/") && endpoint) faulted.add(endpoint);
  const res = await fetch(`${control}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, `${path}: ${await res.text()}`).toBe(true);
}

const ISSUE = (i: Issue) => `PATCH /repos/${i.owner}/${i.repo}/issues/${i.number}`;
/** Text no other test, here or beside this one, will have used. */
const unique = (what: string) => `${what} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const title = (page: Page) => page.locator('[data-perf="title"]');
const body = (page: Page) => page.locator('[data-perf="body"]');
const titleEditor = (page: Page) => page.locator('[data-perf="title-editor"]');
const bodyEditor = (page: Page) => page.locator('[data-perf="body-editor"]');
const editBox = (page: Page) => page.locator('[data-perf="edit-box"]');
const changed = (page: Page) => page.locator('[data-perf="edit-changed"]');
const conflict = (page: Page) => page.locator('[data-perf="edit-conflict"]');
/** An editor's first opening loads its code (compiled on demand by the dev server) and, for a body, its Markdown. */
const OPENS_WITHIN_MS = 15_000;

/** Opens `/issues/:id` and waits for the stream's opening reset to have been handled. */
async function open(page: Page, id: number): Promise<void> {
  const reset = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}` && r.ok());
  await page.goto(`/issues/${id}`);
  await reset;
  await expect(page.locator('[data-perf="composer"]')).toBeVisible();
}

/** The issue as the server has it now. */
async function server(page: Page, id: number): Promise<{ title: string; body: string; state: string }> {
  const d = (await (await page.request.get(`/api/issues/${id}`)).json()) as { title: string; state: string };
  const src = (await (await page.request.get(`/api/issues/${id}/source`)).json()) as { body: string };
  return { ...d, body: src.body };
}

/** Leaves `issue` closed, out of the default list, and waits for beghu to have the close. */
async function closeForGood(page: Page, issue: Issue): Promise<void> {
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect.poll(async () => (await server(page, issue.id)).state, { timeout: SHOWS_WITHIN_MS }).toBe("closed");
}

test.beforeAll(() => {
  control = (JSON.parse(devCtl(["status", "--json"])) as { urls: { control: string } }).urls.control;
});

let release: (() => void) | undefined;

test.beforeEach(async ({ page }, info) => {
  const own = info.timeout;
  const waiting = Date.now();
  info.setTimeout(0);
  release = await shared();
  info.setTimeout(own + (Date.now() - waiting));
  faulted.clear();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
});

test.afterEach(async () => {
  try {
    for (const endpoint of faulted) await fake("/faults", { endpoint }, "DELETE");
  } finally {
    release?.();
  }
});

test("e edits the title in place: Escape cancels, Enter saves, shown at once and then as GitHub has it", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    const was = (await title(page).textContent())!.trim();
    await page.locator('[data-perf="detail"]').focus();
    await page.keyboard.press("e");
    await expect(editBox(page)).toBeFocused({ timeout: OPENS_WITHIN_MS });
    await expect(editBox(page)).toHaveValue(was);
    await editBox(page).fill("Not this one");
    await page.keyboard.press("Escape");
    await expect(titleEditor(page)).toHaveCount(0);
    await expect(title(page)).toHaveText(was);

    const mine = unique("Renamed");
    // Slow enough to see the edit pending.
    await fake("/faults/latency", { endpoint: ISSUE(issue), ms: 1500, count: 1 });
    await page.keyboard.press("e");
    await editBox(page).fill(mine);
    await page.keyboard.press("Enter");
    await expect(titleEditor(page)).toHaveCount(0);
    await expect(title(page)).toHaveText(mine);
    await expect(title(page).locator('[data-perf="pending"]')).toBeVisible();
    await expect(title(page).locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
    await expect(title(page)).toHaveText(mine);
    expect((await server(page, issue.id)).title).toBe(mine);
    // The list's row has it too.
    await expect(page.locator(`[data-perf="row"][data-id="${issue.id}"]`)).toContainText(mine);
  } finally {
    await closeForGood(page, issue);
  }
});

test("a live change to the body under edit shows at once; saving gives a 409 with both, and Overwrite with mine wins", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await page.locator('[data-perf="edit-body"]').click();
    await expect(editBox(page)).toBeFocused({ timeout: OPENS_WITHIN_MS });
    const mine = unique("My description");
    await editBox(page).fill(mine);
    await expect(changed(page)).toHaveCount(0);

    const theirs = unique("Their description");
    devCtl(["fake", "edit", issue.ref, "--body", theirs, "--as", "ilze-k"]);
    await expect(changed(page)).toHaveText("Changed since you started editing", { timeout: SHOWS_WITHIN_MS });
    // The text typed stays.
    await expect(editBox(page)).toHaveValue(mine);

    await page.keyboard.press(`${MOD}+Enter`);
    await expect(conflict(page)).toBeVisible();
    await expect(conflict(page).locator('[data-perf="edit-theirs"]')).toHaveText(theirs);
    await expect(editBox(page)).toHaveValue(mine);
    expect((await server(page, issue.id)).body).toBe(theirs);

    await bodyEditor(page).getByRole("button", { name: "Overwrite with mine" }).click();
    await expect(bodyEditor(page)).toHaveCount(0);
    await expect(body(page)).toHaveText(mine);
    await expect.poll(async () => (await server(page, issue.id)).body, { timeout: SHOWS_WITHIN_MS }).toBe(mine);
    await expect(body(page)).toHaveText(mine);
  } finally {
    await closeForGood(page, issue);
  }
});

test("an Overwrite with mine that fails otherwise keeps the editor on GitHub's body, not changed since", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await page.locator('[data-perf="edit-body"]').click();
    await expect(editBox(page)).toBeFocused({ timeout: OPENS_WITHIN_MS });
    const mine = unique("My description");
    await editBox(page).fill(mine);
    const theirs = unique("Their description");
    devCtl(["fake", "edit", issue.ref, "--body", theirs, "--as", "ilze-k"]);
    await expect(changed(page)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(conflict(page).locator('[data-perf="edit-theirs"]')).toHaveText(theirs);

    // GitHub refuses the patch: the edit was made over their text, which is still GitHub's.
    await fake("/faults/fail", { endpoint: ISSUE(issue), count: 1, status: 422 });
    await bodyEditor(page).getByRole("button", { name: "Overwrite with mine" }).click();
    await expect(bodyEditor(page).locator('[data-perf="edit-failed"]')).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await expect(editBox(page)).toHaveValue(mine);
    await expect(conflict(page)).toHaveCount(0);
    await expect(changed(page)).toHaveCount(0);
    expect((await server(page, issue.id)).body).toBe(theirs);
  } finally {
    await closeForGood(page, issue);
  }
});

test("Discard mine closes the editor on GitHub's title", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue.id);
    await page.locator('[data-perf="edit-title"]').click();
    await expect(editBox(page)).toBeFocused({ timeout: OPENS_WITHIN_MS });
    await editBox(page).fill(unique("Mine"));
    const theirs = unique("Theirs");
    devCtl(["fake", "edit", issue.ref, "--title", theirs, "--as", "ilze-k"]);
    await expect(changed(page)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await page.keyboard.press("Enter");
    await expect(conflict(page).locator('[data-perf="edit-theirs"]')).toHaveText(theirs);

    await titleEditor(page).getByRole("button", { name: "Discard mine" }).click();
    await expect(titleEditor(page)).toHaveCount(0);
    await expect(title(page)).toHaveText(theirs);
    expect((await server(page, issue.id)).title).toBe(theirs);
  } finally {
    await closeForGood(page, issue);
  }
});

test("closing the tab with an open editor asks first; an edit on its way alone doesn't", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    const leave = async () => {
      let asked = false;
      const onDialog = (d: { type(): string; accept(): Promise<void> }) => {
        asked ||= d.type() === "beforeunload";
        void d.accept();
      };
      page.on("dialog", onDialog);
      await page.goto("about:blank");
      page.off("dialog", onDialog);
      return asked;
    };

    await open(page, issue.id);
    await page.locator('[data-perf="edit-title"]').click();
    await editBox(page).fill(unique("Unsaved"));
    expect(await leave()).toBe(true);

    await open(page, issue.id);
    await fake("/faults/latency", { endpoint: ISSUE(issue), ms: 8000, count: 1 });
    await page.locator('[data-perf="edit-title"]').click();
    await editBox(page).fill(unique("On its way"));
    await page.keyboard.press("Enter");
    await expect(titleEditor(page)).toHaveCount(0);
    await expect(title(page).locator('[data-perf="pending"]')).toBeVisible();
    // A click first: browsers only ask on pages the user has interacted with.
    await page.locator('[data-perf="composer"] textarea').click();
    expect(await leave()).toBe(false);
  } finally {
    await closeForGood(page, issue);
  }
});
