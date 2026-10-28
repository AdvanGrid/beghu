// The create form in a real browser, against Fake GitHub: "New issue" and `c` open it in the panel
// with the repo the view filters on, else the last one used; Create opens the new issue by its
// real id, with no row standing in for it, and lists find it through the push; a failure keeps
// every field and is never sent again on its own; archived repos aren't offered; on a Read repo,
// labels, assignees and milestone stay in place, greyed and unsent.
//
// Last, on its own (playwright.config.ts): every issue made here is new to every tab's lists, and
// archiving a repo changes what every tab offers. Each test holds the stack alone (claims.ts), and
// each issue made is closed afterwards, out of the default list again.
import { expect, test, type Page } from "@playwright/test";
import { exclusive, fiveHundreds } from "./claims";
import { BUDGET_MS, recordPushes, SHOWS_WITHIN_MS } from "./push";
import { devCtl, status } from "./stack";

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

/** GitHub's endpoint for a new issue, in any repo. */
const CREATE = "POST /repos/*/*/issues";

/** A word no other issue's title has: titles are searched by the start of their words. */
const unique = () => `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const rows = (page: Page) => page.locator('[data-perf="row"]');
const form = (page: Page) => page.locator('[data-perf="create-form"]');
const repoSelect = (page: Page) => page.locator('[data-perf="create-repo"]');
const title = (page: Page) => page.locator('[data-perf="create-title"]');
const body = (page: Page) => page.locator('[data-perf="create-body"]');
const submit = (page: Page) => page.locator('[data-perf="create-submit"]');
const failed = (page: Page) => page.locator('[data-perf="create-failed"]');
const opener = (page: Page, prop: string) => form(page).locator(`[data-perf="pick-${prop}"]`);
const propRow = (page: Page, prop: string) => form(page).locator(`dd[data-perf="${prop}"]`);
const options = (page: Page) => page.locator('[data-perf="picker"] [data-perf="pick"]');

type Repo = { id: number; name: string; role: string | null; archived: boolean };

async function signIn(page: Page, login = "tomsj"): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`/auth/login?login=${login}`);
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
}

/** The account's synced repos, as `/api/me` has them now. */
async function repos(page: Page): Promise<Repo[]> {
  return ((await (await page.request.get("/api/me")).json()) as { repos: Repo[] }).repos;
}

async function repoNamed(page: Page, name: string): Promise<Repo> {
  const r = (await repos(page)).find((r) => r.name === name);
  if (!r) throw new Error(`no synced repo ${name}`);
  return r;
}

/** Opens the list on `query`, and waits for its rows. */
async function view(page: Page, query: string): Promise<void> {
  await page.goto(`/?q=${encodeURIComponent(query)}`);
  await expect(rows(page).first()).toBeVisible();
}

/** The issues made here, closed after each test. */
let made: number[] = [];

/** The new issue the panel opened: its id, from the URL. */
async function opened(page: Page): Promise<number> {
  await page.waitForURL((u) => /^\/issues\/\d+$/.test(u.pathname));
  const id = Number(/\/issues\/(\d+)/.exec(page.url())![1]);
  made.push(id);
  await expect(page.locator(`[data-perf="detail"][data-id="${id}"]`)).toBeVisible();
  return id;
}

/** The open issues whose title has `word`, as a list finds them. */
async function listed(page: Page, word: string): Promise<number[]> {
  const res = await page.request.get(`/api/issues?q=${encodeURIComponent(`is:open in:title ${word}`)}`);
  return ((await res.json()) as { rows: { id: number }[] }).rows.map((r) => r.id);
}

/** The ops the page sends from now on, first sends only. */
function opsSent(page: Page): { kind: string; labels?: string[]; assignees?: string[]; milestone?: number | null }[] {
  const sent: { kind: string }[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/ops" && r.method() === "POST") {
      const b = r.postDataJSON() as { op: { kind: string }; resend?: boolean };
      if (!b.resend) sent.push(b.op);
    }
  });
  return sent;
}

/**
 * Starts watching `page` (set up with `recordPushes`), every frame, for a row titled `text`; the
 * result waits for it, then holds the time from the last push naming the new issue `id` before
 * that frame to the budget.
 */
async function watchRow(page: Page, text: string): Promise<(id: number) => Promise<void>> {
  await page.evaluate((text) => {
    const w = window as unknown as { pushTiming: { since?: number; shownAt?: number } };
    w.pushTiming.since = performance.now();
    delete w.pushTiming.shownAt;
    const frame = () => {
      if ([...document.querySelectorAll('[data-perf="row"]')].some((r) => r.textContent?.includes(text))) w.pushTiming.shownAt = performance.now();
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, text);
  return async (id) => {
    type Timing = { pushes: { at: number; ids: number[] }[]; since: number; shownAt?: number };
    const timing = () => page.evaluate(() => (window as unknown as { pushTiming: Timing }).pushTiming);
    await expect.poll(async () => (await timing()).shownAt, { timeout: SHOWS_WITHIN_MS }).toBeDefined();
    const t = await timing();
    const push = t.pushes.filter((p) => p.at >= t.since && p.at <= t.shownAt! && p.ids.includes(id)).at(-1);
    expect(push, `a push named ${id} before it showed`).toBeDefined();
    expect(t.shownAt! - push!.at, "ms from the push reaching the tab to the row on screen").toBeLessThanOrEqual(BUDGET_MS);
  };
}

test.beforeAll(() => {
  control = status().urls.control;
});

let release: (() => void)[] = [];

test.beforeEach(async ({ page }, info) => {
  // Waiting for the lock isn't the test's own time (as in writes.spec.ts).
  const own = info.timeout;
  const waiting = Date.now();
  info.setTimeout(0);
  release = [await exclusive()];
  if (info.tags.includes("@5xx")) release.push(await fiveHundreds());
  info.setTimeout(own + (Date.now() - waiting));
  faulted.clear();
  made = [];
  await page.setViewportSize({ width: 1400, height: 900 });
});

test.afterEach(async ({ page }) => {
  try {
    for (const endpoint of faulted) await fake("/faults", { endpoint }, "DELETE");
    for (const id of made) {
      const d = (await (await page.request.get(`/api/issues/${id}`)).json()) as { owner: string; repo: string; number: number };
      devCtl(["fake", "edit", `${d.owner}/${d.repo}#${d.number}`, "--close"]);
    }
  } finally {
    for (const r of release.reverse()) r();
  }
});

