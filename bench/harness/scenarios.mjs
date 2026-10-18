// The 7 scenarios from "Benchmark scenarios and metrics for the stack comparison"
// (https://github.com/tomsjansons/beghu/issues/11#issuecomment-6141302538).
//
// Each scenario has `iteration(h, ctx, i, state)` returning samples. Except for cold load, a
// scenario shares one browser context across its iterations (warm storage and HTTP cache, like a
// returning user) and the runner primes it with one unmeasured visit first. Each iteration opens a
// new tab. `state` lives for one scenario run, which has its own fresh container.

const SEARCH_TERM = 'dark m';
const FILTER_LABELS = ['bug', 'enhancement', 'frontend', 'backend', 'ux', 'p2', 'performance', 'p1'];
const DETAIL_COMMENTS = 30;
// The reconnect scenario: how long the sync connection is down, and how many webhooks land meanwhile.
const OUTAGE_MS = 5000;
const OUTAGE_EDITS = 100;

// A sync scenario's n-th edit, later than every fixture timestamp and every earlier edit.
const editTime = (h, n) => new Date(h.expect.fixtureNow() + 2 * 86_400_000 + n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function waitResult(page, what, timeout = 30_000) {
  try {
    await page.waitForFunction(() => window.__bench?.result, null, { timeout, polling: 50 });
  } catch {
    throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
  }
  return page.evaluate(() => window.__bench.result);
}

const arm = (page, kind, arg, clock) => page.evaluate(([k, a, c]) => window.__bench.arm(k, a, c), [kind, arg, clock]);

// Time from the input event to the frame that showed the expected DOM.
async function inputToFrame(page, what, act) {
  return (await timedStep(page, what, act)).ms;
}

// The same, plus who answered: `local` once the page had marked `bench:cache-ready` (a browser
// cache took over the queries) before the input event, else `server`.
async function timedStep(page, what, act) {
  await act();
  const r = await waitResult(page, what);
  if (!r.input) throw new Error(`${what}: the DOM matched before any input event arrived`);
  const ready = await page.evaluate(() => performance.getEntriesByName('bench:cache-ready')[0]?.startTime ?? null);
  return { ms: r.t - r.input.t, by: ready !== null && ready < r.input.t ? 'local' : 'server' };
}

// Toggles a label, then an assignee, then state closed, recording each as a step.
async function toggles(h, page, i, steps, prefix = '') {
  const label = FILTER_LABELS[i % FILTER_LABELS.length];
  const team = h.expect.team();
  const assignee = team[1 + (i % (team.length - 1))];
  const toggle = async (name, filter, selector) => {
    await arm(page, 'rows', { ids: h.expect.ids(filter) });
    steps.push({ step: prefix + name, ...(await timedStep(page, name, () => page.click(selector))) });
  };
  await toggle(`label ${label}`, { labels: [label] }, `[data-bench=filter-label][data-value="${label}"]`);
  await toggle(`assignee ${assignee}`, { labels: [label], assignees: [assignee] }, `[data-bench=filter-assignee][data-value="${assignee}"]`);
  await toggle('state closed', { state: 'closed', labels: [label], assignees: [assignee] }, '[data-bench=filter-state][data-value=closed]');
}

// Types the search term one key at a time, recording each key as a step.
async function typeSearch(h, page, steps, prefix = '') {
  await page.click('[data-bench=search]');
  for (let n = 1; n <= SEARCH_TERM.length; n++) {
    const q = SEARCH_TERM.slice(0, n);
    await arm(page, 'rows', { ids: h.expect.ids({ q }) });
    steps.push({ step: `${prefix}search "${q}"`, ...(await timedStep(page, `search "${q}"`, () => page.keyboard.type(SEARCH_TERM[n - 1]))) });
  }
}

const cacheMark = (page, name, timeout) =>
  page
    .waitForFunction((n) => performance.getEntriesByName(`bench:${n}`)[0]?.startTime ?? false, name, { timeout, polling: 50 })
    .then((h) => h.jsonValue());

// Opens the app in a new tab and waits until the list is live.
async function open(h, ctx) {
  const page = await h.newPage(ctx);
  await page.goto(h.url, { waitUntil: 'commit' });
  await waitResult(page, 'the list to become ready');
  return page;
}

export const scenarios = [
  {
    name: 'cold',
    title: 'Cold load',
    fresh: true,
    reference: { ms: 3000 },
    async iteration(h, ctx) {
      const page = await h.newPage(ctx, { armLoad: true });
      const js = h.trackScripts(page);
      await page.goto(h.url, { waitUntil: 'commit' });
      const r = await waitResult(page, 'first 20 rows of the default view');
      await page.waitForLoadState('load').catch(() => {});
      // A candidate that fills a browser cache marks `bench:cache-start` when it begins and
      // `bench:cache-warm` once the cache is persisted; the latter is recorded from navigation.
      const warm = await page
        .waitForFunction(
          () => {
            const mark = (n) => performance.getEntriesByName(`bench:${n}`)[0];
            if (!mark('cache-start')) return { none: true };
            // `bench:cache-ready` (queries now answered by the cache) is waited for up to 3 s
            // past cache-warm, since only some candidates mark it.
            const warm = mark('cache-warm');
            if (!warm || (!mark('cache-ready') && performance.now() - warm.startTime < 3000)) return false;
            return { t: warm.startTime };
          },
          null,
          { timeout: 120_000, polling: 50 },
        )
        .then((h) => h.jsonValue());
      const ready = await page.evaluate(() => performance.getEntriesByName('bench:cache-ready')[0]?.startTime ?? null);
      return { latency: [r.t], js: await js(), ...(warm.none ? {} : { cache_warm_ms: [warm.t] }), ...(ready !== null ? { cache_ready_ms: [ready] } : {}) };
    },
  },
  {
    name: 'warm',
    title: 'Warm load',
    reference: { ms: 1000 },
    async iteration(h, ctx) {
      const page = await h.newPage(ctx, { armLoad: true });
      await page.goto(h.url, { waitUntil: 'commit' });
      const r = await waitResult(page, 'first 20 rows of the default view');
      // A page that fills a cache (it marked `bench:cache-start`) may answer from the server until
      // its cache is ready; record when that is, from navigation, waiting up to 30 s.
      const caches = await page.evaluate(() => performance.getEntriesByName('bench:cache-start').length > 0);
      const ready = caches ? await cacheMark(page, 'cache-ready', 30_000).catch(() => null) : null;
      await page.close();
      return { latency: [r.t], ...(ready !== null ? { cache_ready_ms: [ready] } : {}) };
    },
  },
  {
    name: 'filter',
    title: 'Filter and search',
    reference: { ms: 200 },
    async iteration(h, ctx, i) {
      const steps = [];
      let page = await open(h, ctx);
      await toggles(h, page, i, steps);
      await page.close();
      page = await open(h, ctx);
      await typeSearch(h, page, steps);
      await page.close();
      return { latency: steps.map((s) => s.ms), steps };
    },
  },
  {
    // A first visit that filters at once: the search is typed the moment the list is live, while
    // a cache would still be filling. Then, once the page marks `bench:cache-ready` (60 s at most;
    // not waited for if the page never marked `bench:cache-start`), the three toggles run on the same tab.
    name: 'early',
    title: 'Filter straight after a cold load',
    fresh: true,
    reference: { ms: 200 },
    async iteration(h, ctx, i) {
      const steps = [];
      const page = await open(h, ctx);
      await typeSearch(h, page, steps, 'early ');
      // Only a page that marked `bench:cache-start` will ever mark ready.
      const caches = await page.evaluate(() => performance.getEntriesByName('bench:cache-start').length > 0);
      const ready = caches ? await cacheMark(page, 'cache-ready', 60_000).catch(() => null) : null;
      await page.fill('[data-bench=search]', '');
      await page.waitForFunction(() => document.querySelectorAll('[data-bench=row]').length >= 20, null, { timeout: 30_000, polling: 50 });
      await toggles(h, page, i, steps, 'later ');
      const switched = await page.evaluate(() => (performance.getEntriesByName('bench:switch-differs').length ? 'differs' : performance.getEntriesByName('bench:switch-same').length ? 'same' : null));
      await page.close();
      return { latency: steps.map((s) => s.ms), steps, ...(ready !== null ? { cache_ready_ms: [ready] } : {}), switched };
    },
  },
  {
    name: 'scroll',
    title: 'Scroll 500 rows',
    reference: { frameMs: 33, longTaskMs: 100 },
    async iteration(h, ctx) {
      const target = h.expect.ids({}, 1, 500)[0];
      const page = await open(h, ctx);
      const box = await page.locator('[data-bench=list]').boundingBox();
      const vp = page.viewportSize();
      await page.mouse.move(box.x + box.width / 2, Math.min(box.y + box.height / 2, box.y + (vp.height - box.y) / 2));
      await arm(page, 'visible', { id: target });
      await page.evaluate(() => window.__bench.startFrames());
      const started = Date.now();
      let reached = false;
      while (Date.now() - started < 60_000) {
        await page.mouse.wheel(0, 400);
        if (await page.evaluate(() => !!window.__bench.result)) {
          reached = true;
          break;
        }
      }
      const elapsed = Date.now() - started;
      const { frames, longTasks } = await page.evaluate(() => ({ frames: window.__bench.stopFrames(), longTasks: window.__bench.longTasks }));
      await page.close();
      if (!reached) throw new Error('row 500 never scrolled into view within 60 s');
      return { frames: frames.slice(1), longTasks: longTasks.map((t) => t.duration), reach_ms: [elapsed] };
    },
  },
  {
    name: 'detail',
    title: 'Open detail',
    reference: { ms: 300 },
    async iteration(h, ctx, i) {
      const top = h.expect.ids({});
      const id = top[i % top.length];
      const page = await open(h, ctx);
      await arm(page, 'detail', { id, comments: DETAIL_COMMENTS });
      const ms = await inputToFrame(page, `detail of ${id}`, () => page.click(`[data-bench=row][data-id="${id}"]`));
      await page.close();
      return { latency: [ms] };
    },
  },
  {
    name: 'live',
    title: 'Live update',
    reference: { ms: 2000 },
    async iteration(h, ctx, i, state) {
      // Edits land on rows of the label filter. Each edit moves its issue to the top, so the
      // expected list is the pristine one with the edited issues pulled up, newest edit first.
      state.edited ??= [];
      const filter = { labels: ['bug'] };
      const expected = () => {
        const edited = [...state.edited].reverse();
        return [...edited, ...h.expect.ids(filter, 20 + edited.length).filter((id) => !edited.includes(id))].slice(0, 20);
      };
      const page = await open(h, ctx);
      await arm(page, 'rows', { ids: expected() });
      await page.click('[data-bench=filter-label][data-value=bug]');
      await waitResult(page, 'the bug filter');

      const id = expected()[4];
      // A counter, not edited.length: once edits re-target an already edited row, the length
      // stops growing and two edits would share an updated_at, tying their order.
      const n = (state.edits = (state.edits ?? 0) + 1);
      const title = `Live update ${n} ${Math.random().toString(36).slice(2, 8)}`;
      const updatedAt = new Date(h.expect.fixtureNow() + 86_400_000 + n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await arm(page, 'title', { text: title }, 'date');
      const t0 = Date.now();
      await h.webhookTitleEdit(id, title, updatedAt);
      const r = await waitResult(page, `title "${title}" to appear`);
      state.edited = [...state.edited.filter((x) => x !== id), id];
      await page.close();
      return { latency: [r.t - t0] };
    },
  },
  {
    name: 'write',
    title: 'Optimistic write',
    reference: { ms: 100 },
    async iteration(h, ctx, i, state) {
      state.added ??= {};
      const page = await open(h, ctx);
      const ids = await page.$$eval('[data-bench=row]', (rows) => rows.slice(0, 10).map((r) => r.dataset.id));
      const id = ids[i % ids.length];
      const have = new Set([...h.expect.labelsOf(id), ...(state.added[id] ?? [])]);
      const name = h.expect.labelNames().find((l) => !have.has(l));
      await arm(page, 'detail', { id, comments: 0 });
      await page.click(`[data-bench=row][data-id="${id}"]`);
      await waitResult(page, `detail of ${id}`);

      await arm(page, 'label', { name });
      const t0 = Date.now();
      const responded = page
        .waitForResponse((r) => r.request().method() !== 'GET' && r.url().startsWith(h.url), { timeout: 30_000 })
        .then(() => Date.now());
      // Awaited below; until then, a timeout must fail this iteration, not the whole run.
      responded.catch(() => {});
      const ms = await inputToFrame(page, `label "${name}" on ${id}`, () =>
        page.click(`[data-bench=detail] [data-bench=add-label][data-value="${name}"]`),
      );
      const roundtrip = (await responded) - t0;
      (state.added[id] ??= []).push(name);
      await page.close();
      return { latency: [ms], roundtrip_ms: [roundtrip] };
    },
  },

  // --- sync scenarios ------------------------------------------------------------------------
  // For the sync benchmarks. Not part of `all`; run them with `--scenarios sync` or by name. They
  // need the candidate to mark `bench:sync-open` when its sync connection is (re)established and
  // `bench:sync-caught-up` once its cache holds everything the server had then, to serve
  // `POST /bench/outage?ms=<n>` (drop every sync connection and refuse new ones for n ms) and
  // `POST /bench/fail-writes?n=<n>` (the next n writes fail after the GitHub latency), and to mark
  // `bench:sync-leader` in the tab that syncs, if only one does.
  {
    // A tab whose sync connection drops for 5 s while 100 webhooks arrive, then comes back.
    name: 'reconnect',
    title: 'Catch-up after reconnecting',
    sync: true,
    reference: { ms: 2000 },
    async iteration(h, ctx, i, state) {
      const page = await open(h, ctx);
      await cacheMark(page, 'cache-ready', 60_000);
      await cacheMark(page, 'sync-caught-up', 30_000);
      const ids = h.expect.ids({}, 300);
      const t0 = Date.now();
      await h.post(`/bench/outage?ms=${OUTAGE_MS}`);
      let last;
      for (let k = 0; k < OUTAGE_EDITS; k++) {
        const n = (state.edits = (state.edits ?? 0) + 1);
        last = `Offline edit ${n} ${Math.random().toString(36).slice(2, 8)}`;
        await h.webhookTitleEdit(Number(ids[(n * 7) % ids.length]), last, editTime(h, n));
      }
      if (Date.now() - t0 > OUTAGE_MS - 500) throw new Error(`posting ${OUTAGE_EDITS} webhooks took longer than the outage`);
      await arm(page, 'title', { text: last }, 'date');
      const end = t0 + OUTAGE_MS;
      const r = await waitResult(page, `title "${last}" after the outage`);
      if (r.t < end) throw new Error('a change reached the page during the outage');
      const m = await page.evaluate(() => {
        const at = (n) => performance.getEntriesByName(`bench:${n}`).map((e) => e.startTime + performance.timeOrigin);
        return { open: at('sync-open'), caught: at('sync-caught-up') };
      });
      const opened = m.open.filter((t) => t >= end - 50).at(0);
      const caught = m.caught.filter((t) => t >= (opened ?? end)).at(0);
      await page.close();
      return { latency: [r.t - end], ...(opened ? { reconnect_ms: [opened - end] } : {}), ...(opened && caught ? { catchup_ms: [caught - opened] } : {}) };
    },
  },
  {
    // Two tabs: a webhook reaches both; then the syncing tab closes and the next webhook reaches
    // the other.
    name: 'tabs',
    title: 'Live update in a second tab, and after the syncing tab closes',
    sync: true,
    reference: { ms: 2000 },
    async iteration(h, ctx, i, state) {
      const a = await open(h, ctx);
      await cacheMark(a, 'cache-ready', 60_000);
      const b = await open(h, ctx);
      await cacheMark(b, 'cache-ready', 60_000);
      const leads = (p) => p.evaluate(() => performance.getEntriesByName('bench:sync-leader').length > 0);
      const ids = h.expect.ids({}, 20);
      const edit = async (pages) => {
        const n = (state.edits = (state.edits ?? 0) + 1);
        const title = `Tab edit ${n} ${Math.random().toString(36).slice(2, 8)}`;
        for (const p of pages) await arm(p, 'title', { text: title }, 'date');
        const t0 = Date.now();
        await h.webhookTitleEdit(Number(ids[n % ids.length]), title, editTime(h, n));
        return Promise.all(pages.map((p) => waitResult(p, `title "${title}"`).then((r) => r.t - t0)));
      };
      const [la, lb] = [await leads(a), await leads(b)];
      const [ta, tb] = await edit([a, b]);
      const out = {};
      if (la !== lb) {
        out.leader_ms = [la ? ta : tb];
        out.follower_ms = [la ? tb : ta];
      }
      // Close the syncing tab (or the first, if neither or both say they sync).
      const [gone, kept] = lb && !la ? [b, a] : [a, b];
      await gone.close();
      const [th] = await edit([kept]);
      await kept.close();
      return { latency: out.follower_ms ?? [tb], ...out, ...(la !== lb ? { handoff_ms: [th] } : { after_close_ms: [th] }) };
    },
  },
  {
    // Add a label while GitHub fails the write: the label shows at once, then goes.
    name: 'rollback',
    title: 'Optimistic write that fails',
    sync: true,
    reference: { ms: 100 },
    async iteration(h, ctx, i) {
      const page = await open(h, ctx);
      await cacheMark(page, 'cache-ready', 60_000);
      const ids = await page.$$eval('[data-bench=row]', (rows) => rows.slice(0, 10).map((r) => r.dataset.id));
      const id = ids[i % ids.length];
      const name = h.expect.labelNames().find((l) => !h.expect.labelsOf(id).includes(l));
      await arm(page, 'detail', { id, comments: 0 });
      await page.click(`[data-bench=row][data-id="${id}"]`);
      await waitResult(page, `detail of ${id}`);
      await h.post('/bench/fail-writes?n=1');
      await arm(page, 'label', { name });
      const t0 = Date.now();
      const responded = page
        .waitForResponse((r) => r.request().method() !== 'GET' && r.url().startsWith(h.url), { timeout: 30_000 })
        .then(() => Date.now());
      // Awaited below; until then, a timeout must fail this iteration, not the whole run.
      responded.catch(() => {});
      await page.click(`[data-bench=detail] [data-bench=add-label][data-value="${name}"]`);
      const shown = await waitResult(page, `label "${name}" on ${id}`);
      await arm(page, 'labelGone', { name });
      const gone = await waitResult(page, `label "${name}" to roll back`);
      const roundtrip = (await responded) - t0;
      await page.close();
      return { latency: [shown.t - shown.input.t], rolled_back_ms: [gone.t - shown.input.t], roundtrip_ms: [roundtrip] };
    },
  },
  {
    // Storage after a first visit, and after the fixture's 500 webhooks; then a returning tab.
    name: 'storage',
    title: 'Browser storage, and a warm load after 500 changes',
    sync: true,
    fresh: true,
    reference: {},
    async iteration(h, ctx) {
      const usage = (p) => p.evaluate(async () => {
        const e = await navigator.storage.estimate();
        return (e.usageDetails?.indexedDB ?? e.usage) / 1024;
      });
      const page = await open(h, ctx);
      await cacheMark(page, 'cache-warm', 120_000);
      await cacheMark(page, 'cache-ready', 60_000);
      const first = await usage(page);
      const feed = h.feed();
      for (const e of feed) await h.webhook(e);
      // The last delivery's issue, as a sign that the tab has applied the whole feed.
      await page.waitForTimeout(3000);
      const after = await usage(page);
      await page.close();
      const again = await h.newPage(ctx);
      await again.goto(h.url, { waitUntil: 'commit' });
      const r = await waitResult(again, 'the list to become ready');
      const ready = await cacheMark(again, 'cache-ready', 60_000).catch(() => null);
      const settled = await usage(again);
      await again.close();
      return { latency: [r.t], idb_kb: [first], idb_after_feed_kb: [after], idb_next_visit_kb: [settled], ...(ready !== null ? { cache_ready_ms: [ready] } : {}) };
    },
  },
];

