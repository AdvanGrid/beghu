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

/** Opens the view at `search`, once the canvas has drawn. */
async function open(page: Page, search = ""): Promise<void> {
  await page.goto(VIEW + search);
  // A first open may wait on Vite compiling the view, or the server reading the analysis.
  await expect(viewport(page)).toHaveAttribute("data-drawn", /.+/, { timeout: 30_000 });
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
  await expect(block(page, "crates-server")).toContainText(`service · changeddouble-click ▸${server.name}${files.length} files · +${add} −${del}`);
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
  await open(page, "?boxes=inside-product");
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
  for (const k of kids) {
    // Inside a frame a part is named on its own; the frame's title says where it is.
    const b = item(page, k.id);
    await expect(b).toContainText(k.name);
    expect(await inside(b, frame)).toBe(true);
  }
  await expect(undoes(page)).toHaveText(`undoes: opened ${server.name}`);
  await settled(page);
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

test("The glide: contents grow out of the block and the lines come back once it lands; reduced motion snaps", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const glides = async () => Number((await viewport(page).getAttribute("data-glide")) ?? 0);
  const n = await glides();
  const at = (await block(page, "crates-server").boundingBox())!;
  await block(page, "crates-server").dblclick();
  await expect.poll(glides).toBe(n + 1);
  // Mid-glide the lines are away; the clicked block stays where it was.
  await expect(page.locator('[data-perf="canvas-lines"]')).toHaveAttribute("data-gliding", "");
  const now = (await item(page, "crates-server").boundingBox())!;
  expect(Math.abs(now.x - at.x)).toBeLessThan(2);
  expect(Math.abs(now.y - at.y)).toBeLessThan(2);
  await settled(page);
  // Every moving item stays mounted, in the order it was first drawn.
  const order = await page.locator("[data-item]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item));
  await page.locator('[data-perf="frame"][data-id="crates-server"] [data-perf="frame-title"]').click();
  await settled(page);
  const after = await page.locator("[data-item]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item));
  expect(after.slice(0, order.length)).toEqual(order);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await block(page, "crates-server").dblclick();
  await expect(page.locator('[data-perf="frame"][data-id="crates-server"]')).toBeVisible();
  await expect(page.locator('[data-perf="canvas-lines"]')).not.toHaveAttribute("data-gliding", "", { timeout: 200 });
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

test("A partly drawn part: marked folded, its frame says how many folders are drawn, and a rest block", async ({ context }) => {
  const page = await signIn(context);
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    g.analysis.nodes.find((x: Json) => x.id === "crates-fake-github").drawn = { partial: true, folders: 9 };
    await route.fulfill({ response: res, json: g });
  });
  await open(page);
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
  await open(page, "?lens=data");
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
