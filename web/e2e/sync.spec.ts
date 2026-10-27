// "Sync degraded · Resync" in a real browser against the ./dev-ctl stack. A missed change is made
// the way the server meets one: a relationship delivery whose read-back can't be made (its
// installation is gone), which marks every account syncing the repo for a resync.
//
// Fake GitHub can't make that delivery itself (its deliveries name installations it has), so the
// test sends it, signed with the dev stack's webhook secret as ./dev-ctl status reports it
// (stack.ts). The delivery changes no issue (it's dated long ago), so there's none to claim.
//
// Runs last (playwright.config.ts), and takes the stack to itself (`@alone`, claims.ts): the
// marks reach every account syncing the repo, which then says "sync degraded", and the Resync
// sweeps the account's repos. Not for `--repeat-each`: the account's Resync is spent for the hour
// (`./dev-ctl reset` gives it back).
import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { exclusive } from "./claims";
import { status as stackStatus } from "./stack";

/** An installation GitHub doesn't have: its token request is a 404, so the read-back gives up. */
const GONE_INSTALLATION = 41009999;

test.describe.configure({ mode: "serial" });

let release: (() => void) | undefined;

test.beforeEach(async ({}, info) => {
  // Waiting for the lock isn't the test's own time (as in writes.spec.ts).
  const own = info.timeout;
  const waiting = Date.now();
  info.setTimeout(0);
  release = info.tags.includes("@alone") ? await exclusive() : undefined;
  info.setTimeout(own + (Date.now() - waiting));
});

test.afterEach(() => {
  release?.();
  release = undefined;
});

/** A delivery the server takes as a missed relationship change on the first row's issue. */
async function missChange(page: Page): Promise<void> {
  const s = stackStatus();
  const [server, secret] = [s.urls.server, s.webhook_secret];
  const row = page.locator('[data-perf="row"]').first();
  const id = Number(await row.getAttribute("data-id"));
  const [repoName, number] = (await row.locator('[data-perf="ref"]').textContent())!.trim().split("#");
  const me = (await (await page.request.get("/api/me")).json()) as { repos: { id: number; owner: string; name: string }[] };
  const repo = me.repos.find((r) => r.name === repoName)!;
  const payload = JSON.stringify({
    action: "blocked_by_added",
    repository: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    installation: { id: GONE_INSTALLATION },
    blocked_issue_id: id,
    // Dated long ago, so it never changes the row.
    blocked_issue: { id, node_id: "I_e2e", number: Number(number), title: "x", state: "open", updated_at: "2020-01-01T00:00:00Z" },
  });
  const res = await fetch(`${server}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_dependencies",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`,
    },
    body: payload,
  });
  expect(res.status).toBe(202);
}

test("a missed change says sync degraded, Resync repairs it, and is offered again only after an hour", { tag: "@alone" }, async ({ page }) => {
  // A Resync sweeps every repo the account syncs, one after another, writing each page as it reads.
  test.setTimeout(120_000);
  await page.goto("/auth/login?login=ilze-k");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  const status = page.locator('[data-perf="status"]');

  await missChange(page);
  await expect(status).toHaveText("sync degraded · Resync");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(status.getByRole("button", { name: "Resync" })).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });

  await status.getByRole("button", { name: "Resync" }).click();
  await expect(status).toHaveText("resyncing…");
  // Repaired, and healthy again: the slot says nothing.
  await expect(status).toHaveText("", { timeout: 60_000 });

  // Missed again within the hour: Resync waits.
  await missChange(page);
  await expect(status).toHaveText(/^sync degraded · Resync available in (59|60) min$/);
  await expect(status.getByRole("button", { name: "Resync" })).toHaveCount(0);
});
