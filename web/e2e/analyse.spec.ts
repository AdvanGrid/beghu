// The PR panel's Analyse button (#177) in a real browser: each label from its state, the popover's
// three shapes, Copy (the clipboard), Copy again and Copy a new link, End run, the live change from
// Waiting for agent to Agent working to PR view as an agent fetches and uploads, "N behind" after
// a push and "outdated" after a force push, a re-analysis's dot and short word beside PR view (its
// full state in the accessible name) leaving the status row's chips whole, the pulse stopping
// under reduced motion, the dots' token colours in both themes, the popover's focus from the
// keyboard (End run's included), and the kept prompts: another tab's, read by the `storage` event,
// and an account's going at its sign-out while another account's stay.
//
// The agent's side goes through the run API with the token from the copied prompt, as `curl`
// would; the PR is set up as the analysis crate's sample's (its description and a push of its two
// files to its head) through Fake GitHub's control port. Two labels need what the stack can't
// give: "CLI working" (CLI runs start with slice 5's credential) and "Analyse again" for an
// expired run (24 h); the server's tests cover both states (crates/server/tests/analyse_button.rs).
// Nor can it fail a read of the account's `analyses.db` (only a disk fault does that): the
// server's test checks the detail's `run_unknown`, and Analyse.tsx keeps what it showed for it.
//
// It edits PR bodies and pushes to PRs, which reorders the list other specs read, so it runs on
// its own after prs.spec.ts (playwright.config.ts). Each test takes a PR with no run or analysis
// yet, so a rerun without `./dev-ctl reset` finds fresh ones.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { recordPushes } from "./push";
import { status } from "./stack";
import { issueUrl } from "./urls";

test.describe.configure({ mode: "serial" });

const SAMPLE = fileURLToPath(new URL("../../crates/analysis/tests/sample/analysis.json", import.meta.url));

/** A head SHA no PR has had: each test's pushes are its own, however often the suite runs. */
function newHead(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The sample analysis, as a first analysis of the PR at `head`. */
function sample(head: string): Record<string, unknown> {
  const a = JSON.parse(readFileSync(SAMPLE, "utf8")) as Record<string, unknown> & { pr: Record<string, unknown> };
  return { ...a, pr: { ...a.pr, headSha: head }, carried: [] };
}

async function control(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${status().urls.control}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
  return res.json();
}

type Pr = { owner: string; repo: string; number: number; kind: "pr"; head?: string };

/** PRs this run of the spec has taken, so no two tests share one. */
const taken = new Set<number>();

/**
 * An open PR of acme/web with no run and no analysis for tomsj; with `asSample`, set up as the
 * sample's PR (its description, and a push of its two files to a new head), to upload to.
 */
async function freshPr(page: Page, asSample: boolean): Promise<Pr> {
  const res = await page.request.get(`/api/issues?q=${encodeURIComponent("is:pr is:open repo:acme/web")}`);
  for (const r of ((await res.json()) as { rows: { number: number }[] }).rows) {
    if (taken.has(r.number)) continue;
    const d = (await (await page.request.get(`/api/at/acme/web/${r.number}`)).json()) as { pr: { run?: unknown; analysis?: unknown } };
    if (d.pr.run || d.pr.analysis) continue;
    taken.add(r.number);
    if (!asSample) return { owner: "acme", repo: "web", number: r.number, kind: "pr" };
    const head = newHead();
    const description = (sample(head).pr as { description: string }).description;
    await control("/edit", { repo: "acme/web", number: r.number, body: description });
    await control("/push", {
      repo: "acme/web",
      number: r.number,
      sha: head,
      files: [
        { filename: "api/main.go", status: "modified", additions: 1, deletions: 0 },
        { filename: "api/orders/refund.go", status: "added", additions: 21, deletions: 0 },
      ],
    });
    return { owner: "acme", repo: "web", number: r.number, kind: "pr", head };
  }
  throw new Error("no open PR in acme/web without a run or an analysis: ./dev-ctl reset");
}

/** Signed in as tomsj in `context`, with the clipboard allowed, the stream open, at the PR. */
async function openPr(context: BrowserContext, pr: Pr | "sample" | "any"): Promise<{ page: Page; pr: Pr }> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await context.newPage();
  await recordPushes(page);
  const live = page.waitForResponse((r) => r.url().includes("through=") && r.ok());
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/issues");
  await live;
  const at = typeof pr === "string" ? await freshPr(page, pr === "sample") : pr;
  await page.goto(issueUrl(at));
  await expect(button(page)).toBeVisible();
  return { page, pr: at };
}

