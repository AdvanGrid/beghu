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
  await act();
  const r = await waitResult(page, what);
  if (!r.input) throw new Error(`${what}: the DOM matched before any input event arrived`);
  return r.t - r.input.t;
}

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
            return mark('cache-warm') ? { t: mark('cache-warm').startTime } : false;
          },
          null,
          { timeout: 120_000, polling: 50 },
        )
        .then((h) => h.jsonValue());
      return { latency: [r.t], js: await js(), ...(warm.none ? {} : { cache_warm_ms: [warm.t] }) };
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
      await page.close();
      return { latency: [r.t] };
    },
  },
  {
    name: 'filter',
    title: 'Filter and search',
    reference: { ms: 200 },
    async iteration(h, ctx, i) {
      const label = FILTER_LABELS[i % FILTER_LABELS.length];
      const team = h.expect.team();
      const assignee = team[1 + (i % (team.length - 1))];
      const steps = [];
      let page = await open(h, ctx);

      const toggle = async (name, filter, selector) => {
        await arm(page, 'rows', { ids: h.expect.ids(filter) });
        steps.push({ step: name, ms: await inputToFrame(page, name, () => page.click(selector)) });
      };
      await toggle(`label ${label}`, { labels: [label] }, `[data-bench=filter-label][data-value="${label}"]`);
      await toggle(`assignee ${assignee}`, { labels: [label], assignees: [assignee] }, `[data-bench=filter-assignee][data-value="${assignee}"]`);
      await toggle('state closed', { state: 'closed', labels: [label], assignees: [assignee] }, '[data-bench=filter-state][data-value=closed]');
      await page.close();

      page = await open(h, ctx);
      await page.click('[data-bench=search]');
      for (let n = 1; n <= SEARCH_TERM.length; n++) {
        const q = SEARCH_TERM.slice(0, n);
        await arm(page, 'rows', { ids: h.expect.ids({ q }) });
        steps.push({ step: `search "${q}"`, ms: await inputToFrame(page, `search "${q}"`, () => page.keyboard.type(SEARCH_TERM[n - 1])) });
      }
      await page.close();
      return { latency: steps.map((s) => s.ms), steps };
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
      const ms = await inputToFrame(page, `label "${name}" on ${id}`, () =>
        page.click(`[data-bench=detail] [data-bench=add-label][data-value="${name}"]`),
      );
      const roundtrip = (await responded) - t0;
      (state.added[id] ??= []).push(name);
      await page.close();
      return { latency: [ms], roundtrip_ms: [roundtrip] };
    },
  },
];
