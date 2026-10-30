// Roles in a real browser, against Fake GitHub: what the account's role allows on an issue
// (roles.rs decides, the detail carries `can` and the role line) and how the tab shows the rest.
// ilze-k has Write on web, Read on cli and Triage on docs.
//
// An op the role leaves out loses its affordance in place, hidden with its room kept; its key
// refuses, pulsing the role line with the reason (`role="status"`), and the hint bar and the `?`
// overlay dim it. A role changed on GitHub reaches open tabs as a `roles` push, without a reload
// and keeping what was typed; here a refusal in another tab re-reads it, as the first write the
// new role refuses does. An archived repo is read-only; a locked issue takes comments only from
// Write and up. The relationship picker dims what the role can't link.
//
// Last but prefs, on its own (playwright.config.ts): it changes ilze-k's roles, archives a repo and
// locks issues, which other tabs would see. Each test puts back what it changed.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { SHOWS_WITHIN_MS } from "./push";
import { devCtl } from "./stack";

type Detail = { id: number; repo: string; number: number; title: string; author: { login: string } | null };

const roleLine = (page: Page) => page.locator('[data-perf="role-line"]');
const composer = (page: Page) => page.locator('[data-perf="composer"]');
const commentBox = (page: Page) => composer(page).getByRole("textbox", { name: "Comment" });
const closeButton = (page: Page) => composer(page).locator('[data-perf="close"]');
const editTitle = (page: Page) => page.locator('[data-perf="edit-title"]');
const pickLabels = (page: Page) => page.locator('[data-perf="pick-labels"]');
const addRelates = (page: Page) => page.locator('[data-perf="add-relates"]');
const unique = (what: string) => `${what} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function signIn(page: Page, login: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`/auth/login?login=${login}`);
  await page.waitForURL((u) => u.pathname === "/");
}

/** Open issues in `repo` that `login` didn't open, from the top of its list. */
async function othersIssues(page: Page, repo: string, login: string, n: number): Promise<Detail[]> {
  const res = await page.request.get(`/api/issues?q=${encodeURIComponent(`is:open repo:${repo}`)}`);
  const rows = ((await res.json()) as { rows: { id: number }[] }).rows;
  const out: Detail[] = [];
  for (const r of rows) {
    const d = (await (await page.request.get(`/api/issues/${r.id}`)).json()) as Detail;
    if (d.author?.login !== login) out.push(d);
    if (out.length === n) return out;
  }
  throw new Error(`fewer than ${n} open issues of others' in ${repo}`);
}

/** Opens `/issues/:id`, and waits for its detail and its composer. */
async function openIssue(page: Page, id: number): Promise<void> {
  await page.goto(`/issues/${id}`);
  await expect(page.locator(`[data-perf="detail"][data-id="${id}"]`)).toBeVisible();
  await expect(composer(page)).toBeVisible();
}

/** Gives ilze-k `role` on `repo` on GitHub, and has beghu read it at once: a sign-in re-reads. */
async function setRole(context: BrowserContext, repo: string, role: string): Promise<void> {
  devCtl(["fake", "role", "ilze-k", repo, role]);
  const page = await context.newPage();
  await signIn(page, "ilze-k");
  await page.close();
}

test("on someone else's issue Read keeps the values and loses the affordances in place; a key says why", async ({ page }) => {
  await signIn(page, "ilze-k");
  const [issue] = await othersIssues(page, "cli", "ilze-k", 1);
  await openIssue(page, issue!.id);

  await expect(roleLine(page)).toHaveText("Read on cli");
  // Nothing is announced yet: opening an issue isn't news.
  await expect(page.locator('[data-perf="role-refusal"]')).toHaveText("");
  // Comment stays; Close, Edit, the pickers and the links go, their room kept.
  await expect(commentBox(page)).toBeVisible();
  await expect(closeButton(page)).toBeHidden();
  await expect(closeButton(page)).toHaveAttribute("data-withheld", "true");
  await expect(editTitle(page)).toBeHidden();
  await expect(pickLabels(page)).toHaveAttribute("data-withheld", "true");
  await expect(pickLabels(page)).not.toHaveRole("button");
  await expect(addRelates(page)).toBeHidden();

  // `l` opens no picker: the role line pulses and says why, and it's announced (`role="status"`).
  await page.locator('[data-perf="detail"]').focus();
  await page.keyboard.press("l");
  await expect(roleLine(page)).toHaveText("Labels: you have Read on cli");
  await expect(roleLine(page)).toHaveAttribute("data-refused", "true");
  await expect(page.getByRole("status").filter({ hasText: "Labels: you have Read on cli" })).toHaveAttribute("data-perf", "role-refusal");
  await expect(page.locator('[data-perf="picker"]')).toHaveCount(0);
  await page.keyboard.press("Shift+X");
  await expect(roleLine(page)).toHaveText("Close / reopen: you have Read on cli, which closes or reopens only issues you opened");
  // Back to the role once the reason has been read.
  await expect(roleLine(page)).toHaveText("Read on cli", { timeout: 10_000 });

  // The hint bar dims what the role refuses here, with the reason; Comment isn't dimmed.
  const hint = (what: string) => page.locator('[data-perf="hints"] > span', { hasText: what });
  await expect(hint("Labels")).toHaveAttribute("aria-disabled", "true");
  await expect(hint("Labels")).toHaveAttribute("title", "you have Read on cli");
  await expect(hint("Comment")).not.toHaveAttribute("aria-disabled", "true");
  // So does the `?` overlay.
  await page.keyboard.press("?");
  const help = page.locator('[data-perf="key-help"]');
  await expect(help).toBeVisible();
  const row = (what: string) => help.locator("tr", { has: page.locator("td", { hasText: new RegExp(`^${what}$`) }) });
  await expect(row("Labels")).toHaveAttribute("aria-disabled", "true");
  await expect(row("Labels")).toContainText("you have Read on cli");
  await expect(row("Edit title")).toContainText("you have Read on cli, which edits only issues you opened");
  await expect(row("Comment")).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});

