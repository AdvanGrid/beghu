// PRs in a real browser: read-only rows beside the issues (only under `is:pr` and `is:any`), each
// with its status icon and review chip; the PR panel, read-only, with its branches, review chip
// and conversation; and linked PRs reaching an issue's panel when a closing keyword or a
// Development-sidebar link is made on Fake GitHub.
//
// It edits (a PR's body, its sidebar links), so it runs after every other spec, serially
// (playwright.config.ts). Every change a test makes, it undoes, so the stack is as it found it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { recordPushes, SHOWS_WITHIN_MS, timeFromPush } from "./push";
import { status } from "./stack";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test.describe.configure({ mode: "serial" });

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

/** An outside edit through Fake GitHub's control port: the item as it is afterwards. */
async function edit(body: Record<string, unknown>): Promise<{ body: string | null }> {
  const res = await fetch(`${status().urls.control}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
  return ((await res.json()) as { issue: { body: string | null } }).issue;
}

interface Unlinked {
  repo: string;
  number: number;
  id: number;
}

/** The fixture's issues with no relationships, next to the fixture the stack's Fake GitHub serves. */
async function unlinked(): Promise<Unlinked[]> {
  const { control } = status().urls;
  const { fixture } = (await (await fetch(`${control}/state`)).json()) as { fixture: string };
  return (JSON.parse(readFileSync(fixture.replace(/mirror-([^/]*)\.db$/, "fixture-$1.json"), "utf8")) as { unlinked: Unlinked[] }).unlinked;
}

type Row = { id: number; number: number; repo: string; kind: string; pr: { status: string; review: string | null } | null };

const rows = (page: Page) => page.locator('[data-perf="row"]');

/** Signed in, with the stream's opening refetch done, at `path`. */
async function open(page: Page, path = "/"): Promise<void> {
  await recordPushes(page);
  const live = page.waitForResponse((r) => r.url().includes("through=") && r.ok());
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await live;
  if (path !== "/") await page.goto(path);
}

/** The first open PR in acme/web that closes nothing. */
async function barePr(page: Page): Promise<Row> {
  const res = await page.request.get(`/api/issues?q=${encodeURIComponent("is:pr is:open repo:acme/web")}`);
  for (const r of ((await res.json()) as { rows: Row[] }).rows) {
    const d = (await (await page.request.get(`/api/issues/${r.id}`)).json()) as { closes: unknown[] };
    if (d.closes.length === 0) return r;
  }
  throw new Error("no open PR in acme/web closes nothing");
}

test("PRs list only under is:pr and is:any, each with its status icon and its review chip", async ({ page }) => {
  await open(page);
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator('[data-perf="row"] [data-pr-status]')).toHaveCount(0);

  await page.goto(`/?q=${encodeURIComponent("is:pr")}`);
  await expect(rows(page).first()).toBeVisible();
  const shown = await rows(page).count();
  await expect(page.locator('[data-perf="row"] [data-pr-status]')).toHaveCount(shown);
  // A PR's review decision sits in the labels column.
  await expect(page.locator('[data-perf="row"] [data-perf="labels"] [data-perf="review"]').first()).toBeVisible();

  // `is:any` lists PRs beside issues: one PR, found by its title.
  const pr = ((await (await page.request.get(`/api/issues?q=${encodeURIComponent("is:pr")}`)).json()) as { rows: (Row & { title: string })[] }).rows[0]!;
  await page.goto(`/?q=${encodeURIComponent(`is:any "${pr.title}"`)}`);
  const id = pr.id;
  await expect(page.locator(`[data-perf="row"][data-id="${id}"] [data-pr-status]`)).toBeVisible();
});

test("a PR opens in the same panel, read-only: its status, branches, review chip and conversation", async ({ page }) => {
  await open(page, `/?q=${encodeURIComponent("is:pr is:open")}`);
  const res = await page.request.get(`/api/issues?q=${encodeURIComponent("is:pr is:open")}`);
  const pr = ((await res.json()) as { rows: Row[] }).rows.find((r) => r.pr?.review)!;
  await page.locator(`[data-perf="row"][data-id="${pr.id}"]`).click();
  const detail = page.locator('[data-perf="detail"]');
  await expect(detail).toHaveAttribute("data-id", String(pr.id));

  await expect(detail.locator('[data-perf="badge"]')).toHaveText(pr.pr!.status === "draft" ? "Draft" : "Open");
  const branches = detail.locator('[data-perf="branches"]');
  await expect(branches).toContainText("→");
  await expect(branches.locator('[data-perf="review"]')).toHaveAttribute("data-review", pr.pr!.review!);
  const github = detail.locator('[data-perf="open-on-github"]');
  await expect(github).toHaveText(/Open on GitHub/);
  await expect(github).toHaveAttribute("href", `https://github.com/${await prOwner(page, pr.id)}/${pr.repo}/pull/${pr.number}`);
  await expect(detail.locator('[data-perf="reviews-elsewhere"]')).toHaveText("Reviews and diff comments are on GitHub →");
  await expect(detail.locator('[data-perf="closes"]')).toBeVisible();
  await expect(detail.locator('[data-perf="comments"]')).toBeAttached();

  // Nothing to write with: no composer, no close or reopen, no pending-write note.
  const panel = page.locator('[data-perf="panel"]');
  await expect(panel.locator("textarea")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^(Comment|Close|Reopen)/ })).toHaveCount(0);
  await expect(panel.locator('[data-perf="state-note"]')).toHaveCount(0);
  // No pickers: the property names are plain text, with no marker slot for a pick's dot.
  await expect(panel.locator('[data-perf^="pick-"]')).toHaveCount(0);
  await expect(panel.locator('[data-perf="prop-note"]')).toHaveCount(0);
  // × closes the panel, and says so: not "Close the issue", which is a write.
  await expect(panel.getByRole("link", { name: "Close the PR panel" })).toBeVisible();
});

