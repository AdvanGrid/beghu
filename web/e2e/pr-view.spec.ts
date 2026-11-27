// The PR view (#181) in a real browser, on the recorded analysis of AdvanGrid/beghu#191: v2, which
// `./dev-ctl start` and `reset` upload for tomsj (after v1, so its `carried` has v1's IDs). Its
// canvas is a placeholder until slice 8 (pr-view/Canvas.tsx); everything else is the view's:
// a cold open (one read of the graph, the claims after it, no list), the top bar, every place the
// panel shows (the PR, a part, a line, a step, a claim and its evidence), back and forward through
// picks, the graph failing and its Retry (and a migration's own message), the claims failing in
// every place with one Retry, the skeleton while they're on their way, v1's IDs forwarding on v2
// (merged, dropped, unknown), and both themes.
//
// As ilze-k: NoAnalysis on a PR of acme/web with no run or analysis, and the start from it,
// whose upload's push fills the page in; and on #191, the newer-analysis pill. ilze-k has no
// analysis of #191 on a fresh stack: `./dev-ctl analyse --version 1 --as ilze-k` uploads v1, the
// view opens on a line `carried-split.after-v1.json` splits, and `./dev-ctl analyse --version
// carried-split --as ilze-k` uploads that case over it (dev-ctl skips v1, which she has), so the
// open view gets the `analysis` push: the pill, Show it, and the place kept through the split.
// That leaves her analysis at the case, so a rerun of that test needs `./dev-ctl reset`.
//
// Graph and claims failures go through Playwright's request routing (Fake GitHub isn't
// involved); so does one part made partly drawn (`drawn`), which no recording has at v2.
//
// Its uploads move #191 on Fake GitHub between v1's and v2's heads, which moves the PR to the top
// of every tab's list: it runs on its own after analyse.spec.ts (playwright.config.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { devCtl, status } from "./stack";

test.describe.configure({ mode: "serial" });

const FIXTURES = fileURLToPath(new URL("../../fixtures/pr-view/", import.meta.url));
type Json = Record<string, any>;
const read = (path: string): Json => JSON.parse(readFileSync(FIXTURES + path, "utf8")) as Json;
const V2 = read("beghu-191/analysis-v2.json");
const SPLIT = read("cases/carried-split.after-v1.json");
const SAMPLE = fileURLToPath(new URL("../../crates/analysis/tests/sample/analysis.json", import.meta.url));

const VIEW = "/AdvanGrid/beghu/pull/191/view";
const GRAPH = "**/api/AdvanGrid/beghu/pulls/191/analysis";
const CLAIMS = "**/api/AdvanGrid/beghu/pulls/191/analysis/*/v*/claims";

const panel = (page: Page) => page.locator('[data-perf="view-panel"]');
const note = (page: Page) => page.locator('[data-perf="forward-note"]');
const selOf = (page: Page) => new URL(page.url()).searchParams.get("sel");

