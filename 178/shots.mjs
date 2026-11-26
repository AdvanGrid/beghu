import { chromium } from "playwright";
const base = "http://localhost:24173", out = process.argv[2];
const b = await chromium.launch();
for (const [user, scheme] of [["tomsj","light"],["tomsj","dark"],["ilze-k","light"]]) {
  const ctx = await b.newContext({ baseURL: base, colorScheme: scheme, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(`/auth/login?login=${user}`); await p.waitForURL(/\/issues/);
  await p.goto("/AdvanGrid/beghu/pull/191");
  const main = p.locator('[data-perf="analyse-main"]');
  await main.waitFor({ timeout: 60000 });
  await p.waitForTimeout(1500);
  console.log(user, scheme, JSON.stringify(await main.textContent()), "title:", await p.locator("h1, h2").first().textContent());
  await p.screenshot({ path: `${out}/${user}-${scheme}.png` });
  if (user === "tomsj" && scheme === "light") {
    const caret = p.locator('[data-perf="analyse-pop"], [aria-haspopup]').first();
    if (await caret.count()) { await caret.click().catch(()=>{}); await p.waitForTimeout(800); await p.screenshot({ path: `${out}/tomsj-popover.png` }); }
  }
  await ctx.close();
}
await b.close();
