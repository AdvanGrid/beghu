// Usage: node candidates/proa/tools/turbo-phases.mjs against a native server on :8095 (see RESULTS.md).
import { chromium } from 'playwright';
const b = await chromium.launch(); const ctx = await b.newContext(); const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
await p.addInitScript(() => {
  window.__t = [];
  for (const e of ['turbo:click','turbo:visit','turbo:before-fetch-request','turbo:before-fetch-response','turbo:before-render','turbo:render','turbo:load','turbo:before-frame-render','turbo:frame-render','turbo:frame-load'])
    document.addEventListener(e, () => window.__t.push([e, performance.now()]), true);
  document.addEventListener('click', () => window.__t.push(['click', performance.now()]), true);
});
await p.goto('http://127.0.0.1:8095/'); await p.waitForSelector('[data-bench=list][data-bench-ready]'); await p.waitForTimeout(1000);
for (const sel of ['[data-bench=filter-label][data-value=bug]', '[data-bench=filter-assignee]:nth-of-type(3)', '[data-bench=row]']) {
  await p.evaluate(() => (window.__t = []));
  await p.click(sel); await p.waitForTimeout(2500);
  const t = await p.evaluate(() => window.__t); const t0 = t[0][1];
  console.log(sel, t.map(([e, v]) => `${e.replace('turbo:', '')}+${Math.round(v - t0)}`).join(' '));
}
const html = await (await fetch('http://127.0.0.1:8095/?label=bug')).text(); console.log('list html bytes', html.length);
await b.close();
