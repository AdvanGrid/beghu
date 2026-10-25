// Drives the deploy probe in Chromium: deploys under an open tab, then sign-in, sign-out and
// account switching with the shell cached. The server's request log says what reached it; anything
// missing from it came from the browser's cache (or bfcache). Prints one JSON object per scenario.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../node_modules/playwright/index.mjs';

const PORT = 8193;
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? tmpdir();
const only = process.argv.slice(2);
const asset = (build, name) => readdirSync(new URL(`./builds/${build}/assets`, import.meta.url)).find((f) => f.startsWith(name + '-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
async function startServer(env = {}) {
  await stopServer();
  server = spawn('./target/release/bench-axum-solid', {
    cwd: new URL('./server', import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), MIRROR_PATH: join(SCRATCH, 'mirror.db'), BUILDS_DIR: '../builds', BUILD: 'A', ...env },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = undefined;
  s.kill('SIGTERM');
  await new Promise((r) => s.once('exit', r));
}
const deploy = (build, keep = []) => fetch(`${BASE}/__deploy?build=${build}&keep=${keep.join(',')}`, { method: 'POST' });
const clearLog = () => fetch(`${BASE}/__log`, { method: 'DELETE' });
const log = async () => (await (await fetch(`${BASE}/__log`)).json()).map((e) => `${e.status} ${e.path}${e.account ? ` [${e.account}]` : ''}${e.if_none_match ? ` inm=${e.if_none_match}` : ''}`);

async function browser() {
  const dir = mkdtempSync(join(SCRATCH, 'profile-'));
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, channel: process.env.CHANNEL || undefined, ignoreDefaultArgs: ['--disable-back-forward-cache', '--disable-field-trial-config'], args: process.env.BF_ARGS ? process.env.BF_ARGS.split(' ') : [] });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Page.enable');
  const bfcache = [];
  cdp.on('Page.backForwardCacheNotUsed', (e) => bfcache.push(e.notRestoredExplanations.map((x) => x.reason)));
  return { ctx, page, bfcache };
}

async function state(page) {
  return page.evaluate(() => ({
    url: location.pathname + location.search,
    build: document.documentElement.dataset.build ?? null,
    account: document.getElementById('account')?.dataset.account ?? null,
    signinPage: !!document.getElementById('signin-page'),
    rows: document.querySelectorAll('[data-bench=row]').length,
    detail: document.querySelector('[data-bench=detail]')?.getAttribute('data-id') ?? null,
    aside: document.querySelector('aside')?.textContent?.slice(0, 120) ?? null,
    probe: window.__probe ?? null,
  }));
}

async function signIn(page, account, next = '/') {
  await page.goto(`${BASE}/auth/login?account=${account}&next=${encodeURIComponent(next)}`);
  await page.waitForSelector('[data-bench=row]');
}
const rowIds = (page) => page.$$eval('[data-bench=row]', (as) => as.map((a) => a.dataset.id));
async function openRow(page, i) {
  const id = (await rowIds(page))[i];
  await page.click(`[data-bench=row][data-id="${id}"]`);
  await page.waitForSelector(`[data-bench=detail][data-id="${id}"]`, { timeout: 3000 }).catch(() => {});
  await sleep(300);
  return id;
}

const scenarios = {
  async baseline() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await clearLog();
    await openRow(page, 0);
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  // An open tab on build A clicks into the lazy detail route after a deploy to B.
  async 'lazy-chunk-old-deleted'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await deploy('B', []);
    await clearLog();
    await openRow(page, 0);
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  async 'lazy-chunk-old-deleted-recover'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await page.evaluate(() => localStorage.setItem('recover', '1'));
    await deploy('B', []);
    await clearLog();
    const id = (await rowIds(page))[0];
    await page.click(`[data-bench=row][data-id="${id}"]`);
    await page.waitForSelector(`[data-bench=detail][data-id="${id}"]`, { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  async 'lazy-chunk-old-kept'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await deploy('B', ['A']);
    await clearLog();
    await openRow(page, 0);
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  // The detail chunk is already loaded; then a deploy deletes A, and the tab keeps navigating.
  async 'router-nav-after-deploy'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await openRow(page, 0);
    await deploy('B', []);
    await clearLog();
    await openRow(page, 1);
    await page.click('[data-bench=filter-state][data-value=closed]');
    await sleep(500);
    await openRow(page, 0);
    await page.click('[data-bench=filter-state][data-value=open]');
    await sleep(500);
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  // Within max-age of the shell: a fresh navigation (link, typed URL, new tab), a reload, and a
  // hard reload, after a deploy that deleted A's assets.
  async 'navigations-within-max-age'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await page.goto(`${BASE}/`); // the shell for / is now cached (the sign-in redirect stored it too)
    await page.waitForSelector('[data-bench=row]');
    await deploy('B', []);
    const out = {};
    await clearLog();
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    await openRow(page, 0);
    out.goto = { after: await state(page), requests: await log() };
    await clearLog();
    const tab = await ctx.newPage();
    await tab.goto(`${BASE}/`);
    await tab.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    out.newTab = { after: await state(tab), requests: await log() };
    await tab.close();
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-bench=row]');
    await clearLog();
    await page.reload();
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    out.reload = { after: await state(page), requests: await log() };
    await clearLog();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Page.reload', { ignoreCache: true });
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    out.hardReload = { after: await state(page), requests: await log() };
    await ctx.close();
    return out;
  },
  // A tab opened a URL whose shell was never cached gets the new build at once.
  async 'uncached-url-after-deploy'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await deploy('B', []);
    await clearLog();
    await page.goto(`${BASE}/?state=closed`);
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  // Two deploys inside one max-age: A's shell is still cached when C replaces B.
  async 'two-deploys-within-max-age'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    await deploy('B', ['A']);
    await deploy('C', ['B']);
    await clearLog();
    await page.goto(`${BASE}/`);
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    await openRow(page, 0);
    const r = { after: await state(page), requests: await log() };
    await ctx.close();
    return r;
  },
  // Back/forward after the shell's max-age ran out: history navigations may use a stale shell.
  async 'back-after-max-age'() {
    await startServer({ SHELL_MAX_AGE: '2' });
    const { ctx, page, bfcache } = await browser();
    await signIn(page, 'a');
    await page.goto(`${BASE}/auth/login`); // a full navigation away (the sign-in page)
    await deploy('B', []);
    await sleep(2500);
    await clearLog();
    await page.goBack({ waitUntil: 'commit' });
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    await openRow(page, 0);
    const r = { after: await state(page), requests: await log(), bfcacheNotUsed: bfcache };
    await ctx.close();
    await startServer();
    return r;
  },

  // ---- sign-in, sign-out, account switch ----

  async 'signin-links'() {
    const { ctx, page } = await browser();
    await signIn(page, 'a');
    const out = {};
    await clearLog();
    await page.click('#signin-claimed');
    await sleep(1000);
    out.claimed = { after: await state(page), requests: await log() };
    await signIn(page, 'a');
    await clearLog();
    await page.click('#signin-external');
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    await sleep(300);
    out.external = { after: await state(page), requests: await log() };
    await ctx.close();
    return out;
  },
  async 'signout-then-back'() {
    const { ctx, page, bfcache } = await browser();
    await signIn(page, 'a');
    await openRow(page, 0);
    await clearLog();
    await page.click('#signout button');
    await page.waitForSelector('#signin-page', { timeout: 3000 }).catch(() => {});
    const out = { signout: { after: await state(page), requests: await log() } };
    await clearLog();
    await page.goBack({ waitUntil: 'commit' });
    await sleep(1000);
    out.back = { after: await state(page), requests: await log(), bfcacheNotUsed: bfcache.slice() };
    await clearLog();
    await page.goBack({ waitUntil: 'commit' });
    await sleep(1000);
    out.back2 = { after: await state(page), requests: await log(), bfcacheNotUsed: bfcache.slice() };
    await ctx.close();
    return out;
  },
  async 'switch-account-then-back'() {
    const { ctx, page, bfcache } = await browser();
    await signIn(page, 'a');
    await clearLog();
    await page.click('#signin-external'); // as b, same tab, back to /
    await page.waitForSelector('#account[data-account=b]', { timeout: 3000 }).catch(() => {});
    const out = { switch: { after: await state(page), requests: await log() } };
    await clearLog();
    await page.goBack({ waitUntil: 'commit' });
    await sleep(1000);
    out.back = { after: await state(page), requests: await log(), bfcacheNotUsed: bfcache.slice() };
    await ctx.close();
    return out;
  },
  // a opens a view b never opens, switches to b, then walks back to it: does b's tab get a's
  // cached API responses?
  async 'cross-account-history'() {
    const { ctx, page, bfcache } = await browser();
    await signIn(page, 'a');
    await page.goto(`${BASE}/?state=closed`);
    await page.waitForSelector('[data-bench=row]');
    await page.goto(`${BASE}/auth/login`);
    await clearLog();
    await page.click('#as-b');
    await page.waitForSelector('#account[data-account=b]');
    const out = { switch: { after: await state(page), requests: await log() } };
    await clearLog();
    await page.goBack({ waitUntil: 'commit' }); // the sign-in page (no-store)
    await sleep(800);
    await page.goBack({ waitUntil: 'commit' }); // /?state=closed, last shown as a
    await sleep(1200);
    out.back = { after: await state(page), requests: await log(), bfcacheNotUsed: bfcache.slice() };
    await ctx.close();
    return out;
  },
  // After a bfcache restore, is the page's EventSource still connected?
  async 'bfcache-sse'() {
    const { ctx, page, bfcache } = await browser();
    await ctx.addInitScript(() => {
      const orig = window.EventSource;
      window.__es = [];
      window.EventSource = class extends orig {
        constructor(...a) {
          super(...a);
          window.__es.push(this);
        }
      };
    });
    await signIn(page, 'a');
    await sleep(500);
    const before = await page.evaluate(() => window.__es.map((e) => e.readyState));
    await page.goto(`${BASE}/auth/login`);
    await sleep(300);
    await clearLog();
    await page.goBack({ waitUntil: 'commit' });
    await sleep(2500);
    // Push one change through the server and see whether the restored page's stream gets it.
    await page.evaluate(() => {
      window.__got = 0;
      window.__es.forEach((e) => e.addEventListener('message', () => window.__got++));
    });
    const hook = JSON.parse(readFileSync(new URL('../../data/webhooks-20k.jsonl', import.meta.url), 'utf8').split('\n')[0]);
    const sent = await fetch(`${BASE}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': hook.event }, body: JSON.stringify(hook.payload) });
    await sleep(1500);
    const after = await page.evaluate(() => ({ persisted: window.__probe.shows.map((s) => s.persisted), es: window.__es.map((e) => e.readyState), messages: window.__got }));
    after.webhook = sent.status;
    const r = { before, after, requests: await log(), bfcacheNotUsed: bfcache };
    await ctx.close();
    return r;
  },
  async 'bfcache-sse-while-away'() {
    const { ctx, page, bfcache } = await browser();
    await ctx.addInitScript(() => {
      const orig = window.EventSource;
      window.__es = [];
      window.EventSource = class extends orig {
        constructor(...a) {
          super(...a);
          window.__es.push(this);
        }
      };
    });
    await signIn(page, 'a');
    await sleep(500);
    const before = await page.evaluate(() => window.__es.map((e) => e.readyState));
    await page.goto(`${BASE}/auth/login`);
    await sleep(300);
    await clearLog();
    {
      const h = JSON.parse(readFileSync(new URL('../../data/webhooks-20k.jsonl', import.meta.url), 'utf8').split('\n')[1]);
      await fetch(`${BASE}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': h.event }, body: JSON.stringify(h.payload) });
      await sleep(1500);
    }
    await page.goBack({ waitUntil: 'commit' });
    await sleep(2500);
    // Push one change through the server and see whether the restored page's stream gets it.
    const early = await page.evaluate(() => ({ persisted: window.__probe.shows.map((s) => s.persisted) }));
    await page.evaluate(() => {
      window.__got = 0;
      window.__es.forEach((e) => e.addEventListener('message', () => window.__got++));
    });
    const hook = JSON.parse(readFileSync(new URL('../../data/webhooks-20k.jsonl', import.meta.url), 'utf8').split('\n')[0]);
    const sent = await fetch(`${BASE}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': hook.event }, body: JSON.stringify(hook.payload) });
    await sleep(1500);
    const after = await page.evaluate(() => ({ persisted: window.__probe.shows.map((s) => s.persisted), es: window.__es.map((e) => e.readyState), messages: window.__got }));
    after.webhook = sent.status;
    const r = { before, early, after, requests: await log(), bfcacheNotUsed: bfcache };
    await ctx.close();
    return r;
  },
  // The first visit ever, signed out: the shell is account-free, so the app sends the user on.
  async 'first-visit-signed-out'() {
    const { ctx, page } = await browser();
    await clearLog();
    await page.goto(`${BASE}/issues/12?state=closed`);
    await page.waitForSelector('#signin-page', { timeout: 3000 }).catch(() => {});
    const out = { first: { after: await state(page), requests: await log() } };
    await clearLog();
    await page.click('#as-a');
    await page.waitForSelector('[data-bench=row]', { timeout: 3000 }).catch(() => {});
    out.signin = { after: await state(page), requests: await log() };
    await ctx.close();
    return out;
  },
};

// Same sign-out and switch flows with variant headers.
for (const [name, env] of [
  ['vary-cookie', { VARY_COOKIE: '1' }],
  ['clear-site-data', { CLEAR_SITE_DATA: '"cache"' }],
  ['api-no-store', { API_CACHE_CONTROL: 'no-store' }],
]) {
  for (const base of ['signout-then-back', 'switch-account-then-back']) {
    scenarios[`${base}:${name}`] = async () => {
      await startServer(env);
      const r = await scenarios[base]();
      await startServer();
      return r;
    };
  }
}

await startServer();
try {
  console.log(JSON.stringify({ assets: { A: { issue: asset('A', 'Issue'), entry: asset('A', 'index') }, B: { issue: asset('B', 'Issue') } } }));
  for (const [name, run] of Object.entries(scenarios)) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    await deploy('A', []);
    const result = await run().catch((e) => ({ error: String(e) }));
    console.log(JSON.stringify({ scenario: name, ...result }));
  }
} finally {
  await stopServer();
}
