import { chromium } from 'playwright';
const out = process.env.OUT, [doc, list, w = '1000', h = '1500'] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.on('pageerror', (e) => console.log('ERR', e.message));
for (const spec of list.split(',')) {
  const [v, f, t] = spec.split('-');
  await p.goto(`http://localhost:5180/issues/3000040375?md=${doc}&variant=${v}&frame=${f}`);
  await p.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), t);
  await p.waitForSelector('.md'); await p.waitForTimeout(1200);
  await p.evaluate(() => { const d = document.querySelector('.detail'); const post = document.querySelector('.post'); d.scrollTop = post.offsetTop - 40; });
  await p.waitForTimeout(200);
  await (await p.$('.detail')).screenshot({ path: `${out}/${spec}.png` });
}
await b.close();
