// The detail's Labels, Assignees and Milestone pickers in a real browser, against Fake GitHub:
// each pick sent at once as its own write, pending on its own row, a refusal reverted in place,
// and a label renamed on GitHub reaching an open picker and the rows.
//
// After writes.spec.ts (playwright.config.ts). As there, every issue written to sits below the
// default list's top 40 rows and is left closed, so it's out of the default list again.
//
// Safe side by side, and with `--repeat-each`, as writes.spec.ts is: each test claims the issue
// it opens (claims.ts) and sets faults only on that issue's endpoints, removing just those after.
// Renaming a repo's label changes what every test's picker lists, and the test reads a row at the
// top of the list: it takes the stack to itself (`@alone`).
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, exclusive, shared, type Issue } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";
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

/** GitHub's endpoints for adding a label to `i`, removing one, and changing `i` (the milestone). */
const ISSUE_PATH = (i: Issue) => `/repos/${i.owner}/${i.repo}/issues/${i.number}`;
const LABELS = (i: Issue) => `POST ${ISSUE_PATH(i)}/labels`;
const UNLABEL = (i: Issue) => `DELETE ${ISSUE_PATH(i)}/labels/*`;
const ISSUE = (i: Issue) => `PATCH ${ISSUE_PATH(i)}`;

const rows = (page: Page) => page.locator('[data-perf="row"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');
const propRow = (page: Page, prop: string) => page.locator(`dd[data-perf="${prop}"]`);
const opener = (page: Page, prop: string) => page.locator(`[data-perf="pick-${prop}"]`);
const picker = (page: Page) => page.locator('[data-perf="picker"]');
const option = (page: Page, name: string) => picker(page).locator(`[data-perf="pick"][data-name="${name}"]`);
const labelsShown = (page: Page) => propRow(page, "labels").locator('[data-perf="label"]');

type Row = { id: number; repo: string; labels: { name: string }[]; assignees: { login: string }[] };

/**
 * An unclaimed issue below the top (in `repo` if given, and passing `fits`), claimed for this
 * test. One repo's issues are looked for through the whole list: a few are spread over it.
 */
async function claim(page: Page, repo?: string, fits: (r: Issue) => boolean = () => true): Promise<Issue> {
  return claimBelowTheTop(page, (r) => (repo === undefined || r.repo === repo) && fits(r), repo === undefined ? undefined : 2000);
}

/**
 * Gives `issue` at least `n` labels on GitHub, and waits for beghu to have them: few of a repo's
 * issues already have that many, and tests side by side each need their own.
 */
async function withLabels(page: Page, issue: Issue, n: number): Promise<Issue> {
  const has = issue.labels.map((l) => l.name);
  const add = ["bug", "frontend", "backend", "documentation"].filter((l) => !has.includes(l)).slice(0, Math.max(0, n - has.length));
  if (add.length === 0) return issue;
  devCtl(["fake", "edit", issue.ref, "--label", add.join(",")]);
  const want = [...has, ...add].sort().join(",");
  await expect.poll(() => labelsOf(page, issue.id), { timeout: SHOWS_WITHIN_MS }).toBe(want);
  return { ...issue, labels: [...has, ...add].map((name) => ({ name })) };
}

async function signIn(page: Page, login = "tomsj"): Promise<void> {
  // Off the app first: a page still running it as another account would take the new session
  // for its own ended one and leave for sign-in itself, over this navigation.
  await page.goto("about:blank");
  await page.goto(`/auth/login?login=${login}`);
  await page.waitForURL((u) => u.pathname === "/");
  await expect(rows(page).first()).toBeVisible();
}