async function signIn(context: BrowserContext, login: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/auth/login?login=${login}`);
  await page.waitForURL((u) => u.pathname === "/issues");
  return page;
}

/** The API requests the page makes from now on, the stream aside. */
function apiRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && u.pathname !== "/api/stream") seen.push(u.pathname + u.search);
  });
  return seen;
}

/** Opens the view at `search`, once the panel is up. */
async function open(page: Page, search = ""): Promise<void> {
  await page.goto(VIEW + search);
  // A first open may wait on Vite compiling the view, or the server reading the analysis.
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
}

test("A cold open reads the graph once, then the claims, and no list; the top bar names the PR and the analysis", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const api = apiRequests(page);
  await open(page);
  // The top bar: back to the PR panel, the title, the analysis's head and age, Analyse again.
  await expect(page.locator('[data-perf="view-back"]')).toHaveText("← beghu#191");
  await expect(page.locator('[data-perf="view-back"]')).toHaveAttribute("href", "/AdvanGrid/beghu/pull/191");
  await expect(page.locator('[data-perf="view-title"]')).toHaveText(V2.pr.title);
  await expect(page.locator('[data-perf="view-analysed"]')).toHaveText(new RegExp(`^analysed at ${V2.pr.headSha.slice(0, 7)}, (just now|\\d+(m|h|d) ago)$`));
  await expect(page.locator('[data-perf="analyse-main"]')).toHaveText("Analyse again");
  await expect(page.locator('[data-perf="tab-canvas"]')).toHaveAttribute("aria-selected", "true");
  // The app's chrome stays; the list doesn't show.
  await expect(page.locator("header").getByText("beghu", { exact: true })).toBeVisible();
  await expect(page.locator('[data-perf="list-pane"]')).toHaveCount(0);
  // The canvas (a placeholder) and the PR's panel.
  await expect(page.locator('[data-perf="block"]').first()).toBeVisible();
  await expect(panel(page).locator("h2").first()).toHaveText("All changes, by kind");

  // The claims are read in the background as soon as the graph is in: one of each, and no list.
  await expect.poll(() => api.filter((u) => u.endsWith("/claims")).length).toBe(1);
  await page.waitForTimeout(500);
  expect(api.filter((u) => u === "/api/AdvanGrid/beghu/pulls/191/analysis")).toHaveLength(1);
  expect(api.filter((u) => u.endsWith("/claims"))).toHaveLength(1);
  expect(api.indexOf("/api/AdvanGrid/beghu/pulls/191/analysis")).toBeLessThan(api.findIndex((u) => u.endsWith("/claims")));
  expect(api.filter((u) => u.startsWith("/api/issues") || u.startsWith("/api/facets") || u.startsWith("/api/tree"))).toEqual([]);
});

test("The PR's panel: All changes by kind, the description, coverage, the facets found, and Since the last analysis", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page);
  const groups = panel(page).locator('[data-perf="rank-group"] h3');
  await expect(groups).toHaveText([/^Boundary crossings \(\d+\)$/, /^New and removed parts \(\d+\)$/, /^Changed responsibilities or facets \(\d+\)$/, /^Edits inside parts \(\d+\)$/]);

  // The description, verbatim, folded.
  const description = panel(page).locator('[data-perf="description"]');
  await expect(description).not.toHaveAttribute("open");
  await description.locator("summary").click();
  await expect(description).toContainText(V2.pr.description.split("\n")[0]);

  await expect(panel(page).locator('[data-perf="coverage"]')).toContainText(V2.coverage.summary);
  for (const f of V2.facets) await expect(panel(page).locator('[data-perf="facets-found"]')).toContainText(f.name);

  // Since the last analysis: v2's `carried`, grouped by cause, each entry with its reason and claims.
  const since = panel(page).locator('[data-perf="since-last"]');
  await since.locator("> summary").click();
  const scope = V2.carried.filter((c: Json) => c.cause === "scope");
  await expect(since.locator('[data-perf="since-scope"] > summary')).toHaveText(`No longer drawn (${scope.length})`);
  await expect(since.locator('[data-perf="since-code"]')).toHaveCount(0);
  await since.locator('[data-perf="since-scope"] > summary').click();
  const merged = scope.find((c: Json) => c.kind === "merged");
  const entry = since.locator('[data-perf="carried"]', { hasText: merged.was }).first();
  await entry.locator("summary").first().click();
  await expect(entry).toContainText(merged.reason);
  await expect(entry.locator('[data-perf="claim"]').first()).toBeVisible();
});

test("A part's panel: questions to evidence, what it does and who uses it, how it's built, connections with hidden ones faded, files", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const node = V2.nodes.find((n: Json) => n.id === "crates-fake-github");
  await open(page, `?sel=part:${node.id}`);
  const p = panel(page).locator('[data-perf="part-panel"]');
  await expect(p.locator("h2")).toHaveText(node.name);
  await expect(p).toContainText(node.summary);

  // A question: its answer, then its claims, each one fold down to its evidence.
  const q = p.locator('[data-perf="question"]').first();
  await q.locator("summary").first().click();
  await expect(q.locator('[data-perf="answer"]')).toHaveText(node.questions[0].answer);
  const claim = q.locator('[data-perf="claim"]').first();
  await claim.locator("summary").click();
  const ev = claim.locator('[data-perf="evidence"][data-kind="code"]').first();
  await expect(ev.locator("pre")).toBeVisible();
  await expect(ev.locator('[data-perf="checked"]')).toHaveText("checked by the uploader's tool");
  await expect(ev.locator('[data-perf="evidence-link"]')).toHaveAttribute("href", new RegExp(`^https://github\\.com/AdvanGrid/beghu/blob/(${V2.pr.headSha}|${V2.pr.baseSha})/.+#L\\d+-L\\d+$`));

  // What it does, each responsibility with its change; how it's built.
  await expect(p.locator('[data-perf="responsibility"]')).toHaveCount(node.responsibilities.length);
  await expect(p.locator('[data-perf="facets"] > li')).toHaveCount(node.facets.length);

  // Connections: the test lines the Lines menu hides by default listed faded and labelled.
  const hidden = p.locator('[data-perf="connection"][data-hidden]');
  await expect(hidden.first()).toContainText("(hidden: test)");
  expect(Number(await hidden.first().evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(1);
  await expect(p.locator('[data-perf="connection"]:not([data-hidden])').first()).toBeVisible();

  // Files, in one grid: +, − and the path.
  await expect(p.locator('[data-perf="file"]').first()).toBeVisible();

  // A responsibility used by other parts says how many; its users are a fold away, and a pick.
  const used = V2.nodes.flatMap((n: Json) => n.responsibilities.map((r: Json) => ({ n, r })));
  const withUsers = used.find(({ n, r }: Json) => V2.edges.some((e: Json) => e.to === n.id && e.uses === r.id && e.from !== n.id));
  await open(page, `?sel=part:${withUsers.n.id}`);
  const row = panel(page).locator('[data-perf="responsibility"]', { hasText: withUsers.r.text });
  await expect(row.locator('[data-perf="used-by"]')).toHaveText(/used by \d+ parts?/);
});

test("A part's panel says what's partly drawn, and the PR's coverage lists it", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  // No recording has a partly drawn part at v2: one made so on the way in.
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    const n = g.analysis.nodes.find((x: Json) => x.id === "crates-dbrt");
    n.drawn = { partial: true, folders: 9 };
    await route.fulfill({ response: res, json: g });
  });
  await open(page, "?sel=part:crates-dbrt");
  const kids = V2.nodes.filter((n: Json) => n.parent === "crates-dbrt").length;
  await expect(panel(page).locator('[data-perf="partly-drawn"]')).toHaveText(`Partly drawn: ${kids} of 9 folders drawn: no line, step, purpose or conflict in this PR reaches the other ${9 - kids}.`);
  await open(page);
  await expect(panel(page).locator('[data-perf="coverage"]')).toContainText("Partly drawn parts (1)");
});