/** The PR's owner, as its detail has it. */
async function prOwner(page: Page, id: number): Promise<string> {
  return ((await (await page.request.get(`/api/issues/${id}`)).json()) as { owner: string }).owner;
}

test("a closing keyword added to a PR on GitHub shows it under the issue's Linked PRs", async ({ page }) => {
  await open(page);
  const pr = await barePr(page);
  const issue = (await unlinked()).find((u) => u.repo === "web")!;
  await page.goto(`/issues/${issue.id}`);
  const linked = page.locator('[data-perf="linked-prs"]');
  await expect(linked).toHaveText("None");
  const shown = await timeFromPush(page, issue.id, (id) => !!document.querySelector(`[data-perf="linked-prs"] [data-id="${id}"]`), pr.id);
  const before = (await edit({ repo: "acme/web", number: pr.number })).body;
  try {
    await edit({ repo: "acme/web", number: pr.number, body: `${before ?? ""}\n\nFixes #${issue.number}` });
    await expect(linked.locator(`[data-id="${pr.id}"]`)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await shown();
    // It opens in the panel, which lists the issue it closes.
    await linked.locator(`[data-id="${pr.id}"] a`).first().click();
    await expect(page.locator('[data-perf="detail"]')).toHaveAttribute("data-id", String(pr.id));
    await expect(page.locator(`[data-perf="closes"] [data-id="${issue.id}"]`)).toBeVisible();
  } finally {
    await edit({ repo: "acme/web", number: pr.number, body: before ?? "" });
  }
  await page.goto(`/issues/${issue.id}`);
  await expect(linked).toHaveText("None", { timeout: SHOWS_WITHIN_MS });
});

test("a PR linked to an issue in GitHub's Development sidebar shows under its Linked PRs", async ({ page }) => {
  await open(page);
  const pr = await barePr(page);
  const issue = (await unlinked()).find((u) => u.repo === "web")!;
  await page.goto(`/issues/${issue.id}`);
  const linked = page.locator('[data-perf="linked-prs"]');
  await expect(linked).toHaveText("None");
  const shown = await timeFromPush(page, issue.id, (id) => !!document.querySelector(`[data-perf="linked-prs"] [data-id="${id}"]`), pr.id);
  try {
    // No webhook: the events-feed poller sees it while this tab's stream is open.
    devCtl(["fake", "edit", `web#${pr.number}`, "--link-issue", `#${issue.number}`]);
    await expect(linked.locator(`[data-id="${pr.id}"]`)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await shown();
  } finally {
    devCtl(["fake", "edit", `web#${pr.number}`, "--unlink-issue", `#${issue.number}`]);
  }
  await expect(linked).toHaveText("None", { timeout: SHOWS_WITHIN_MS });
});