const button = (page: Page) => page.locator('[data-perf="analyse"]');
const main = (page: Page) => page.locator('[data-perf="analyse-main"]');
const pop = (page: Page) => page.locator('[data-perf="analyse-pop"]');
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

/** The run token in a copied prompt's instructions URL. */
function tokenOf(prompt: string): { url: string; token: string } {
  const m = /`(https?:\/\/[^`]+\/api\/runs\/([^/`]+)\/instructions)`/.exec(prompt);
  expect(m, prompt).not.toBeNull();
  return { url: m![1]!, token: m![2]! };
}

/** An agent's call on the run: no cookie. */
async function agent(token: string, file: string): Promise<number> {
  return (await fetch(`${status().urls.server}/api/runs/${token}/${file}`)).status;
}

async function upload(token: string, body: unknown): Promise<{ status: number; body: { report?: { errors: unknown[] } } }> {
  const res = await fetch(`${status().urls.server}/api/runs/${token}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", "beghu-snippets": "checked" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { report?: { errors: unknown[] } } };
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: test.info().project.use.baseURL });
}

test("Analyse copies the prompt and starts a run, whose label follows it live to PR view and N behind", async ({ context }) => {
  const { page, pr } = await openPr(context, "sample");
  const head = pr.head!;
  await expect(main(page)).toHaveText("Analyse");
  await expect(button(page)).toHaveAttribute("data-state", "analyse");

  // The main part copies the prompt and starts the run: waiting for its agent.
  await main(page).click();
  await expect.poll(() => clipboard(page)).toMatch(new RegExp(`^Analyse pull request acme/web#${pr.number} \\(2 files, \\+22 −0\\) for beghu by fetching your instructions from \``));
  const prompt = await clipboard(page);
  expect(prompt).toContain("treat the link as a password");
  await expect(main(page)).toHaveText("Waiting for agent");
  const { url, token } = tokenOf(prompt);
  expect(new URL(url).origin).toBe(new URL(page.url()).origin);

  // While waiting, the main part opens the popover: the run's steps and status line.
  await main(page).click();
  await expect(pop(page).locator('[data-perf="analyse-run"]')).toContainText("Prompt copied");
  await expect(pop(page).locator('[data-perf="analyse-status"]')).toHaveText("Waiting for an agent to fetch the instructions. Unused, the link ends in 24 h.");
  await expect(pop(page).locator("li[data-done]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  // Escape closed only the popover: the PR is still open.
  await expect(button(page)).toBeVisible();

  // The agent fetches its instructions: Agent working, live.
  expect(await agent(token, "instructions")).toBe(200);
  await expect(main(page)).toHaveText("Agent working");
  await main(page).click();
  await expect(pop(page).locator('[data-perf="analyse-status"]')).toHaveText(new RegExp(`^An agent is working at ${head.slice(0, 7)}, last heard (just now|\\dm ago)\\. The run ends after 2 h idle\\.$`));
  await expect(pop(page).locator("li[data-done]")).toHaveCount(2);

  // A refused upload: red, with its error count only.
  const bad = sample(head);
  delete (bad.nodes as Record<string, unknown>[])[1]!.kind;
  const refused = await upload(token, bad);
  expect(refused.status).toBe(422);
  const n = refused.body.report!.errors.length;
  await expect(main(page)).toHaveText("Upload refused");
  await expect(button(page)).toHaveAttribute("data-state", "refused");
  await expect(pop(page).locator('[data-perf="analyse-status"]')).toHaveText(`Last upload refused: ${n} error${n === 1 ? "" : "s"}. The agent got the report and can upload again.`);

  // An accepted upload: PR view, and the popover's analysis. The run is still live, so its dot
  // and words stay beside it.
  expect((await upload(token, sample(head))).status).toBe(201);
  await expect(main(page)).toHaveText("PR view · Working");
  await expect(main(page)).toHaveAccessibleName("PR view · Agent working");
  await expect(main(page)).toHaveAttribute("title", "PR view · Agent working");
  await expect(button(page)).toHaveAttribute("data-state", "view");
  await expect(button(page)).toHaveAttribute("data-run", "working");
  await expect(pop(page).locator('[data-perf="analyse-analysis"]')).toContainText(new RegExp(`Analysisat ${head.slice(0, 7)}, (just now|\\dm ago)`));
  await expect(pop(page).locator('[data-perf="analyse-analysis"]')).toContainText("5 parts · 2 purposes · 1 conflict");
  await expect(pop(page).locator("li[data-done]")).toHaveCount(3);

  // A push to the PR: PR view · 1 behind, and the chip.
  await control("/push", { repo: "acme/web", number: pr.number });
  await expect(main(page)).toHaveText("PR view · 1 behind · Working");
  await expect(main(page)).toHaveAccessibleName("PR view · 1 behind · Agent working");
  await expect(pop(page).locator('[data-perf="analyse-behind"]')).toHaveText("1 commit behind");

  // End run: the run goes; the analysis stays, with Analyse again.
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(pop(page).locator('[data-perf="analyse-run"]')).toHaveCount(0);
  await expect(pop(page).locator('[data-perf="analyse-none"]').getByRole("button", { name: "Analyse again" })).toBeVisible();
  expect(await agent(token, "instructions")).toBe(410);
  await expect(main(page)).toHaveText("PR view · 1 behind");
  await expect(button(page)).not.toHaveAttribute("data-run");

  // A force push leaves the analysed head out of the PR's commits: outdated.
  await control("/push", { repo: "acme/web", number: pr.number, force: true });
  await expect(main(page)).toHaveText("PR view · outdated");
  await expect(pop(page).locator('[data-perf="analyse-behind"]')).toHaveText("Outdated");
});

/** An analysis of a fresh sample PR, uploaded by a run that then ended: the page shows PR view. */
async function analysedPr(context: BrowserContext): Promise<{ page: Page; pr: Pr }> {
  const { page, pr } = await openPr(context, "sample");
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const { token } = tokenOf(await clipboard(page));
  expect(await agent(token, "pr.json")).toBe(200);
  expect((await upload(token, sample(pr.head!))).status).toBe(201);
  await main(page).click();
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(main(page)).toHaveText("PR view");
  await page.keyboard.press("Escape");
  return { page, pr };
}

test("A re-analysis keeps PR view on the button, with its run's dot and words", async ({ context }) => {
  const { page, pr } = await analysedPr(context);
  const dot = main(page).locator("span[aria-hidden]");
  await expect(dot).toHaveCount(0);
  const colour = () => dot.evaluate((e) => getComputedStyle(e).backgroundColor);

  // Analyse again from the popover: waiting, amber and pulsing.
  await page.locator('[data-perf="analyse-more"]').click();
  await pop(page).getByRole("button", { name: "Analyse again" }).click();
  await expect(main(page)).toHaveText("PR view · Waiting");
  await expect(main(page)).toHaveAccessibleName("PR view · Waiting for agent");
  await expect(button(page)).toHaveAttribute("data-run", "waiting");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  expect(await colour()).toBe("rgb(138, 92, 0)");
  expect(await dot.evaluate((e) => getComputedStyle(e).animationName)).not.toBe("none");
  const { token } = tokenOf(await clipboard(page));

  // The agent fetches: working, green.
  expect(await agent(token, "instructions")).toBe(200);
  await expect(main(page)).toHaveText("PR view · Working");
  await expect(button(page)).toHaveAttribute("data-run", "working");
  // The open token: #1a7f37 in light.
  expect(await colour()).toBe("rgb(26, 127, 55)");

  // A refused upload: red and steady, beside the analysis it would replace.
  const bad = sample(pr.head!);
  delete (bad.nodes as Record<string, unknown>[])[1]!.kind;
  expect((await upload(token, bad)).status).toBe(422);
  await expect(main(page)).toHaveText("PR view · Refused");
  await expect(main(page)).toHaveAccessibleName("PR view · Upload refused");
  await expect(button(page)).toHaveAttribute("data-run", "refused");
  // The danger token: #cf222e in light.
  expect(await colour()).toBe("rgb(207, 34, 46)");
  expect(await dot.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");

  // In dark too.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(colour).toBe("rgb(248, 81, 73)");
  // The popover is still open from Analyse again.
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(main(page)).toHaveText("PR view");
});

test("Copy again copies the kept prompt; another browser's Copy a new link supersedes the run, and End run ends it", async ({ context, browser }) => {
  const { page, pr } = await openPr(context, "any");
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const first = await clipboard(page);
  const run = (await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("beghu.prompt.")))) as string[];
  expect(run.length).toBe(1);

  // Copy again copies the prompt word for word, which What was copied shows.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.locator('[data-perf="analyse-more"]').click();
  await pop(page).getByRole("button", { name: "Copy again" }).click();
  await expect.poll(() => clipboard(page)).toBe(first);
  await pop(page).getByText("What was copied").click();
  await expect(pop(page).locator('[data-perf="analyse-prompt"]')).toHaveText(first);
  await expect(pop(page)).toContainText(`Or run beghu analyse acme/web#${pr.number}`);

  // Another browser holds no prompt: Copy a new link starts a new run in place of this one.
  const other = await newContext(browser);
  const b = await openPr(other, pr);
  await expect(main(b.page)).toHaveText("Waiting for agent");
  await main(b.page).click();
  await b.page.getByRole("button", { name: "Copy a new link" }).click();
  await expect.poll(() => clipboard(b.page)).not.toBe(first);
  const second = await clipboard(b.page);
  expect(tokenOf(second).token).not.toBe(tokenOf(first).token);
  expect(await agent(tokenOf(first).token, "instructions")).toBe(410);

  // The first browser's kept prompt was for the superseded run: gone, so it offers a new link.
  await expect(pop(page).getByRole("button", { name: "Copy a new link" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("beghu.prompt.")).length)).toBe(0);

  // End run from the second browser: both show Analyse, and its prompt goes.
  await b.page.getByRole("button", { name: "End run" }).click();
  await expect(main(b.page)).toHaveText("Analyse");
  await expect(main(page)).toHaveText("Analyse");
  await expect.poll(() => b.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("beghu.prompt.")).length)).toBe(0);
  expect(await agent(tokenOf(second).token, "instructions")).toBe(410);
  await other.close();
});

