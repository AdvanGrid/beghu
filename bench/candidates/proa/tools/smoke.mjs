// Usage: node candidates/proa/tools/smoke.mjs against a native server on :8095 (see RESULTS.md).
import { chromium } from 'playwright';
const U = 'http://127.0.0.1:8095';
const b = await chromium.launch(); const p = await b.newPage();
p.on('pageerror', e => console.log('pageerror:', e.message));
p.on('console', m => { if (m.type() !== 'log') console.log('console:', m.type(), m.text()); });
const rows = () => p.$$eval('[data-bench=row]', r => r.slice(0, 3).map(x => x.dataset.id + ':' + x.querySelector('[data-bench=title]').textContent.slice(0, 30)));
await p.goto(U); await p.waitForSelector('[data-bench=list][data-bench-ready]');
console.log('rows', (await p.$$('[data-bench=row]')).length, await rows());
await p.evaluate(() => { window.__marker = 1; });
let nav = 0; p.on('framenavigated', f => { if (f === p.mainFrame()) nav++; });
await p.click('[data-bench=filter-label][data-value=bug]'); await p.waitForTimeout(700);
console.log('after bug', p.url(), await rows());
await p.click('[data-bench=search]');
for (const ch of 'dark m') { await p.keyboard.type(ch); await p.waitForTimeout(500); console.log('typed', JSON.stringify(await p.inputValue('[data-bench=search]')), 'focused', await p.evaluate(() => document.activeElement?.dataset.bench), p.url().split('?')[1], (await rows())[0]); }
console.log('js context survived', await p.evaluate(() => window.__marker === 1));
await p.goto(U); await p.waitForSelector('[data-bench=list][data-bench-ready]');
for (let i = 0; i < 80; i++) { await p.mouse.wheel(0, 400); await p.waitForTimeout(50); }
console.log('rows after scroll', (await p.$$('[data-bench=row]')).length);
await p.goto(U); await p.waitForSelector('[data-bench=list][data-bench-ready]');
const id = await p.$eval('[data-bench=row]', r => r.dataset.id);
await p.click(`[data-bench=row][data-id="${id}"]`); await p.waitForSelector(`[data-bench=detail][data-id="${id}"]`);
console.log('detail comments', (await p.$$('[data-bench=detail] [data-bench=comment]')).length, 'labels', await p.$$eval('[data-bench=detail] [data-bench=label]', l => l.map(x => x.dataset.value)));
const have = await p.$$eval('[data-bench=detail] [data-bench=label]', l => l.map(x => x.dataset.value));
const add = await p.$$eval('[data-bench=detail] [data-bench=add-label]', (b, have) => b.map(x => x.dataset.value).find(v => !have.includes(v)), have);
console.log('adding', add);
const t0 = Date.now(); await p.click(`[data-bench=add-label][data-value="${add}"]`);
await p.waitForSelector(`[data-bench=detail] [data-bench=label][data-value="${add}"]`); console.log('chip after', Date.now() - t0, 'ms');
await p.waitForTimeout(800);
console.log('labels later', await p.$$eval('[data-bench=detail] [data-bench=label]', l => l.map(x => x.dataset.value)));
await b.close();
