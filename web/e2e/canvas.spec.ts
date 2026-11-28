// The PR view's canvas (#182) in a real browser, on the recorded analysis of AdvanGrid/beghu#191
// (v2, which `./dev-ctl start` and `reset` upload for tomsj): layout A's columns and a part's
// face; each lens, Show, Colour by (a multi-valued part's stripes), Boxes (the Shared box),
// Outlines and the Lines menu (counts, greyed under a lens); the no-lines grid; opening in
// place, folding, Back, Start over and Fold to groups, the glide and reduced motion; a selection
// opening down to itself; a double-click on a line; a partly drawn part's frame and rest block
// (made so on the way in, as pr-view.spec.ts does: no recording has one at v2); hover cards with
// Drawn as, and a line's boundary to its panel; a trunk's card pinned, dragged and closed; the
// legend (rows matching what's drawn, hover and pin, folding remembered); the keys; the Group
// panel; and both themes. Rebinding a canvas key is prefs.spec.ts's (the setup page).
//
// It only reads tomsj's analysis, and runs after pr-view.spec.ts in a project of its own
// (playwright.config.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";

type Json = Record<string, any>;
const V2 = JSON.parse(readFileSync(fileURLToPath(new URL("../../fixtures/pr-view/beghu-191/analysis-v2.json", import.meta.url)), "utf8")) as Json;
const VIEW = "/AdvanGrid/beghu/pull/191/view";
const GRAPH = "**/api/AdvanGrid/beghu/pulls/191/analysis";

const nodeOf = (id: string): Json => V2.nodes.find((n: Json) => n.id === id);
const viewport = (page: Page) => page.locator('[data-perf="canvas-viewport"]');
const panel = (page: Page) => page.locator('[data-perf="view-panel"]');
/** A drawn item (block, frame, box, column, rest block), not hidden. */
const item = (page: Page, id: string) => page.locator(`[data-item="${id}"]:not([hidden] *)`);
const block = (page: Page, id: string) => page.locator(`[data-perf="block"][data-id="${id}"]:not([hidden] *)`);
const blocks = (page: Page) => page.locator('[data-perf="block"]:not([hidden] *):not([data-grid])');
const selOf = (page: Page) => new URL(page.url()).searchParams.get("sel");
const param = (page: Page, k: string) => new URL(page.url()).searchParams.get(k);
const undoes = (page: Page) => page.locator('[data-perf="canvas-undoes"]');

async function signIn(context: BrowserContext, login = "tomsj"): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`/auth/login?login=${login}`);
  await page.waitForURL((u) => u.pathname === "/issues");
  return page;
}

/**
 * Opens the view at `search`, once the canvas has drawn; with `fit`, Fit then brings the whole
 * drawing into view (the start view shows its top left at 85% or more, and the canvas clips).
 */
async function open(page: Page, search = "", opts: { fit?: boolean } = {}): Promise<void> {
  await page.goto(VIEW + search);
  // A first open may wait on Vite compiling the view, or the server reading the analysis.
  await expect(viewport(page)).toHaveAttribute("data-drawn", /.+/, { timeout: 30_000 });
  if (opts.fit) {
    const zoom = page.locator('[data-perf="zoom-level"]');
    const before = await zoom.textContent();
    await page.locator('[data-perf="zoom-fit"]').click();
    await expect.poll(() => zoom.textContent()).not.toBe(before);
  }
}

/** The ids of the drawn closed blocks (the no-lines grid aside). */
const drawnIds = async (page: Page) => (await blocks(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id!))).sort();

/** Waits for the canvas's glides to settle: its lines are back. */
const settled = (page: Page) => expect(page.locator('[data-perf="canvas-lines"]')).not.toHaveAttribute("data-gliding", "");

/** A point on a drawn line's or trunk's route where the pointer reaches it (no trunk, card or legend over it). */
async function pointOn(target: Locator): Promise<{ x: number; y: number }> {
  const p = await target.evaluate((el) => {
    const path = el as SVGPathElement;
    const len = path.getTotalLength();
    const m = path.getScreenCTM()!;
    for (let i = 1; i < 60; i++) {
      const at = path.getPointAtLength(len * ((i * 0.618) % 1));
      const x = at.x * m.a + at.y * m.c + m.e, y = at.x * m.b + at.y * m.d + m.f;
      if (document.elementFromPoint(x, y) === el) return { x, y };
    }
    return null;
  });
  if (!p) throw new Error("no point on it the pointer reaches");
  return p;
}

/** A point on a line's route near its end (or its start), where the pointer reaches it. */
async function pointNear(target: Locator, atEnd: boolean): Promise<{ x: number; y: number }> {
  const p = await target.evaluate((el, atEnd) => {
    const path = el as SVGPathElement;
    const len = path.getTotalLength();
    const m = path.getScreenCTM()!;
    for (let i = 4; i < 60; i++) {
      const at = path.getPointAtLength(atEnd ? len * (1 - i / 100) : (len * i) / 100);
      const x = at.x * m.a + at.y * m.c + m.e, y = at.x * m.b + at.y * m.d + m.f;
      if (document.elementFromPoint(x, y) === el) return { x, y };
    }
    return null;
  }, atEnd);
  if (!p) throw new Error("no point near its end the pointer reaches");
  return p;
}

/** A point on the canvas's background, or an open column's, box's or frame's own room: a drag there pans. */
async function backgroundPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await viewport(page).evaluate((vp) => {
    const r = vp.getBoundingClientRect();
    for (let y = r.bottom - 30; y > r.top + 20; y -= 17)
      for (let x = r.left + 20; x < r.right - 20; x += 23) {
        const at = document.elementFromPoint(x, y);
        if (!at || at.closest("[data-chrome]") || at.closest("[data-line],[data-trunk]")) continue;
        const it = at.closest<HTMLElement>("[data-item]");
        if (at === vp || at.parentElement === vp || (it && ["column", "box", "frame"].includes(it.dataset.perf!) && !at.closest("[data-title]"))) return { x, y };
      }
    return null;
  });
  if (!p) throw new Error("no background in view");
  return p;
}

/**
 * Whether an item is drawn whole where it belongs: no animation left on it, fully opaque, and its
 * computed transform its own place (`--x`, `--y`), no scale or lingering offset.
 */
const wholeAt = (l: Locator) =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el);
    const m = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
    const x = parseFloat(el.style.getPropertyValue("--x")), y = parseFloat(el.style.getPropertyValue("--y"));
    const ok = el.getAnimations().length === 0 && cs.opacity === "1" && m.a === 1 && m.d === 1 && Math.abs(m.e - x) < 0.5 && Math.abs(m.f - y) < 0.5;
    return ok ? "whole" : `animations ${el.getAnimations().length}, opacity ${cs.opacity}, transform ${cs.transform} (at ${x}, ${y})`;
  });

/** Nothing of a glide is left once it lands: no skin, and no item's own border, fill or stripes still hidden for one. */
async function noSkins(page: Page): Promise<void> {
  expect(await page.locator("[data-skin]").count()).toBe(0);
  const bare = await page.locator("[data-item]").evaluateAll((els) =>
    els.filter((e) => /--bare|--worn/.test((e as HTMLElement).getAttribute("style") ?? "")).map((e) => (e as HTMLElement).dataset.item),
  );
  expect(bare).toEqual([]);
}

