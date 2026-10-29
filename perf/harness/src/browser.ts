// The browser suite: full Chromium against the production build, each action timed from its
// input event to the frame that shows the right outcome (probe.ts), with the right rows taken
// from the API beforehand. Beside the timings it counts what a page load and each action cost:
// the request depth of the first load (cold and warm), its bytes (gzip), the list fetches a load
// makes (the stream open's reset refetches it: measured, with no exemption), the round trips of
// a filter and of opening an issue, the refetch batches of a push, the rows rendered while
// scrolling and the long tasks meanwhile.
import { type Browser, type BrowserContext, type CDPSession, type Page, chromium } from "playwright-core";
import { expected, fetchRaw, Session, settle } from "./http.ts";
import { probe, type Check, type Outcome } from "./probe.ts";
import { control, type Stack } from "./stack.ts";
import type { Probe, Sample } from "./suite.ts";
import { sleep } from "./stats.ts";

const VIEWPORT = { width: 1280, height: 800 };
/** How long a page goes without an API request before its load or action counts as done. */
const QUIET_MS = 1000;

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
 * was ready counts (the stream's reset refetch comes after, from the stream).
 */
function depth(reqs: Map<string, Req>, readyAt: number): { depth: number; chain: string[] } {
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
}

/** A signed-in browser for `stack`: its storage, to start cold contexts from, and a warm context. */
export async function prepare(browser: Browser, stack: Stack, opts: { quick?: boolean } = {}): Promise<BrowserCtx> {
  const session = new Session(stack.url);
  await session.signIn("tomsj");
  const login = await browser.newContext({ viewport: VIEWPORT, baseURL: stack.url });
  const page = await login.newPage();
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  const state = await login.storageState();
  await login.close();
  const warm = await browser.newContext({ viewport: VIEWPORT, baseURL: stack.url, storageState: state });
  await warm.addInitScript(probe, null);
  // An unmeasured visit fills the warm context's cache.
  const prime = await warm.newPage();
  await prime.goto("/");
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
  return { browser, stack, session, state, warm };
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
    gates: ["browser.cold.ms", "browser.cold.depth", "browser.load.list-fetches", "browser.first-load.kb", "browser.first-load.html.kb"],
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
        await page.goto("/");
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
        await page.goto("/");
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

  // Filter: a preset, then back to Open, a click each.
  const views = async () => [
    { button: "Assigned to me", ...(await expected(c.session, "is:open assignee:me")) },
    { button: "Open", ...(await expected(c.session, "is:open")) },
  ];
  probes.push({
    name: "browser.filter",
    gates: ["browser.filter.ms", "browser.filter.round-trips"],
    async sample(): Promise<Sample> {
      const [mine, open] = await views();
      const page = await warmPage(c.warm, "/", open!.ids);
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
      const page = await warmPage(c.warm, `/?q=${encodeURIComponent("is:open dar")}`, dar.ids);
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
      const page = await warmPage(c.warm, "/", top.ids);
      try {
        const row = top.rows[1 + (open++ % 10)]!;
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
      const page = await warmPage(c.warm, "/", (await expected(c.session)).ids);
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
      const page = await warmPage(c.warm, "/", (await expected(c.session)).ids);
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

  // Live: an outside edit renames the 5th row's issue; from its webhook reaching beghu to the
  // frame that shows the new title. Then the refetch batches the push caused.
  let edits = 0;
  probes.push({
    name: "browser.live",
    gates: ["browser.live.ms", "browser.live.refetch-batches"],
    async sample(): Promise<Sample> {
      const now = await expected(c.session);
      const page = await warmPage(c.warm, "/", now.ids);
      try {
        const row = now.rows[4]!;
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

  // A write: a comment, from the click on Comment to the frame that shows it.
  const target = first.rows.slice(40).find((r) => r.comments < 10) ?? first.rows[40]!;
  let comments = 0;
  probes.push({
    name: "browser.write",
    gates: ["browser.write.ms"],
    async sample(): Promise<Sample> {
      const page = await c.warm.newPage();
      try {
        await page.goto(`/issues/${target.id}`);
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

  return probes;
}
