// The PR view (#181) in a real browser, on the recorded analysis of AdvanGrid/beghu#191: v2, which
// `./dev-ctl start` and `reset` upload for tomsj (after v1, so its `carried` has v1's IDs). The
// canvas is canvas.spec.ts's (slice 8); everything else is the view's here:
// a cold open (one read of the graph, the claims after it, no list), the top bar, the PR panel's
// PR view into the view and its ← back with the list's view kept, every place the
// panel shows (the PR, a part, a line, a step, a claim and its evidence), back and forward through
// picks, the graph failing and its Retry (and a migration's own message), the claims failing in
// every place with one Retry, the skeleton while they're on their way, v1's IDs forwarding on v2
// (merged, dropped, unknown), and both themes. Since the walkthrough (#183, purposes.spec.ts),
// each place's panel here is its reference, folded at the walk's end (`reference` opens it).
//
// NoAnalysis on a PR of acme/web with no run or analysis: as tomsj, the PR's details failing
// (the start can't show) and Retry; as ilze-k, the start, whose upload's push fills the page in.
// As ilze-k on #191, the newer-analysis pill from the upload's push; as tomsj on a PR of acme/web
// set up as the sample's, the pill from the reopened stream's reset, the push lost to a dropped
// stream. ilze-k has no
// analysis of #191 on a fresh stack: `./dev-ctl analyse --version 1 --as ilze-k` uploads v1, the
// view opens on a line `carried-split.after-v1.json` splits, and `./dev-ctl analyse --version
// carried-split --as ilze-k` uploads that case over it (dev-ctl skips v1, which she has), so the
// open view gets the `analysis` push: the pill, Show it, and the place kept through the split.
// That leaves her analysis at the case, so a rerun of that test needs `./dev-ctl reset`.
//
// Graph, claims and detail failures go through Playwright's request routing (Fake GitHub isn't
// involved); so do one part made partly drawn (`drawn`) and a split across kinds, which no
// recording has at v2.
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

/**
 * Opens the place's reference, folded at the end of the walkthrough (#183): "All changes, by
 * kind" at the PR, "Questions, facets, files and evidence" elsewhere (this spec's panels, #181).
 */
async function reference(page: Page): Promise<void> {
  const d = panel(page).locator('[data-perf="walk-reference"] details').first();
  await expect(d).toBeVisible({ timeout: 30_000 });
  if ((await d.getAttribute("open")) === null) await d.locator("> summary").click();
}

test("A cold open reads the graph once, then the claims, and no list; the top bar names the PR and the analysis", async ({ context }) => {
  await signIn(context, "tomsj");
  // A tab of its own: the list the sign-in landed on refetches on its stream's opening reset.
  const page = await context.newPage();
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
  // The canvas and the PR's panel.
  await expect(page.locator('[data-perf="block"]').first()).toBeVisible();
  await expect(panel(page).locator('[data-perf="walk-title"]')).toHaveText(V2.pr.title);
  await expect(panel(page).locator('[data-perf="walk-reference"] summary').first()).toHaveText("All changes, by kind");

  // The claims are read in the background as soon as the graph is in: one of each, and no list.
  await expect.poll(() => api.filter((u) => u.endsWith("/claims")).length).toBe(1);
  await page.waitForTimeout(500);
  expect(api.filter((u) => u === "/api/AdvanGrid/beghu/pulls/191/analysis")).toHaveLength(1);
  expect(api.filter((u) => u.endsWith("/claims"))).toHaveLength(1);
  expect(api.indexOf("/api/AdvanGrid/beghu/pulls/191/analysis")).toBeLessThan(api.findIndex((u) => u.endsWith("/claims")));
  expect(api.filter((u) => u.startsWith("/api/issues") || u.startsWith("/api/facets") || u.startsWith("/api/tree"))).toEqual([]);
});