/** Whether `inner`'s box lies inside `outer`'s. */
async function inside(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  return !!a && !!b && a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
}

const tops = V2.nodes.filter((n: Json) => n.parent === "system");
const isCode = (n: Json) => !["actor", "external", "store"].includes(n.kind);

test("Layout A: the columns as frames, each part's face, lines with no labels but their counts", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  // Modules and services: code parts only, in the changed and unchanged columns.
  await expect(page.locator('[data-perf="column"]:not([hidden] *)')).toHaveCount(2);
  await expect(item(page, "column:changed").locator('[data-perf="frame-title"]')).toHaveText("▾ Changed");
  await expect(item(page, "column:unchanged").locator('[data-perf="frame-title"]')).toHaveText("▾ Unchanged");
  for (const id of await drawnIds(page)) expect(isCode(nodeOf(id)), `${id} is code`).toBe(true);
  // A part's face: kind, change, name, then its change size; "double-click ▸" when it has parts inside.
  const server = nodeOf("crates-server");
  const files = V2.nodes.filter((n: Json) => n.id === server.id || n.id.startsWith("crates-server.")).flatMap((n: Json) => n.files);
  const add = files.reduce((s: number, f: Json) => s + f.added, 0).toLocaleString("en-US");
  const del = files.reduce((s: number, f: Json) => s + f.removed, 0).toLocaleString("en-US");
  await expect(block(page, "crates-server")).toContainText(`service · changed${server.name}${files.length} files · +${add} −${del}double-click ▸`);
  await expect(block(page, "crates-dbrt")).toContainText("library · unchanged");
  await expect(block(page, "crates-dbrt")).not.toContainText("double-click");
  // The changed column sits at the top left, with no empty band above.
  const [vp, changed] = [await viewport(page).boundingBox(), await item(page, "column:changed").boundingBox()];
  expect(changed!.x - vp!.x).toBeLessThan(40);
  expect(changed!.y - vp!.y).toBeLessThan(40);
  // Lines carry no labels: the only text on them is a count, on a line carrying several.
  const texts = await page.locator('[data-perf="canvas-lines"] text').allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  for (const t of texts) expect(t).toMatch(/^[2-9]\d*$|^1\d+$/);
  const counted = await page.locator('[data-perf="canvas-line"]').evaluateAll((els) => els.filter((e) => Number((e as HTMLElement).dataset.count) > 1).length);
  expect(texts.length).toBeLessThanOrEqual(counted);
});

test("Each lens draws its own lines and parts", async ({ context }) => {
  const page = await signIn(context);
  // Data flow: only lines with data; people, outside systems and stores drawn; Kind fixed, greyed.
  await open(page, "?lens=data");
  for (const m of await page.locator('[data-perf="canvas-line"]').evaluateAll((els) => els.flatMap((e) => (e as HTMLElement).dataset.members!.split(" ")))) {
    expect(V2.edges.find((e: Json) => e.id === m).data, `${m} carries data`).toBeTruthy();
  }
  await expect(page.locator('[data-perf="column"][data-id="column:people"]')).toBeVisible();
  await expect(page.locator('[data-perf="column"][data-id="column:outside"]')).toBeVisible();
  // A line of one connection read from its far end points back at the reader.
  const back = V2.edges.find((e: Json) => e.data?.direction === "back" && e.when === "runtime" && tops.some((t: Json) => t.id === e.from) && tops.some((t: Json) => t.id === e.to));
  if (back) {
    const line = page.locator(`[data-perf="canvas-line"][data-members="${back.id}"]`);
    if (await line.count()) await expect(line).toHaveAttribute("data-heads", back.from < back.to ? "from" : "to");
  }
  await page.locator('[data-perf="lines-menu"]').click();
  await expect(page.locator('[data-perf="lines-fixed"]')).toHaveText("Data flow draws lines with data only.");
  for (const k of ["call", "data", "event"]) await expect(page.locator(`[data-perf="lines-option"][data-value="${k}"] input`)).toBeDisabled();

  // External connections: what touches the outside or crosses a boundary; the rest faded.
  await open(page, "?lens=external");
  for (const m of await page.locator('[data-perf="canvas-line"]').evaluateAll((els) => els.flatMap((e) => (e as HTMLElement).dataset.members!.split(" ")))) {
    const e = V2.edges.find((x: Json) => x.id === m);
    const outside = [e.from, e.to].some((id: string) => !isCode(nodeOf(id)));
    expect(outside || e.boundaries.length > 0, `${m} touches the outside or crosses a boundary`).toBe(true);
  }
  await expect(page.locator("[data-item][data-faded]").first()).toBeVisible();
  await expect(page.locator('[data-perf="legend-row"][data-row="faded"]')).toContainText("Faded: not on a line that crosses a boundary");

  // Order of actions is listed, disabled, until it comes.
  await expect(page.locator('[data-perf="picker-lens"] option[value="order"]')).toHaveJSProperty("disabled", true);
});

test("Show: the change and what it connects to, and changed parts only", async ({ context }) => {
  const page = await signIn(context);
  await open(page, "?lens=data");
  const all = await drawnIds(page);
  await page.locator('[data-perf="picker-show"]').selectOption("changed");
  await expect.poll(() => param(page, "show")).toBe("changed");
  await expect(page.locator('[data-perf="column"][data-id="column:unchanged"]')).toHaveCount(0);
  const changed = await drawnIds(page);
  for (const id of changed) expect(nodeOf(id).change !== "unchanged" || V2.nodes.some((n: Json) => n.id.startsWith(`${id}.`) && n.change !== "unchanged"), `${id} changed`).toBe(true);
  await page.locator('[data-perf="picker-show"]').selectOption("reach");
  await expect.poll(() => param(page, "show")).toBe("reach");
  const reach = await drawnIds(page);
  expect(reach.length).toBeGreaterThan(changed.length);
  expect(reach.length).toBeLessThanOrEqual(all.length);
  // People reach the change in data flow.
  expect(reach).toContain("actor-user");
});

test("Colour by a facet: words on the face, a multi-valued part's stripes, the legend's rows", async ({ context }) => {
  const page = await signIn(context);
  await open(page, "?colour=inside-product");
  const facet = V2.facets.find((f: Json) => f.id === "inside-product");
  const label = (v: string) => facet.values.find((x: Json) => x.id === v).label;
  const values = nodeOf("crates-server").facets.find((f: Json) => f.facet === "inside-product").values.map((v: Json) => v.value);
  expect(values.length).toBeGreaterThan(1);
  await expect(block(page, "crates-server").locator('[data-perf="stripe"]')).toHaveCount(values.length);
  await expect(block(page, "crates-server")).toContainText(values.map(label).join(", "));
  const one = block(page, "crates-analysis").locator('[data-perf="stripe"]');
  await expect(one).toHaveCount(1);
  // The legend: the facet's own section, a row per value drawn, and stripes.
  await expect(page.locator('[data-perf="legend-section"]').first()).toHaveAttribute("data-section", facet.name);
  await expect(page.locator('[data-perf="legend-row"][data-row="value:*stripes"]')).toContainText("Stripes: several values");
  await expect(page.locator('[data-perf="legend-row"][data-row="value:*stripes"] [data-perf="legend-count"]')).toHaveText("1");
});