test("New issue opens the form with the view's repo, and Create opens the new issue by its id, which lists then show", async ({ page, context }) => {
  await signIn(page);
  const docs = await repoNamed(page, "docs");
  const query = "is:open repo:docs";
  // Another tab on the same view: the new issue reaches its list through the push.
  const other = await context.newPage();
  await recordPushes(other);
  await view(other, query);
  await view(page, query);

  await page.getByRole("link", { name: "New issue" }).click();
  await expect(form(page)).toBeVisible();
  expect(new URL(page.url()).searchParams.get("q")).toBe(query);
  await expect(repoSelect(page)).toHaveValue(String(docs.id));
  await expect(title(page)).toBeFocused();
  await expect(submit(page)).toBeDisabled();

  const word = unique();
  const text = `Made in the form ${word}`;
  await title(page).fill(text);
  await body(page).fill("Steps:\n\n1. Open the form");
  await opener(page, "labels").click();
  const label = (await options(page).first().getAttribute("data-name"))!;
  await options(page).first().click();
  await page.keyboard.press("Escape");
  await expect(propRow(page, "labels")).toContainText(label);

  // GitHub takes its time: the form says so, disabled, and no row stands in for the issue.
  await fake("/faults/latency", { endpoint: CREATE, ms: 1500 });
  const shows = await watchRow(other, word);
  await submit(page).click();
  await expect(submit(page)).toHaveText("Creating…");
  await expect(title(page)).toBeDisabled();
  await expect(body(page)).toBeDisabled();
  await expect(rows(page).filter({ hasText: word })).toHaveCount(0);

  const id = await opened(page);
  await expect(page.locator('[data-perf="title"]')).toHaveText(text);
  await expect(page.locator('dd[data-perf="labels"]')).toContainText(label);
  await expect(page.locator('[data-perf="body"] ol')).toContainText("Open the form");
  // In this tab's list and the other's, through the push.
  await expect(rows(page).filter({ hasText: word })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: word })).toHaveAttribute("data-id", String(id));
  await shows(id);
  expect(await listed(page, word)).toEqual([id]);
});

