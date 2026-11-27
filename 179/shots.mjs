import { chromium } from "playwright";
const [out, code] = process.argv.slice(2);
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await b.newContext({ baseURL: "http://localhost:24373", colorScheme: scheme, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto("/auth/login?login=tomsj"); await p.waitForURL(/\/issues/);
  if (scheme === "light") { await p.goto("/cli"); await p.waitForLoadState("networkidle"); await p.screenshot({ path: `${out}/cli-page.png`, fullPage: true }); }
  await p.goto(`/cli/login?code=${code}`);
  const approve = p.getByRole("button", { name: "Approve" }); await approve.waitFor({ timeout: 30000 });
  await p.waitForTimeout(500); await p.screenshot({ path: `${out}/cli-login-${scheme}.png` });
  if (scheme === "dark") {
    await approve.click(); await p.waitForTimeout(1500); await p.screenshot({ path: `${out}/cli-login-approved.png` });
    await p.goto("/prefs"); await p.getByText("evidence-laptop").first().waitFor({ timeout: 30000 });
    await p.getByText("evidence-laptop").first().scrollIntoViewIfNeeded(); await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/prefs-cli-sign-ins.png` });
  }
  console.log(scheme, "ok"); await ctx.close();
}
await b.close();