test("Boxes: a Shared box for a part with several values, its Group panel with each member's values and claims", async ({ context }) => {
  const page = await signIn(context);
  await open(page, "?boxes=inside-product", { fit: true });
  const shared = item(page, "box:changed:inside-product:*shared");
  await expect(shared.locator('[data-perf="frame-title"]')).toHaveText("▾ Shared: 2 Product area");
  expect(await inside(block(page, "crates-server"), shared)).toBe(true);
  // Never copied into each of its values' boxes; its card shows a chip per value.
  await expect(page.locator('[data-perf="block"][data-id="crates-server"]')).toHaveCount(1);
  await block(page, "crates-server").hover();
  const label = (v: string) => V2.facets.find((f: Json) => f.id === "inside-product").values.find((x: Json) => x.id === v).label;
  const values = nodeOf("crates-server").facets.find((f: Json) => f.facet === "inside-product").values.map((v: Json) => label(v.value));
  await expect(page.locator('[data-perf="hover-card"] [data-perf="value-chip"]')).toHaveText(values);
  await page.mouse.move(5, 5);
  // Its body selects it: the Group panel.
  const box = (await shared.boundingBox())!;
  await page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
  await expect.poll(() => selOf(page)).toBe("group:box:changed:inside-product:*shared");
  const g = panel(page).locator('[data-perf="group-panel"]');
  await expect(g.locator("h2")).toHaveText("Shared: 2 Product area");
  await expect(g.locator('[data-perf="group-counts"]')).toHaveText("1 part · 1 changed");
  const member = g.locator('[data-perf="group-member"][data-id="crates-server"]');
  await expect(member.locator('[data-perf="facets"]')).toContainText("Product area:");
  // A box folds by its title, into one block with summed lines.
  await shared.locator('[data-perf="frame-title"]').click();
  await expect(page.locator('[data-perf="group-block"][data-id="box:changed:inside-product:*shared"]')).toBeVisible();
  await expect(block(page, "crates-server")).toHaveCount(0);
  await expect(undoes(page)).toHaveText("undoes: folded Shared: 2 Product area");
});

test("Outlines: rings in the values' colours, a legend row per value", async ({ context }) => {
  const page = await signIn(context);
  await open(page, "?outlines=lang");
  const langs = nodeOf("web").facets.find((f: Json) => f.facet === "lang").values.filter((v: Json) => v.value !== "unknown");
  await expect(block(page, "web").locator('[data-perf="ring"]')).toHaveCount(Math.min(langs.length, 3));
  const sec = page.locator('[data-perf="legend-section"][data-section="Outlines: Language"]');
  await expect(sec).toBeVisible();
  await expect(sec.locator('[data-perf="legend-row"]').first()).toBeVisible();
});

test("The Lines menu: counts at this level, test lines on, and the no-lines grid", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const lines = page.locator('[data-perf="canvas-line"]');
  const before = await lines.count();
  await page.locator('[data-perf="lines-menu"]').click();
  const tests = page.locator('[data-perf="lines-option"][data-value="test"]');
  const count = Number(await tests.locator('[data-perf="lines-count"]').textContent());
  expect(count).toBeGreaterThan(0);
  await tests.locator("input").check();
  await expect.poll(() => param(page, "lines")).toBe("runtime,test,call,data,event");
  await expect.poll(() => lines.count()).toBeGreaterThan(before);
  await tests.locator("input").uncheck();
  await expect.poll(() => param(page, "lines")).toBeNull();

  // Parts with no lines: hidden, then shown in a grid, counted by the lines shown.
  const lonely = page.locator('[data-perf="show-lonely"]');
  const n = Number(/Show (\d+) parts? with no lines/.exec((await lonely.textContent())!)![1]);
  await lonely.click();
  await expect(page.locator('[data-perf="no-lines-grid"]')).toContainText(`${n} parts with no lines`);
  await expect(page.locator('[data-perf="block"][data-grid]:not([hidden] *)')).toHaveCount(n);
  await expect(page.locator('[data-perf="legend-row"][data-row="grid"] [data-perf="legend-count"]')).toHaveText(String(n));
  await expect(lonely).toHaveText(`Hide ${n} parts with no lines`);
});

test("Opening in place, folding by the title, Back, Start over and Fold to groups", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const server = nodeOf("crates-server");
  const kids = V2.nodes.filter((n: Json) => n.parent === "crates-server");
  await block(page, "crates-server").dblclick();
  const frame = page.locator('[data-perf="frame"][data-id="crates-server"]');
  await expect(frame.locator('[data-perf="frame-title"]')).toHaveText(`▾ ${server.name}`);
  await expect(undoes(page)).toHaveText(`undoes: opened ${server.name}`);
  // Mid-glide the contents are still growing out of the block's corner: their places are read once it lands.
  await settled(page);
  for (const k of kids) {
    // Inside a frame a part is named on its own; the frame's title says where it is.
    const b = item(page, k.id);
    await expect(b).toContainText(k.name);
    expect(await inside(b, frame)).toBe(true);
  }
  // Folding: a click on the frame's title.
  await frame.locator('[data-perf="frame-title"]').click();
  await expect(block(page, "crates-server")).toBeVisible();
  await expect(item(page, kids[0].id)).toHaveCount(0);
  await expect(undoes(page)).toHaveText(`undoes: folded ${server.name}`);
  // Back undoes the fold, then the open.
  await page.locator('[data-perf="canvas-back"]').click();
  await expect(frame).toBeVisible();
  await expect(undoes(page)).toHaveText(`undoes: opened ${server.name}`);
  // Start over: the starting state, nothing to undo.
  await page.locator('[data-perf="canvas-start-over"]').click();
  await expect(block(page, "crates-server")).toBeVisible();
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();

  // Fold to groups: the columns as blocks; one opened brings its boxes out folded; Back undoes it.
  await page.locator('[data-perf="fold-to-groups"]').click();
  await expect(page.locator('[data-perf="group-block"]:not([hidden] *)')).toHaveCount(2);
  await expect(blocks(page)).toHaveCount(0);
  await expect(undoes(page)).toHaveText("undoes: folded to groups");
  await page.locator('[data-perf="group-block"][data-id="column:changed"]').dblclick();
  await expect(item(page, "column:changed").locator('[data-perf="frame-title"]')).toHaveText("▾ Changed");
  await expect(page.locator('[data-perf="group-block"][data-id="box:changed:folder:crates"]')).toBeVisible();
  await expect(undoes(page)).toHaveText("undoes: opened Changed");
  await page.locator('[data-perf="canvas-back"]').click();
  await page.locator('[data-perf="canvas-back"]').click();
  await expect(block(page, "crates-server")).toBeVisible();
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
});