test("`c` opens the form with the last repo used, after the view's; with neither, the repo is picked", async ({ page }) => {
  await signIn(page);
  const api = await repoNamed(page, "api");
  const docs = await repoNamed(page, "docs");
  await view(page, "is:open");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await expect(form(page)).toBeVisible();
  // No `repo:` in the view and none used yet on this device: nothing is chosen for the user.
  await expect(repoSelect(page)).toHaveValue("");
  const word = unique();
  await title(page).fill(`Picked by hand ${word}`);
  await expect(submit(page)).toBeDisabled();
  await repoSelect(page).selectOption(String(api.id));
  await submit(page).click();
  const id = await opened(page);
  expect(await listed(page, word)).toEqual([id]);

  // The next form starts in the repo last used, unless the view filters on one.
  await view(page, "is:open");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await expect(repoSelect(page)).toHaveValue(String(api.id));
  await expect(title(page)).toHaveValue("");
  await view(page, "is:open repo:docs");
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(repoSelect(page)).toHaveValue(String(docs.id));
});

test("a failed create keeps every field, says why with Try again, and is never sent again on its own", { tag: "@5xx" }, async ({ page }) => {
  await signIn(page);
  await view(page, "is:open repo:web");
  const sent = opsSent(page);
  await page.getByRole("link", { name: "New issue" }).click();
  const word = unique();
  const text = `Kept through a failure ${word}`;
  await title(page).fill(text);
  await body(page).fill("Every word of this stays.");
  await opener(page, "labels").click();
  const label = (await options(page).first().getAttribute("data-name"))!;
  await options(page).first().click();
  await page.keyboard.press("Escape");
  await opener(page, "assignees").click();
  await options(page).filter({ hasText: "tomsj" }).click();
  await page.keyboard.press("Escape");

  // GitHub fails on it: it may have made the issue, so it's not sent again.
  await fake("/faults/fail", { endpoint: CREATE, status: 502, count: 2 });
  await submit(page).click();
  await expect(failed(page)).toContainText("May or may not have been created; check the list before trying again");
  await expect(failed(page).getByRole("button", { name: "Try again" })).toBeEnabled();
  await expect(title(page)).toHaveValue(text);
  await expect(body(page)).toHaveValue("Every word of this stays.");
  await expect(propRow(page, "labels")).toContainText(label);
  await expect(propRow(page, "assignees")).toContainText("tomsj");
  expect(new URL(page.url()).pathname).toBe("/new");
  // Nothing more goes out, to beghu or to GitHub: one of the two failures is still unused.
  await page.waitForTimeout(4000);
  expect(sent.filter((o) => o.kind === "create")).toHaveLength(1);
  const state = (await (await fetch(`${control}/state`)).json()) as { faults: { fail: { remaining: number }[] } };
  expect(state.faults.fail.map((f) => f.remaining)).toEqual([1]);
  expect(await listed(page, word)).toEqual([]);

  // The user tries again, as many times as it takes: each a new create.
  await failed(page).getByRole("button", { name: "Try again" }).click();
  await expect(failed(page)).toContainText("May or may not have been created");
  await failed(page).getByRole("button", { name: "Try again" }).click();
  const id = await opened(page);
  expect(sent.filter((o) => o.kind === "create")).toHaveLength(3);
  await expect(page.locator('dd[data-perf="labels"]')).toContainText(label);
  expect(await listed(page, word)).toEqual([id]);
});

test("archived repos aren't offered in the repo picker", async ({ page }) => {
  await signIn(page);
  const docs = await repoNamed(page, "docs");
  const archive = async (archived: boolean) => {
    await fake("/archive", { repo: "docs", archived });
    await expect.poll(async () => (await repoNamed(page, "docs")).archived, { timeout: SHOWS_WITHIN_MS }).toBe(archived);
  };
  await archive(true);
  try {
    // The view filters on it: the form starts with no repo rather than an archived one.
    await view(page, "is:open repo:docs");
    await page.getByRole("link", { name: "New issue" }).click();
    await expect(form(page)).toBeVisible();
    await expect(repoSelect(page).locator(`option[value="${docs.id}"]`)).toHaveCount(0);
    await expect(repoSelect(page).locator("option", { hasText: "web" })).toHaveCount(1);
    await expect(repoSelect(page)).toHaveValue("");
  } finally {
    await archive(false);
  }
  await page.reload();
  await expect(repoSelect(page).locator(`option[value="${docs.id}"]`)).toHaveCount(1);
});