test("A line's panel: what it carries, when, mode, what it crosses, and its evidence", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const e = V2.edges.find((x: Json) => x.data && x.boundaries.length > 0);
  await open(page, `?sel=line:${encodeURIComponent(e.id)}`);
  const l = panel(page).locator('[data-perf="line"]');
  await expect(l).toHaveAttribute("data-id", e.id);
  await expect(l).toContainText(e.label);
  await expect(l.locator('[data-perf="carries"]')).toContainText(e.data.what);
  await expect(l.locator('[data-perf="when"]')).toContainText(e.when === "runtime" ? "at run time" : e.when === "build" ? "at build time" : "in tests");
  await expect(l.locator('[data-perf="crosses"]')).toContainText(V2.boundaries.find((b: Json) => b.id === e.boundaries[0]).name);
  await expect(l.locator('[data-perf="claim"]').first()).toBeVisible();
  // Its ends are picks.
  await l.locator("h2 button").first().click();
  await expect.poll(() => selOf(page)).toBe(`part:${e.from}`);
});

test("A step's panel: previous and next, and the whole flow", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const sc = V2.scenarios[0];
  await open(page, `?sel=step:${sc.id}/2`);
  const st = panel(page).locator('[data-perf="step-panel"]');
  await expect(st).toContainText(`${sc.title} · step 2 of ${sc.steps.length}`);
  await expect(st.locator("h2")).toHaveText(sc.steps[1].action);
  await expect(st.locator('[data-perf="flow"] [aria-current="step"]')).toContainText(sc.steps[1].action);
  await st.getByRole("button", { name: "Next →" }).click();
  await expect.poll(() => selOf(page)).toBe(`step:${sc.id}/3`);
  await expect(st.locator("h2")).toHaveText(sc.steps[2].action);
  await st.getByRole("button", { name: "← Previous" }).click();
  await st.getByRole("button", { name: "← Previous" }).click();
  await expect(st.getByRole("button", { name: "← Previous" })).toBeDisabled();
});