/**
 * What the page draws at the glide's halfway frame (the first frame at or past GLIDE_MS / 2 after
 * the lines go away), read in the page as it glides (a check from here could land after it):
 * how long into the glide that frame was, and each selector's box, then and as the glide began.
 */
function atHalfway(page: Page, selectors: string[]): Promise<{ t: number; start: (Box | null)[]; half: (Box | null)[] }> {
  return page.evaluate(
    ({ half, selectors }) =>
      new Promise((done) => {
        const lines = document.querySelector('[data-perf="canvas-lines"]')!;
        const read = () =>
          selectors.map((sel) => {
            const r = document.querySelector(sel)?.getBoundingClientRect();
            return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
          });
        const mo = new MutationObserver(() => {
          if (!lines.hasAttribute("data-gliding")) return;
          mo.disconnect();
          const t0 = performance.now();
          const start = read();
          const tick = () => {
            const t = performance.now() - t0;
            if (t < half) return void requestAnimationFrame(tick);
            done({ t, start, half: read() });
          };
          requestAnimationFrame(tick);
        });
        mo.observe(lines, { attributes: true, attributeFilter: ["data-gliding"] });
      }),
    { half: GLIDE_MS / 2, selectors },
  );
}
type Box = { x: number; y: number; width: number; height: number };
/** The canvas's glide (Canvas.tsx's GLIDE_MS). */
const GLIDE_MS = 420;

test("The glide: contents grow out of the block and the lines come back once it lands; reduced motion snaps", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const glides = async () => Number((await viewport(page).getAttribute("data-glide")) ?? 0);
  const n = await glides();
  const at = (await block(page, "crates-server").boundingBox())!;
  const title = '[data-item="crates-server"] [data-perf="frame-title"]';
  // As it starts and halfway through, the lines are away and the clicked block stays where it
  // was; its title, which it gets as it opens, is drawn at its own size, never scaled.
  const mid = atHalfway(page, ['[data-item="crates-server"]', title]);
  await block(page, "crates-server").dblclick();
  await expect.poll(glides).toBe(n + 1);
  const opening = await mid;
  expect(opening.t).toBeLessThan(GLIDE_MS);
  for (const b of [opening.start[0]!, opening.half[0]!]) {
    expect(Math.abs(b.x - at.x)).toBeLessThan(2);
    expect(Math.abs(b.y - at.y)).toBeLessThan(2);
  }
  await settled(page);
  await noSkins(page);
  const titleAt = (await page.locator(title).boundingBox())!;
  expect(Math.abs(opening.half[1]!.height - titleAt.height)).toBeLessThan(1);
  expect(Math.abs(opening.half[1]!.width - titleAt.width)).toBeLessThan(1);
  // Every moving item stays mounted, in the order it was first drawn.
  const order = await page.locator("[data-item]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item));
  // Folding: the block's face, which it gets back as it folds, is drawn at its own size too.
  const name = '[data-item="crates-server"] [data-perf="face-name"]';
  const folding = atHalfway(page, [name]);
  await page.locator(title).click();
  const folded = await folding;
  expect(folded.t).toBeLessThan(GLIDE_MS);
  await settled(page);
  await noSkins(page);
  const nameAt = (await page.locator(name).boundingBox())!;
  expect(Math.abs(folded.half[0]!.height - nameAt.height)).toBeLessThan(1);
  const after = await page.locator("[data-item]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item));
  expect(after.slice(0, order.length)).toEqual(order);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await block(page, "crates-server").dblclick();
  await expect(page.locator('[data-perf="frame"][data-id="crates-server"]')).toBeVisible();
  await expect(page.locator('[data-perf="canvas-lines"]')).not.toHaveAttribute("data-gliding", "", { timeout: 200 });
  await noSkins(page);
});

test("An open cut short by another continues from where everything is drawn: nothing jumps", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  await expect(block(page, "crates-analysis")).toBeVisible();
  // Each frame from the first open to well after the second lands: every drawn item's box as it
  // looks (a resizing one's skin, mid-glide, is its box), and which glide is under way.
  type Frame = { t: number; glide: string; boxes: Record<string, [number, number, number, number]> };
  const frames = await page.evaluate(
    ({ glide }) =>
      new Promise<Frame[]>((done) => {
        const vp = document.querySelector<HTMLElement>('[data-perf="canvas-viewport"]')!;
        const out: Frame[] = [];
        const look = (el: HTMLElement): [number, number, number, number] | null => {
          const skin = el.querySelector(":scope > [data-skin]");
          const [a, b] = skin ? [skin.children[0]!.getBoundingClientRect(), skin.children[3]!.getBoundingClientRect()] : [el.getBoundingClientRect(), el.getBoundingClientRect()];
          return a.width > 0 ? [a.left, a.top, b.right, b.bottom] : null;
        };
        const t0 = performance.now();
        const tick = () => {
          const boxes: Frame["boxes"] = {};
          for (const el of document.querySelectorAll<HTMLElement>("[data-item]")) {
            if (el.closest("[hidden]")) continue;
            const b = look(el);
            if (b) boxes[el.dataset.item!] = b;
          }
          out.push({ t: performance.now() - t0, glide: vp.dataset.glide ?? "", boxes });
          if (performance.now() - t0 < 100 + glide + 300) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
        const dbl = (id: string) => document.querySelector(`[data-perf="block"][data-id="${id}"]`)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        dbl("crates-server");
        // The second open, a quarter of the way into the first glide.
        setTimeout(() => dbl("crates-analysis"), 100);
      }),
    { glide: GLIDE_MS },
  );
  // The frame the second glide starts in: the first glide was under way for some frames before it.
  const second = frames.at(-1)!.glide;
  const k = frames.findIndex((f) => f.glide === second);
  expect(frames[0]!.glide).not.toBe(second);
  expect(k).toBeGreaterThanOrEqual(2);
  expect(frames[k]!.t).toBeLessThan(100 + GLIDE_MS / 2);
  // At the frame the second glide starts, no item moves further than its own speed either side of
  // it would take it (a few px of leeway): it carries on from where it was drawn, never from
  // where the first glide was taking it.
  const moved = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  const jumps: string[] = [];
  for (const id of Object.keys(frames[k]!.boxes)) {
    const [p, c, q] = [frames[k - 1]!.boxes[id], frames[k]!.boxes[id], frames[k + 1]?.boxes[id]];
    if (!p || !c) continue;
    const dt = frames[k]!.t - frames[k - 1]!.t;
    const before = frames[k - 2]?.boxes[id] ? moved(p, frames[k - 2]!.boxes[id]!) / (frames[k - 1]!.t - frames[k - 2]!.t) : 0;
    const after = q ? moved(q, c) / (frames[k + 1]!.t - frames[k]!.t) : 0;
    const d = moved(c, p);
    if (d > Math.max(before, after) * dt + 6) jumps.push(`${id}: ${d.toFixed(1)} px in ${dt.toFixed(0)} ms`);
  }
  expect(jumps).toEqual([]);
  await settled(page);
  await noSkins(page);
  await expect(page.locator('[data-perf="frame"][data-id="crates-analysis"]')).toBeVisible();
  await expect(page.locator('[data-perf="frame"][data-id="crates-server"]')).toBeVisible();
});

test("Parts come back whole after fold → Back and fold → open, and the clicked block stays still going back", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const kids = V2.nodes.filter((n: Json) => n.parent === "crates-server");
  const title = page.locator('[data-perf="frame"][data-id="crates-server"] [data-perf="frame-title"]');
  const allWhole = async () => {
    for (const k of kids) await expect.poll(() => wholeAt(page.locator(`[data-item="${k.id}"]`))).toBe("whole");
  };
  await block(page, "crates-server").dblclick();
  await settled(page);
  await allWhole();
  // Fold, then Back: the contents that shrank away come back opaque and in place.
  await title.click();
  await settled(page);
  const folded = (await item(page, "crates-server").boundingBox())!;
  await page.locator('[data-perf="canvas-back"]').click();
  // Back glides about the block it undoes: it stays where it was.
  await expect(page.locator('[data-perf="canvas-lines"]')).toHaveAttribute("data-gliding", "");
  const going = (await item(page, "crates-server").boundingBox())!;
  expect(Math.abs(going.x - folded.x)).toBeLessThan(2);
  expect(Math.abs(going.y - folded.y)).toBeLessThan(2);
  await settled(page);
  await allWhole();
  // Fold, then open again by a double-click.
  await title.click();
  await settled(page);
  await block(page, "crates-server").dblclick();
  await settled(page);
  await allWhole();
  // And under reduced motion, which snaps.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await title.click();
  await page.locator('[data-perf="canvas-back"]').click();
  await allWhole();
  await settled(page);
  await noSkins(page);
});

