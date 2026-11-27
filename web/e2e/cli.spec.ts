// The beghu CLI's sign-in in a real browser against the ./dev-ctl stack (1k fixture): `/cli/login`
// Approve and Deny, a code typed by hand, one that's no login's, and the setup page's "CLI
// sign-ins" with Revoke. The CLI's side of the device flow (`beghu login`'s start and polls) goes
// straight to the server's HTTP surface, as the CLI sends it; each test names its machine so it
// finds only its own sign-in among tomsj's.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const panel = (page: Page) => page.locator('[data-perf="cli-login"]');
const signIns = (page: Page) => page.locator('[data-perf="prefs-cli"]');

/** A `beghu login` from a machine called `name`: its device secret and code. */
async function startLogin(request: APIRequestContext, name: string): Promise<{ device: string; code: string }> {
  const res = await request.post("/api/cli/login", { data: { name }, headers: { "user-agent": "beghu-cli/0.1.0" } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { device: string; code: string };
}

/** The CLI's poll: its status and body. */
async function poll(request: APIRequestContext, device: string): Promise<[number, { token?: string; error?: string; account?: string }]> {
  const res = await request.post("/api/cli/login/poll", { data: { device }, headers: { "user-agent": "beghu-cli/0.1.0" } });
  return [res.status(), await res.json()];
}

/** Signs tomsj in, landing on `url`. */
async function signedIn(page: Page, url: string): Promise<void> {
  await page.goto(`/auth/login?login=tomsj&next=${encodeURIComponent(url)}`);
  await page.waitForURL((u) => u.pathname + u.search === url);
}

const machine = (what: string) => `e2e-${what}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test("approving a beghu login signs it in, and the setup page lists and revokes it", async ({ page, request }) => {
  const name = machine("approve");
  const { device, code } = await startLogin(request, name);
  expect((await poll(request, device))[0]).toBe(202);

  await signedIn(page, `/cli/login?code=${code}`);
  await expect(panel(page).getByRole("heading", { name: "Sign in the beghu CLI" })).toBeVisible();
  await expect(panel(page).getByText(name)).toBeVisible();
  await expect(panel(page).locator('[data-perf="cli-code"]')).toHaveText(code);
  // When `beghu login` started it, a moment ago.
  await expect(panel(page).locator('[data-perf="cli-started"]')).toHaveText("now");
  await expect(panel(page).getByText("It will act as tomsj")).toBeVisible();
  await panel(page).getByRole("button", { name: "Approve" }).click();
  await expect(panel(page).getByRole("status")).toContainText(`Approved: the beghu CLI on ${name} is signed in as tomsj`);

  const [status, approved] = await poll(request, device);
  expect(status).toBe(200);
  expect(approved.account).toBe("tomsj");
  const token = approved.token!;
  expect(token).toMatch(/^beghu_cli_/);

  // The setup page lists it by its machine's name, with the install line.
  await page.goto("/prefs");
  await expect(signIns(page).getByRole("heading", { name: "CLI sign-ins" })).toBeVisible();
  await expect(signIns(page).locator('[data-perf="cli-install"]')).toHaveText(/^curl -fsSL http.*\/cli\/install\.sh \| sh$/);
  await expect(signIns(page).getByRole("link", { name: "how it works" })).toHaveAttribute("href", "/cli");
  const row = signIns(page).locator('[data-perf="cli-sign-in"]', { hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("now");

  // Revoke: gone from the list at once, and the CLI's next call is refused.
  await row.getByRole("button", { name: `Revoke ${name}` }).click();
  await expect(row).toHaveCount(0);
  // Shown again without a reload (the list, then back), it isn't listed from the cache.
  await page.getByRole("link", { name: "Close" }).click();
  await page.waitForURL((u) => u.pathname === "/issues");
  await page.goBack();
  await expect(signIns(page).getByRole("heading", { name: "CLI sign-ins" })).toBeVisible();
  await expect(signIns(page).locator('[data-perf="cli-sign-in"]', { hasText: name })).toHaveCount(0);
  await expect
    .poll(async () => (await request.get("/api/cli/status", { headers: { authorization: `Bearer ${token}` } })).status())
    .toBe(401);
  // And it stays gone once read again.
  await page.reload();
  await expect(signIns(page).getByRole("heading", { name: "CLI sign-ins" })).toBeVisible();
  await expect(signIns(page).locator('[data-perf="cli-sign-in"]', { hasText: name })).toHaveCount(0);
});

test("a code typed by hand, then Deny: the CLI isn't signed in", async ({ page, request }) => {
  const name = machine("deny");
  const { device, code } = await startLogin(request, name);
  await signedIn(page, "/cli/login");
  // Typed as a person might: lower case, without the dash.
  await panel(page).getByLabel("Enter the code").fill(code.replace("-", "").toLowerCase());
  await panel(page).getByRole("button", { name: "Continue" }).click();
  await expect(panel(page).getByText(name)).toBeVisible();
  await panel(page).getByRole("button", { name: "Deny" }).click();
  await expect(panel(page).getByRole("status")).toContainText(`Denied: the beghu CLI on ${name} isn't signed in`);
  const [status, body] = await poll(request, device);
  expect(status).toBe(410);
  expect(body.error).toBe("login_denied");
});

test("a code no login has says so, and takes another", async ({ page }) => {
  await signedIn(page, "/cli/login?code=BBBB-BBBB");
  await expect(panel(page).getByRole("alert")).toContainText("No sign-in is waiting with the code BBBB-BBBB");
  await panel(page).getByLabel("Enter the code").fill("not a code");
  await panel(page).getByRole("button", { name: "Continue" }).click();
  await expect(panel(page).getByText("A code is eight letters")).toBeVisible();
});
