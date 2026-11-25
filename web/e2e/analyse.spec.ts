// The PR panel's Analyse button (#177) in a real browser: each label from its state, the popover's
// three shapes, Copy (the clipboard), Copy again and Copy a new link, End run, the live change from
// Waiting for agent to Agent working to PR view as an agent fetches and uploads, "N behind" after
// a push, the pulse stopping under reduced motion, and the dots' token colours in both themes.
//
// The agent's side goes through the run API with the token from the copied prompt, as `curl`
// would; the PR is set up as the analysis crate's sample's (its description and a push of its two
// files to its head) through Fake GitHub's control port. Two labels need what the stack can't
// give: "CLI working" (CLI runs start with slice 5's credential) and "Analyse again" for an
// expired run (24 h); the server's tests cover both states (crates/server/tests/analyse_button.rs).
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

  // An accepted upload: PR view, and the popover's analysis.
  expect((await upload(token, sample(head))).status).toBe(201);
  await expect(main(page)).toHaveText("PR view");
  await expect(pop(page).locator('[data-perf="analyse-analysis"]')).toContainText(new RegExp(`Analysisat ${head.slice(0, 7)}, (just now|\\dm ago)`));
  await expect(pop(page).locator('[data-perf="analyse-analysis"]')).toContainText("5 parts · 2 purposes · 1 conflict");
  await expect(pop(page).locator("li[data-done]")).toHaveCount(3);

  // A push to the PR: PR view · 1 behind, and the chip.
  await control("/push", { repo: "acme/web", number: pr.number });
  await expect(main(page)).toHaveText("PR view · 1 behind");
  await expect(pop(page).locator('[data-perf="analyse-behind"]')).toHaveText("1 commit behind");

  // End run: the run goes; the analysis stays, with Analyse again.
  await pop(page).getByRole("button", { name: "End run" }).click();
  await expect(pop(page).locator('[data-perf="analyse-run"]')).toHaveCount(0);
  await expect(pop(page).locator('[data-perf="analyse-none"]').getByRole("button", { name: "Analyse again" })).toBeVisible();
  expect(await agent(token, "instructions")).toBe(410);
  await expect(main(page)).toHaveText("PR view · 1 behind");
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