test("A selection inside a folded block opens down to it, as one Back step", async ({ context }) => {
  const page = await signIn(context);
  const deep = V2.nodes.find((n: Json) => n.parent && V2.nodes.find((p: Json) => p.id === n.parent)?.parent === "crates-server");
  await open(page, `?sel=part:${deep.id}`);
  await expect(block(page, deep.id)).toBeVisible();
  await expect(block(page, deep.id)).toHaveAttribute("data-selected", "");
  await expect(page.locator('[data-perf="frame"][data-id="crates-server"]')).toBeVisible();
  await expect(page.locator(`[data-perf="frame"][data-id="${deep.parent}"]`)).toBeVisible();
  await expect(undoes(page)).toContainText("undoes: opened down to");
  await page.locator('[data-perf="canvas-back"]').click();
  await expect(block(page, "crates-server")).toBeVisible();
  // The selection stays: Back walks opens, not picks.
  expect(selOf(page)).toBe(`part:${deep.id}`);
});

test("A double-click on a line glides to its far end and selects it", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  // A line of one connection between two top-level parts.
  const line = page.locator('[data-perf="canvas-line"][data-count="1"]').first();
  const member = (await line.getAttribute("data-members"))!;
  const e = V2.edges.find((x: Json) => x.id === member);
  const p = await pointOn(line);
  await page.mouse.dblclick(p.x, p.y);
  await expect.poll(() => selOf(page), { timeout: 5_000 }).toMatch(/^part:/);
  // One of its ends: the part itself, or the top-level part holding it.
  const picked = selOf(page)!.slice("part:".length);
  expect([e.from, e.to].some((end: string) => end === picked || end.startsWith(`${picked}.`))).toBe(true);
});

test("A reversed Data flow line's double-click glides to the end it reaches, opening down to it", async ({ context }) => {
  const page = await signIn(context);
  await open(page, "?lens=data");
  // crates-server.src.github → ext-github, its data back from GitHub: drawn from crates-server,
  // its arrowhead there. From near GitHub, the far end is the server's github module.
  const e = V2.edges.find((x: Json) => x.id === "e.crate-server.src.github.to.github");
  expect(e.data.direction).toBe("back");
  await page.locator('[data-perf="zoom-fit"]').click();
  const line = page.locator(`[data-perf="canvas-line"][data-members="${e.id}"]`);
  await expect(line).toHaveAttribute("data-heads", "from");
  const p = await pointNear(line, true);
  await page.mouse.dblclick(p.x, p.y);
  await expect.poll(() => selOf(page), { timeout: 5_000 }).toBe(`part:${e.from}`);
  await expect(page.locator('[data-perf="frame"][data-id="crates-server"]')).toBeVisible();
});

test("A line's flight cut short by a drag leaves nothing lit or faded", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  // Zoomed in to 200%, a flight runs its longest (1.1 s): time to cut it short.
  await viewport(page).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("+");
  await expect(page.locator('[data-perf="zoom-level"]')).toHaveText("200%");
  let p: { x: number; y: number } | undefined;
  for (const line of await page.locator('[data-perf="canvas-line"][data-count="1"]').all()) {
    p = await pointOn(line).catch(() => undefined);
    if (p) break;
  }
  if (!p) throw new Error("no line of one connection in view");
  const bg = await backgroundPoint(page);
  await page.mouse.dblclick(p.x, p.y);
  // Mid-flight (once any open down to its far end has landed), a drag on the background takes over.
  await expect(viewport(page)).toHaveAttribute("data-flying", "", { timeout: 2_000 });
  await page.mouse.move(bg.x, bg.y);
  await page.mouse.down();
  await page.mouse.move(bg.x + 40, bg.y + 30, { steps: 2 });
  await page.mouse.up();
  await expect(viewport(page)).not.toHaveAttribute("data-flying", "");
  // The double-click's first click picked the line; cut short, the flight picks nothing more.
  expect(selOf(page)).toMatch(/^line:/);
  await page.waitForTimeout(1200);
  expect(selOf(page)).toMatch(/^line:/);
  // Cleared, nothing stays lit or faded: the flight's own fade went with it.
  await viewport(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(() => selOf(page)).toBeNull();
  await page.mouse.move(2, 2);
  await expect(page.locator("[data-lit]")).toHaveCount(0);
  await expect(page.locator('[data-focus="dim"]')).toHaveCount(0);
  expect(await page.locator('[data-perf="canvas"]').evaluate((el) => getComputedStyle(el).getPropertyValue("--fade").trim())).toBe("1");
});

test("The start view: the content's width fitted, never under 85%, from the changed column's top left", async ({ context }) => {
  const page = await signIn(context);
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const zoom = Number((await page.locator('[data-perf="zoom-level"]').textContent())!.replace("%", ""));
  expect(zoom).toBeGreaterThanOrEqual(85);
  expect(zoom).toBeLessThanOrEqual(100);
  const [vp, changed] = [(await viewport(page).boundingBox())!, (await item(page, "column:changed").boundingBox())!];
  expect(Math.abs(changed.x - vp.x - 24)).toBeLessThan(2);
  expect(Math.abs(changed.y - vp.y - 24)).toBeLessThan(2);
});