test("With no run the popover offers Analyse this PR and the CLI's command, which copies", async ({ context }) => {
  const { page, pr } = await openPr(context, "any");
  await page.locator('[data-perf="analyse-more"]').click();
  const none = pop(page).locator('[data-perf="analyse-none"]');
  await expect(none.getByRole("button", { name: "Analyse this PR" })).toBeVisible();
  await expect(none).toContainText("Copies a prompt for your agent");
  const command = `beghu analyse acme/web#${pr.number}`;
  await expect(none.locator("summary")).toHaveText(`Or run ${command}`);
  await none.locator("summary").click();
  await none.getByRole("button", { name: "Copy" }).click();
  await expect.poll(() => clipboard(page)).toBe(command);
  await expect(none.getByRole("button", { name: "Copied" })).toBeVisible();
  // Clicking away closes it.
  await page.mouse.click(5, 5);
  await expect(pop(page)).toHaveCount(0);
});

test("The dot pulses, stops under reduced motion, and takes its token colour in both themes", async ({ context }) => {
  const { page } = await openPr(context, "any");
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const dot = main(page).locator("span[aria-hidden]");
  const style = () => dot.evaluate((e) => ({ animation: getComputedStyle(e).animationName, colour: getComputedStyle(e).backgroundColor }));
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  expect((await style()).animation).not.toBe("none");
  // The warn token: #8a5c00 in light, #d29922 in dark.
  expect((await style()).colour).toBe("rgb(138, 92, 0)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await style()).colour).toBe("rgb(210, 153, 34)");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await style()).animation).toBe("none");
  // Its words say the state without the dot.
  await expect(main(page)).toHaveText("Waiting for agent");
  await page.locator('[data-perf="analyse-more"]').click();
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(main(page)).toHaveText("Analyse");
});

test("The popover takes focus from the keyboard, keeps Tab in order, and gives it back on Escape", async ({ context }) => {
  const { page } = await openPr(context, "any");
  const more = page.locator('[data-perf="analyse-more"]');
  // Analyse starts a run: the main part opens nothing yet.
  await expect(main(page)).not.toHaveAttribute("aria-haspopup");
  await expect(more).toHaveAttribute("aria-haspopup", "dialog");
  await expect(more).toHaveAttribute("aria-expanded", "false");

  // ▾ from the keyboard: the dialog opens with focus on its first control.
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(pop(page)).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const analyseThis = pop(page).getByRole("button", { name: "Analyse this PR" });
  await expect(analyseThis).toBeFocused();
  // Tab goes on in order: the fold's summary next.
  await page.keyboard.press("Tab");
  await expect(pop(page).locator("summary")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(analyseThis).toBeFocused();

  // Escape closes only the popover, and focus is back on ▾: the PR stays open.
  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(button(page)).toBeVisible();

  // With a run live, the main part opens the dialog too, and says so.
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  await expect(main(page)).toHaveAttribute("aria-haspopup", "dialog");
  await main(page).focus();
  await page.keyboard.press("Space");
  await expect(main(page)).toHaveAttribute("aria-expanded", "true");
  await expect(pop(page).getByRole("button", { name: "Copy again" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(main(page)).toBeFocused();
  await expect(button(page)).toBeVisible();

  // Tabbing past its last control closes it behind the focus.
  await main(page).click();
  await expect(pop(page)).toBeVisible();
  await pop(page).getByRole("button", { name: "End run" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(pop(page)).toHaveCount(0);
  // End run from the keyboard: its section goes, and focus moves to the popover's first control.
  await main(page).click();
  await pop(page).getByRole("button", { name: "End run" }).focus();
  await page.keyboard.press("Enter");
  await expect(main(page)).toHaveText("Analyse");
  await expect(pop(page).getByRole("button", { name: "Analyse this PR" })).toBeFocused();
});

test("Signing out drops the account's kept prompts", async ({ context }) => {
  const { page } = await openPr(context, "any");
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const account = await page.evaluate(() => /(?:^|;\s*)beghu_acct=(\d+)/.exec(document.cookie)?.[1]);
  const kept = () => page.evaluate((a) => Object.keys(localStorage).filter((k) => k.startsWith(`beghu.prompt.${a}.`)).length, account);
  expect(await kept()).toBe(1);

  await page.locator('[data-perf="account"]').click();
  const menu = page.locator('[data-perf="account-menu"]');
  await expect(menu).toHaveCSS("position", "absolute");
  await menu.getByRole("menuitem", { name: "Sign out of tomsj" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/acme/"));
  expect(await kept()).toBe(0);
});

test("A second tab of the browser that started the run offers Copy again, not a new link", async ({ context }) => {
  const { page, pr } = await openPr(context, "any");
  // The second tab shows the PR first, with nothing kept yet.
  const second = await context.newPage();
  await second.goto(issueUrl(pr));
  await expect(main(second)).toHaveText("Analyse");
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const prompt = await clipboard(page);
  await expect(main(second)).toHaveText("Waiting for agent");
  await second.locator('[data-perf="analyse-more"]').click();
  // The first tab's prompt reached it by the `storage` event: Copy again copies that one.
  await expect(pop(second).getByRole("button", { name: "Copy again" })).toBeVisible();
  await second.evaluate(() => navigator.clipboard.writeText(""));
  await pop(second).getByRole("button", { name: "Copy again" }).click();
  await expect.poll(() => clipboard(second)).toBe(prompt);

  // With no change to the run, the second tab reads storage again on the first's `storage`
  // events: the prompt dropped there, then kept again.
  const [key, value] = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((k) => k.startsWith("beghu.prompt."))!;
    return [k, localStorage.getItem(k)!] as const;
  });
  await page.evaluate((k) => localStorage.removeItem(k), key);
  await expect(pop(second).getByRole("button", { name: "Copy a new link" })).toBeVisible();
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value] as const);
  await expect(pop(second).getByRole("button", { name: "Copy again" })).toBeVisible();

  await pop(second).getByRole("button", { name: "End run" }).click();
  await expect(main(page)).toHaveText("Analyse");
  await second.close();
});

test("Signing out of one account keeps another account's prompts", async ({ context }) => {
  // tomsj starts a run, then ilze-k signs in to the same browser and starts one on another PR.
  const { page } = await openPr(context, "any");
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const cookieAccount = () => page.evaluate(() => /(?:^|;\s*)beghu_acct=(\d+)/.exec(document.cookie)?.[1]);
  const tomsj = await cookieAccount();
  await page.goto("/auth/login?login=ilze-k");
  await page.waitForURL((u) => u.pathname === "/issues");
  const ilze = await cookieAccount();
  expect(ilze).not.toBe(tomsj);
  const theirs = await freshPr(page, false);
  await page.goto(issueUrl(theirs));
  await main(page).click();
  await expect(main(page)).toHaveText("Waiting for agent");
  const kept = (a: string | undefined) => page.evaluate((a) => Object.keys(localStorage).filter((k) => k.startsWith(`beghu.prompt.${a}.`)).length, a);
  expect([await kept(tomsj), await kept(ilze)]).toEqual([1, 1]);

  // Back to tomsj, and signed out of it: the browser is ilze-k's alone, whose prompt stays.
  await page.locator('[data-perf="account"]').click();
  const menu = page.locator('[data-perf="account-menu"]');
  await expect(menu).toHaveCSS("position", "absolute");
  await menu.getByRole("menuitem", { name: "Switch to tomsj" }).click();
  await expect(page.locator('[data-perf="account"]')).toHaveText("tomsj");
  await page.locator('[data-perf="account"]').click();
  await expect(menu).toHaveCSS("position", "absolute");
  await menu.getByRole("menuitem", { name: "Sign out of tomsj" }).click();
  await expect(page.locator('[data-perf="account"]')).toHaveText("ilze-k");
  await expect.poll(() => kept(tomsj)).toBe(0);
  // Past the load's sweep and `/api/me`, which lists ilze-k alone.
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
  expect(await kept(ilze)).toBe(1);

  // ilze-k's run still offers Copy again.
  await page.goto(issueUrl(theirs));
  await page.locator('[data-perf="analyse-more"]').click();
  await expect(pop(page).getByRole("button", { name: "Copy again" })).toBeVisible();
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(main(page)).toHaveText("Analyse");
});

test("The longest label leaves the status row's chips whole at the panel's default width", async ({ context }) => {
  const { page, pr } = await analysedPr(context);
  // A 1200 px window, the panel at its default half: the full label (PR view · 100 behind ·
  // Waiting for agent) with no room to wrap cut the number to 45 px of its 50 here.
  await page.setViewportSize({ width: 1200, height: 800 });
  // 100 commits pushed since the analysis, and a re-analysis waiting: PR view · 100 behind · ● Waiting.
  await control("/push", { repo: "acme/web", number: pr.number, commits: 100 });
  await expect(main(page)).toHaveText("PR view · 100 behind");
  await page.locator('[data-perf="analyse-more"]').click();
  await pop(page).getByRole("button", { name: "Analyse again" }).click();
  await expect(main(page)).toHaveText("PR view · 100 behind · Waiting");
  await expect(main(page)).toHaveAccessibleName("PR view · 100 behind · Waiting for agent");
  await page.keyboard.press("Escape");
  const whole = (perf: string) =>
    page.locator(`[data-perf="${perf}"]`).evaluate((e) => ({ text: e.textContent, scroll: e.scrollWidth, client: e.clientWidth }));
  const ref = await whole("detail-ref");
  expect(ref.text).toBe(`web#${pr.number}`);
  expect(ref.scroll, "the number is cut short").toBeLessThanOrEqual(ref.client);
  const focus = await whole("focus-issue");
  expect(focus.scroll, "Focus issue is cut short").toBeLessThanOrEqual(focus.client);
  await page.locator('[data-perf="analyse-more"]').click();
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(main(page)).toHaveText("PR view · 100 behind");
});
