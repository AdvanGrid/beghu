// The browser suite: full Chromium against the production build, each action timed from its
// input event to the frame that shows the right outcome (probe.ts), with the right rows taken
// from the API beforehand. Beside the timings it counts what a page load and each action cost:
// the request depth of the first load (cold and warm), its bytes (gzip), the PR view's modules it
// mustn't fetch (in any chunk, the entry's included) and the view's chunks' own bytes (gzip), the list fetches a load makes (the stream open's
// reset refetches it: measured, with no exemption), the round trips of a filter and of opening
// an issue, the refetch batches of a push, the rows rendered while
// scrolling and the long tasks meanwhile.
//
// The PR view's canvas (#182), on the tiled analyses (#2627's shape at 1×, and 3×; uploaded on
// the first sample that needs them, unless the stack has them): a cold navigation to the frame
// with the top-level drawing, and the round trips chained before it; from the PR panel's link in
// a warm app to the drawing; a revisit's bytes for the analysis; and a double-click on a block to
// the frame its glide starts in, with the long tasks from the click to the glide's end.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, type CDPSession, type Page, chromium } from "playwright-core";
import { ensureTiles, type Tile } from "./analyses.ts";
import { expected, fetchRaw, Session, settle } from "./http.ts";
import { probe, type Check, type Outcome } from "./probe.ts";
import { control, type Stack } from "./stack.ts";
import type { Probe, Sample } from "./suite.ts";
import { sleep } from "./stats.ts";

const VIEWPORT = { width: 1280, height: 800 };
/** How long a page goes without an API request before its load or action counts as done. */
const QUIET_MS = 1000;

/** The PR view's source module, as the Vite manifest keys it (web/src/router.tsx imports it lazily). */
const VIEW_MODULE = "src/pr-view/View.tsx";

/**
 * The PR view's chunks (`/assets/…`) in a web build: its module's and those it imports
 * statically, at any depth, the entry's aside (first-load JS). None in a build from before the
 * view (main, when this tree is compared with it): its gates go unmeasured there.
 */
export function viewChunks(web: string): string[] {
  const path = join(web, ".vite", "manifest.json");
  if (!existsSync(path)) return [];
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, { file: string; isEntry?: boolean; imports?: string[] }>;
  if (!manifest[VIEW_MODULE]) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const todo = [VIEW_MODULE];
  for (let k = todo.pop(); k !== undefined; k = todo.pop()) {
    const m = manifest[k];
    if (!m || m.isEntry || seen.has(k)) continue;
    seen.add(k);
    out.push(`/${m.file}`);
    todo.push(...(m.imports ?? []));
  }
  return out;
}

/** The PR view's own source (`src/pr-view/`) and the Analyse module it shares with the PR panel. */
const isViewModule = (m: string) => m.startsWith("src/pr-view/") || m === "src/Analyse.tsx";

/**
 * The PR view's modules (`isViewModule`) in the chunks `fetched` (`/assets/…` paths), the entry
 * included: from the build's module list (`.vite/modules.json`, web/vite.config.ts `moduleList`),
 * each chunk's source modules. Undefined for a build without the list (main, when this tree is
 * compared with it): the gate goes unmeasured there. Throws if the list names no `src/pr-view/`
 * module in the view's own chunks (`viewChunks`): its module ids no longer match the paths this
 * looks for (or the view's chunks are gone), and a count of none would pass for nothing.
 */