test("The start view keeps a people column left of the changed one in view when the drawing fits", async ({ context }) => {
  const page = await signIn(context);
  // Wide enough for External's whole drawing at 85% or more, the panel open beside it.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await open(page, "?lens=external");
  const people = item(page, "column:people");
  await expect(people).toBeVisible();
  const [vp, col, changed] = [(await viewport(page).boundingBox())!, (await people.boundingBox())!, (await item(page, "column:changed").boundingBox())!];
  expect(col.x).toBeLessThan(changed.x);
  // The drawing's left edge at the margin, the people column in view; the top still the changed column's.
  expect(col.x).toBeGreaterThanOrEqual(vp.x + 23);
  expect(Math.abs(changed.y - vp.y - 24)).toBeLessThan(2);
});

test("The wheel scrolls the legend over it, and pans the drawing elsewhere", async ({ context }) => {
  const page = await signIn(context);
  await page.setViewportSize({ width: 1500, height: 560 });
  await open(page, "?outlines=" + encodeURIComponent(V2.facets.find((f: Json) => f.appliesTo === "node").id));
  const body = page.locator('[data-perf="legend-body"]');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const at = (await block(page, "crates-server").boundingBox())!;
  const b = (await body.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const still = (await block(page, "crates-server").boundingBox())!;
  expect(still.y).toBe(at.y);
  // Off the legend, the wheel pans.
  const bg = await backgroundPoint(page);
  await page.mouse.move(bg.x, bg.y);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await block(page, "crates-server").boundingBox())!.y).toBeLessThan(at.y - 50);
});

test("The keyboard: Tab lands on the changed column, arrows select the nearest part, Enter opens and folds", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  // From the toolbar's last control, Tab reaches the canvas's one tab stop.
  await page.locator('[data-perf="lines-menu"]').focus();
  const active = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.item ?? (document.activeElement as HTMLElement | null)?.dataset.perf ?? null);
  for (let i = 0; i < 6 && (await active()) !== "column:changed"; i++) await page.keyboard.press("Tab");
  expect(await active()).toBe("column:changed");
  await expect(page.locator('[data-perf="hints"]')).toContainText("Open or fold the selection");
  // An arrow selects the nearest part that way, and the focus follows it.
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => selOf(page)).toMatch(/^part:/);
  const first = selOf(page)!.slice("part:".length);
  await expect.poll(active).toBe(first);
  const a = (await block(page, first).boundingBox())!;
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => selOf(page)).not.toBe(`part:${first}`);
  const next = selOf(page)!.slice("part:".length);
  const b = (await block(page, next).boundingBox())!;
  expect(b.x + b.width / 2).toBeGreaterThan(a.x + a.width / 2);
  await expect.poll(active).toBe(next);
  // Enter opens the selected block in place, and folds it again. (Escape first: a click on the
  // selected block would open it.)
  await page.keyboard.press("Escape");
  await expect.poll(() => selOf(page)).toBeNull();
  await block(page, "crates-server").click();
  await expect.poll(active).toBe("crates-server");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-perf="frame"][data-id="crates-server"]')).toBeVisible();
  await expect(undoes(page)).toHaveText(`undoes: opened ${nodeOf("crates-server").name}`);
  await settled(page);
  await page.keyboard.press("Enter");
  await expect(block(page, "crates-server")).toBeVisible();
  await expect(undoes(page)).toHaveText(`undoes: folded ${nodeOf("crates-server").name}`);
  // What a screen reader hears of a block: a button named by its face and how to open it, not
  // expanded, current while selected. A click on it while it's selected opens it (a screen
  // reader's browse mode sends Enter as a click), and the open frame is expanded.
  await expect.poll(active).toBe("crates-server");
  const server = page.locator('[data-perf="block"][data-id="crates-server"]');
  const attr = (l: Locator, name: string) => l.evaluate((el, name) => el.getAttribute(name), name);
  await expect(server).toHaveAttribute("role", "button");
  await expect(server).toHaveAttribute("aria-current", "true");
  await expect(server).toHaveAttribute("aria-expanded", "false");
  await expect(server).toHaveAttribute("aria-label", `service · changed, ${nodeOf("crates-server").name}, has parts inside, Enter opens`);
  expect(await attr(server, "aria-pressed")).toBeNull();
  await expect(viewport(page)).toHaveAttribute("aria-label", "The PR's parts and lines: arrow keys move the selection, Enter opens or folds it, ] and [ step through its lines");
  await server.click();
  const serverFrame = page.locator('[data-perf="frame"][data-id="crates-server"]');
  await expect(serverFrame).toBeVisible();
  await expect(undoes(page)).toHaveText(`undoes: opened ${nodeOf("crates-server").name}`);
  await expect(serverFrame).toHaveAttribute("aria-expanded", "true");
  await expect(serverFrame).toHaveAttribute("aria-current", "true");
  await expect(serverFrame).toHaveAttribute("aria-label", /, Enter folds$/);
  await settled(page);
  // A part with nothing inside: neither expanded nor not, and says nothing of opening.
  const leaf = V2.nodes.find((n: Json) => n.parent === "crates-server" && !V2.nodes.some((k: Json) => k.parent === n.id))!;
  const plain = block(page, leaf.id);
  await expect(plain).toBeVisible();
  expect(await attr(plain, "aria-expanded")).toBeNull();
  expect(await attr(plain, "aria-current")).toBeNull();
  await expect(plain).not.toHaveAttribute("aria-label", /parts inside|opens/);
  await expect.poll(active).toBe("crates-server");
  await page.keyboard.press("Enter");
  await expect(server).toBeVisible();
  await settled(page);
  // ] and [ step through the selected part's lines, the focus on each: a line is reached without a pointer.
  await expect.poll(active).toBe("crates-server");
  const focusedLine = () => page.evaluate(() => (document.activeElement as SVGElement | null)?.dataset?.line ?? null);
  /** The focused line's words: its two ends and how many connections it carries. */
  const said = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  await page.keyboard.press("]");
  await expect.poll(() => selOf(page)).toMatch(/^line:/);
  await expect.poll(focusedLine).not.toBeNull();
  const line1 = (await focusedLine())!;
  expect(await said()).toContain(nodeOf("crates-server").name);
  await page.keyboard.press("]");
  await expect.poll(focusedLine).not.toBe(line1);
  expect(await said()).toContain(nodeOf("crates-server").name);
  await page.keyboard.press("[");
  await expect.poll(focusedLine).toBe(line1);
  expect(await attr(server, "aria-current")).toBeNull();
  await page.keyboard.press("Escape");
  await expect.poll(() => selOf(page)).toBeNull();
  // Space on a card's or the legend's button is the button's.
  await page.locator('[data-perf="legend-close"]').focus();
  await page.keyboard.press(" ");
  await expect(page.locator('[data-perf="legend"]')).toHaveCount(0);
  await page.locator('[data-perf="legend-open"]').click();
});