test("The PR panel's PR view opens the view, and its ← goes back to the panel with the list's view", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const list = `?q=${encodeURIComponent("is:pr repo:AdvanGrid/beghu")}`;
  await page.goto(`/AdvanGrid/beghu/pull/191${list}`);
  const main = page.locator('[data-perf="analyse-main"]');
  await expect(main).toHaveAttribute("href", VIEW);
  await main.click();
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(VIEW);
  const back = page.locator('[data-perf="view-back"]');
  await expect(back).toHaveAttribute("href", `/AdvanGrid/beghu/pull/191${list}`);
  // A pick keeps the way back.
  await page.locator('[data-perf="block"]').first().click();
  await expect.poll(() => selOf(page)).toMatch(/^part:/);
  await expect(back).toHaveAttribute("href", `/AdvanGrid/beghu/pull/191${list}`);
  await back.click();
  await expect(page.locator('[data-perf="list-pane"]')).toBeVisible();
  await expect(page.locator('[data-perf="analyse"]')).toBeVisible();
  expect(new URL(page.url()).search).toBe(list);
});

test("The PR's panel: All changes by kind, the description, coverage, the facets found, and Since the last analysis", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page);
  await reference(page);
  const groups = panel(page).locator('[data-perf="rank-group"] h3');
  await expect(groups).toHaveText([/^Boundary crossings \(\d+\)$/, /^New and removed parts \(\d+\)$/, /^Changed responsibilities or facets \(\d+\)$/, /^Edits inside parts \(\d+\)$/]);

  // Every changed line is in a group: crossing, new or removed, or an edit (one crossing no
  // boundary between the same two parts).
  const lineItems = await panel(page).locator('[data-perf="rank-item"][data-kind="line"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  for (const e of V2.edges.filter((x: Json) => x.change !== "unchanged")) expect(lineItems).toContain(e.id);
  const edits = panel(page).locator('[data-perf="rank-group"]').nth(3);
  const edit = V2.edges.find((x: Json) => x.change === "modified" && x.boundaries.length === 0);
  await expect(edits.locator(`[data-perf="rank-item"][data-id="${edit.id}"]`)).toHaveCount(1);

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

test("All changes by kind lists a line's changed facet with the parts' changed responsibilities and facets", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  // No recording changes a line's facet: one made so on the way in.
  const e = V2.edges.find((x: Json) => x.facets.length > 0);
  const def = V2.facets.find((f: Json) => f.id === e.facets[0].facet);
  const other = def.values.find((v: Json) => v.id !== e.facets[0].values[0].value);
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    g.analysis.edges.find((x: Json) => x.id === e.id).facets[0].was = [other.id];
    await route.fulfill({ response: res, json: g });
  });
  await open(page);
  await reference(page);
  const facets = panel(page).locator('[data-perf="rank-group"]').nth(2);
  await expect(facets.locator(`[data-perf="rank-item"][data-kind="line"][data-id="${e.id}"]`)).toContainText(`${def.name} ${other.label} →`);
});

test("A part's panel: questions to evidence, what it does and who uses it, how it's built, connections with hidden ones faded, files", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const node = V2.nodes.find((n: Json) => n.id === "crates-fake-github");
  await open(page, `?sel=part:${node.id}`);
  await reference(page);
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
  await reference(page);
  const row = panel(page).locator('[data-perf="responsibility"]', { hasText: withUsers.r.text });
  await expect(row.locator('[data-perf="used-by"]')).toHaveText(/used by \d+ parts?/);
});

