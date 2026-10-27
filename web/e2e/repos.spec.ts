// Installing the App, picking repos and watching the import, in a real browser against the
// ./dev-ctl stack: the newcomer fixture account starts with no installation.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

/** A call to Fake GitHub's control port; the status. */
async function fake(control: string, path: string, body: unknown, method = "POST"): Promise<number> {
  const res = await fetch(`${control}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status;
}

test("a user with no installation installs the App, comes back to pick repos, and watches rows arrive", async ({ page }) => {
  const control = (JSON.parse(devCtl(["status", "--json"])) as { urls: { control: string } }).urls.control;
  // A run before this one may have installed it: GitHub takes it away again.
  await fake(control, "/uninstall", { login: "newcomer" });
  // Slow enough to watch the import, quick enough to finish.
  expect(await fake(control, "/faults/latency", { endpoint: "POST /graphql", ms: 700 })).toBe(200);
  try {
    // Signing in finds no installation: the install step.
    await page.goto("/auth/login?login=newcomer");
    await expect(page.getByRole("heading", { name: "Install beghu" })).toBeVisible();
    await page.getByRole("link", { name: "Install beghu on GitHub" }).click();
    // GitHub's install page knows who's signed in there, and installs on their account.
    await expect(page.getByRole("heading", { name: /^Install / })).toBeVisible();
    await page.getByRole("button", { name: "Install" }).click();

    // Back through the setup URL to the picker, with the newly visible repo unsynced.
    await page.waitForURL((u) => u.pathname === "/repos");
    const notes = page.locator('[data-perf="pick-repo"][data-repo="newcomer/notes"]');
    await expect(notes).toBeVisible();
    await expect(notes.getByRole("checkbox")).not.toBeChecked();
    await notes.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForURL((u) => u.pathname === "/");

    // The status slot names the phase and counts the import, every view ends with the note (the
    // picker's too), and rows arrive.
    const status = page.locator('[data-perf="status"]');
    await expect(status).toHaveText(/Importing (open issues|open PRs|comments|closed issues and PRs)… \d of 1 repo/);
    await expect(page.locator('[data-perf="list-pane"] [data-perf="still-importing"]')).toBeVisible();
    await page.locator('[data-perf="repos-link"]').click();
    await expect(page.locator('[data-perf="repo-picker"] [data-perf="still-importing"]')).toBeVisible();
    await page.getByRole("link", { name: "Cancel" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await expect(page.locator('[data-perf="row"]')).toHaveCount(5, { timeout: 20_000 });
    await expect(page.getByText("Plan the garden beds")).toBeVisible();
    // Then it's done, and says so by saying nothing.
    await expect(status).toHaveText("", { timeout: 30_000 });
    await expect(page.locator('[data-perf="still-importing"]')).toHaveCount(0);
  } finally {
    await fake(control, "/faults/latency", { endpoint: "POST /graphql", ms: 0 });
  }
});

test("the picker lists every visible repo, ticked as synced, and shows in both themes", async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await page.locator('[data-perf="repos-link"]').click();
  await page.waitForURL((u) => u.pathname === "/repos");
  const repos = page.locator('[data-perf="pick-repo"]');
  await expect(repos).toHaveCount(10);
  for (const box of await repos.getByRole("checkbox").all()) await expect(box).toBeChecked();
  // Nothing changed: nothing to save.
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /Install beghu on another account/ })).toBeVisible();

  const bg = () => page.locator('[data-perf="repo-picker"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByRole("button", { name: "Dark" }).click();
  const dark = await bg();
  await page.getByRole("button", { name: "Light" }).click();
  expect(await bg()).not.toBe(dark);
});
