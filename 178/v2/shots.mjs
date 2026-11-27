import { chromium } from "playwright";
const out = process.argv[2]; const b = await chromium.launch();
for (const scheme of ["light","dark"]) {
const ctx = await b.newContext({ baseURL: "http://localhost:24273", colorScheme: scheme, viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
await p.goto("/auth/login?login=tomsj"); await p.waitForURL(/\/issues/);
if (scheme === "light") { await p.waitForTimeout(1500); await p.screenshot({ path: `${out}/tomsj-list-after-seeding.png` }); }
await p.goto("/AdvanGrid/beghu/pull/191");
const main = p.locator('[data-perf="analyse-main"]'); await main.waitFor({ timeout: 60000 });
await main.locator("xpath=following-sibling::button[1]").click();
await p.locator('[data-perf="analyse-pop"]').waitFor(); await p.waitForTimeout(500);
console.log(scheme, JSON.stringify(await main.textContent()), JSON.stringify(await p.locator('[data-perf="analyse-pop"]').innerText()));
await p.screenshot({ path: `${out}/tomsj-v2-${scheme}.png` }); await ctx.close(); }
await b.close();