test("A part's panel says which folders are partly drawn, at any depth, and the PR's coverage lists it", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  // No recording has a partly drawn part at v2: one made so on the way in. crates-server draws
  // folders two deep (src/reconcile/sweep) and file parts (src/accounts.rs, whose folder counts).
  // Three unchanged parts are added whose names an extension misreads, each its own claim's
  // evidence saying what it is: docker/Dockerfile and LICENSE files, conf.d a folder.
  const extra: [string, string, string][] = [
    ["crates-server.docker", "crates/server/docker/Dockerfile", "crates/server/docker/Dockerfile"],
    ["crates-server.license", "crates/server/LICENSE", "crates/server/LICENSE"],
    ["crates-server.conf-d", "crates/server/conf.d", "crates/server/conf.d/app.conf"],
  ];
  const claim = (id: string, path: string) => ({
    id: `c-${id}`,
    status: "supported",
    text: `${path} line 1`,
    evidence: [{ kind: "code", side: "head", path, start: 1, end: 1, note: "test", snippet: "x" }],
  });
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    const n = g.analysis.nodes.find((x: Json) => x.id === "crates-server");
    n.drawn = { partial: true, folders: 20 };
    for (const [id, path] of extra) {
      g.analysis.nodes.push({
        id,
        kind: "module",
        parent: "crates-server",
        name: path.slice(path.lastIndexOf("/") + 1),
        paths: [path],
        summary: "test",
        change: "unchanged",
        responsibilities: [{ id: "r", text: "test", change: "unchanged", claims: [`c-${id}`] }],
        facets: [],
        questions: [],
        files: [],
      });
      g.analysis.claims.push({ id: `c-${id}`, status: "supported", code: 1, description: 0, issue: 0 });
    }
    await route.fulfill({ response: res, json: g });
  });
  await page.route(CLAIMS, async (route: Route) => {
    const res = await route.fetch();
    const f = (await res.json()) as Json;
    f.claims.push(...extra.map(([id, , shown]) => claim(id, shown)));
    await route.fulfill({ response: res, json: f });
  });
  await open(page, "?sel=part:crates-server");
  await reference(page);
  const drawn = ["conf.d", "docker", "src", "src/analyses", "src/import", "src/reconcile", "src/reconcile/sweep", "tests"];
  const line = `${drawn.length} of 20 folders drawn (${drawn.join(", ")}): no line, step, purpose or conflict in this PR reaches the other ${20 - drawn.length}.`;
  await expect(panel(page).locator('[data-perf="partly-drawn"]')).toHaveText(`Partly drawn: ${line}`);
  await open(page);
  await reference(page);
  const coverage = panel(page).locator('[data-perf="coverage"]');
  await expect(coverage).toContainText("Partly drawn parts (1)");
  await coverage.locator("summary", { hasText: "Partly drawn parts (1)" }).click();
  await expect(coverage).toContainText(`${V2.nodes.find((x: Json) => x.id === "crates-server").name}: ${line}`);
});

test("A line's panel: what it carries, when, mode, what it crosses, and its evidence", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const e = V2.edges.find((x: Json) => x.data && x.boundaries.length > 0);
  await open(page, `?sel=line:${encodeURIComponent(e.id)}`);
  await reference(page);
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
  const bare = sc.id.slice("scenario:".length);
  await open(page, `?sel=step:${bare}/2`);
  const st = panel(page).locator('[data-perf="step-panel"]');
  await expect(st).toContainText(`${sc.title} · step 2 of ${sc.steps.length}`);
  await expect(st.locator("h2")).toHaveText(sc.steps[1].action);
  await expect(st.locator('[data-perf="flow"] [aria-current="step"]')).toContainText(sc.steps[1].action);
  await st.getByRole("button", { name: "Next →" }).click();
  await expect.poll(() => selOf(page)).toBe(`step:${bare}/3`);
  await expect(st.locator("h2")).toHaveText(sc.steps[2].action);
  await st.getByRole("button", { name: "← Previous" }).click();
  await st.getByRole("button", { name: "← Previous" }).click();
  await expect(st.getByRole("button", { name: "← Previous" })).toBeDisabled();
});