test("a role change on GitHub reaches an open tab through roles, without a reload, keeping typed text", async ({ page, context }) => {
  await signIn(page, "ilze-k");
  const [issue, other] = await othersIssues(page, "web", "ilze-k", 2);
  await openIssue(page, issue!.id);
  // Write: everything, and no role line.
  await expect(roleLine(page)).toHaveText("");
  await expect(closeButton(page)).toBeVisible();
  const draft = unique("A draft");
  await commentBox(page).fill(draft);
  await editTitle(page).click();
  const titleBox = page.locator('[data-perf="title-editor"] [data-perf="edit-box"]');
  await expect(titleBox).toBeVisible();
  const typed = unique("A title");
  await titleBox.fill(typed);
  const labelsAt = () => page.locator('dd[data-perf="labels"]').evaluate((el) => el.getBoundingClientRect().top);
  const before = await labelsAt();
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));

  devCtl(["fake", "role", "ilze-k", "web", "read"]);
  try {
    // Another tab still offers Close; GitHub refuses it, which re-reads the role at once.
    const other_tab = await context.newPage();
    await openIssue(other_tab, other!.id);
    await closeButton(other_tab).getByRole("button", { name: "Close issue" }).click();
    await expect(other_tab.locator('[data-perf="state-note"]')).toContainText("you have Read on web, which closes or reopens only issues you opened");
    await other_tab.close();

    await expect(roleLine(page)).toHaveText("Read on web", { timeout: SHOWS_WITHIN_MS });
    await expect(closeButton(page)).toBeHidden();
    await expect(pickLabels(page)).toHaveAttribute("data-withheld", "true");
    // Nothing typed was lost, and nothing moved.
    await expect(commentBox(page)).toHaveValue(draft);
    await expect(titleBox).toHaveValue(typed);
    expect(await labelsAt()).toBe(before);
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
  } finally {
    await setRole(context, "web", "write");
  }
  await expect(roleLine(page)).toHaveText("", { timeout: SHOWS_WITHIN_MS });
  await expect(closeButton(page)).toBeVisible();
});

test("a Triage title edit on someone else's issue, which GitHub answers unchanged, fails with the role's reason", async ({ page, context }) => {
  await signIn(page, "ilze-k");
  const [issue] = await othersIssues(page, "web", "ilze-k", 1);
  await openIssue(page, issue!.id);
  await editTitle(page).click();
  const titleBox = page.locator('[data-perf="title-editor"] [data-perf="edit-box"]');
  await titleBox.fill(unique("Renamed"));
  // GitHub takes it as Triage now: a 200 that leaves the title as it was.
  devCtl(["fake", "role", "ilze-k", "web", "triage"]);
  try {
    await titleBox.press("Enter");
    await expect(page.locator('[data-perf="edit-failed"]')).toHaveText("Couldn't save the title — you have Triage on web, which edits only issues you opened", {
      timeout: SHOWS_WITHIN_MS,
    });
    const now = (await (await page.request.get(`/api/issues/${issue!.id}`)).json()) as Detail;
    expect(now.title).toBe(issue!.title);
    // The refusal re-read the role: the tab follows.
    await expect(roleLine(page)).toHaveText("Triage on web", { timeout: SHOWS_WITHIN_MS });
  } finally {
    await setRole(context, "web", "write");
  }
});

