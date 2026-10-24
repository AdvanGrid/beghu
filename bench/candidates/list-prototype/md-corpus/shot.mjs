import { chromium } from 'playwright';
const out = process.env.OUT, [doc = 'kitchen', vs = 'A,B,C', themes = 'light,dark', w = '1400'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +w, height: 5200 } });
p.on('pageerror', (e) => console.log('ERR', e.message));
for (const v of vs.split(',')) for (const t of themes.split(',')) {
  await p.goto(`http://localhost:5180/issues/3000040375?md=${doc}&variant=${v}`);
  await p.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), t);
  await p.waitForSelector('.md'); await p.waitForTimeout(1500);
  const el = await p.$('.detail');
  await el.screenshot({ path: `${out}/${doc.replace(/\W/g,'_')}-${v}-${t}-${w}.png` });
  console.log(v, t, await p.evaluate(() => document.querySelector('.sw-walk')?.textContent));
}
await b.close();