test("Back and forward walk the picks; a setting replaces its entry and stays through picks", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page, "?lens=data");
  // Pick a block (the first the PR's fold draws, #183), then a connection of it from the panel.
  const first = page.locator('[data-perf="block"]:not([hidden] *)').first();
  const top = [(await first.getAttribute("data-id"))!];
  await first.click();
  await expect.poll(() => selOf(page)).toBe(`part:${top[0]}`);
  await reference(page);
  await panel(page).locator('[data-perf="connection"] button').first().click();
  await expect.poll(() => selOf(page)).toMatch(/^line:/);
  const lineSel = selOf(page);
  // The view-wide setting rode along.
  expect(new URL(page.url()).searchParams.get("lens")).toBe("data");

  await page.goBack();
  await expect.poll(() => selOf(page)).toBe(`part:${top[0]}`);
  await expect(panel(page).locator('[data-perf="walk-part"]')).toHaveAttribute("data-id", top[0]);
  await page.goBack();
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(panel(page).locator('[data-perf="walk-pr"]')).toBeVisible();
  await page.goForward();
  await expect(panel(page).locator('[data-perf="walk-part"]')).toHaveAttribute("data-id", top[0]);
  await page.goForward();
  await expect.poll(() => selOf(page)).toBe(lineSel);
  await expect(panel(page).locator('[data-perf="walk-line"]')).toBeVisible();
});

test("A setting replaces its history entry, normalised, and the panel follows it", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page, "?sel=part:crates-fake-github");
  await reference(page);
  const entries = await page.evaluate(() => history.length);
  const hidden = panel(page).locator('[data-perf="connection"][data-hidden]');
  await expect(hidden.first()).toContainText("(hidden: test)");
  // The canvas's Lines menu (canvas.spec.ts has its counts and the lens greying it).
  const tests = page.locator('[data-perf="lines-option"][data-value="test"] input');
  await page.locator('[data-perf="lines-menu"]').click();

  // Test lines on: the URL says so in place of its entry, and the panel's test lines aren't faded.
  await tests.check();
  await expect.poll(() => new URL(page.url()).searchParams.get("lines")).toBe("runtime,test,call,data,event");
  await expect(panel(page).locator('[data-perf="connection"]', { hasText: "(hidden: test)" })).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(entries);
  expect(selOf(page)).toBe("part:crates-fake-github");

  // Off again: back at the default, which the URL leaves out.
  await tests.uncheck();
  await expect.poll(() => new URL(page.url()).searchParams.has("lines")).toBe(false);
  await expect(hidden.first()).toContainText("(hidden: test)");
  expect(await page.evaluate(() => history.length)).toBe(entries);

  // A URL that spells out the defaults reads as them, and the next write drops them.
  // `boxes=folder,outside-role` is both slots' defaults: own parts by folder, outside systems by
  // the analysis's first `outside-*` facet.
  await open(page, "?sel=part:crates-fake-github&lines=call,runtime,data,event&boxes=folder,outside-role&lens=modules");
  await page.locator('[data-perf="lines-menu"]').click();
  await tests.check();
  await expect.poll(() => new URL(page.url()).search).toBe("?sel=part:crates-fake-github&lines=runtime,test,call,data,event");
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
  await expect(panel(page).locator('[data-perf="walk-pr"]')).toBeVisible();
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
  await reference(page);
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
  await reference(page);
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
  await expect(panel(page).locator('[data-perf="walk-part"]')).toHaveAttribute("data-id", merged.now[0]);
  // The forward replaced its entry: Back leaves the view's first entry behind it.
  expect(new URL(page.url()).searchParams.get("lens")).toBe("data");

  const dropped = V2.carried.find((c: Json) => c.kind === "dropped" && !c.was.includes(".") && !c.was.startsWith("e"));
  await open(page, `?sel=part:${dropped.was}`);
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(note(page)).toContainText(`${dropped.was} was dropped: ${dropped.reason}; showing the PR`);
  await expect(panel(page).locator('[data-perf="walk-pr"]')).toBeVisible();

  await open(page, "?sel=part:no-such-part");
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(note(page)).toContainText("no-such-part was not found in this analysis; showing the PR");
  // The note goes with the next pick.
  await page.locator('[data-perf="block"]').first().click();
  await expect(note(page)).toHaveCount(0);

  // An old link followed in the tab (a link from elsewhere, as the router hears it): its note
  // stays on the entry it forwarded to, and goes when Back leaves it.
  const first = selOf(page);
  await page.evaluate((was) => {
    history.pushState(history.state, "", `?sel=part:${was}`);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, merged.was);
  await expect.poll(() => selOf(page)).toBe(`part:${merged.now[0]}`);
  await expect(note(page)).toContainText(`${merged.was} was merged into`);
  await page.goBack();
  await expect.poll(() => selOf(page)).toBe(first);
  await expect(note(page)).toHaveCount(0);
  await page.goForward();
  await expect.poll(() => selOf(page)).toBe(`part:${merged.now[0]}`);
  await expect(note(page)).toHaveCount(0);
});