test("an archived repo shows 'Archived repo · read-only' and offers no affordances", async ({ page }) => {
  await signIn(page, "ilze-k");
  const [issue] = await othersIssues(page, "docs", "ilze-k", 1);
  await openIssue(page, issue!.id);
  await expect(roleLine(page)).toHaveText("Triage on docs");
  devCtl(["fake", "archive", "docs"]);
  try {
    await expect(roleLine(page)).toHaveText("Archived repo · read-only", { timeout: SHOWS_WITHIN_MS });
    await expect(commentBox(page)).toHaveCount(0);
    await expect(composer(page).locator('[data-perf="no-comment"]')).toHaveText("No comments here: docs is archived, so it's read-only.");
    await expect(composer(page).getByRole("button")).toHaveCount(0);
    await expect(editTitle(page)).toBeHidden();
    await expect(page.locator('[data-perf="edit-body"]')).toBeHidden();
    for (const prop of ["labels", "assignees", "milestone"]) {
      await expect(page.locator(`[data-perf="pick-${prop}"]`)).toHaveAttribute("data-withheld", "true");
    }
    for (const kind of ["blocked_by", "blocking", "relates", "parent", "sub"]) {
      await expect(page.locator(`[data-perf="add-${kind}"]`)).toBeHidden();
    }
  } finally {
    devCtl(["fake", "unarchive", "docs"]);
  }
  await expect(roleLine(page)).toHaveText("Triage on docs", { timeout: SHOWS_WITHIN_MS });
  await expect(commentBox(page)).toBeVisible();
});

test("a locked issue shows the locked notice below Write, and Write keeps the composer", async ({ page }) => {
  await signIn(page, "ilze-k");
  const [triaged] = await othersIssues(page, "docs", "ilze-k", 1);
  const [written] = await othersIssues(page, "web", "ilze-k", 1);
  const ref = (d: Detail) => `${d.repo}#${d.number}`;
  devCtl(["fake", "edit", ref(triaged!), "--lock"]);
  devCtl(["fake", "edit", ref(written!), "--lock"]);
  try {
    await expect.poll(async () => ((await (await page.request.get(`/api/issues/${triaged!.id}`)).json()) as { locked: boolean }).locked, { timeout: SHOWS_WITHIN_MS }).toBe(true);
    await openIssue(page, triaged!.id);
    await expect(page.locator('[data-perf="locked"]')).toBeVisible();
    await expect(composer(page).locator('[data-perf="locked-notice"]')).toHaveText(
      "No comments here: it's locked, and only Write and up comment on it; you have Triage on docs.",
    );
    await expect(commentBox(page)).toHaveCount(0);
    // Triage still closes it.
    await expect(closeButton(page)).toBeVisible();
    // The comment key refuses.
    await page.locator('[data-perf="detail"]').focus();
    await page.keyboard.press("r");
    await expect(roleLine(page)).toHaveText("Comment: it's locked, and only Write and up comment on it; you have Triage on docs");

    await expect.poll(async () => ((await (await page.request.get(`/api/issues/${written!.id}`)).json()) as { locked: boolean }).locked, { timeout: SHOWS_WITHIN_MS }).toBe(true);
    await openIssue(page, written!.id);
    await expect(page.locator('[data-perf="locked"]')).toBeVisible();
    await expect(commentBox(page)).toBeVisible();
    await expect(composer(page).locator('[data-perf="locked-notice"]')).toHaveCount(0);
  } finally {
    devCtl(["fake", "edit", ref(triaged!), "--unlock"]);
    devCtl(["fake", "edit", ref(written!), "--unlock"]);
  }
});

test("the relationship picker dims an issue the role can't link, with 'needs Triage on …'", async ({ page }) => {
  await signIn(page, "ilze-k");
  const [issue] = await othersIssues(page, "docs", "ilze-k", 1);
  const [cli] = await othersIssues(page, "cli", "ilze-k", 1);
  const [web] = await othersIssues(page, "web", "ilze-k", 1);
  await openIssue(page, issue!.id);
  await addRelates(page).click();
  const picker = page.locator('[data-perf="relationship-picker"]');
  await picker.locator("input").fill(`cli#${cli!.number}`);
  const offer = picker.locator(`[data-perf="relationship-option"][data-ref="cli#${cli!.number}"]`);
  await expect(offer).toHaveAttribute("aria-disabled", "true");
  await expect(offer.locator('[data-perf="why-not"]')).toHaveText("needs Triage on cli");
  // Write on the other repo: linkable.
  await picker.locator("input").fill(`web#${web!.number}`);
  const linkable = picker.locator(`[data-perf="relationship-option"][data-ref="web#${web!.number}"]`);
  await expect(linkable).toBeVisible();
  await expect(linkable).not.toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});