test("on a Read repo, labels, assignees and milestone are disabled in place, kept greyed and unsent", async ({ page }) => {
  // Write on web, Read on cli.
  await signIn(page, "ilze-k");
  const cli = await repoNamed(page, "cli");
  await view(page, "is:open repo:web");
  const sent = opsSent(page);
  await page.getByRole("link", { name: "New issue" }).click();
  await opener(page, "labels").click();
  const label = (await options(page).first().getAttribute("data-name"))!;
  await options(page).first().click();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-perf="create-role"]')).toHaveText("");
  // A row's key opens its picker, with the focus in the panel, as on an issue.
  const close = page.getByRole("link", { name: "Close the form" });
  await close.focus();
  await page.keyboard.press("m");
  await expect(page.locator('[data-perf="picker"]')).toBeVisible();
  await page.keyboard.press("Escape");
  const where = () => body(page).evaluate((el) => el.getBoundingClientRect().top);
  const before = await where();

  await repoSelect(page).selectOption(String(cli.id));
  for (const prop of ["labels", "assignees", "milestone"]) await expect(opener(page, prop)).toBeDisabled();
  await expect(propRow(page, "labels")).toHaveAttribute("data-unsent", "true");
  await expect(propRow(page, "labels")).toContainText(label);
  await expect(page.locator('[data-perf="create-role"]')).toHaveText("You have Read on cli: labels, assignees and milestone won't be sent.");
  // Nothing moved.
  expect(await where()).toBe(before);
  // The key for a row does nothing there.
  await title(page).fill(`From a reader ${unique()}`);
  await close.focus();
  await page.keyboard.press("l");
  await expect(page.locator('[data-perf="picker"]')).toHaveCount(0);

  await submit(page).click();
  await opened(page);
  const create = sent.find((o) => o.kind === "create")!;
  expect(create.labels).toEqual([]);
  expect(create.assignees).toEqual([]);
  expect(create.milestone).toBeNull();
  await expect(page.locator('dd[data-perf="labels"]')).toContainText("None");
});

/** The status slot's word on a create that ended while the form was closed. */
const createStatus = (page: Page) => page.locator('[data-perf="create-status"]');

/** Opens the list's first row that isn't `word`'s, and waits for its detail; its id. */
async function openRow(page: Page, word: string): Promise<number> {
  const row = rows(page).filter({ hasNotText: word }).first();
  const id = Number(await row.getAttribute("data-id"));
  await row.click();
  await page.waitForURL((u) => u.pathname === `/issues/${id}`);
  await expect(page.locator(`[data-perf="detail"][data-id="${id}"]`)).toBeVisible();
  return id;
}

test("a create carries on when the form closes: back in the form it's still Creating…, never sent twice, and the panel stays where the user went", async ({ page }) => {
  await signIn(page);
  await view(page, "is:open repo:docs");
  const sent = opsSent(page);
  const creates = () => sent.filter((o) => o.kind === "create");
  await fake("/faults/latency", { endpoint: CREATE, ms: 4000 });

  // Away and back while it's on its way: the form says so, locked, and can't send it again.
  await page.getByRole("link", { name: "New issue" }).click();
  const word = unique();
  const text = `Left mid-flight ${word}`;
  await title(page).fill(text);
  await submit(page).click();
  await expect(submit(page)).toHaveText("Creating…");
  await openRow(page, word);
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(form(page)).toBeVisible();
  await expect(submit(page)).toHaveText("Creating…");
  await expect(submit(page)).toBeDisabled();
  await expect(title(page)).toBeDisabled();
  await expect(title(page)).toHaveValue(text);
  await page.keyboard.press("Enter");
  // Back in the form when it's made: the form opens it.
  const id = await opened(page);
  await expect(page.locator('[data-perf="title"]')).toHaveText(text);
  expect(creates()).toHaveLength(1);
  expect(await listed(page, word)).toEqual([id]);

  // Away when it's made: the panel stays on the issue the user opened, and the status slot says
  // where the new one went.
  await page.getByRole("link", { name: "New issue" }).click();
  const second = unique();
  await title(page).fill(`Made while away ${second}`);
  await submit(page).click();
  await expect(submit(page)).toHaveText("Creating…");
  const elsewhere = await openRow(page, second);
  await expect(createStatus(page)).toContainText("Created the issue in docs", { timeout: 10_000 });
  expect(new URL(page.url()).pathname).toBe(`/issues/${elsewhere}`);
  expect(creates()).toHaveLength(2);
  const [madeId] = await listed(page, second);
  expect(madeId).toBeDefined();
  made.push(madeId!);
  await createStatus(page).getByRole("link", { name: "Open" }).click();
  await page.waitForURL((u) => u.pathname === `/issues/${madeId}`);
  await expect(createStatus(page)).toHaveCount(0);
  // The form starts afresh.
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(title(page)).toHaveValue("");
  await expect(submit(page)).toHaveText("Create issue");
});