test("A split to parts and a line selects the parts, and says the line is selected separately, not that it's missing", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  // No recording splits across kinds: a split added on the way in, to two parts, a line and an
  // ID no analysis has.
  const [a, b] = V2.nodes.filter((n: Json) => n.kind !== "system" && n.parent === V2.nodes.find((x: Json) => x.kind === "system").id);
  const e = V2.edges[0];
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    g.analysis.carried.push({ kind: "split", was: "old-mixed", now: [a.id, e.id, b.id, "no-such-part"], cause: "correction", reason: "test split", claims: [] });
    await route.fulfill({ response: res, json: g });
  });
  await open(page, "?sel=part:old-mixed");
  await expect.poll(() => selOf(page)).toBe(`part:${a.id},${b.id}`);
  await expect(note(page)).toContainText(`old-mixed was split into ${a.name} and ${b.name}: test split`);
  await expect(note(page)).toContainText("can be selected separately");
  await expect(note(page)).toContainText("no-such-part not found in this analysis");
  await expect(note(page)).not.toContainText(`${e.id} not found`);
});

test("Typed IDs are written once: a conflict, a purpose and a step without their own prefixes", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  // v2 has no conflict: v1's first, added on the way in.
  const conflict = read("beghu-191/analysis-v1.json").conflicts[0];
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    g.analysis.conflicts.push(conflict);
    await route.fulfill({ response: res, json: g });
  });
  expect(conflict.id.startsWith("conflict:")).toBe(true);
  await open(page, `?sel=conflict:${conflict.id.slice("conflict:".length)}`);
  await expect(panel(page).locator('[data-perf="conflict-panel"] h2')).toHaveText(conflict.question);
  expect(selOf(page)).toBe(conflict.id);

  const purpose = V2.purposes[0];
  await open(page, `?sel=purpose:${purpose.id.slice("purpose:".length)}`);
  await expect(panel(page).locator('[data-perf="walk-purpose"] [data-perf="walk-title"]')).toHaveText(purpose.name);
  expect(selOf(page)).toBe(purpose.id);
  const sc = V2.scenarios[0];
  expect(sc.id.startsWith("scenario:")).toBe(true);
  await open(page, `?sel=step:${sc.id.slice("scenario:".length)}/1`);
  await expect(panel(page).locator('[data-perf="step-panel"] h2')).toHaveText(sc.steps[0].action);
  // A pick writes the same form.
  await panel(page).getByRole("button", { name: "Next →" }).click();
  await expect.poll(() => selOf(page)).toBe(`step:${sc.id.slice("scenario:".length)}/2`);
});