export function viewModulesIn(web: string, fetched: string[]): { found: string[]; chunks: number } | undefined {
  const path = join(web, ".vite", "modules.json");
  if (!existsSync(path)) return undefined;
  const list = JSON.parse(readFileSync(path, "utf8")) as Record<string, string[]>;
  const own = viewChunks(web);
  if (!own.some((url) => list[url.replace(/^\//, "")]?.some((m) => m.startsWith("src/pr-view/")))) {
    throw new Error(
      `browser.cold.pr-view-modules: ${path} lists no src/pr-view/ module in the PR view's own chunks (${own.join(", ") || "none in the manifest"}), so the gate can't tell view code from the rest: check web/vite.config.ts moduleList's paths`,
    );
  }
  const found: string[] = [];
  let chunks = 0;
  for (const url of new Set(fetched)) {
    const modules = list[url.replace(/^\//, "")];
    if (!modules) continue;
    chunks++;
    for (const m of modules) if (isViewModule(m)) found.push(`${url}: ${m}`);
  }
  return { found, chunks };
}

export function launch(): Promise<Browser> {
  return chromium.launch({ channel: "chromium", headless: true });
}




/** The API requests a page makes (the stream aside), with when each began. */
function watchApi(page: Page): { url: string; at: number }[] {
  const seen: { url: string; at: number }[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && u.pathname !== "/api/stream") seen.push({ url: u.pathname + u.search, at: Date.now() });
  });
  return seen;
}

async function quiet(seen: { at: number }[], ms = QUIET_MS): Promise<void> {
  for (;;) {
    const last = seen.at(-1)?.at ?? 0;
    const wait = last + ms - Date.now();
    if (wait <= 0) return;
    await sleep(wait);
  }
}

async function outcome(page: Page, timeout = 30_000): Promise<Outcome> {
  try {
    const h = await page.waitForFunction(() => window.__perf.result, null, { timeout, polling: 50 });
    return (await h.jsonValue()) as Outcome;
  } catch (e) {
    // What the page showed instead, for the log.
    const seen = await page
      .evaluate(() => ({
        armed: window.__perf?.armed,
        rows: [...document.querySelectorAll<HTMLElement>('[data-perf="row"]')].slice(0, 20).map((r) => r.dataset.id),
        list: document.querySelector('[data-perf="list"]')?.outerHTML.slice(0, 200),
        text: document.body.innerText.slice(0, 300),
      }))
      .catch(() => null);
    throw new Error(`${(e as Error).message}\n  at ${page.url()}\n  page: ${JSON.stringify(seen)}`);
  }
}

/** Arms `check`, runs `act`, and returns the time from the input event to the frame. */
async function act(page: Page, check: Check, action: () => Promise<void>): Promise<{ ms: number; at: Outcome }> {
  await page.evaluate((c) => window.__perf.arm(c), check);
  await action();
  const at = await outcome(page);
  if (!at.input) throw new Error(`${check.kind}: no input event before the frame`);
  return { ms: at.t - at.input.t, at };
}

/** A network request of a page load, as CDP saw it. */
interface Req {
  id: string;
  url: string;
  type: string;
  parent: string | null;
  cached: boolean;
  at: number;
}

/** Records every request of the page CDP is attached to, with what started it. */
async function network(cdp: CDPSession): Promise<Map<string, Req>> {
  const reqs = new Map<string, Req>();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (e) => {
    if (reqs.has(e.requestId)) return; // a redirect: the same request
    const i = e.initiator;
    let parent: string | null = null;
    if (i.type === "script") {
      for (let st: typeof i.stack | undefined = i.stack; st && !parent; st = st.parent) parent = st.callFrames.find((f) => f.url)?.url ?? null;
    } else if (i.url) parent = i.url;
    reqs.set(e.requestId, { id: e.requestId, url: e.request.url, type: e.type ?? "Other", parent, cached: false, at: Date.now() });
  });
  cdp.on("Network.requestServedFromCache", (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.cached = true;
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (r && (e.response.fromDiskCache || e.response.fromPrefetchCache || e.response.fromServiceWorker)) r.cached = true;
  });
  return reqs;
}

const strip = (u: string) => u.split("#")[0]!;

/**
 * The load's depth: the longest chain of network round trips, each request one deeper than what
 * started it, a cache hit adding none. Only the first request for each URL begun before the list
 * was ready counts (the stream's reset refetch comes after, from the stream). `only`: the chains
 * to the URLs it picks alone (what a drawing waits on), not every request begun before.
 */
function depth(reqs: Map<string, Req>, readyAt: number, only?: (url: string) => boolean): { depth: number; chain: string[] } {
  const firsts = new Map<string, Req>();
  for (const r of reqs.values()) {
    const u = strip(r.url);
    if (r.at > readyAt || u.includes("/api/stream") || firsts.has(u)) continue;
    firsts.set(u, r);
  }
  const memo = new Map<string, { depth: number; chain: string[] }>();
  const of = (u: string, seen: Set<string>): { depth: number; chain: string[] } => {
    const known = memo.get(u);
    if (known) return known;
    const r = firsts.get(u);
    if (!r || seen.has(u)) return { depth: 0, chain: [] };
    seen.add(u);
    const up = r.parent ? of(strip(r.parent), seen) : { depth: 0, chain: [] };
    const out = { depth: up.depth + (r.cached ? 0 : 1), chain: [...up.chain, `${new URL(u).pathname}${r.cached ? " (cache)" : ""}`] };
    memo.set(u, out);
    return out;
  };
  let best = { depth: 0, chain: [] as string[] };
  for (const u of firsts.keys()) {
    if (only && !only(u)) continue;
    const d = of(u, new Set());
    if (d.depth > best.depth) best = d;
  }
  return best;
}

export interface BrowserCtx {
  browser: Browser;
  stack: Stack;
  session: Session;
  state: Awaited<ReturnType<BrowserContext["storageState"]>>;
  warm: BrowserContext;
  /**
   * The list's path on this stack, where sign-in lands: `/issues`, or `/` on a build from before
   * the public site took `/` (main, when this tree is compared with it).
   */
  list: string;
}

/** A signed-in browser for `stack`: its storage, to start cold contexts from, and a warm context. */
export async function prepare(browser: Browser, stack: Stack, opts: { quick?: boolean } = {}): Promise<BrowserCtx> {
  const session = new Session(stack.url);
  await session.signIn("tomsj");
  const login = await browser.newContext({ viewport: VIEWPORT, baseURL: stack.url });
  const page = await login.newPage();
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/issues" || u.pathname === "/");
  const list = new URL(page.url()).pathname;
  const state = await login.storageState();
  await login.close();
  const warm = await browser.newContext({ viewport: VIEWPORT, baseURL: stack.url, storageState: state });
  await warm.addInitScript(probe, null);
  // An unmeasured visit fills the warm context's cache.
  const prime = await warm.newPage();
  await prime.goto(list);
  // The first visit to fresh data can wait on the server's first reads of the mirrors.
  await prime
    .locator('[data-perf="row"]')
    .first()
    .waitFor({ timeout: 120_000 })
    .catch(async (e: Error) => {
      throw new Error(`${e.message}\n  page: ${(await prime.locator("body").innerText().catch(() => "?")).slice(0, 300)}`);
    });
  await sleep(QUIET_MS);
  await prime.close();
  // Quick mode makes no writes: a shorter hold only has the events poller's first pass to wait out.
  await settle(session, opts.quick ? 1000 : 3000);
  return { browser, stack, session, state, warm, list };
}

/** A new tab in the warm context on `path`, once its list shows `ids`. */
async function warmPage(ctx: BrowserContext, path: string, ids: number[]): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(path);
  await page.evaluate((c) => window.__perf.arm(c), { kind: "rows", ids } as Check);
  await outcome(page);
  return page;
}

export async function browserProbes(c: BrowserCtx): Promise<Probe[]> {
  const first = await expected(c.session);
  const cookie = c.state.cookies.map((k) => `${k.name}=${k.value}`).join("; ");
  let coldCounted = false;
  let warmCounted = false;
  let filterCounted = false;
  let openCounted = false;
  const probes: Probe[] = [];

  probes.push({
    name: "browser.cold",
    gates: [
      "browser.cold.ms",
      "browser.cold.depth",
      "browser.load.list-fetches",
      "browser.first-load.kb",
      "browser.first-load.html.kb",
      "browser.cold.pr-view-modules",
      "browser.pr-view.kb",
    ],
    async sample(): Promise<Sample> {
      // Live and write samples reorder the list: what it should show is read again each time.
      const top = await expected(c.session);
      const ctx = await c.browser.newContext({ viewport: VIEWPORT, baseURL: c.stack.url, storageState: c.state });
      try {
        await ctx.addInitScript(probe, { kind: "rows", ids: top.ids } as Check);
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        const reqs = await network(cdp);
        const api = watchApi(page);
        const all: { url: string; type: string }[] = [];
        page.on("request", (r) => all.push({ url: r.url(), type: r.resourceType() }));
        await page.goto(c.list);
        const at = await outcome(page);
        const values: Record<string, number> = { "browser.cold.ms": at.t };
        const evidence: Record<string, string[]> = {};
        // Every fetch of the list's first page, every load: its own, and the stream open's reset.
        await quiet(api);
        const lists = api.filter((r) => r.url.startsWith("/api/issues") && !r.url.startsWith("/api/issues/") && !r.url.includes("after="));
        values["browser.load.list-fetches"] = lists.length;
        evidence["browser.load.list-fetches"] = api.map((r) => r.url);
        if (!coldCounted) {
          const d = depth(reqs, at.date);
          values["browser.cold.depth"] = d.depth;
          evidence["browser.cold.depth"] = [d.chain.join(" → ")];
          // The bytes of everything the load fetched, gzip as the budgets count them.
          let total = 0;
          let html = 0;
          const sizes: string[] = [];
          for (const r of all) {
            if (r.url.includes("/api/stream") || !r.url.startsWith(c.stack.url)) continue;
            const a = await fetchRaw(r.url, { headers: { cookie } });
            total += a.wire.length;
            if (r.type === "document") html = a.wire.length;
            sizes.push(`${new URL(r.url).pathname} ${(a.wire.length / 1024).toFixed(1)}`);
          }
          values["browser.first-load.kb"] = total / 1024;
          values["browser.first-load.html.kb"] = html / 1024;
          evidence["browser.first-load.kb"] = sizes;
          // The PR view's code is its own route's: none of its modules loads with the list, in its
          // chunks or inlined into another (the entry's included).
          const fetchedPaths = all.filter((r) => r.url.startsWith(c.stack.url)).map((r) => new URL(r.url).pathname);
          const modules = viewModulesIn(c.stack.build.web, fetchedPaths);
          if (modules) {
            values["browser.cold.pr-view-modules"] = modules.found.length;
            evidence["browser.cold.pr-view-modules"] = modules.found.length ? modules.found : [`none in the ${modules.chunks} chunks fetched`];
          }
          const view = viewChunks(c.stack.build.web);
          if (view.length > 0) {
            let bytes = 0;
            const each: string[] = [];
            for (const chunk of view) {
              const a = await fetchRaw(`${c.stack.url}${chunk}`);
              if (a.status !== 200) throw new Error(`${chunk}: ${a.status}`);
              bytes += a.wire.length;
              each.push(`${chunk} ${(a.wire.length / 1024).toFixed(1)}`);
            }
            values["browser.pr-view.kb"] = bytes / 1024;
            evidence["browser.pr-view.kb"] = each;
          }
          coldCounted = true;
        }
        return { values, evidence };
      } finally {
        await ctx.close();
      }
    },
  });

  probes.push({
    name: "browser.warm",
    gates: ["browser.warm.ms", "browser.warm.depth"],
    async sample(): Promise<Sample> {
      const top = await expected(c.session);
      const page = await c.warm.newPage();
      try {
        const cdp = await c.warm.newCDPSession(page);
        const reqs = await network(cdp);
        const api = watchApi(page);
        await page.addInitScript((ids) => window.__perf.arm({ kind: "rows", ids }), top.ids);
        await page.goto(c.list);
        const at = await outcome(page);
        const values: Record<string, number> = { "browser.warm.ms": at.t };
        const evidence: Record<string, string[]> = {};
        if (!warmCounted) {
          await quiet(api);
          const d = depth(reqs, at.date);
          values["browser.warm.depth"] = d.depth;
          evidence["browser.warm.depth"] = [d.chain.join(" → ")];
          warmCounted = true;
        }
        return { values, evidence };
      } finally {
        await page.close();
      }
    },
  });

  // Filter: a preset on, then off again, a click each. Presets toggle their own token, so the
  // second click drops `assignee:me` and goes back to the default `is:open`.
  const views = async () => [
    { button: "Assigned to me", ...(await expected(c.session, "is:open assignee:me")) },
    { button: "Assigned to me", ...(await expected(c.session, "is:open")) },
  ];
  probes.push({
    name: "browser.filter",
    gates: ["browser.filter.ms", "browser.filter.round-trips"],
    async sample(): Promise<Sample> {
      const [mine, open] = await views();
      const page = await warmPage(c.warm, c.list, open!.ids);
      try {
        const values: Record<string, number> = {};
        const trips: number[] = [];
        // Round trips are the same every time: counted on the first sample only, which saves
        // the wait for the page to go quiet on the others.
        const count = !filterCounted;
        for (const v of [mine!, open!]) {
          const api = watchApi(page);
          const r = await act(page, { kind: "rows", ids: v.ids }, () => page.getByRole("button", { name: v.button, exact: true }).click());
          values["browser.filter.ms"] = Math.max(values["browser.filter.ms"] ?? 0, r.ms);
          if (count) {
            await quiet(api, 500);
            trips.push(api.filter((x) => x.url.startsWith("/api/issues")).length);
          }
        }
        if (count) {
          values["browser.filter.round-trips"] = Math.max(...trips);
          filterCounted = true;
        }
        return { values };
      } finally {
        await page.close();
      }
    },
  });

  // A search keystroke: `dar` becomes `dark`.
  probes.push({
    name: "browser.search-key",
    gates: ["browser.search-key.ms"],
    async sample(): Promise<Sample> {
      const dar = await expected(c.session, "is:open dar");
      const dark = await expected(c.session, "is:open dark");
      const page = await warmPage(c.warm, `${c.list}?q=${encodeURIComponent("is:open dar")}`, dar.ids);
      try {
        const box = page.getByRole("combobox", { name: "Filter issues" });
        await box.click();
        await box.press("End");
        const r = await act(page, { kind: "rows", ids: dark.ids }, () => box.press("k"));
        return { values: { "browser.search-key.ms": r.ms } };
      } finally {
        await page.close();
      }
    },
  });

  // Opening an issue from the list: a click on its row.
  let open = 0;
  probes.push({
    name: "browser.open-issue",
    gates: ["browser.open-issue.ms", "browser.open-issue.round-trips"],
    async sample(): Promise<Sample> {
      const top = await expected(c.session);
      const page = await warmPage(c.warm, c.list, top.ids);
      try {
        // An issue, as the gate is named: PRs list beside them.
        const row = top.rows.filter((r) => r.kind === "issue")[1 + (open++ % 10)]!;
        // The pointer lands on the row in one move (crossing no other row, whose hover would
        // preload it), and clicks at once.
        const box = (await page.locator(`[data-perf="row"][data-id="${row.id}"]`).boundingBox())!;
        const api = watchApi(page);
        const r = await act(page, { kind: "detail", id: row.id, comments: Math.min(row.comments, 30) }, async () => {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 1 });
          await page.mouse.down();
          await page.mouse.up();
        });
        if (openCounted) return { values: { "browser.open-issue.ms": r.ms } };
        await quiet(api, 500);
        // What opening it cost: the requests for the issue (its detail and anything of its own).
        const mine = api.filter((x) => x.url === `/api/issues/${row.id}` || x.url.startsWith(`/api/issues/${row.id}?`) || x.url.startsWith(`/api/issues/${row.id}/`));
        openCounted = true;
        return {
          values: { "browser.open-issue.ms": r.ms, "browser.open-issue.round-trips": mine.length },
          evidence: { "browser.open-issue.round-trips": api.map((x) => x.url) },
        };
      } finally {
        await page.close();
      }
    },
  });

  // The next page: scrolled to the end of the first, until the list holds more rows.
  probes.push({
    name: "browser.next-page",
    gates: ["browser.next-page.ms"],
    async sample(): Promise<Sample> {
      const page = await warmPage(c.warm, c.list, (await expected(c.session)).ids);
      try {
        const loaded = Number(await page.locator('[data-perf="list"]').getAttribute("data-perf-rows"));
        await page.locator('[data-perf="row"]').first().hover();
        const r = await act(page, { kind: "more", than: loaded }, () => page.mouse.wheel(0, 34 * loaded));
        return { values: { "browser.next-page.ms": r.ms } };
      } finally {
        await page.close();
      }
    },
  });

  // Scrolling: 400 px a wheel step down to row 500, every frame watched.
  probes.push({
    name: "browser.scroll",
    gates: ["browser.scroll.rows", "browser.scroll.long-tasks"],
    async sample(): Promise<Sample> {
      const page = await warmPage(c.warm, c.list, (await expected(c.session)).ids);
      try {
        await page.locator('[data-perf="row"]').first().hover();
        await page.evaluate(() => window.__perf.startFrames());
        for (let i = 0; i < 45; i++) {
          await page.mouse.wheel(0, 400);
          await sleep(50);
        }
        await sleep(500);
        const f = await page.evaluate(() => window.__perf.stopFrames());
        const long = f.longTasks.filter((d) => d > 100);
        return {
          values: { "browser.scroll.rows": f.maxRows, "browser.scroll.long-tasks": long.length },
          evidence: {
            "browser.scroll.rows": [`a viewport holds ${f.window} rows; at most ${f.maxRows} were rendered`],
            "browser.scroll.long-tasks": long.map((d) => `${Math.round(d)} ms`),
          },
        };
      } finally {
        await page.close();
      }
    },
  });

  // Live: an outside edit renames the 5th row's issue (the 5th issue: PRs list beside them, and a
  // PR's edit comes as another webhook); from its webhook reaching beghu to the
  // frame that shows the new title. Then the refetch batches the push caused.
  let edits = 0;
  probes.push({
    name: "browser.live",
    gates: ["browser.live.ms", "browser.live.refetch-batches"],
    async sample(): Promise<Sample> {
      const now = await expected(c.session);
      const page = await warmPage(c.warm, c.list, now.ids);
      try {
        const row = now.rows.filter((r) => r.kind === "issue")[4]!;
        const title = `${row.title.replace(/ · perf \d+$/, "")} · perf ${Date.now() % 1e6}${edits++}`;
        const api = watchApi(page);
        await page.evaluate((x) => window.__perf.arm(x), { kind: "title", id: row.id, text: title } as Check);
        const before = c.stack.deliveries.length;
        await control(c.stack, "POST", "/edit", { repo: `${row.owner}/${row.repo}`, number: row.number, title });
        const at = await outcome(page);
        const d = c.stack.deliveries.slice(before).find((x) => (JSON.parse(x.body) as { issue?: { title?: string } }).issue?.title === title);
        if (!d) throw new Error("the edit's webhook never reached beghu");
        await quiet(api, 500);
        const after = api.filter((x) => x.at >= d.at).map((x) => x.at);
        let batches = 0;
        for (let i = 0; i < after.length; i++) if (i === 0 || after[i]! - after[i - 1]! > 100) batches++;
        await settle(c.session);
        return {
          values: { "browser.live.ms": at.date - d.at, "browser.live.refetch-batches": batches },
          evidence: { "browser.live.refetch-batches": api.filter((x) => x.at >= d.at).map((x) => x.url) },
        };
      } finally {
        await page.close();
      }
    },
  });

  // A write: a comment, from the click on Comment to the frame that shows it. On an issue: a PR
  // has no composer.
  const issues = first.rows.slice(40).filter((r) => r.kind === "issue");
  const target = issues.find((r) => r.comments < 10) ?? issues[0]!;
  let comments = 0;
  probes.push({
    name: "browser.write",
    gates: ["browser.write.ms"],
    async sample(): Promise<Sample> {
      const page = await c.warm.newPage();
      try {
        await page.goto(`/${target.owner}/${target.repo}/issues/${target.number}`);
        await page.evaluate((x) => window.__perf.arm(x), { kind: "detail", id: target.id, comments: 0 } as Check);
        await outcome(page);
        const box = page.getByRole("textbox", { name: "Comment" });
        await box.waitFor();
        const text = `perf comment ${Date.now()}-${comments++}`;
        await box.fill(text);
        const r = await act(page, { kind: "comment", text }, () => page.getByRole("button", { name: "Comment", exact: true }).click());
        // Until GitHub has it, so the next sample's page starts settled.
        await page.locator('[data-perf="comment"]', { hasText: text }).locator('[data-perf="pending"]').waitFor({ state: "detached", timeout: 15_000 });
        // Its webhook moves the issue to the top a second later: the next sample starts after.
        await settle(c.session);
        return { values: { "browser.write.ms": r.ms } };
      } finally {
        await page.close();
      }
    },
  });

  probes.push(...prViewProbes(c));
  return probes;
}