test("A partly drawn part: marked folded, its frame says how many folders are drawn, and a rest block", async ({ context }) => {
  const page = await signIn(context);
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    g.analysis.nodes.find((x: Json) => x.id === "crates-fake-github").drawn = { partial: true, folders: 9 };
    await route.fulfill({ response: res, json: g });
  });
  await open(page, "", { fit: true });
  const b = block(page, "crates-fake-github");
  await expect(b).toContainText("partly drawn · double-click ▸");
  await b.dblclick();
  await settled(page);
  const frame = page.locator('[data-perf="frame"][data-id="crates-fake-github"]');
  await expect(frame.locator('[data-perf="frame-title"]')).toHaveText(/^▾ fake-github · (\d) of 9 folders drawn$/);
  const drawn = Number(/· (\d) of 9/.exec((await frame.locator('[data-perf="frame-title"]').textContent())!)![1]);
  const rest = page.locator('[data-perf="rest"][data-id="rest:crates-fake-github"]');
  await expect(rest).toContainText(`${9 - drawn} folders not drawn`);
  await expect(rest).toContainText("no line, step, purpose or conflict in this PR reaches them");
  expect(await inside(rest, frame)).toBe(true);
  // It can't be opened.
  await rest.dispatchEvent("dblclick");
  await expect(rest).toBeVisible();
  await expect(page.locator('[data-perf="legend-row"][data-row="rest"]')).toContainText("Dashed, muted: stands for parts left out");
  await expect(page.locator('[data-perf="legend-row"][data-row="partial"]')).toContainText("Partly drawn: some folders not drawn");
});

test("A line only an undetermined claim backs is dotted, in the legend and its card says not confirmed", async ({ context }) => {
  const page = await signIn(context);
  // No recording has one at v2: a line of one connection, its claims made undetermined on the way in.
  await open(page);
  const id = (await page.locator('[data-perf="canvas-line"][data-count="1"]').first().getAttribute("data-members"))!;
  const e = V2.edges.find((x: Json) => x.id === id);
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    for (const c of g.analysis.claims) if (e.claims.includes(c.id)) c.status = "undetermined";
    await route.fulfill({ response: res, json: g });
  });
  await open(page);
  const line = page.locator(`[data-perf="canvas-line"][data-members="${e.id}"]`);
  await expect(line).toHaveAttribute("data-style", /dotted/);
  await expect(page.locator('[data-perf="legend-row"][data-row="line:dotted"]')).toContainText("Dotted: not confirmed");
  const p = await pointOn(line);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('[data-perf="line-card"]')).toContainText("not confirmed");
  await expect(page.locator('[data-perf="line-card"] [data-perf="drawn-as-row"][data-row="line:dotted"]')).toBeVisible();
});

test("Hover cards: a part's and a line's, each with Drawn as; a line's boundary opens its panel", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  await block(page, "crates-server").hover();
  const card = page.locator('[data-perf="hover-card"]');
  await expect(card.locator('[data-perf="part-card"]')).toContainText(nodeOf("crates-server").summary);
  await expect(card.locator('[data-perf="drawn-as-row"][data-row="change:modified"]')).toContainText("Changed");
  await expect(card.locator('[data-perf="drawn-as-row"][data-row="opens"]')).toBeVisible();
  // Hovering fades what's unrelated.
  await expect(page.locator('[data-focus="dim"]').first()).toBeAttached();
  await expect(block(page, "crates-server")).toHaveAttribute("data-focus", "lit");
  // Its lines light, each one's route through its trunks with it.
  await expect(page.locator("[data-line-drawn][data-lit]").first()).toBeAttached();

  // A line crossing a boundary, under External connections.
  await open(page, "?lens=external");
  const crossing = V2.edges.find((e: Json) => e.boundaries.length > 0 && e.when === "runtime");
  const line = page.locator(`[data-perf="canvas-line"][data-members~="${crossing.id}"]`);
  await expect(line).toHaveCount(1);
  await expect(line).toHaveAttribute("data-style", /dashed/);
  const p = await pointOn(line);
  await page.mouse.move(p.x, p.y);
  const lc = page.locator('[data-perf="line-card"]');
  await expect(lc.locator(`[data-perf="card-connection"][data-id="${crossing.id}"]`)).toContainText(crossing.label);
  await expect(lc.locator('[data-perf="drawn-as-line"]').first()).toHaveText(/^a line(, riding \d+ trunks?)?$/);
  await expect(lc.locator('[data-perf="drawn-as-row"][data-row="line:dashed"]')).toContainText("Dashed: crosses a boundary");
  const boundary = V2.boundaries.find((b: Json) => b.id === crossing.boundaries[0]);
  // The card stays while the pointer moves onto it.
  const pick = lc.locator('[data-perf="card-boundary"]', { hasText: boundary.name }).first();
  const at = (await pick.boundingBox())!;
  await page.mouse.move(at.x + 3, at.y + at.height / 2, { steps: 6 });
  await pick.click();
  await expect.poll(() => selOf(page)).toBe(`boundary:${boundary.id}`);
  const bp = panel(page).locator('[data-perf="boundary-panel"]');
  await expect(bp.locator("h2")).toHaveText(boundary.name);
  await expect(bp.locator('[data-perf="crossing"]')).toHaveCount(V2.edges.filter((e: Json) => e.boundaries.includes(boundary.id)).length);
});

test("A trunk's card: pinned by a click, dragged by its head, closed by × and Escape; a row lights its line", async ({ context }) => {
  const page = await signIn(context);
  await open(page, "?lens=data", { fit: true });
  const trunk = page.locator('[data-perf="trunk"]').first();
  const p = await pointOn(trunk);
  await page.mouse.move(p.x, p.y);
  await expect(page.locator('[data-perf="trunk-hover"]')).toContainText(/\d+ lines share this stretch/);
  await page.mouse.click(p.x, p.y);
  const card = page.locator('[data-perf="trunk-card"]');
  await expect(card).toBeVisible();
  // Dragged by its head.
  const head = card.locator('[data-perf="trunk-card-head"]');
  const was = (await card.boundingBox())!;
  const h = (await head.boundingBox())!;
  await page.mouse.move(h.x + 20, h.y + h.height / 2);
  await page.mouse.down();
  // (Toward the canvas's middle: dragged, the card stays inside the canvas.)
  const vp = (await viewport(page).boundingBox())!;
  const dx = was.x > vp.x + vp.width / 2 ? -100 : 100, dy = was.y > vp.y + vp.height / 2 ? -80 : 80;
  await page.mouse.move(h.x + 20 + dx, h.y + h.height / 2 + dy, { steps: 5 });
  await page.mouse.up();
  const moved = (await card.boundingBox())!;
  expect(Math.abs(moved.x - was.x - dx)).toBeLessThan(2);
  expect(Math.abs(moved.y - was.y - dy)).toBeLessThan(2);
  // A row lights its line's whole route.
  const row = card.locator('[data-perf="trunk-row"]').first();
  const id = (await row.getAttribute("data-id"))!;
  await row.hover();
  // (Drawn lines' IDs are JSON: quoted in single quotes.)
  await expect(page.locator(`[data-line-drawn='${id}']`)).toHaveAttribute("data-lit", "");
  await card.locator('[data-perf="trunk-card-close"]').click();
  await expect(card).toHaveCount(0);
  // Pinned again, Escape closes it.
  await page.mouse.click(p.x, p.y);
  await expect(card).toBeVisible();
  await viewport(page).focus();
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});