/** Opens `/issues/:id` and waits for the stream's opening reset to have been handled. */
async function open(page: Page, id: number): Promise<void> {
  const reset = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/issues/${id}` && r.ok());
  await page.goto(`/issues/${id}`);
  await reset;
  await expect(composer(page)).toBeVisible();
}

/** Leaves `issue` closed, out of the default list, and waits for beghu to have the close. */
async function closeForGood(page: Page, issue: { id: number; ref: string }): Promise<void> {
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, {
      timeout: SHOWS_WITHIN_MS,
    })
    .toBe("closed");
}

/** The ops the page sends from now on, in the order it sends them. */
function opsSent(page: Page): { kind: string; label?: string; login?: string; milestone?: number | null }[] {
  const sent: { kind: string }[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/ops" && r.method() === "POST") {
      const body = r.postDataJSON() as { op: { kind: string }; resend?: boolean };
      if (!body.resend) sent.push(body.op);
    }
  });
  return sent;
}

/** Where an element's box is: its top and height. */
async function box(page: Page, selector: string): Promise<{ top: number; height: number }> {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });
}

/** From now on, per frame: the labels `page`'s labels row shows, sorted and joined. */
async function sampleLabels(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    const frame = () => {
      const names = [...document.querySelectorAll('dd[data-perf="labels"] [data-perf="label"]')].map((l) => l.textContent ?? "");
      w.seen.push(names.sort().join(","));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * The frames `sampleLabels` saw, checked for flicker: each of `picks` (each toggled once) shows or
 * doesn't throughout, then switches once and stays; and the row ends on `final`.
 */
async function expectNoFlicker(page: Page, picks: string[], final: string): Promise<void> {
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  expect(seen.at(-1)).toBe(final);
  for (const name of picks) {
    const shown = seen.map((s) => s.split(",").includes(name));
    const switches = shown.filter((v, i) => i > 0 && v !== shown[i - 1]).length;
    expect(switches, `${name} switched ${switches} times`).toBeLessThanOrEqual(1);
  }
}

/** Five labels to toggle on `issue`, and the labels it has once each is toggled. */
function toggles(issue: Row): { picks: string[]; final: string } {
  const picks = ["p0", "p1", "p2", "ux", "question"];
  const want = new Set(issue.labels.map((l) => l.name));
  for (const name of picks) {
    if (want.has(name)) want.delete(name);
    else want.add(name);
  }
  return { picks, final: [...want].sort().join(",") };
}

/** The issue's labels as the server has them, sorted and joined. */
async function labelsOf(page: Page, id: number): Promise<string> {
  return ((await (await page.request.get(`/api/issues/${id}`)).json()) as Row).labels
    .map((l) => l.name)
    .sort()
    .join(",");
}

/** The detail panel at its narrowest, so a property row's line has little room left. */
async function narrowPanel(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("beghu.detail-width", "360"));
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
  release = [await (info.tags.includes("@alone") ? exclusive() : shared())];
  info.setTimeout(own + (Date.now() - waiting));
  faulted.clear();
  await page.setViewportSize({ width: 1400, height: 900 });
});

test.afterEach(async () => {
  try {
    for (const endpoint of faulted) await fake("/faults", { endpoint }, "DELETE");
  } finally {
    for (const r of release.reverse()) r();
  }
});

test("the labels picker ticks the issue's labels and filters as you type", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page, undefined, (r) => r.labels.length > 0);
  await open(page, issue.id);
  await opener(page, "labels").click();
  await expect(picker(page)).toBeVisible();
  for (const l of issue.labels) await expect(option(page, l.name)).toHaveAttribute("aria-selected", "true");
  const off = ["bug", "frontend", "backend", "p0", "p1"].find((n) => !issue.labels.some((l) => l.name === n))!;
  await expect(option(page, off)).toHaveAttribute("aria-selected", "false");

  await page.keyboard.type("end");
  // Only the labels whose name or description holds it: "frontend", "backend".
  await expect(picker(page).locator('[data-perf="pick"]')).toHaveCount(2);
  await expect(option(page, "frontend")).toBeVisible();
  await expect(option(page, "backend")).toBeVisible();
  await page.keyboard.type("zzz");
  await expect(picker(page)).toContainText("No labels match");

  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();
  await expect(opener(page, "labels")).toBeFocused();
  // Its button opens and closes it; a press elsewhere closes it too.
  await opener(page, "labels").click();
  await expect(picker(page)).toBeVisible();
  await opener(page, "labels").click();
  await expect(picker(page)).toBeHidden();
  await opener(page, "milestone").click();
  await expect(picker(page)).toBeVisible();
  await page.locator('h2[data-perf="title"]').click();
  await expect(picker(page)).toBeHidden();
});

test("toggling five labels sends five ops in order, pending on the labels row only, and lands", async ({ page }) => {
  // Five slowed GitHub calls, one after another.
  test.slow();
  await signIn(page);
  const issue = await claim(page);
  try {
    await open(page, issue.id);
    const had = issue.labels.map((l) => l.name);
    const picks = ["p0", "p1", "p2", "ux", "question"];
    const want = new Set(had);
    const expected = picks.map((name) => {
      const on = want.has(name);
      if (on) want.delete(name);
      else want.add(name);
      return { kind: on ? "label_remove" : "label_add", issue: issue.id, label: name };
    });
    const sent = opsSent(page);
    const assigneesBefore = await box(page, 'dd[data-perf="assignees"]');
    const milestoneBefore = await box(page, 'dd[data-perf="milestone"]');
    // GitHub is slow: every pick is still pending when the last is made.
    await fake("/faults/latency", { endpoint: LABELS(issue), ms: 1000 });
    await fake("/faults/latency", { endpoint: UNLABEL(issue), ms: 1000 });

    await opener(page, "labels").click();
    for (const name of picks) await option(page, name).click();
    await expect.poll(() => sent.length).toBe(5);
    expect(sent).toEqual(expected);
    // Pending: the labels row shows them at once with its dot; the other rows didn't change.
    await expect(propRow(page, "labels").locator('[data-perf="pending"]')).toBeVisible();
    await expect(labelsShown(page)).toHaveText([...want].sort((a, b) => a.localeCompare(b)), { ignoreCase: true });
    expect(await box(page, 'dd[data-perf="assignees"]')).toEqual(assigneesBefore);
    expect((await box(page, 'dd[data-perf="milestone"]')).height).toEqual(milestoneBefore.height);
    for (const name of picks) await expect(option(page, name)).toHaveAttribute("aria-selected", want.has(name) ? "true" : "false");

    // Confirmed: the dot goes, and GitHub's data says the same once its webhooks are in.
    await expect(propRow(page, "labels").locator('[data-perf="pending"]')).toBeHidden({ timeout: 30_000 });
    const labels = async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as Row).labels.map((l) => l.name).sort();
    await expect.poll(labels, { timeout: SHOWS_WITHIN_MS }).toEqual([...want].sort());
    await expect(labelsShown(page)).toHaveText([...want].sort((a, b) => a.localeCompare(b)), { ignoreCase: true });
  } finally {
    await closeForGood(page, issue);
  }
});

test("quick picks never flicker back while GitHub's webhooks for them land", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page);
  try {
    await open(page, issue.id);
    const { picks, final } = toggles(issue);
    await sampleLabels(page);
    // GitHub is quick: all five land within a second or two, so their webhooks, about a second
    // later, share an `updated_at` and may come in any order.
    await opener(page, "labels").click();
    for (const name of picks) await option(page, name).click();
    await expect.poll(() => labelsOf(page, issue.id), { timeout: SHOWS_WITHIN_MS }).toBe(final);
    await page.waitForTimeout(4_000);
    await expectNoFlicker(page, picks, final);
  } finally {
    await closeForGood(page, issue);
  }
});

test("another tab of the same account never flickers while the first picks quickly", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page);
  const other = await page.context().newPage();
  try {
    await open(other, issue.id);
    await open(page, issue.id);
    const { picks, final } = toggles(issue);
    await sampleLabels(other);
    await opener(page, "labels").click();
    for (const name of picks) await option(page, name).click();
    // The other tab has no pending writes: it shows the mirror, pushed to it as it changes.
    await expect.poll(() => labelsOf(page, issue.id), { timeout: SHOWS_WITHIN_MS }).toBe(final);
    await page.waitForTimeout(4_000);
    await expectNoFlicker(other, picks, final);
  } finally {
    await other.close();
    await closeForGood(page, issue);
  }
});

test("a refused pick reverts in one frame with its marker on the row, and nothing moves", async ({ page }) => {
  // GitHub refuses the label (a 403); the role, re-read, allows it, so that's the reason. A Read
  // repo offers no picker at all (roles.spec.ts).
  await signIn(page);
  const issue = await claim(page);
  try {
    await open(page, issue.id);
    const name = ["p0", "p1", "p2", "ux"].find((n) => !issue.labels.some((l) => l.name === n))!;
    await fake("/faults/latency", { endpoint: LABELS(issue), ms: 800, count: 1 });
    await fake("/faults/fail", { endpoint: LABELS(issue), status: 403, count: 1 });
    await opener(page, "labels").click();
    await expect(option(page, name)).toBeVisible();
    // Per frame from the pick on: whether the label shows, whether the marker does, and where the
    // byline under the property rows sits.
    await page.evaluate((name) => {
      const w = window as unknown as { frames: { chip: boolean; marker: boolean; below: number }[] };
      w.frames = [];
      const frame = () => {
        const row = document.querySelector('dd[data-perf="labels"]')!;
        const chip = [...row.querySelectorAll('[data-perf="label"]')].some((c) => c.textContent === name);
        const marker = !!row.querySelector('[data-perf="pick-failed"]');
        const below = document.querySelector('dl')!.getBoundingClientRect().bottom;
        if (chip || marker || w.frames.length) w.frames.push({ chip, marker, below });
        if (!marker) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, name);
    await option(page, name).click();
    await page.keyboard.press("Escape");
    const marker = propRow(page, "labels").locator('[data-perf="pick-failed"]');
    await expect(marker).toContainText(`Couldn't add ${name} — GitHub didn't apply this change`);
    await expect(marker.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(marker.getByRole("button", { name: "Dismiss" })).toBeVisible();
    // The row's opener is described by its marker, so a screen reader hears the failure there.
    await expect(opener(page, "labels")).toHaveAccessibleDescription(new RegExp(`Couldn't add ${name} — GitHub didn't apply this change`));

    const frames = await page.evaluate(() => (window as unknown as { frames: { chip: boolean; marker: boolean; below: number }[] }).frames);
    expect(frames[0]!.chip).toBe(true);
    // No frame between the pending label and its marker shows neither, or both.
    expect(frames.every((f) => f.chip !== f.marker)).toBe(true);
    expect(frames.at(-1)!.marker).toBe(true);
    // The property rows kept their height throughout.
    expect(new Set(frames.map((f) => f.below)).size).toBe(1);
    await expect(labelsShown(page).filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(0);
    // Its own row only: not the state's, nor the status slot, which is for issues that aren't open.
    await expect(page.locator('[data-perf="state-note"]')).not.toContainText("Couldn't");
    await expect(page.locator('[data-perf="status"]')).not.toContainText("Couldn't");

    await marker.getByRole("button", { name: "Dismiss" }).click();
    await expect(marker).toHaveCount(0);
  } finally {
    await signIn(page);
    await closeForGood(page, issue);
  }
});

test("assignees are added and removed from their picker", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page, undefined, (r) => !r.assignees.some((a) => a.login === "ilze-k"));
  try {
    await open(page, issue.id);
    await opener(page, "assignees").click();
    await expect(option(page, "ilze-k")).toHaveAttribute("aria-selected", "false");
    await page.keyboard.type("ilze");
    await page.keyboard.press("Enter");
    await expect(propRow(page, "assignees").locator('[data-perf="assignee"]').filter({ hasText: "ilze-k" })).toBeVisible();
    await expect(option(page, "ilze-k")).toHaveAttribute("aria-selected", "true");
    await expect(propRow(page, "assignees").locator('[data-perf="pending"]')).toBeHidden({ timeout: SHOWS_WITHIN_MS });
    await option(page, "ilze-k").click();
    await expect(propRow(page, "assignees").locator('[data-perf="assignee"]').filter({ hasText: "ilze-k" })).toHaveCount(0);
    await expect(propRow(page, "assignees").locator('[data-perf="pending"]')).toBeHidden({ timeout: SHOWS_WITHIN_MS });
    const d = (await (await page.request.get(`/api/issues/${issue.id}`)).json()) as Row;
    expect(d.assignees.map((a) => a.login)).not.toContain("ilze-k");
  } finally {
    await closeForGood(page, issue);
  }
});

test("the milestone is set and cleared, and of two quick picks the last wins", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page);
  try {
    await open(page, issue.id);
    const now = ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { milestone: { number: number } | null }).milestone;
    const milestones = (await (await page.request.get(`/api/repos/${await repoId(page, issue.id)}/milestones`)).json()) as {
      number: number;
      title: string;
    }[];
    // Two it isn't in: picking the one it's in would take it out.
    const [first, second] = milestones.filter((m) => m.number !== now?.number);
    const title = page.locator('[data-perf="milestone-title"]');
    const sent = opsSent(page);
    // The first pick is slow to reach GitHub; the second is made while it's on its way.
    await fake("/faults/latency", { endpoint: ISSUE(issue), ms: 1500, count: 1 });
    await opener(page, "milestone").click();
    await option(page, first!.title).click();
    await expect(picker(page)).toBeHidden();
    await expect(title).toHaveText(first!.title);
    await opener(page, "milestone").click();
    await option(page, second!.title).click();
    await expect(title).toHaveText(second!.title);
    await expect(propRow(page, "milestone").locator('[data-perf="pending"]')).toBeHidden({ timeout: SHOWS_WITHIN_MS });
    expect(sent.map((o) => o.kind)).toEqual(["milestone_set", "milestone_set"]);
    // Both changes may land within one second on GitHub, so their webhooks may carry the same
    // `updated_at`: the first one's, arriving after the second's answer, can't be ordered by it,
    // and the server reads the issue again rather than apply it.
    const milestone = async () =>
      ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { milestone: { title: string } | null }).milestone?.title ?? null;
    await expect.poll(milestone, { timeout: SHOWS_WITHIN_MS }).toBe(second!.title);
    await expect(title).toHaveText(second!.title);

    await opener(page, "milestone").click();
    await option(page, "No milestone").click();
    await expect(propRow(page, "milestone")).toContainText("None");
    await expect(propRow(page, "milestone").locator('[data-perf="pending"]')).toBeHidden({ timeout: SHOWS_WITHIN_MS });
    await expect.poll(milestone, { timeout: SHOWS_WITHIN_MS }).toBeNull();
  } finally {
    await closeForGood(page, issue);
  }
});

async function repoId(page: Page, issue: number): Promise<number> {
  return ((await (await page.request.get(`/api/issues/${issue}`)).json()) as { repo_id: number }).repo_id;
}

test("a label renamed on GitHub updates the open picker, the detail and the list live", { tag: "@alone" }, async ({ page }) => {
  await signIn(page);
  const issue = await claim(page, "web", (r) => r.labels.some((l) => l.name === "ux"));
  // A row on screen that carries it too.
  const top = ((await (await page.request.get("/api/issues")).json()) as { rows: Row[] }).rows
    .slice(0, 15)
    .find((r) => r.repo === "web" && r.labels.some((l) => l.name === "ux"))!;
  // A name that sorts first, so a row's first label slot shows it.
  const renamed = `a11y ${Date.now().toString(36)}`;
  let done = false;
  try {
    await open(page, issue.id);
    await opener(page, "labels").click();
    await expect(option(page, "ux")).toHaveAttribute("aria-selected", "true");
    devCtl(["fake", "label", "web", "ux", "--rename", renamed]);
    done = true;
    await expect(option(page, renamed)).toHaveAttribute("aria-selected", "true", { timeout: SHOWS_WITHIN_MS });
    await expect(option(page, "ux")).toHaveCount(0);
    await expect(labelsShown(page).filter({ hasText: renamed })).toBeVisible();
    await expect(page.locator(`[data-perf="row"][data-id="${top.id}"]`)).toContainText(renamed);
  } finally {
    if (done) devCtl(["fake", "label", "web", renamed, "--rename", "ux"]);
    await expect(labelsShown(page).filter({ hasText: /^ux$/ })).toBeVisible({ timeout: SHOWS_WITHIN_MS });
  }
});

test("a refused removal comes back with its marker in the row's slot, and nothing moves", async ({ page }) => {
  await narrowPanel(page);
  // GitHub refuses the removal (a 403); the role, re-read, allows it.
  await signIn(page);
  const issue = await withLabels(page, await claim(page), 2);
  try {
    await open(page, issue.id);
    const name = issue.labels[0]!.name;
    await fake("/faults/fail", { endpoint: UNLABEL(issue), status: 403, count: 1 });
    const below = () => box(page, "dl").then((b) => b.top + b.height);
    const before = await below();
    await opener(page, "labels").click();
    await option(page, name).click();
    await page.keyboard.press("Escape");
    const marker = propRow(page, "labels").locator('[data-perf="pick-failed"]');
    await expect(marker).toContainText(`Couldn't remove ${name} — GitHub didn't apply this change`);
    await expect(labelsShown(page).filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(1);
    expect(await below()).toBe(before);
    await marker.getByRole("button", { name: "Dismiss" }).click();
    await expect(marker).toHaveCount(0);
    expect(await below()).toBe(before);
  } finally {
    await signIn(page);
    await closeForGood(page, issue);
  }
});

test("on a full labels row a refused pick's marker keeps to one line, with +N for an earlier one", async ({ page }) => {
  await narrowPanel(page);
  // GitHub refuses both picks (403s).
  await signIn(page);
  const issue = await withLabels(page, await claim(page), 3);
  try {
    await open(page, issue.id);
    const off = ["p0", "p1", "p2", "ux", "question"].filter((n) => !issue.labels.some((l) => l.name === n));
    await fake("/faults/fail", { endpoint: LABELS(issue), status: 403, count: 2 });
    const row = () => box(page, 'dd[data-perf="labels"]');
    const before = await row();
    const milestone = await box(page, 'dd[data-perf="milestone"]');
    await opener(page, "labels").click();
    await option(page, off[0]!).click();
    const marker = propRow(page, "labels").locator('[data-perf="pick-failed"]');
    await expect(marker).toContainText(`Couldn't add ${off[0]}`);
    await option(page, off[1]!).click();
    // The latest failure, and how many more there are.
    await expect(marker).toContainText(`Couldn't add ${off[1]}`);
    await expect(marker).toContainText("+1");
    await page.keyboard.press("Escape");
    expect(await row()).toEqual(before);
    expect(await box(page, 'dd[data-perf="milestone"]')).toEqual(milestone);
    // Dismissing the latest shows the one before it.
    await marker.getByRole("button", { name: "Dismiss" }).click();
    await expect(marker).toContainText(`Couldn't add ${off[0]}`);
    await expect(marker).not.toContainText("+1");
    expect(await row()).toEqual(before);
  } finally {
    await signIn(page);
    await closeForGood(page, issue);
  }
});