/** How long a PR view sample may wait for its drawing (the first can wait on the server's first read). */
const DRAWING_MS = 120_000;
/** The canvas's glide (web/src/pr-view/canvas/Canvas.tsx `GLIDE_MS`), and a frame's margin. */
const GLIDE_MS = 420;
/** The block browser.pr-block-open(-3x) opens: beghu#191's analysis-wasm crate, in each tile's start view. */
const OPENED = "crates-analysis-wasm";
/** A long task, as the Long Tasks API reports one. */
const LONG_TASK_MS = 50;

/** The PR view's gates (#182), on the tiled analyses. */
function prViewProbes(c: BrowserCtx): Probe[] {
  let tilesP: Promise<Tile[]> | undefined;
  const tile = async (name: "tiled-1x" | "tiled-3x") => {
    tilesP ??= ensureTiles(c.stack, c.session);
    const t = (await tilesP).find((x) => x.name === name);
    if (!t) throw new Error(`no ${name} analysis`);
    return t;
  };
  const viewOf = (t: Tile) => `/${t.repo}/pull/${t.number}/view`;
  const probes: Probe[] = [];
  const view = viewChunks(c.stack.build.web);
  let depthCounted = false;
  let bytesCounted = false;

  // A cold navigation to the view: navigation start to the frame with the top-level drawing.
  for (const [name, which] of [
    ["browser.pr-cold", "tiled-1x"],
    ["browser.pr-cold-3x", "tiled-3x"],
  ] as const) {
    const gates = which === "tiled-1x" ? [`${name}.ms`, `${name}.depth`] : [`${name}.ms`];
    probes.push({
      name,
      gates,
      async sample(): Promise<Sample> {
        const t = await tile(which);
        const ctx = await c.browser.newContext({ viewport: VIEWPORT, baseURL: c.stack.url, storageState: c.state });
        try {
          await ctx.addInitScript(probe, { kind: "drawing", analysis: t.analysis } as Check);
          const page = await ctx.newPage();
          const cdp = await ctx.newCDPSession(page);
          const reqs = await network(cdp);
          await page.goto(viewOf(t));
          const at = await outcome(page, DRAWING_MS);
          const values: Record<string, number> = { [`${name}.ms`]: at.t };
          const evidence: Record<string, string[]> = {};
          if (which === "tiled-1x" && !depthCounted) {
            // The round trips the drawing waits on: the graph's and the view's chunks' chains
            // (the claims come after the graph, and the drawing never waits for them).
            const graph = `/api/${t.repo}/pulls/${t.number}/analysis`;
            const d = depth(reqs, at.date, (u) => new URL(u).pathname === graph || view.includes(new URL(u).pathname));
            values[`${name}.depth`] = d.depth;
            evidence[`${name}.depth`] = [d.chain.join(" → ")];
            depthCounted = true;
          }
          return { values, evidence };
        } finally {
          await ctx.close();
        }
      },
    });
  }

  // The PR panel's link to the view in a warm app, to the drawing; then a revisit's bytes.
  probes.push({
    name: "browser.pr-open",
    gates: ["browser.pr-open.ms", "browser.pr-warm.kb"],
    async sample(): Promise<Sample> {
      const t = await tile("tiled-1x");
      const page = await c.warm.newPage();
      try {
        await page.goto(`/${t.repo}/pull/${t.number}`);
        const link = page.locator(`[data-perf="analyse-main"][href="${viewOf(t)}"]`);
        await link.waitFor({ timeout: DRAWING_MS });
        const r = await act(page, { kind: "drawing", analysis: t.analysis }, () => link.click());
        const values: Record<string, number> = { "browser.pr-open.ms": r.ms };
        const evidence: Record<string, string[]> = {};
        if (!bytesCounted) {
          // A revisit: the graph revalidated (a 304), the claims from the cache. Their bodies'
          // bytes on the wire.
          await sleep(QUIET_MS);
          const again = await c.warm.newPage();
          try {
            const cdp = await c.warm.newCDPSession(again);
            const got = new Map<string, { url: string; status: number; cached: boolean; bytes: number }>();
            await cdp.send("Network.enable");
            cdp.on("Network.requestWillBeSent", (e) => {
              const u = new URL(e.request.url);
              if (u.pathname.includes("/analysis")) got.set(e.requestId, { url: u.pathname, status: 0, cached: false, bytes: 0 });
            });
            cdp.on("Network.requestServedFromCache", (e) => {
              const g = got.get(e.requestId);
              if (g) g.cached = true;
            });
            cdp.on("Network.responseReceived", (e) => {
              const g = got.get(e.requestId);
              if (!g) return;
              g.status = e.response.status;
              g.cached ||= !!(e.response.fromDiskCache || e.response.fromPrefetchCache || e.response.fromServiceWorker);
            });
            cdp.on("Network.dataReceived", (e) => {
              const g = got.get(e.requestId);
              if (g) g.bytes += e.encodedDataLength;
            });
            await again.addInitScript(probe, null);
            await again.goto(viewOf(t));
            await again.evaluate((x) => window.__perf.arm(x), { kind: "drawing", analysis: t.analysis } as Check);
            await outcome(again, DRAWING_MS);
            await sleep(QUIET_MS);
            const all = [...got.values()];
            if (!all.some((g) => g.url.endsWith("/claims"))) throw new Error("the revisit never asked for the claims");
            values["browser.pr-warm.kb"] = all.reduce((n, g) => n + g.bytes, 0) / 1024;
            evidence["browser.pr-warm.kb"] = all.map((g) => `${g.url} ${g.cached ? "cache" : g.status} ${(g.bytes / 1024).toFixed(1)}`);
          } finally {
            await again.close();
          }
          bytesCounted = true;
        }
        return { values, evidence };
      } finally {
        await page.close();
      }
    },
  });

  // A double-click on a block to the frame its glide starts in (the clicked block's first click
  // selects it), and the long tasks from the click to the glide's end. The block is OPENED, a
  // top-level part of beghu#191's recording that every tile draws in the start view.
  for (const [name, which] of [
    ["browser.pr-block-open", "tiled-1x"],
    ["browser.pr-block-open-3x", "tiled-3x"],
  ] as const) {
    probes.push({
      name,
      gates: [`${name}.ms`, `${name}.long-tasks`],
      async sample(): Promise<Sample> {
        const t = await tile(which);
        const page = await c.warm.newPage();
        try {
          await page.goto(viewOf(t));
          await page.evaluate((x) => window.__perf.arm(x), { kind: "drawing", analysis: t.analysis } as Check);
          await outcome(page, DRAWING_MS);
          // The same block each sample and each run, by its ID: a change to the start view can't
          // change what's measured. It must be in view and open: if it isn't, the probe fails.
          const target = await page.evaluate((id) => {
            const vp = document.querySelector<HTMLElement>('[data-perf="canvas-viewport"]')!.getBoundingClientRect();
            const el = document.querySelector<HTMLElement>(`[data-perf="block"][data-id="${id}"]:not([data-grid])`);
            if (!el || !(el.textContent ?? "").includes("double-click")) return `${id} isn't drawn as a block that opens`;
            const r = el.getBoundingClientRect();
            if (!(r.width > 0 && r.left >= vp.left && r.top >= vp.top && r.right <= vp.right && r.bottom <= vp.bottom - 60)) return `${id} isn't in view`;
            return { id, x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }, OPENED);
          if (typeof target === "string") throw new Error(`${name}: ${target}`);
          await sleep(QUIET_MS);
          const n = Number((await page.locator('[data-perf="canvas-viewport"]').getAttribute("data-glide")) ?? 0) + 1;
          const since = await page.evaluate(() => performance.now());
          await page.mouse.move(target.x, target.y, { steps: 1 });
          const r = await act(page, { kind: "glide", n }, () => page.mouse.dblclick(target.x, target.y));
          await sleep(GLIDE_MS + 200);
          const long = await page.evaluate((t0) => window.__perf.longTasks.filter((l) => l.start >= t0).map((l) => l.duration), since);
          const over = long.filter((d) => d > LONG_TASK_MS);
          return {
            values: { [`${name}.ms`]: r.ms, [`${name}.long-tasks`]: over.length },
            evidence: { [`${name}.long-tasks`]: [`opening ${target.id}`, ...over.map((d) => `${Math.round(d)} ms`)] },
          };
        } finally {
          await page.close();
        }
      },
    });
  }
  return probes;
}