test("The legend: its rows match what's drawn, hover fades the rest, a click pins, folding is remembered", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const legend = page.locator('[data-perf="legend"]');
  await expect(legend).toBeVisible();
  // The change rows count the blocks drawn in each.
  for (const [row, change] of [
    ["change:added", "added"],
    ["change:modified", "modified"],
    ["change:unchanged", "unchanged"],
  ]) {
    const n = await page.locator(`[data-perf="block"][data-change="${change}"]:not([hidden] *):not([data-grid])`).count();
    const r = legend.locator(`[data-perf="legend-row"][data-row="${row}"]`);
    if (n === 0) await expect(r).toHaveCount(0);
    else await expect(r.locator('[data-perf="legend-count"]')).toHaveText(String(n));
  }
  // Nothing drawn in a style, no row: Modules draws no people or outside systems.
  await expect(legend.locator('[data-perf="legend-row"][data-row="change:none"]')).toHaveCount(0);
  await expect(legend.locator('[data-perf="legend-row"][data-row="line:labels"]')).toContainText("No labels: hover or select a line");
  // Hover fades everything not drawn in that style.
  const added = legend.locator('[data-perf="legend-row"][data-row="change:added"]');
  await added.hover();
  await expect(page.locator('[data-perf="block"][data-change="added"][data-focus="lit"]').first()).toBeVisible();
  await expect(page.locator('[data-perf="block"][data-change="modified"][data-focus="dim"]').first()).toBeVisible();
  // A click pins it; another row's click moves the pin; Escape unpins.
  await added.click();
  await expect(added).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(5, 5);
  await expect(page.locator('[data-perf="block"][data-change="modified"][data-focus="dim"]').first()).toBeVisible();
  const mod = legend.locator('[data-perf="legend-row"][data-row="change:modified"]');
  await mod.click();
  await expect(added).toHaveAttribute("aria-pressed", "false");
  await expect(mod).toHaveAttribute("aria-pressed", "true");
  await viewport(page).focus();
  await page.keyboard.press("Escape");
  await expect(mod).toHaveAttribute("aria-pressed", "false");
  // × folds it to a Key button, remembered by the browser.
  await legend.locator('[data-perf="legend-close"]').click();
  await expect(legend).toHaveCount(0);
  await open(page);
  await expect(page.locator('[data-perf="legend-open"]')).toBeVisible();
  await expect(legend).toHaveCount(0);
  await page.locator('[data-perf="legend-open"]').click();
  await expect(legend).toBeVisible();
  await open(page);
  await expect(legend).toBeVisible();
});

test("Keys: zoom in, out, reset and fit; Backspace goes out one level; Escape clears the selection", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const zoom = page.locator('[data-perf="zoom-level"]');
  await viewport(page).focus();
  const start = Number((await zoom.textContent())!.replace("%", ""));
  await page.keyboard.press("+");
  await expect.poll(async () => Number((await zoom.textContent())!.replace("%", ""))).toBeGreaterThan(start);
  await page.keyboard.press("-");
  await expect(zoom).toHaveText(`${start}%`);
  await page.keyboard.press("0");
  await expect(zoom).toHaveText("100%");
  await page.keyboard.press("f");
  await expect.poll(async () => Number((await zoom.textContent())!.replace("%", ""))).toBeLessThan(100);
  // The hint bar shows the canvas's keys while it has the focus.
  await expect(page.locator('[data-perf="hints"]')).toContainText("Out one level");

  // Backspace: the innermost open frame round the selection folds, and is selected.
  await block(page, "crates-server").dblclick();
  const kid = V2.nodes.find((n: Json) => n.parent === "crates-server");
  await settled(page);
  await block(page, kid.id).click();
  await expect.poll(() => selOf(page)).toBe(`part:${kid.id}`);
  await page.keyboard.press("Backspace");
  await expect(block(page, "crates-server")).toBeVisible();
  await expect.poll(() => selOf(page)).toBe("part:crates-server");
  await page.keyboard.press("Escape");
  await expect.poll(() => selOf(page)).toBeNull();
});

test("Clicks: one selects, the background clears, a drag on the background pans", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  await block(page, "crates-analysis").click();
  await expect.poll(() => selOf(page)).toBe("part:crates-analysis");
  await expect(panel(page).locator('[data-perf="part-panel"]')).toHaveAttribute("data-id", "crates-analysis");
  // A drag on the background pans, selecting nothing.
  const vp = (await viewport(page).boundingBox())!;
  const before = (await block(page, "crates-analysis").boundingBox())!;
  await page.mouse.move(vp.x + vp.width - 40, vp.y + vp.height - 120);
  await page.mouse.down();
  await page.mouse.move(vp.x + vp.width - 140, vp.y + vp.height - 160, { steps: 6 });
  await page.mouse.up();
  const after = (await block(page, "crates-analysis").boundingBox())!;
  expect(before.x - after.x).toBeGreaterThan(80);
  expect(selOf(page)).toBe("part:crates-analysis");
  // A click on the background clears it.
  await page.mouse.click(vp.x + vp.width - 40, vp.y + vp.height - 120);
  await expect.poll(() => selOf(page)).toBeNull();
});

test("The Group panel: a column folded by Fold to groups, its counts, neighbours and members", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  await page.locator('[data-perf="fold-to-groups"]').click();
  await page.locator('[data-perf="group-block"][data-id="column:changed"]').click();
  await expect.poll(() => selOf(page)).toBe("group:column:changed");
  const g = panel(page).locator('[data-perf="group-panel"]');
  await expect(g.locator("h2")).toHaveText("Changed");
  const changed = tops.filter((n: Json) => isCode(n) && (n.change !== "unchanged" || V2.nodes.some((m: Json) => m.id.startsWith(`${n.id}.`) && m.change !== "unchanged")));
  await expect(g.locator('[data-perf="group-counts"]')).toHaveText(`${changed.length} parts · ${changed.length} changed`);
  await expect(g.locator('[data-perf="group-member"]')).toHaveCount(changed.length);
  await expect(g.locator('[data-perf="group-neighbour"]').first()).toContainText("Unchanged");
  // A member is a pick.
  await g.locator('[data-perf="group-member"][data-id="crates-server"] button').click();
  await expect.poll(() => selOf(page)).toBe("part:crates-server");
});

test("Both themes: the canvas's lines, parts and frames take their tokens", async ({ context }) => {
  const page = await signIn(context);
  const colours = async () =>
    page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('[data-perf="block"][data-change="added"]')!;
      const l = document.querySelector<SVGPathElement>('[data-line-drawn] path')!;
      const c = document.querySelector<HTMLElement>('[data-perf="canvas"]')!;
      return [getComputedStyle(b).borderTopColor, getComputedStyle(b).backgroundColor, getComputedStyle(l).stroke, getComputedStyle(c).backgroundColor];
    });
  await page.emulateMedia({ colorScheme: "light" });
  await open(page);
  const light = await colours();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(colours).not.toEqual(light);
  const dark = await colours();
  for (let i = 0; i < light.length; i++) expect(dark[i], `colour ${i} follows the theme`).not.toBe(light[i]);
});