test("Back and forward walk the picks; a setting replaces its entry and stays through picks", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page, "?lens=data");
  const top = V2.nodes.filter((n: Json) => n.parent === "system").map((n: Json) => n.id);
  // Pick a block, then a connection of it from the panel.
  await page.locator(`[data-perf="block"][data-id="${top[0]}"]`).click();
  await expect.poll(() => selOf(page)).toBe(`part:${top[0]}`);
  await panel(page).locator('[data-perf="connection"] button').first().click();
  await expect.poll(() => selOf(page)).toMatch(/^line:/);
  const lineSel = selOf(page);
  // The view-wide setting rode along.
  expect(new URL(page.url()).searchParams.get("lens")).toBe("data");

  await page.goBack();
  await expect.poll(() => selOf(page)).toBe(`part:${top[0]}`);
  await expect(panel(page).locator('[data-perf="part-panel"]')).toHaveAttribute("data-id", top[0]);
  await page.goBack();
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(panel(page).locator('[data-perf="pr-panel"]')).toBeVisible();
  await page.goForward();
  await expect(panel(page).locator('[data-perf="part-panel"]')).toHaveAttribute("data-id", top[0]);
  await page.goForward();
  await expect.poll(() => selOf(page)).toBe(lineSel);
  await expect(panel(page).locator('[data-perf="line-panel"]')).toBeVisible();
});

test("The graph failing replaces the canvas with Retry, the chrome stays; a failed migration says so", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  let failing: "internal" | "migration_failed" | undefined = "internal";
  await page.route(GRAPH, (route: Route) =>
    failing ? route.fulfill({ status: 500, json: { error: failing, message: "test" } }) : route.continue(),
  );
  await page.goto(VIEW);
  const failed = page.locator('[data-perf="view-failed"]');
  await expect(failed).toContainText("Couldn't load the analysis");
  await expect(page.locator('[data-perf="canvas"]')).toHaveCount(0);
  await expect(page.locator('[data-perf="view-back"]')).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: "Repos" })).toBeVisible();

  failing = "migration_failed";
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed).toContainText("couldn't bring this analysis up to its current shape");

  failing = undefined;
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator('[data-perf="canvas"]')).toBeVisible();
  await expect(panel(page).locator('[data-perf="pr-panel"]')).toBeVisible();
});

test("The claims failing: every place says so and the counts stay; one Retry reads the one file again", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  let failing = true;
  let reads = 0;
  await page.route(CLAIMS, (route: Route) => {
    reads++;
    return failing ? route.fulfill({ status: 500, json: { error: "internal", message: "test" } }) : route.continue();
  });
  const node = V2.nodes.find((n: Json) => n.id === "crates-fake-github");
  await open(page, `?sel=part:${node.id}`);
  const p = panel(page).locator('[data-perf="part-panel"]');
  // Two places: a question's claims and a responsibility's.
  await p.locator('[data-perf="question"] summary').first().click();
  await p.locator('[data-perf="responsibility"] summary').first().click();
  const failures = p.locator('[data-perf="claims-failed"]');
  await expect(failures).toHaveCount(2);
  await expect(failures.first()).toContainText("Couldn't load the evidence");
  // The answer and the counts don't wait on the claims.
  await expect(p.locator('[data-perf="answer"]').first()).toHaveText(node.questions[0].answer);
  await expect(p.locator('[data-perf="question"]').first()).toContainText(/\d+ claims?/);
  await page.waitForTimeout(1500);
  expect(reads).toBe(1);

  failing = false;
  await failures.first().getByRole("button", { name: "Retry" }).click();
  await expect(failures).toHaveCount(0);
  await expect(p.locator('[data-perf="claims"] [data-perf="claim"]').first()).toBeVisible();
  await expect(p.locator('[data-perf="responsibility"] [data-perf="claim"]').first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(reads).toBe(2);
});

test("A drill-down that beats the claims shows a skeleton until they arrive", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(CLAIMS, async (route: Route) => {
    await held;
    await route.continue();
  });
  await open(page, "?sel=part:crates-fake-github");
  await panel(page).locator('[data-perf="question"] summary').first().click();
  await expect(panel(page).locator('[data-perf="claims-loading"]')).toBeVisible();
  release();
  await expect(panel(page).locator('[data-perf="claims-loading"]')).toHaveCount(0);
  await expect(panel(page).locator('[data-perf="question"] [data-perf="claim"]').first()).toBeVisible();
});