test("a create that fails while the form is closed says so in the status slot, and the form keeps it with Try again", { tag: "@5xx" }, async ({ page }) => {
  await signIn(page);
  await view(page, "is:open repo:web");
  const sent = opsSent(page);
  await page.getByRole("link", { name: "New issue" }).click();
  const word = unique();
  const text = `Failed while away ${word}`;
  await title(page).fill(text);
  await body(page).fill("Kept for the next try.");
  await fake("/faults/latency", { endpoint: CREATE, ms: 3000 });
  await fake("/faults/fail", { endpoint: CREATE, status: 502, count: 1 });
  await submit(page).click();
  await expect(submit(page)).toHaveText("Creating…");
  const elsewhere = await openRow(page, word);

  // Lost: it may have been made, so it's never sent again on its own.
  await expect(createStatus(page)).toContainText("May or may not have been created; check the list before trying again", { timeout: 10_000 });
  expect(new URL(page.url()).pathname).toBe(`/issues/${elsewhere}`);
  await createStatus(page).getByRole("link", { name: "Open the form" }).click();
  await expect(form(page)).toBeVisible();
  await expect(createStatus(page)).toHaveCount(0);
  await expect(failed(page)).toContainText("May or may not have been created");
  await expect(title(page)).toHaveValue(text);
  await expect(body(page)).toHaveValue("Kept for the next try.");
  expect(sent.filter((o) => o.kind === "create")).toHaveLength(1);
  expect(await listed(page, word)).toEqual([]);

  await failed(page).getByRole("button", { name: "Try again" }).click();
  const id = await opened(page);
  expect(sent.filter((o) => o.kind === "create")).toHaveLength(2);
  expect(await listed(page, word)).toEqual([id]);
});