test("Both themes: the view's chrome and change colours take their tokens", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  await open(page, "?sel=part:crates-fake-github");
  await reference(page);
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

/** An open PR of acme/web with neither a run nor an analysis for the page's account. */
async function barePr(page: Page): Promise<number> {
  const rows = ((await (await page.request.get(`/api/issues?q=${encodeURIComponent("is:pr is:open repo:acme/web")}`)).json()) as { rows: { number: number }[] }).rows;
  for (const r of rows) {
    const d = (await (await page.request.get(`/api/at/acme/web/${r.number}`)).json()) as { pr: { run?: unknown; analysis?: unknown } };
    if (!d.pr.run && !d.pr.analysis) return r.number;
  }
  throw new Error("no PR of acme/web without a run or an analysis: ./dev-ctl reset");
}

/**
 * A bare PR of acme/web (`barePr`) set up as the analysis crate's sample's (its description, a
 * push of the sample's files to a new head), so the sample, at that head, uploads to it.
 */
async function asSamplesPr(page: Page): Promise<{ number: number; head: string; analysis: Json }> {
  const number = await barePr(page);
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
  return { number, head, analysis };
}

/** Analyse this PR on the NoAnalysis page: the run's token, from the prompt it copied. */
async function startFromEmpty(page: Page): Promise<string> {
  await page.locator('[data-perf="no-analysis"]').getByRole("button", { name: "Analyse this PR" }).click();
  await expect(page.locator('[data-perf="no-analysis"] [data-perf="analyse-start"] [data-perf="analyse-status"]')).toBeVisible();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  return /\/api\/runs\/([^/`]+)\/instructions/.exec(prompt)![1]!;
}

/** What the agent does with a run: fetches its pr.json (pinning it) and uploads `analysis`. */
async function agentUploads(token: string, analysis: Json): Promise<void> {
  expect((await fetch(`${status().urls.server}/api/runs/${token}/pr.json`)).status).toBe(200);
  const up = await fetch(`${status().urls.server}/api/runs/${token}/analysis`, {
    method: "POST",
    headers: { "content-type": "application/json", "beghu-snippets": "not-checked" },
    body: JSON.stringify(analysis),
  });
  expect(up.status, await up.clone().text()).toBe(201);
}

test("NoAnalysis: the PR's details failing says the run can't start from here, and Retry recovers", async ({ context }) => {
  const page = await signIn(context, "tomsj");
  const number = await barePr(page);
  // The PR's detail, by where it is (a cold load) or by id (once the tab knows it).
  const detail = (u: URL) => u.pathname === `/api/at/acme/web/${number}` || /^\/api\/issues\/\d+$/.test(u.pathname);
  await page.route(detail, (route: Route) => route.fulfill({ status: 500, json: { error: "internal", message: "test" } }));
  await page.goto(`/acme/web/pull/${number}/view`);
  const empty = page.locator('[data-perf="no-analysis"]');
  await expect(empty.locator("h2")).toHaveText("No analysis of this PR yet");
  const failed = empty.locator('[data-perf="no-analysis-failed"]');
  await expect(failed).toHaveText(/^Couldn't load the PR's details, so the run can't start from here · Retry$/);
  await expect(empty.getByRole("button", { name: "Analyse this PR" })).toHaveCount(0);

  await page.unroute(detail);
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed).toHaveCount(0);
  await expect(empty.getByRole("button", { name: "Analyse this PR" })).toBeVisible();
  await expect(page.locator('[data-perf="view-title"]')).not.toBeEmpty();
});

test("NoAnalysis: the empty state starts a run, shows it in the button's place, and the accepted upload fills the page in", async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await signIn(context, "ilze-k");
  const { number, head, analysis } = await asSamplesPr(page);

  await page.goto(`/acme/web/pull/${number}/view`);
  const empty = page.locator('[data-perf="no-analysis"]');
  await expect(empty.locator("h2")).toHaveText("No analysis of this PR yet");
  await expect(empty).toContainText("beghu never reads your code");
  await expect(empty).toContainText("Only you can see it.");
  await expect(empty).toContainText(`beghu analyse acme/web#${number}`);
  // No analysis: the top bar has no Analyse again.
  await expect(page.locator('[data-perf="view-bar"] [data-perf="analyse"]')).toHaveCount(0);

  const token = await startFromEmpty(page);
  const start = empty.locator('[data-perf="analyse-start"]');
  await expect(start.locator('[data-perf="analyse-status"]')).toContainText("This page fills in when the upload is accepted.");
  await expect(start.getByRole("button", { name: "End run" })).toHaveCount(0);

  // The agent fetches and uploads: the `analysis` push loads the view.
  await agentUploads(token, analysis);
  await expect(page.locator('[data-perf="canvas"]')).toBeVisible({ timeout: 20_000 });
  await expect(panel(page).locator('[data-perf="walk-pr"]')).toBeVisible();
  await expect(page.locator('[data-perf="view-analysed"]')).toContainText(`analysed at ${head.slice(0, 7)}`);
  // The PR's first analysis: nothing came before it.
  await expect(panel(page).locator('[data-perf="since-last"]')).toHaveCount(0);
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
  // Two more tabs open on v1: a part whose ID survives with new words, and a sub-purpose the
  // case drops, whose place is the level above.
  const V1 = read("beghu-191/analysis-v1.json");
  const kept = V1.nodes.find((n: Json) => n.id === "crates-fake-github");
  const keptNow = SPLIT.nodes.find((n: Json) => n.id === kept.id);
  expect(keptNow.summary).not.toBe(kept.summary);
  const sub = SPLIT.carried.find((c: Json) => c.kind === "dropped" && c.was.startsWith("purpose:") && c.was.includes("/"));
  const parent = SPLIT.purposes.find((p: Json) => p.id === sub.was.slice(0, sub.was.lastIndexOf("/")));
  const survives = await context.newPage();
  await open(survives, `?sel=part:${kept.id}`);
  await reference(survives);
  const p1 = panel(survives).locator('[data-perf="part-panel"]');
  await expect(p1).toContainText(kept.summary);
  // A claims place opened, so Show it must put the newer analysis's claims there.
  await p1.locator('[data-perf="responsibility"] summary').first().click();
  await expect(p1.locator('[data-perf="responsibility"] [data-perf="claim"]').first()).toBeVisible();
  const above = await context.newPage();
  await open(above, `?sel=purpose:${sub.was.slice("purpose:".length)}`);
  await expect(panel(above).locator('[data-perf="walk-purpose"] [data-perf="walk-title"]')).toHaveText(V1.purposes.find((p: Json) => p.id === sub.was).name);

  // External connections, where the canvas draws the outside system picked below.
  await open(page, `?sel=line:${encodeURIComponent(split.was)}&lens=external`);
  await reference(page);
  const body = page.locator('[data-perf="view-body"]');
  const v1 = await body.getAttribute("data-analysis");
  await expect(panel(page).locator('[data-perf="line"]')).toHaveAttribute("data-id", split.was);

  // v1's reference places that v2 lacks: an undetermined claim, with where it looked.
  // (On the same page: a link to the outside system, which the PR's fold (#183) draws only in its
  // rest block, so it opens the fold down to it; and back.)
  await open(page, "?sel=part:ext-image-hosts&lens=external");
  await expect.poll(() => selOf(page)).toBe("part:ext-image-hosts");
  await expect(page.locator('[data-perf="block"][data-id="ext-image-hosts"]')).toHaveAttribute("data-selected", "");
  await reference(page);
  const r = panel(page).locator('[data-perf="responsibility"]').first();
  await r.locator("summary").first().click();
  const und = r.locator('[data-perf="claim"]', { hasText: "couldn't determine" }).first();
  await und.locator("summary").click();
  await expect(und).toContainText("Looked at:");
  await page.goBack();
  await reference(page);
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
  await reference(page);
  await expect(panel(page).locator('[data-perf="line"]')).toHaveCount(2);
  await expect(note(page)).toContainText("was split into");
  await expect(note(page)).toContainText(split.reason);

  // The part whose ID survived: still selected, in the newer analysis's words.
  await survives.locator('[data-perf="newer"]').getByRole("button", { name: "Show it" }).click();
  await expect(survives.locator('[data-perf="newer"]')).toHaveCount(0);
  await reference(survives);
  await expect(p1).toContainText(keptNow.summary);
  await expect(p1).not.toContainText(kept.summary);
  expect(selOf(survives)).toBe(`part:${kept.id}`);
  await expect(note(survives)).toHaveCount(0);
  await expect(p1.locator('[data-perf="responsibility"]')).toHaveCount(keptNow.responsibilities.length);
  await p1.locator('[data-perf="responsibility"] summary').first().click();
  const claimNow = SPLIT.claims.find((c: Json) => c.id === keptNow.responsibilities[0].claims[0]);
  await expect(p1.locator('[data-perf="responsibility"] [data-perf="claim"]').first()).toContainText(claimNow.text);

  // The dropped sub-purpose: the level above, its parent, with the reason.
  await above.locator('[data-perf="newer"]').getByRole("button", { name: "Show it" }).click();
  await expect.poll(() => selOf(above)).toBe(parent.id);
  await expect(panel(above).locator('[data-perf="walk-purpose"] [data-perf="walk-title"]')).toHaveText(parent.name);
  await expect(note(above)).toContainText(`was dropped: ${sub.reason}; showing ${parent.name}`);

  // An old link to the v1 line forwards the same way.
  await open(page, `?sel=line:${encodeURIComponent(split.was)}`);
  await expect.poll(() => selOf(page)).toBe(`line:${split.now.join(",")}`);
  await expect(note(page)).toContainText("was split into");
});

test("An upload while the stream was down shows the pill once the stream's reset says so", async ({ context }) => {
  // On a PR of its own, as the sample's, through a run started from its empty state: a run takes
  // more than one upload, and the sample again keeps every ID, so it needs no `carried`. (Not
  // #191 through ./dev-ctl analyse: each account takes its recorded chain once per reset, and the
  // other tests use tomsj's and ilze-k's.)
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await signIn(context, "tomsj");
  // A handle on the tab's EventSources, to cut the live one as a dropped connection would
  // (live.spec.ts does the same).
  await page.addInitScript(() => {
    const Native = window.EventSource;
    const all: EventSource[] = [];
    (window as unknown as { streams: EventSource[] }).streams = all;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        all.push(this);
      }
    };
  });
  const { number, analysis } = await asSamplesPr(page);
  await page.goto(`/acme/web/pull/${number}/view`);
  const token = await startFromEmpty(page);
  await agentUploads(token, analysis);
  const body = page.locator('[data-perf="view-body"]');
  await expect(body).toBeVisible({ timeout: 20_000 });
  const shown = await body.getAttribute("data-analysis");
  await page.waitForFunction(() => (window as unknown as { streams: EventSource[] }).streams.at(-1)?.readyState === EventSource.OPEN);
  const pill = page.locator('[data-perf="newer"]');

  // The stream drops and stays down: every retry is refused, so the upload's push is lost.
  const stream = (u: URL) => u.pathname === "/api/stream";
  await page.route(stream, (route: Route) => route.abort("connectionrefused"));
  await page.evaluate(() => (window as unknown as { streams: EventSource[] }).streams.at(-1)!.dispatchEvent(new Event("error")));
  await agentUploads(token, analysis);
  await page.waitForTimeout(1500);
  await expect(pill).toHaveCount(0);

  // Back: the stream opens with a reset, the PR's detail is read again, and it names a newer
  // analysis than the one shown.
  await page.unroute(stream);
  await expect(pill).toHaveText(/A newer analysis is ready\s*Show it/, { timeout: 20_000 });
  await expect(body).toHaveAttribute("data-analysis", shown!);
  await pill.getByRole("button", { name: "Show it" }).click();
  await expect(body).not.toHaveAttribute("data-analysis", shown!);
  await expect(pill).toHaveCount(0);
});