test("a picker is used from the keyboard alone, and closes when focus leaves it", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page);
  try {
    await open(page, issue.id);
    const sent = opsSent(page);
    await opener(page, "labels").focus();
    await page.keyboard.press("Enter");
    const filter = picker(page).getByRole("combobox");
    await expect(filter).toBeFocused();
    await expect(filter).toHaveAttribute("aria-autocomplete", "list");
    // Nothing matches: no option is active, and ArrowDown makes none so.
    await page.keyboard.type("zzz");
    await expect(picker(page)).toContainText("No labels match");
    await page.keyboard.press("ArrowDown");
    await expect(filter).not.toHaveAttribute("aria-activedescendant");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await expect(picker(page).locator('[data-perf="pick"]').first()).toBeVisible();
    await page.keyboard.press("ArrowDown");
    // The active option is one that exists, and Enter picks it.
    await expect(filter).toHaveAttribute("aria-activedescendant", /.+/);
    const active = await filter.getAttribute("aria-activedescendant");
    const chosen = picker(page).locator(`[id="${active}"]`);
    await expect(chosen).toHaveAttribute("data-index", "1");
    const name = (await chosen.getAttribute("data-name"))!;
    const was = await chosen.getAttribute("aria-selected");
    await page.keyboard.press("Enter");
    await expect(option(page, name)).not.toHaveAttribute("aria-selected", was!);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ label: name });
    // Focus moves on: the picker closes.
    await page.keyboard.press("Tab");
    await expect(picker(page)).toBeHidden();
  } finally {
    await closeForGood(page, issue);
  }
});