test("picks belong to their repo: when the form's repo changes, the milestone and assignees go and only the labels the new repo has stay", async ({ page }) => {
  await signIn(page);
  const web = await repoNamed(page, "web");
  const docs = await repoNamed(page, "docs");
  // A label only web has.
  const only = unique();
  devCtl(["fake", "label", "web", only, "--color", "5319e7"]);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/repos/${web.id}/labels`)).json()) as { name: string }[]).map((l) => l.name), {
      timeout: SHOWS_WITHIN_MS,
    })
    .toContain(only);

  // Picked with web as the view's repo.
  await view(page, "is:open repo:web");
  const sent = opsSent(page);
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(repoSelect(page)).toHaveValue(String(web.id));
  const pickNamed = async (prop: string, name: string) => {
    await opener(page, prop).click();
    await options(page).filter({ hasText: name }).first().click();
    if (prop !== "milestone") await page.keyboard.press("Escape");
    await expect(propRow(page, prop)).toContainText(name);
  };
  await pickNamed("labels", only);
  await pickNamed("labels", "bug");
  await pickNamed("assignees", "tomsj");
  await pickNamed("milestone", "v0.1");
  const word = unique();
  await title(page).fill(`Picks moved ${word}`);

  // The view's repo changes, and with it the form's: the picks follow it.
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.fill("is:open repo:docs ");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("is:open repo:docs");
  await page.getByRole("link", { name: "Close the form" }).click();
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(repoSelect(page)).toHaveValue(String(docs.id));
  await expect(title(page)).toHaveValue(`Picks moved ${word}`);
  await expect(propRow(page, "milestone")).toHaveText("None");
  await expect(propRow(page, "assignees")).toHaveText("No one");
  await expect(propRow(page, "labels")).toContainText("bug");
  await expect(propRow(page, "labels")).not.toContainText(only);

  // Chosen by hand too: a milestone picked in docs goes on the way back to web.
  await pickNamed("milestone", "v1.2");
  await repoSelect(page).selectOption(String(web.id));
  await expect(propRow(page, "milestone")).toHaveText("None");
  await expect(propRow(page, "labels")).toContainText("bug");
  await repoSelect(page).selectOption(String(docs.id));

  await submit(page).click();
  const id = await opened(page);
  const create = sent.find((o) => o.kind === "create")! as { repo?: number; labels?: string[]; assignees?: string[]; milestone?: number | null };
  expect(create.repo).toBe(docs.id);
  expect(create.labels).toEqual(["bug"]);
  expect(create.assignees).toEqual([]);
  expect(create.milestone).toBeNull();
  await expect(page.locator('dd[data-perf="labels"]')).toContainText("bug");
  await expect(page.locator('dd[data-perf="milestone"]')).not.toContainText("v0.1");
  expect(await listed(page, word)).toEqual([id]);
});

test("a title is trimmed and at most 256 characters long, as on GitHub", async ({ page }) => {
  await signIn(page);
  await view(page, "is:open repo:docs");
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(title(page)).toHaveAttribute("maxlength", "256");
  await title(page).fill("   ");
  await expect(submit(page)).toBeDisabled();
  const word = unique();
  await title(page).fill(`  Trimmed ${word}  `);
  await submit(page).click();
  await opened(page);
  await expect(page.locator('[data-perf="title"]')).toHaveText(`Trimmed ${word}`);
});

test("the repo a create is sent to holds while it's on its way, so a failed one can be sent again from the form", { tag: "@5xx" }, async ({ page }) => {
  await signIn(page);
  const web = await repoNamed(page, "web");
  await view(page, "is:open repo:web");
  const sent = opsSent(page);
  await page.getByRole("link", { name: "New issue" }).click();
  await expect(repoSelect(page)).toHaveValue(String(web.id));
  await opener(page, "labels").click();
  await options(page).filter({ hasText: "bug" }).first().click();
  await page.keyboard.press("Escape");
  await expect(propRow(page, "labels")).toContainText("bug");
  const word = unique();
  await title(page).fill(`Held repo ${word}`);
  await fake("/faults/latency", { endpoint: CREATE, ms: 3000 });
  await fake("/faults/fail", { endpoint: CREATE, status: 502, count: 1 });
  await submit(page).click();
  await expect(submit(page)).toHaveText("Creating…");

  // The view's repo changes while it's on its way: the form keeps the repo it sent to.
  await page.getByRole("combobox", { name: "Filter issues" }).fill("is:open repo:docs ");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("is:open repo:docs");
  await expect(repoSelect(page)).toHaveValue(String(web.id));
  await expect(failed(page)).toContainText("May or may not have been created", { timeout: 10_000 });
  await expect(repoSelect(page)).toHaveValue(String(web.id));
  await expect(propRow(page, "labels")).toContainText("bug");

  // Try again sends it, to the same repo with the same labels.
  await expect(failed(page).getByRole("button", { name: "Try again" })).toBeEnabled();
  await failed(page).getByRole("button", { name: "Try again" }).click();
  const id = await opened(page);
  const creates = sent.filter((o) => o.kind === "create") as { repo?: number; labels?: string[] }[];
  expect(creates).toHaveLength(2);
  expect(creates[1]!.repo).toBe(web.id);
  expect(creates[1]!.labels).toEqual(["bug"]);
  expect(await listed(page, word)).toEqual([id]);
});

test("a failed write outranks the word on an issue created while away, which shows again once it's dismissed", async ({ page }) => {
  await signIn(page);
  await view(page, "is:open repo:docs");
  await fake("/faults/latency", { endpoint: CREATE, ms: 3000 });
  await page.getByRole("link", { name: "New issue" }).click();
  const word = unique();
  await title(page).fill(`Made beside a failure ${word}`);
  await submit(page).click();
  await expect(submit(page)).toHaveText("Creating…");
  const elsewhere = await openRow(page, word);
  await expect(createStatus(page)).toContainText("Created the issue in docs", { timeout: 10_000 });
  const [madeId] = await listed(page, word);
  made.push(madeId!);

  // A close on the open issue fails; on another issue, it's off screen, and the slot shows it.
  const d = (await (await page.request.get(`/api/issues/${elsewhere}`)).json()) as { owner: string; repo: string; number: number };
  await fake("/faults/fail", { endpoint: `PATCH /repos/${d.owner}/${d.repo}/issues/${d.number}`, status: 403, count: 1 });
  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(page.locator('[data-perf="state-note"]')).toContainText("Couldn't close");
  const other = rows(page).and(page.locator(`:not([data-id="${elsewhere}"]):not([data-id="${madeId}"])`)).first();
  const otherId = await other.getAttribute("data-id");
  await other.click();
  await page.waitForURL((u) => u.pathname === `/issues/${otherId}`);
  const slot = page.locator('[data-perf="status"]');
  await expect(slot).toContainText(`Couldn't close ${d.repo}#${d.number}`);
  await expect(createStatus(page)).toHaveCount(0);
  await slot.getByRole("button", { name: "Dismiss" }).click();
  await expect(createStatus(page)).toContainText("Created the issue in docs");
});