test("v1's IDs forward on v2: merged to the new part, dropped and unknown to the PR, each with its note", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const merged = V2.carried.find((c: Json) => c.kind === "merged" && !c.was.startsWith("e"));
  await open(page, `?sel=part:${merged.was}&lens=data`);
  await expect.poll(() => selOf(page)).toBe(`part:${merged.now[0]}`);
  await expect(note(page)).toContainText(`${merged.was} was merged into`);
  await expect(note(page)).toContainText(merged.reason);
  await expect(panel(page).locator('[data-perf="part-panel"]')).toHaveAttribute("data-id", merged.now[0]);
  // The forward replaced its entry: Back leaves the view's first entry behind it.
  expect(new URL(page.url()).searchParams.get("lens")).toBe("data");

  const dropped = V2.carried.find((c: Json) => c.kind === "dropped" && !c.was.includes(".") && !c.was.startsWith("e"));
  await open(page, `?sel=part:${dropped.was}`);
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(note(page)).toContainText(`${dropped.was} was dropped: ${dropped.reason}; showing the PR`);
  await expect(panel(page).locator('[data-perf="pr-panel"]')).toBeVisible();

  await open(page, "?sel=part:no-such-part");
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(note(page)).toContainText("no-such-part was not found in this analysis; showing the PR");
  // The note goes with the next pick.
  await page.locator('[data-perf="block"]').first().click();
  await expect(note(page)).toHaveCount(0);
});

test("Both themes: the view's chrome and change colours take their tokens", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page, "?sel=part:crates-fake-github");
  const back = page.locator('[data-perf="view-back"]');
  const added = panel(page).locator('[data-perf="connection"] span[aria-label="added"]').first();
  await page.emulateMedia({ colorScheme: "light" });
  // The accent token: #2563eb in light, #3b82f6 in dark; the open token for added.
  await expect.poll(() => back.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(37, 99, 235)");
  await expect.poll(() => added.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(26, 127, 55)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => back.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(59, 130, 246)");
  await expect.poll(() => added.evaluate((e) => getComputedStyle(e).color)).toBe("rgb(63, 185, 80)");
  await expect.poll(() => page.locator('[data-perf="pr-view"]').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(9, 9, 11)");
});

// ---- ilze-k ------------------------------------------------------------------------------------

async function control(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${status().urls.control}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.ok, await res.clone().text()).toBe(true);
}

test("NoAnalysis: the empty state starts a run, shows it in the button's place, and the accepted upload fills the page in", async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await signIn(context, "ilze-k");
  // A PR of acme/web with neither a run nor an analysis for ilze-k.
  const rows = ((await (await page.request.get(`/api/issues?q=${encodeURIComponent("is:pr is:open repo:acme/web")}`)).json()) as { rows: { number: number }[] }).rows;
  let number: number | undefined;
  for (const r of rows) {
    const d = (await (await page.request.get(`/api/at/acme/web/${r.number}`)).json()) as { pr: { run?: unknown; analysis?: unknown } };
    if (!d.pr.run && !d.pr.analysis) {
      number = r.number;
      break;
    }
  }
  if (number === undefined) throw new Error("no PR of acme/web without a run or an analysis for ilze-k: ./dev-ctl reset");
  // Set up as the analysis crate's sample's PR, so the sample uploads to it.
  const head = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sample = JSON.parse(readFileSync(SAMPLE, "utf8")) as Json;
  const analysis = { ...sample, pr: { ...sample.pr, headSha: head }, carried: [] };
  await control("/edit", { repo: "acme/web", number, body: sample.pr.description });
  await control("/push", {
    repo: "acme/web",
    number,
    sha: head,
    files: [
      { filename: "api/main.go", status: "modified", additions: 1, deletions: 0 },
      { filename: "api/orders/refund.go", status: "added", additions: 21, deletions: 0 },
    ],
  });

  await page.goto(`/acme/web/pull/${number}/view`);
  const empty = page.locator('[data-perf="no-analysis"]');
  await expect(empty.locator("h2")).toHaveText("No analysis of this PR yet");
  await expect(empty).toContainText("beghu never reads your code");
  await expect(empty).toContainText("Only you can see it.");
  await expect(empty).toContainText(`beghu analyse acme/web#${number}`);
  // No analysis: the top bar has no Analyse again.
  await expect(page.locator('[data-perf="view-bar"] [data-perf="analyse"]')).toHaveCount(0);

  await empty.getByRole("button", { name: "Analyse this PR" }).click();
  const start = empty.locator('[data-perf="analyse-start"]');
  await expect(start.locator('[data-perf="analyse-status"]')).toContainText("This page fills in when the upload is accepted.");
  await expect(start.getByRole("button", { name: "End run" })).toHaveCount(0);
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  const token = /\/api\/runs\/([^/`]+)\/instructions/.exec(prompt)![1]!;

  // The agent fetches and uploads: the `analysis` push loads the view.
  expect((await fetch(`${status().urls.server}/api/runs/${token}/pr.json`)).status).toBe(200);
  const up = await fetch(`${status().urls.server}/api/runs/${token}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", "beghu-snippets": "not-checked" },
    body: JSON.stringify(analysis),
  });
  expect(up.status, await up.clone().text()).toBe(201);
  await expect(page.locator('[data-perf="canvas"]')).toBeVisible({ timeout: 20_000 });
  await expect(panel(page).locator('[data-perf="pr-panel"]')).toBeVisible();
  await expect(page.locator('[data-perf="view-analysed"]')).toContainText(`analysed at ${head.slice(0, 7)}`);
  // The run's still live: the top bar shows its state, which opens the popover, with no End run.
  const main = page.locator('[data-perf="view-bar"] [data-perf="analyse-main"]');
  await expect(main).toHaveText(/Agent working|Waiting for agent/);
  await main.click();
  await expect(page.locator('[data-perf="analyse-pop"] [data-perf="analyse-run"]')).toBeVisible();
  await expect(page.locator('[data-perf="analyse-pop"]').getByRole("button", { name: "End run" })).toHaveCount(0);
});