test("a row's key opens its picker from the issue, and Enter picks what the typing filtered to", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page, undefined, (r) => !r.labels.some((l) => l.name === "frontend"));
  try {
    await open(page, issue.id);
    const sent = opsSent(page);
    // The keys work with the focus in the issue.
    await page.locator('[data-perf="detail"]').focus();
    await page.keyboard.press("l");
    const filter = picker(page).getByRole("combobox", { name: "Filter labels" });
    await expect(filter).toBeFocused();
    await page.keyboard.type("frontend");
    await expect(picker(page).locator('[data-perf="pick"]')).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(option(page, "frontend")).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ kind: "label_add", label: "frontend" });
    // Labels stay open for more; Escape closes it, back on its row's button.
    await page.keyboard.press("Escape");
    await expect(picker(page)).toBeHidden();
    await expect(opener(page, "labels")).toBeFocused();
    await expect(labelsShown(page).filter({ hasText: "frontend" })).toHaveCount(1);
    await expect.poll(() => labelsOf(page, issue.id), { timeout: SHOWS_WITHIN_MS }).toContain("frontend");
  } finally {
    await closeForGood(page, issue);
  }
});

test("the filter keeps focus when the picker's gaps are pressed, and aria-controls names only a list that's there", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page);
  await open(page, issue.id);
  // Who can be assigned is held until the test lets it through: the picker shows Loading.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/repos\/\d+\/assignees$/, async (route) => {
    await held;
    await route.continue();
  });
  await opener(page, "assignees").click();
  const filter = picker(page).getByRole("combobox");
  await expect(filter).toBeFocused();
  await expect(picker(page)).toContainText("Loading");
  await expect(filter).not.toHaveAttribute("aria-controls");
  // Presses on the picker's own non-controls (the filter's margin, the Loading note) leave it
  // open with the focus in its filter: the issue's scroller, which takes focus, never gets it.
  const f = (await filter.boundingBox())!;
  await page.mouse.click(f.x + f.width / 2, f.y - 4);
  await expect(picker(page)).toBeVisible();
  await expect(filter).toBeFocused();
  await picker(page).getByText("Loading").click();
  await expect(picker(page)).toBeVisible();
  await expect(filter).toBeFocused();
  release();
  const list = picker(page).getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(filter).toHaveAttribute("aria-controls", (await list.getAttribute("id"))!);
  // The list's bottom padding, below its last option.
  const b = (await list.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 1);
  await expect(filter).toBeFocused();
  await expect(picker(page)).toBeVisible();
});

test("picker code that fails to load reloads the URL once, then says so with Retry", async ({ page }) => {
  await signIn(page);
  const issue = await claim(page);
  const chunk = /\/Pickers[.-]/;
  await open(page, issue.id);
  await page.route(chunk, (r) => r.abort());
  const loads: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname);
  });
  // A deploy that replaced the build is the usual cause: a fresh page names the new chunks.
  await opener(page, "labels").click();
  await expect.poll(() => loads).toEqual([`/issues/${issue.id}`]);
  await expect(composer(page)).toBeVisible();
  // Reloaded once already: this time it says so in place, the detail usable throughout.
  await opener(page, "labels").click();
  const failed = propRow(page, "labels").getByRole("alert");
  await expect(failed).toContainText("Couldn't load the picker");
  await expect(failed).toContainText("beghu may have been updated");
  expect(loads).toHaveLength(1);

  await page.unroute(chunk);
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(picker(page)).toBeVisible();
  expect(loads).toHaveLength(1);
});