test("A newer analysis shows a pill, never swaps by itself, and Show it keeps the place through the upload's carried", async ({ context }) => {
  // Two uploads through ./dev-ctl, each moving the PR on Fake GitHub and waiting for its pin.
  test.setTimeout(300_000);
  const page = await signIn(context, "ilze-k");
  const has = await page.request.get("/api/AdvanGrid/beghu/pulls/191/analysis");
  if (has.status() === 200) {
    const g = (await has.json()) as Json;
    if (!g.analysis.edges.some((e: Json) => e.id === "e:perf-fixture->crates-mirror-db:hash-inputs")) {
      throw new Error("ilze-k's analysis of AdvanGrid/beghu#191 isn't v1: this test needs ./dev-ctl reset");
    }
  } else {
    devCtl(["analyse", "AdvanGrid/beghu#191", "--as", "ilze-k", "--version", "1"]);
  }
  const split = SPLIT.carried.find((c: Json) => c.kind === "split");
  await open(page, `?sel=line:${encodeURIComponent(split.was)}`);
  const body = page.locator('[data-perf="view-body"]');
  const v1 = await body.getAttribute("data-analysis");
  await expect(panel(page).locator('[data-perf="line"]')).toHaveAttribute("data-id", split.was);

  // v1's reference places that v2 lacks: an undetermined claim, with where it looked.
  // (On the same page: a pick away, and back.)
  await page.locator('[data-perf="block"][data-id="ext-image-hosts"]').click();
  const r = panel(page).locator('[data-perf="responsibility"]').first();
  await r.locator("summary").first().click();
  const und = r.locator('[data-perf="claim"]', { hasText: "couldn't determine" }).first();
  await und.locator("summary").click();
  await expect(und).toContainText("Looked at:");
  await page.goBack();
  await expect(panel(page).locator('[data-perf="line"]')).toHaveAttribute("data-id", split.was);

  // The case goes up over v1 while the view is open: the pill, and nothing swapped.
  devCtl(["analyse", "AdvanGrid/beghu#191", "--as", "ilze-k", "--version", "carried-split"]);
  const pill = page.locator('[data-perf="newer"]');
  await expect(pill).toHaveText(/A newer analysis is ready\s*Show it/, { timeout: 20_000 });
  await page.waitForTimeout(1000);
  await expect(body).toHaveAttribute("data-analysis", v1!);
  await expect(panel(page).locator('[data-perf="line"]')).toHaveAttribute("data-id", split.was);

  // Show it: the newer analysis, the selection carried to both halves of the split, with a note.
  await pill.getByRole("button", { name: "Show it" }).click();
  await expect(body).not.toHaveAttribute("data-analysis", v1!);
  await expect(pill).toHaveCount(0);
  await expect.poll(() => selOf(page)).toBe(`line:${split.now.join(",")}`);
  await expect(panel(page).locator('[data-perf="line"]')).toHaveCount(2);
  await expect(note(page)).toContainText("was split into");
  await expect(note(page)).toContainText(split.reason);

  // An old link to the v1 line forwards the same way.
  await open(page, `?sel=line:${encodeURIComponent(split.was)}`);
  await expect.poll(() => selOf(page)).toBe(`line:${split.now.join(",")}`);
  await expect(note(page)).toContainText("was split into");
});
