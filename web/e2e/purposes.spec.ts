// The purpose view (#183) in a real browser: the panel's walkthrough at the PR, a purpose, a
// sub-purpose, a part and a line, with its source chips (an issue's `#N` too) and "Stated, not
// found in code"; Rules it sets; conflict cards, opening a row, a shared cause's card and hovering
// one, and nothing left lit once the selection moves; the canvas's fold plan for the PR and a
// purpose (dots, "N of M parts serve it", the purpose's own lines strong in its colour, rest
// blocks, groups, Back and Start over over the plan, the same plan after a reload), within 16
// blocks on the 3× tiled analysis at the PR and every purpose; a line between two closed blocks
// whose parts that serve nothing meet, and a pick of one the fold drops; picks of parts the fold
// doesn't draw, and of a part inside a group the plan folds; Outside the diff,
// within the budget; Code view at a part and back; Show it under the fold; the unclaimed parts;
// the fallback; both themes' purpose colours and the panel's and canvas's tokens; and the
// server's claim stubs against the ones the cases are served with.
//
// tomsj's analysis of #191 is the recorded v2 (`./dev-ctl start` and `reset` upload it); v1 and
// the hand-written cases (fixtures/pr-view/cases/) are served as that graph on the way in
// (analyses.ts), since each account takes #191's first analysis once per reset. The 3× tile goes
// up for tomsj through `./dev-ctl analyse` (#9003, its own PR), once per stack.
//
// It runs after canvas.spec.ts in a project of its own (playwright.config.ts): it reads tomsj's
// analysis of #191 and uploads the 3× tile, which moves #9003 to the top of every tab's list.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { committed, serve, serveNewer, stub } from "./analyses";
import { devCtl } from "./stack";

type Json = Record<string, any>;
const V2 = committed("v2");
const VIEW = "/AdvanGrid/beghu/pull/191/view";

const viewport = (page: Page) => page.locator('[data-perf="canvas-viewport"]');
const panel = (page: Page) => page.locator('[data-perf="view-panel"]');
const selOf = (page: Page) => new URL(page.url()).searchParams.get("sel");
/** An ID as a CSS attribute value (a group's holds quotes). */
const attr = (id: string) => id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** A drawn item, not hidden. */
const item = (page: Page, id: string) => page.locator(`[data-item="${attr(id)}"]:not([hidden] *)`);
/** The drawn closed blocks under the fold: parts, groups, rest blocks and parts outside the diff. */
const closedBlocks = (page: Page) =>
  page.locator(':is([data-perf="block"], [data-perf="group-block"], [data-perf="rest"], [data-perf="outside-block"]):not([hidden] *):not([data-grid])');
const blockIds = async (page: Page) => (await closedBlocks(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item!))).sort();
const settled = (page: Page) => expect(page.locator('[data-perf="canvas-lines"]')).not.toHaveAttribute("data-gliding", "");
const tops = V2.purposes.filter((p: Json) => !p.parent);
const claimOf = (a: Json, id: string): Json => a.claims.find((c: Json) => c.id === id);
const nodeOf = (a: Json, id: string): Json => a.nodes.find((n: Json) => n.id === id);

async function signIn(context: BrowserContext, login = "tomsj"): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto(`/auth/login?login=${login}`);
  await page.waitForURL((u) => u.pathname === "/issues");
  return page;
}

/** Opens the view at `search`, once the canvas has drawn; with `fit`, the whole drawing in view. */
async function open(page: Page, search = "", opts: { fit?: boolean; view?: string } = {}): Promise<void> {
  await page.goto((opts.view ?? VIEW) + search);
  await expect(viewport(page)).toHaveAttribute("data-drawn", /.+/, { timeout: 30_000 });
  if (opts.fit) {
    const zoom = page.locator('[data-perf="zoom-level"]');
    const before = await zoom.textContent();
    await page.locator('[data-perf="zoom-fit"]').click();
    await expect.poll(() => zoom.textContent()).not.toBe(before);
  }
}

/** A point on the canvas's background (or an open column's or frame's own room): a click there. */
async function backgroundPoint(page: Page): Promise<{ x: number; y: number }> {
  const p = await viewport(page).evaluate((vp) => {
    const r = vp.getBoundingClientRect();
    for (let y = r.bottom - 30; y > r.top + 20; y -= 17)
      for (let x = r.right - 30; x > r.left + 20; x -= 23) {
        const at = document.elementFromPoint(x, y);
        if (!at || at.closest("[data-chrome]") || at.closest("[data-line],[data-trunk]")) continue;
        const it = at.closest<HTMLElement>("[data-item]");
        if (at === vp || at.parentElement === vp || (it && ["column", "frame"].includes(it.dataset.perf!) && !at.closest("[data-title]"))) return { x, y };
      }
    return null;
  });
  if (!p) throw new Error("no background in view");
  return p;
}

/** The computed colour of `prop` on `l`. */
const colourOf = (l: Locator, prop: "backgroundColor" | "stroke" | "color" | "borderTopColor") => l.evaluate((el, p) => getComputedStyle(el)[p as "stroke"], prop);
/** The drawn line between two blocks of one scope (its ID is its two ends, in order). */
const lineBetween = (page: Page, a: string, b: string) => viewport(page).locator(`[data-perf="canvas-line"][data-line="${attr(JSON.stringify([a, b].sort()))}"]`);
/** Every drawn line's analysis lines. */
const drawnMembers = (page: Page) => viewport(page).locator('[data-perf="canvas-line"]').evaluateAll((els) => els.flatMap((e) => (e as HTMLElement).dataset.members!.split(" ")));
/** Each drawn block and frame, with where it's drawn, in the drawing's order. */
const drawing = (page: Page) =>
  viewport(page)
    .locator("[data-item]:not([hidden] *)")
    .evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.item}@${(e as HTMLElement).style.getPropertyValue("--x")},${(e as HTMLElement).style.getPropertyValue("--y")}`));

/** "N of M parts serve(s) it/a purpose/no purpose", as a block's face says it. */
const serveWords = (n: number, total: number, verb: string) => `${n} of ${total} ${total === 1 ? "part" : "parts"} ${n === 1 ? verb.replace(/^serve/, "serves") : verb}`;

test("The PR's walkthrough: its top, the walk with its chips and Stated, not found in code, its purposes in order, the unclaimed parts, the reference folded", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  const p = panel(page);
  await expect(p.locator('[data-perf="walk-trail"]')).toHaveText(`#${V2.pr.number}`);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText(`The whole PR · ${tops.length} purposes`);
  await expect(p.locator('[data-perf="walk-title"]')).toHaveText(V2.pr.title);
  // One paragraph: intro, journey, destination; then the chips, one per kind of source.
  const text = p.locator('[data-perf="walk-text"]');
  await expect(text).toContainText(`${V2.walk.intro} ${V2.walk.journey} ${V2.walk.destination}`);
  const code = V2.walk.claims.flatMap((id: string) => claimOf(V2, id).evidence).filter((e: Json) => e.kind === "code").length;
  await expect(text.locator('[data-perf="source-chip"]')).toHaveText(["PR", `code ×${code}`]);
  // A claim behind it rests on the description alone.
  const stated = text.locator('[data-perf="stated"]');
  await expect(stated).toHaveText("Stated, not found in code");
  // Hidden, it takes no room.
  await expect(p.locator('[data-perf="stated-why"]')).toBeHidden();
  expect(await p.locator('[data-perf="stated-why"]').boundingBox()).toBeNull();
  await stated.hover();
  await expect(p.locator('[data-perf="stated-why"]')).toHaveText("The description or an issue says so; the analysis found no code that shows it.");
  // The PR chip opens each quote with the claim it backs; the code chip, the claims with their lines.
  await text.locator('[data-chip="description"]').click();
  const quoted = V2.walk.claims.map((id: string) => claimOf(V2, id)).find((c: Json) => c.evidence.some((e: Json) => e.kind === "description"));
  const quote = p.locator('[data-perf="source-box"][data-kind="description"] [data-perf="source-quote"]');
  await expect(quote).toHaveCount(1);
  await expect(quote).toContainText(`It backs: ${quoted.text}`);
  await text.locator('[data-chip="code"]').click();
  await expect(p.locator('[data-perf="source-box"][data-kind="description"]')).toHaveCount(0);
  await expect(p.locator('[data-perf="source-box"][data-kind="code"] [data-perf="source-claim"]')).toHaveCount(code);
  await expect(p.locator('[data-perf="source-box"][data-kind="code"] [data-perf="evidence"]').first()).toBeVisible();

  // Its purposes, in order, each with its dot: the colour each top-level purpose's blocks carry.
  const rows = p.locator('[data-perf="walk-next"] [data-perf="next-row"]');
  await expect(rows).toHaveCount(tops.length);
  for (let i = 0; i < tops.length; i++) {
    await expect(rows.nth(i)).toContainText(tops[i].name);
    await expect(rows.nth(i).locator('[data-perf="purpose-dot"]')).toHaveAttribute("data-colour", String(i));
    const dot = viewport(page).locator(`[data-perf="dot"][data-purpose="${tops[i].id}"]`).first();
    await expect(dot).toBeVisible();
    expect(await colourOf(dot, "backgroundColor")).toBe(await colourOf(rows.nth(i).locator('[data-perf="purpose-dot"]'), "backgroundColor"));
  }
  // Hovering a row lights that purpose's blocks; clicking stands on it.
  await rows.nth(1).hover();
  await expect(viewport(page).locator('[data-focus="lit"]').first()).toBeVisible();
  await rows.nth(1).click();
  await expect.poll(() => selOf(page)).toBe(tops[1].id);
  await page.goBack();
  await expect.poll(() => selOf(page)).toBeNull();

  await expect(page.locator('[data-perf="legend-row"][data-row="line:carried"]')).toContainText("Strong: a purpose's own lines");
  await expect(page.locator('[data-perf="legend-row"][data-row="line:faint"]')).toContainText("Faint: lines no purpose follows");
  await expect(p.locator('[data-perf="to-unclaimed"]')).toHaveText(`${V2.unclaimed.length} changed parts serve no purpose ›`);
  // v2 has no conflicts.
  await expect(p.locator('[data-perf="conflicts"]')).toHaveCount(0);
  // The reference, folded at the end: All changes, by kind.
  const ref = p.locator('[data-perf="walk-reference"] > details');
  await expect(ref.locator("> summary")).toHaveText("All changes, by kind");
  await expect(p.locator('[data-perf="rank-group"]')).toHaveCount(0);
  await ref.locator("> summary").click();
  await expect(p.locator('[data-perf="rank-group"]')).toHaveCount(4);
});

test("A purpose's fold: its blocks within 16, how much of each serves it, the dots, its lines strong in its colour, rest blocks, Back and Start over over the plan", async ({ context }) => {
  const page = await signIn(context);
  const at = tops[1];
  await open(page, `?sel=${at.id}`, { fit: true });
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveText(`All purposes › ${at.name}`);
  const p = panel(page);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText(`Purpose · ${at.kind}`);
  await expect(p.locator('[data-perf="walk-title"] [data-perf="purpose-dot"]')).toHaveAttribute("data-colour", "1");

  const plan = await blockIds(page);
  expect(plan.length).toBeLessThanOrEqual(16);
  // Every part block holds a member: its face says how many of its parts serve it.
  const parts = viewport(page).locator('[data-perf="block"]:not([hidden] *)');
  expect(await parts.count()).toBeGreaterThan(0);
  for (const b of await parts.all()) {
    const [n, total] = (await b.getAttribute("data-serve"))!.split("/").map(Number);
    expect(n).toBeGreaterThan(0);
    await expect(b).toContainText(serveWords(n!, total!, "serve it"));
    // The stood-on purpose's dot is the larger.
    await expect(b.locator(`[data-perf="dot"][data-purpose="${at.id}"]`)).toHaveAttribute("data-big", "");
  }
  // Rest blocks: muted and dashed, they can't be opened.
  const rest = viewport(page).locator('[data-perf="rest"]:not([hidden] *)').first();
  await expect(rest).toContainText(/\d+ other \w+don't serve it/);
  expect(await rest.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
  await rest.dispatchEvent("dblclick");
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
  // A rest block carries the dots of the purposes its parts serve: other purposes', never this one's.
  const restDots = await viewport(page).locator('[data-perf="rest"]:not([hidden] *)').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.dots ?? ""));
  expect(restDots.some((d) => d !== "")).toBe(true);
  for (const d of restDots) expect(d.split(" ")).not.toContain(at.id);

  // Its own lines strong in its colour, the rest faint; no line between two rest blocks.
  const carried = new Set(V2.purposes.filter((q: Json) => q.id === at.id || q.parent === at.id).flatMap((q: Json) => q.carries.map((c: Json) => c.edge)));
  const lines = await viewport(page).locator('[data-perf="canvas-line"]').evaluateAll((els) => els.map((e) => ({ id: (e as HTMLElement).dataset.line!, members: (e as HTMLElement).dataset.members!.split(" "), carried: (e as HTMLElement).dataset.carried! })));
  expect(lines.some((l) => l.carried === "strong")).toBe(true);
  for (const l of lines) expect(l.carried, l.id).toBe(l.members.some((m) => carried.has(m)) ? "strong" : "faint");
  const strong = lines.find((l) => l.carried === "strong")!;
  const stroke = await colourOf(page.locator(`[data-line-drawn="${attr(strong.id)}"] path`).first(), "stroke");
  expect(stroke).toBe(await colourOf(p.locator('[data-perf="walk-title"] [data-perf="purpose-dot"]'), "backgroundColor"));
  await expect(page.locator('[data-perf="legend-row"][data-row="line:carried"]')).toContainText("Strong, in its colour: the purpose's own lines");
  await expect(page.locator('[data-perf="legend-row"][data-row="dots"]')).toContainText("● Dots: the purposes it serves (the panel names them)");

  // Opens and folds lay over the plan: Back undoes one, Start over returns to the plan.
  await expect(page.locator('[data-perf="canvas-start-over"]')).toBeDisabled();
  const opens = viewport(page).locator('[data-perf="block"]:not([hidden] *)', { hasText: "double-click ▸" }).first();
  const opened = (await opens.getAttribute("data-item"))!;
  await opens.dblclick();
  await settled(page);
  await expect(item(page, opened)).toHaveAttribute("data-perf", "frame");
  await expect(page.locator('[data-perf="canvas-undoes"]')).toContainText("undoes: opened");
  await page.locator('[data-perf="canvas-back"]').click();
  await settled(page);
  expect(await blockIds(page)).toEqual(plan);
  await item(page, opened).dblclick();
  await settled(page);
  await page.locator('[data-perf="canvas-start-over"]').click();
  await settled(page);
  expect(await blockIds(page)).toEqual(plan);
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();

  // A click on the background goes back to the purpose, not to nothing.
  await parts.first().click();
  await expect.poll(() => selOf(page)).toMatch(/^part:/);
  expect(await blockIds(page)).toEqual(plan);
  const bg = await backgroundPoint(page);
  await page.mouse.click(bg.x, bg.y);
  await expect.poll(() => selOf(page)).toBe(at.id);

  // Standing on another purpose starts afresh: its own plan, no Back.
  await item(page, opened).dblclick();
  await settled(page);
  await expect(page.locator('[data-perf="canvas-back"]')).toBeEnabled();
  await p.locator('[data-perf="crumb"]').first().click();
  await expect.poll(() => selOf(page)).toBeNull();
  await page.locator('[data-perf="walk-next"] [data-perf="next-row"]').nth(2).click();
  await expect.poll(() => selOf(page)).toBe(tops[2].id);
  await settled(page);
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveText(`All purposes › ${tops[2].name}`);
  expect((await blockIds(page)).length).toBeLessThanOrEqual(16);
});

test("Code view at a part and back: layout A opened down to it, then the fold as it was", async ({ context }) => {
  const page = await signIn(context);
  const at = tops[1];
  await open(page, `?sel=${at.id}`, { fit: true });
  // An open of the reader's own, which the way back keeps.
  const opens = viewport(page).locator('[data-perf="block"]:not([hidden] *)', { hasText: "double-click ▸" }).first();
  const opened = (await opens.getAttribute("data-item"))!;
  await opens.dblclick();
  await settled(page);
  const before = await blockIds(page);
  // Picking a part keeps the canvas as it is.
  const leaf = viewport(page).locator('[data-perf="block"]:not([hidden] *)', { hasNotText: "double-click ▸" }).first();
  const id = (await leaf.getAttribute("data-item"))!;
  await leaf.click();
  await expect.poll(() => selOf(page)).toBe(`part:${id}`);
  expect(await blockIds(page)).toEqual(before);
  const go = page.locator('[data-perf="code-view-at"]');
  await expect(go).toHaveText(`Code view at ${nodeOf(V2, id).name} ›`);
  await go.click();
  await settled(page);
  // Layout A, opened down to the part, which is selected.
  const back = page.locator('[data-perf="back-to-fold"]');
  await expect(back).toHaveText(`← Back to ${at.name}`);
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveCount(0);
  await expect(item(page, id)).toHaveAttribute("data-selected", "");
  await expect(viewport(page).locator("[data-serve]")).toHaveCount(0);
  for (const a of V2.nodes.find((n: Json) => n.id === id).parent === "system" ? [] : [nodeOf(V2, id).parent]) await expect(item(page, a)).toHaveAttribute("data-perf", "frame");
  // Back to the fold, as it was: its open kept, the purpose stood on.
  await back.click();
  await settled(page);
  await expect.poll(() => selOf(page)).toBe(at.id);
  expect(await blockIds(page)).toEqual(before);
  await expect(item(page, opened)).toHaveAttribute("data-perf", "frame");
  await expect(page.locator('[data-perf="canvas-back"]')).toBeEnabled();

  // A double-click on a part with nothing inside goes to the code view too; picking the purpose returns.
  await viewport(page).locator(`[data-item="${attr(id)}"]`).dblclick();
  await settled(page);
  await expect(back).toBeVisible();
  await expect.poll(() => selOf(page)).toBe(`part:${id}`);
  // The part's panel names the purpose it serves: standing on it returns to its fold.
  await panel(page).locator(`[data-perf="in-purpose"][data-id="${at.id}"] button`).first().click();
  await expect.poll(() => selOf(page)).toBe(at.id);
  await settled(page);
  await expect(back).toHaveCount(0);
  expect(await blockIds(page)).toEqual(before);
});

test("A part's walkthrough: its purposes by top-level purpose, What it now does, Inside it, the reference folded", async ({ context }) => {
  const page = await signIn(context);
  const n = nodeOf(V2, "crates-server");
  await open(page, `?sel=part:${n.id}`);
  const p = panel(page);
  const served = tops.filter((t: Json) => V2.purposes.filter((q: Json) => q.id === t.id || q.parent === t.id).some((q: Json) => q.serves.some((s: Json) => s.node === n.id || s.node.startsWith(`${n.id}.`))));
  await expect(p.locator('[data-perf="walk-trail"]')).toHaveText(`#191 › ${n.name}`);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText(`Part · ${served.length} purposes`);
  await expect(p.locator('[data-perf="walk-text"]')).toContainText(`${n.walk.intro} ${n.walk.journey} ${n.walk.destination}`);
  await expect(p.locator('[data-perf="walk-built"]')).toHaveCount(0);
  // In this PR's purposes: one per top-level purpose, a dot and its name, its role through the part inside.
  const groups = p.locator('[data-perf="in-purpose"]');
  await expect(groups).toHaveCount(served.length);
  for (let i = 0; i < served.length; i++) {
    await expect(groups.nth(i)).toHaveAttribute("data-id", served[i].id);
    await expect(groups.nth(i).locator('[data-perf="purpose-dot"]')).toHaveAttribute("data-colour", String(tops.indexOf(served[i])));
    const role = served[i].serves.find((s: Json) => s.node.startsWith(`${n.id}.`));
    await expect(groups.nth(i).locator('[data-perf="role"]').first()).toContainText(`${role.role} (through ${nodeOf(V2, role.node).name})`);
  }
  // A row lit while hovered, then gone with its place: nothing stays lit.
  await groups.first().hover();
  await expect(viewport(page).locator('[data-focus="lit"]').first()).toBeVisible();
  await groups.first().locator("button").first().click();
  await expect.poll(() => selOf(page)).toBe(served[0].id);
  await page.mouse.move(4, 4);
  await expect(viewport(page).locator("[data-focus]")).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => selOf(page)).toBe(`part:${n.id}`);
  await expect(p.locator('[data-perf="now-does"]')).toContainText(n.changeSummary);
  const kids = V2.nodes.filter((x: Json) => x.parent === n.id);
  await expect(p.locator('[data-perf="walk-next"] h3')).toHaveText("Inside it");
  await expect(p.locator('[data-perf="walk-next"] [data-perf="next-row"]')).toHaveCount(kids.length);
  await expect(p.locator('[data-perf="walk-reference"] summary')).toHaveText("Questions, facets, files and evidence");
  await p.locator('[data-perf="walk-reference"] summary').click();
  await expect(p.locator('[data-perf="part-panel"]')).toBeVisible();

  // A part no written walk covers: one built from its one-liners, and said so.
  const built = V2.nodes.find((x: Json) => !x.walk && x.kind === "module" && x.change !== "unchanged");
  await p.locator('[data-perf="walk-next"] [data-perf="next-row"]').first().click();
  await expect.poll(() => selOf(page)).toBe(`part:${kids[0].id}`);
  if (!kids[0].walk) await expect(p.locator('[data-perf="walk-built"]')).toHaveText("No walkthrough was written for this; it's built from the code view's one-liners.");
  expect(built).toBeDefined();
  // A part no purpose passes through.
  const none = V2.nodes.find((x: Json) => x.parent === "system" && x.change === "unchanged" && x.kind === "library");
  await open(page, `?sel=part:${none.id}`);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText("Part · 0 purposes");
  await expect(p.locator('[data-perf="in-none"]')).toHaveText("None: the PR's purposes don't pass through it.");
});

test("A line's walkthrough: What flows, When, its purposes; a written walk with Needed by", async ({ context }) => {
  const page = await signIn(context);
  const at = tops[1];
  const e = V2.edges.find((x: Json) => x.id === at.carries[0].edge);
  await open(page, `?sel=line:${e.id}`);
  const p = panel(page);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText("Connection");
  await expect(p.locator('[data-perf="walk-built"]')).toBeVisible();
  await expect(p.locator('[data-perf="line-when"]')).toContainText("At run time");
  if (e.data) await expect(p.locator('[data-perf="line-flows"]')).toContainText(e.data.what);
  const carriers = V2.purposes.filter((q: Json) => q.carries.some((c: Json) => c.edge === e.id));
  await expect(p.locator(`[data-perf="in-purpose"][data-id="${at.id}"] [data-perf="role"]`)).toContainText(carriers.find((q: Json) => q.id === at.id).carries.find((c: Json) => c.edge === e.id).why);

  // v1's lines have written walks, and what needs them.
  const v1 = await serve(page, "v1");
  const w = v1.edges.find((x: Json) => x.walk && x.neededBy?.some((d: Json) => d.purpose));
  await open(page, `?sel=line:${w.id}`);
  await expect(p.locator('[data-perf="walk-text"]')).toContainText(`${w.walk.intro} ${w.walk.journey} ${w.walk.destination}`);
  await expect(p.locator('[data-perf="walk-built"]')).toHaveCount(0);
  const need = w.neededBy.find((d: Json) => d.purpose);
  await p.locator('[data-perf="line-needed"] button', { hasText: need.text }).click();
  await expect.poll(() => selOf(page)).toBe(need.purpose);
});

test("v1's walkthrough: How it's built, the journey's stops, a sub-purpose's trail and kind", async ({ context }) => {
  const page = await signIn(context);
  const v1 = await serve(page, "v1");
  const n = v1.nodes.find((x: Json) => x.built?.length && x.walk);
  await open(page, `?sel=part:${n.id}`);
  const p = panel(page);
  const rows = p.locator('[data-perf="built"] [data-perf="built-row"]');
  await expect(rows).toHaveCount(n.built.length);
  const label = { decision: "Decision", constraint: "Constraint", assumption: "Assumption" } as Record<string, string>;
  for (let i = 0; i < n.built.length; i++) await expect(rows.nth(i)).toHaveText(`${label[n.built[i].kind]}${n.built[i].text}`);

  const q = v1.purposes.find((x: Json) => !x.parent && x.stops.length);
  await open(page, `?sel=${q.id}`);
  await expect(p.locator('[data-perf="walk-next"] h3')).toHaveText("The journey");
  await expect(p.locator('[data-perf="walk-next"] [data-perf="next-row"]')).toHaveCount(q.stops.length);
  for (let i = 0; i < q.stops.length; i++) await expect(p.locator('[data-perf="walk-next"] [data-perf="next-row"]').nth(i)).toContainText(q.stops[i].line);

  const sub = v1.purposes.find((x: Json) => x.parent);
  const parent = v1.purposes.find((x: Json) => x.id === sub.parent);
  await open(page, `?sel=${sub.id}`);
  await expect(p.locator('[data-perf="walk-trail"]')).toHaveText(`#191 › ${parent.name} › ${sub.name}`);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText(`Sub-purpose · ${sub.kind}`);
  // A sub-purpose takes its parent's colour.
  const colour = String(v1.purposes.filter((x: Json) => !x.parent).indexOf(parent));
  await expect(p.locator('[data-perf="walk-title"] [data-perf="purpose-dot"]')).toHaveAttribute("data-colour", colour);
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveText(`All purposes › ${parent.name} › ${sub.name}`);
  // A part a sub-purpose serves lists it under its top-level purpose.
  const s = sub.serves[0];
  await open(page, `?sel=part:${s.node}`);
  await expect(p.locator(`[data-perf="in-purpose"][data-id="${parent.id}"] [data-perf="sub-role"][data-id="${sub.id}"]`)).toContainText(s.role);
});

test("Rules it sets, a broken rule's conflict, code outside the diff, and Outside the diff on the canvas", async ({ context }) => {
  const page = await signIn(context);
  // 37 more break sites than the card lists.
  const a = await serve(page, "conflict-purpose-outside", (x) => {
    for (const k of x.conflicts) for (const side of [k.a, k.b]) if (side.sites) side.sites.more = 37;
  });
  const sub = a.purposes.find((x: Json) => x.parent && x.rules?.some((r: Json) => r.checked.breaks > 0));
  const rule = sub.rules.find((r: Json) => r.checked.breaks > 0);
  const k = a.conflicts.find((c: Json) => c.rule === rule.id);
  await open(page, `?sel=${sub.id}`);
  const p = panel(page);
  const row = p.locator(`[data-perf="rule"][data-id="${rule.id}"]`);
  await expect(row).toContainText(`${rule.text} · ${rule.scope}`);
  const c = rule.checked;
  await expect(row.locator('[data-perf="rule-result"]')).toHaveText(`Checked ${c.found} sites: ${c.holds} hold, ${c.breaks} break ›${c.undetermined ? ` · ${c.undetermined} not determined` : ""}`);
  await expect(row.locator('[data-perf="rule-searched"]')).toHaveCount(0);
  await row.locator('[data-perf="rule-how"] summary').click();
  await expect(row.locator('[data-perf="rule-searched"]')).toHaveText(c.searched);
  // A rule that holds gets its row too.
  const parent = a.purposes.find((x: Json) => x.id === sub.parent);
  const held = parent.rules.find((r: Json) => r.checked.breaks === 0 && r.checked.holds === r.checked.found);
  // Outside the diff: the part the conflict reaches that no purpose names, in a column of its own,
  // its title whole, right of the others.
  const outside = k.touches.nodes.filter((n: Json) => !a.purposes.some((q: Json) => q.serves.some((s: Json) => s.node === n)));
  expect(outside.length).toBeGreaterThan(0);
  const column = item(page, "column:conflict");
  await expect(column).toHaveAttribute("data-perf", "outside-frame");
  const title = column.locator('[data-perf="frame-title"]').first();
  await expect(title).toHaveText("▾ Outside the diff: only through a conflict");
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
  const right = async (id: string) => (await item(page, id).boundingBox())!;
  for (const c of ["column:changed", "column:unchanged"]) if (await item(page, c).count()) expect((await right(c)).x + (await right(c)).width).toBeLessThan((await right("column:conflict")).x);
  for (const n of outside) {
    const b = item(page, `fold-out:${n}`);
    await expect(b).toContainText(`unchanged · ⚠ ${k.question}`);
    expect(await b.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
  }
  // The broken rule links its conflict.
  await row.locator('[data-perf="rule-breaks"]').click();
  await expect.poll(() => selOf(page)).toBe(k.id);
  const card = p.locator('[data-perf="conflict-card"]');
  await expect(card.locator('[data-perf="conflict-question"]')).toHaveText(k.question);
  await expect(card.locator('[data-perf="conflict-kind"]')).toHaveText("purpose vs code outside the diff");
  const outsideSide = k.a.who === "outside" ? k.a : k.b;
  const purposeSide = k.a.who === "purpose" ? k.a : k.b;
  await expect(card.locator('[data-perf="conflict-who"]')).toHaveText([k.a, k.b].map((s: Json) => (s.who === "purpose" ? sub.name : "Code outside the diff")));
  await expect(card.locator('[data-perf="conflict-says"]')).toHaveText([k.a.says, k.b.says]);
  // Opening the outside row: the fact, its first sites with their evidence, how many more, the search.
  await card.locator('[data-perf="conflict-side"][data-who="outside"] [data-perf="conflict-row"]').click();
  const detail = card.locator('[data-perf="conflict-side"][data-who="outside"] [data-perf="conflict-detail"]');
  await expect(detail.locator('[data-perf="conflict-text"]')).toHaveText(outsideSide.text);
  if (outsideSide.sites) {
    await expect(detail.locator('[data-perf="conflict-sites"] [data-perf="claim"]')).toHaveCount(outsideSide.sites.claims.length);
    // The header counts every site, not just those listed.
    await expect(detail.locator('[data-perf="conflict-sites-count"]')).toHaveText(`${outsideSide.sites.claims.length + 37} sites where it breaks: the first ${outsideSide.sites.claims.length}`);
    if (outsideSide.sites.more) await expect(detail.locator('[data-perf="conflict-more"]')).toHaveText(`and ${outsideSide.sites.more} more`);
    await expect(detail.locator('[data-perf="conflict-search"]')).toHaveText(`Found by: ${c.searched}`);
  }
  // The purpose's row goes to the purpose.
  await card.locator('[data-perf="conflict-side"][data-who="purpose"] [data-perf="conflict-row"]').click();
  await expect(card.locator('[data-perf="conflict-side"][data-who="purpose"] [data-perf="conflict-text"]')).toHaveText(purposeSide.text);
  await card.locator('[data-perf="go-to-purpose"]').click();
  await expect.poll(() => selOf(page)).toBe(sub.id);
  await p.locator('[data-perf="walk-trail"] [data-perf="crumb"]', { hasText: parent.name }).click();
  await expect(p.locator(`[data-perf="rule"][data-id="${held.id}"] [data-perf="rule-result"]`)).toHaveText(`Checked ${held.checked.found} sites: all hold`);
  // At the PR too, the conflict and its outside part.
  await open(page);
  await expect(p.locator('[data-perf="conflicts"] h3')).toHaveText("Conflicts (1)");
  await expect(item(page, `fold-out:${outside[0]}`)).toBeVisible();
});

test("A shared cause's card comes first, its questions each with two rows; a stated row opens to its quote; hovering a card lights what it touches", async ({ context }) => {
  const page = await signIn(context);
  const a = await serve(page, "shared-cause");
  await open(page, "", { fit: true });
  const p = panel(page);
  await expect(p.locator('[data-perf="conflicts"] h3')).toHaveText(`Conflicts (${a.conflicts.length})`);
  const card = p.locator('[data-perf="conflicts"] article').first();
  await expect(card).toHaveAttribute("data-perf", "cause-card");
  await expect(card.locator('[data-perf="cause"]')).toContainText(a.causes[0].text);
  await expect(card.locator('[data-perf="conflict-question"]')).toHaveText(a.conflicts.map((c: Json) => c.question));
  await expect(card.locator('[data-perf="conflict-kind"]')).toHaveText(a.conflicts.map(() => "stated vs code"));
  const issueSide = a.conflicts.flatMap((c: Json) => [c.a, c.b]).find((s: Json) => s.who === "issue");
  const ev = claimOf(a, issueSide.claims[0]).evidence.find((e: Json) => e.kind === "issue");
  const who = await card.locator('[data-perf="conflict-who"]').allTextContents();
  expect(who).toContain(`#${ev.number}`);
  expect(who).toContain("PR description");
  expect(who).toContain("The code");
  // The issue's row: the whole fact, and the quote.
  await card.locator('[data-perf="conflict-side"][data-who="issue"] [data-perf="conflict-row"]').click();
  const d = card.locator('[data-perf="conflict-side"][data-who="issue"] [data-perf="conflict-detail"]');
  await expect(d.locator('[data-perf="conflict-text"]')).toHaveText(issueSide.text);
  await expect(d.locator('[data-perf="source-quote"]')).toContainText(ev.quote.trim().slice(0, 30));
  // Hovering it lights what it touches on the canvas, and dims the rest.
  await card.hover();
  const touched = a.conflicts.flatMap((c: Json) => c.touches.nodes);
  await expect(viewport(page).locator('[data-focus="lit"]').first()).toBeVisible();
  const lit = await viewport(page).locator('[data-focus="lit"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id!));
  expect(touched.some((n: string) => lit.some((l) => n === l || n.startsWith(`${l}.`)))).toBe(true);
  await expect(viewport(page).locator('[data-focus="dim"]').first()).toBeVisible();
  // At a part it touches, the conflict shows there too.
  const k = a.conflicts[0];
  await open(page, `?sel=part:${k.touches.nodes[0]}`);
  await expect(p.locator('[data-perf="conflicts"] [data-perf="conflict"]')).toHaveCount(a.conflicts.filter((c: Json) => c.touches.nodes.some((n: string) => n === k.touches.nodes[0] || n.startsWith(`${k.touches.nodes[0]}.`) || k.touches.nodes[0].startsWith(`${n}.`))).length);
});

test("Purpose vs purpose: both rows name a purpose with its dot", async ({ context }) => {
  const page = await signIn(context);
  const a = await serve(page, "conflict-purpose-purpose");
  const k = a.conflicts.find((c: Json) => c.kind === "purpose-purpose");
  await open(page);
  const card = panel(page).locator(`[data-perf="conflict-card"][data-id="${k.id}"]`);
  await expect(card.locator('[data-perf="conflict-kind"]')).toHaveText("purpose vs purpose");
  const name = (id: string) => a.purposes.find((q: Json) => q.id === id).name;
  await expect(card.locator('[data-perf="conflict-who"]')).toHaveText([name(k.a.purpose), name(k.b.purpose)]);
  await expect(card.locator('[data-perf="conflict-who"] [data-perf="purpose-dot"]')).toHaveCount(2);
});

test("A line between two closed blocks that serve the place is drawn, though only parts inside them that serve nothing meet", async ({ context }) => {
  const page = await signIn(context);
  // A purpose served by one part inside each of two top-level parts; the lines between those two
  // run only between their other parts.
  const [P, Q] = ["crates-control-db", "crates-server"];
  const members = [`${P}.migrations`, `${Q}.tests`];
  const q = tops[0];
  await serve(page, "v2", (a) => {
    a.purposes = [{ ...a.purposes.find((x: Json) => x.id === q.id), serves: members.map((node) => ({ node, role: "e2e", claims: [] })), carries: [], stops: [], rules: [] }];
    a.conflicts = [];
    a.causes = [];
  });
  const inside = (id: string, top: string) => id.startsWith(`${top}.`);
  const across = V2.edges.filter((e: Json) => [e.from, e.to].some((x) => inside(x, P)) && [e.from, e.to].some((x) => inside(x, Q))).map((e: Json) => e.id as string);
  expect(across.length).toBeGreaterThan(0);
  expect(V2.edges.filter((e: Json) => across.includes(e.id)).some((e: Json) => members.includes(e.from) || members.includes(e.to))).toBe(false);
  await open(page, `?sel=${q.id}`, { fit: true });
  // The plan opens both: those lines run between their rest blocks, and are dropped.
  await expect(item(page, P)).toHaveAttribute("data-perf", "frame");
  await expect(item(page, Q)).toHaveAttribute("data-perf", "frame");
  expect((await drawnMembers(page)).filter((x) => across.includes(x))).toEqual([]);
  // P folded: from it to Q's rest block.
  await item(page, P).locator('[data-perf="frame-title"]').first().click();
  await settled(page);
  await expect(item(page, P)).toHaveAttribute("data-perf", "block");
  expect([...new Set((await drawnMembers(page)).filter((x) => across.includes(x)))].sort()).toEqual([...across].sort());
  // Both folded: between the two blocks.
  await item(page, Q).locator('[data-perf="frame-title"]').first().click();
  await settled(page);
  await expect(lineBetween(page, P, Q)).toHaveCount(1);
  expect((await lineBetween(page, P, Q).getAttribute("data-members"))!.split(" ").sort()).toEqual([...across].sort());

  // A pick of one of those lines, which the PR's fold (the same members, so the same plan) drops:
  // the fold opens down to both its ends, each pulled out of its rest block, and draws it; one
  // Back step.
  const e = V2.edges.find((x: Json) => x.id === across[0]);
  await open(page, `?sel=line:${encodeURIComponent(e.id)}`, { fit: true });
  await settled(page);
  await expect(page.locator('[data-perf="canvas-undoes"]')).toContainText("undoes: opened down to");
  for (const end of [e.from, e.to]) await expect(item(page, end)).toHaveAttribute("data-perf", /^(block|frame)$/);
  expect(await drawnMembers(page)).toContain(e.id);
  await page.locator('[data-perf="canvas-back"]').click();
  await settled(page);
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
  for (const end of [e.from, e.to]) await expect(item(page, end)).toHaveCount(0);
  expect(await drawnMembers(page)).not.toContain(e.id);
});

test("A pick of a part the fold draws only inside a rest block or a closed block opens the fold down to it; one it can't draw goes to the code view", async ({ context }) => {
  const page = await signIn(context);
  // A cold link to a part in the PR's fold's rest block: pulled out of it, a block of its own, one Back step.
  const none = V2.nodes.find((x: Json) => x.parent === "system" && x.change === "unchanged" && x.kind === "library");
  await open(page, `?sel=part:${none.id}`);
  await settled(page);
  await expect(item(page, none.id)).toHaveAttribute("data-perf", "block");
  await expect(item(page, none.id)).toHaveAttribute("data-selected", "");
  await expect(page.locator('[data-perf="canvas-undoes"]')).toContainText(`undoes: opened down to ${none.name}`);
  await page.locator('[data-perf="canvas-back"]').click();
  await settled(page);
  await expect(item(page, none.id)).toHaveCount(0);

  // The next level: a part the fold leaves inside a block it draws.
  await open(page);
  await settled(page);
  const drawn = new Set(await viewport(page).locator("[data-item]:not([hidden] *)").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item!)));
  const picked = V2.nodes.find((x: Json) => x.parent !== "system" && drawn.has(x.parent) && !drawn.has(x.id));
  expect(picked).toBeDefined();
  await open(page, `?sel=part:${picked.parent}`);
  await settled(page);
  await expect(item(page, picked.id)).toHaveCount(0);
  const kids = V2.nodes.filter((x: Json) => x.parent === picked.parent);
  await panel(page).locator('[data-perf="walk-next"] [data-perf="next-row"]').nth(kids.indexOf(picked)).click();
  await expect.poll(() => selOf(page)).toBe(`part:${picked.id}`);
  await settled(page);
  await expect(item(page, picked.id)).toHaveAttribute("data-selected", "");
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveText("All purposes");
});

test("Outside the diff stays within the budget: 29 parts only a conflict reaches, its first ones, then and N more, which a pick can't open", async ({ context }) => {
  const page = await signIn(context);
  // 28 more parts like `bench` that the conflict touches, ahead of the case's two.
  const a = await serve(page, "conflict-purpose-outside", (x) => {
    const bench = x.nodes.find((nd: Json) => nd.id === "bench");
    const clones = Array.from({ length: 28 }, (_, i) => ({ ...bench, id: `bench-${i + 2}`, name: `bench ${i + 2}` }));
    x.nodes.push(...clones);
    const k = x.conflicts[0];
    k.touches.nodes = [...clones.map((c) => c.id), ...k.touches.nodes];
  });
  // Those no purpose names: the 28, and `bench`.
  const outside = (a.conflicts[0].touches.nodes as string[]).filter((n) => !a.purposes.some((q: Json) => q.serves.some((s: Json) => s.node === n)));
  expect(outside).toHaveLength(29);
  for (const at of ["", `?sel=${a.conflicts[0].touches.purposes[0]}`]) {
    await open(page, at, { fit: true });
    expect((await blockIds(page)).length, at).toBeLessThanOrEqual(16);
    const shown = await viewport(page).locator('[data-perf="outside-block"]:not([hidden] *)').count();
    expect(shown).toBeGreaterThan(0);
    const more = item(page, "fold-out-more");
    await expect(more.locator('[data-perf="face-name"]')).toHaveText(`and ${outside.length - shown} more`);
    await expect(more).toHaveAttribute("data-perf", "rest");
    // In reading order: the first ones each a block.
    for (const id of outside.slice(0, shown)) await expect(item(page, `fold-out:${id}`)).toHaveCount(1);
  }
  // `bench`, last, is in "and N more": a pick of it goes to the code view at it (a part with no
  // lines, in the grid layout A shows when asked).
  const cut = outside.at(-1)!;
  expect(cut).toBe("bench");
  await open(page, `?sel=part:${cut}`);
  await settled(page);
  await expect(page.locator('[data-perf="back-to-fold"]')).toBeVisible();
  await expect(viewport(page).locator("[data-serve]")).toHaveCount(0);
  await page.locator('[data-perf="show-lonely"]').click();
  await expect(item(page, cut)).toHaveAttribute("data-selected", "");
});

test("Show it under the fold: the newer analysis's plan for the place, the reader's own opens and pulled-out parts kept, a fresh Back history", async ({ context }) => {
  const page = await signIn(context);
  const v1 = await serveNewer(page, "v1");
  const at = "purpose:analysis-run";
  const q1 = v1.purposes.find((x: Json) => x.id === at);
  await open(page, `?sel=${at}`, { fit: true });
  const pill = page.locator('[data-perf="newer"]');
  await expect(pill).toHaveText(/A newer analysis is ready\s*Show it/);
  // An open of the reader's own, of a part v1's purpose has members inside.
  const members1 = V2.purposes.filter((x: Json) => x.id === at || x.parent === at).flatMap((x: Json) => x.serves.map((s: Json) => s.node)) as string[];
  const v1members = v1.purposes.filter((x: Json) => x.id === at || x.parent === at).flatMap((x: Json) => x.serves.map((s: Json) => s.node)) as string[];
  const holds = (id: string, ms: string[]) => ms.some((m) => m !== id && m.startsWith(`${id}.`));
  const candidates = await viewport(page).locator('[data-perf="block"]:not([hidden] *)', { hasText: "double-click ▸" }).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item!));
  const opened = candidates.find((id) => holds(id, members1) && holds(id, v1members));
  expect(opened).toBeDefined();
  await item(page, opened!).dblclick();
  await settled(page);
  await expect(item(page, opened!)).toHaveAttribute("data-perf", "frame");
  await expect(page.locator('[data-perf="canvas-back"]')).toBeEnabled();

  await pill.getByRole("button", { name: "Show it" }).click();
  await expect(page.locator('[data-perf="view-body"]')).toHaveAttribute("data-analysis", "e2e-newer-v1");
  await settled(page);
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveText(`All purposes › ${q1.name}`);
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
  await expect(item(page, opened!)).toHaveAttribute("data-perf", "frame");
  // Every block is v1's, each holding a member of v1's purpose.
  for (const b of await viewport(page).locator('[data-perf="block"]:not([hidden] *)').all()) {
    const id = (await b.getAttribute("data-item"))!;
    expect(v1.nodes.some((x: Json) => x.id === id), id).toBe(true);
    expect(Number((await b.getAttribute("data-serve"))!.split("/")[0]), id).toBeGreaterThan(0);
  }
  // Start over: v1's plan, within 16, with nothing of the reader's.
  await page.locator('[data-perf="canvas-start-over"]').click();
  await settled(page);
  await expect(page.locator('[data-perf="canvas-start-over"]')).toBeDisabled();
  expect((await blockIds(page)).length).toBeLessThanOrEqual(16);

  // From a part a cold link pulled out of the PR's fold's rest block (one that serves nothing in
  // either analysis): still a block of its own, and still the selection, on v1's plan.
  const tab = await signIn(context);
  const newer = await serveNewer(tab, "v1");
  const servers = (a: Json) => a.purposes.flatMap((x: Json) => x.serves.map((s: Json) => s.node as string)) as string[];
  const none = V2.nodes.find((x: Json) => x.parent === "system" && x.change === "unchanged" && x.kind === "library");
  expect(newer.nodes.some((x: Json) => x.id === none.id)).toBe(true);
  expect([...servers(V2), ...servers(newer)].some((n) => n === none.id || n.startsWith(`${none.id}.`))).toBe(false);
  await open(tab, `?sel=part:${none.id}`);
  await settled(tab);
  await expect(item(tab, none.id)).toHaveAttribute("data-perf", "block");
  await expect(tab.locator('[data-perf="canvas-undoes"]')).toContainText(`undoes: opened down to ${none.name}`);
  await tab.locator('[data-perf="newer"]').getByRole("button", { name: "Show it" }).click();
  await expect(tab.locator('[data-perf="view-body"]')).toHaveAttribute("data-analysis", "e2e-newer-v1");
  await settled(tab);
  await expect(tab.locator('[data-perf="canvas-back"]')).toBeDisabled();
  await expect(item(tab, none.id)).toHaveAttribute("data-perf", "block");
  await expect(item(tab, none.id)).toHaveAttribute("data-selected", "");
});

test("Show it onto an analysis with no backed purpose: the canvas goes to layout A", async ({ context }) => {
  const page = await signIn(context);
  await serveNewer(page, "unbacked");
  await open(page, "", { fit: true });
  await expect(page.locator('[data-perf="fold-bar"]')).toBeVisible();
  await expect(viewport(page).locator("[data-serve]").first()).toBeVisible();
  await page.locator('[data-perf="newer"]').getByRole("button", { name: "Show it" }).click();
  await expect(page.locator('[data-perf="view-body"]')).toHaveAttribute("data-analysis", "e2e-newer-unbacked");
  await settled(page);
  await expect(page.locator('[data-perf="fold-bar"]')).toHaveCount(0);
  await expect(viewport(page).locator("[data-serve]")).toHaveCount(0);
  await expect(viewport(page).locator("[data-fold]")).toHaveCount(0);
  await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
  await expect(panel(page).locator('[data-perf="unbacked"]')).toBeVisible();
});

test("A walk whose claims quote an issue: its #N chip, which opens the quotes", async ({ context }) => {
  const page = await signIn(context);
  const v1 = await serve(page, "v1");
  const n = v1.nodes.find((x: Json) => x.id === "top-level-files");
  await open(page, `?sel=part:${n.id}`);
  const text = panel(page).locator('[data-perf="walk-text"]');
  const ev = n.walk.claims.flatMap((id: string) => claimOf(v1, id).evidence) as Json[];
  const issues = ev.filter((e) => e.kind === "issue");
  expect(issues.length).toBeGreaterThan(0);
  const code = ev.filter((e) => e.kind === "code").length;
  await expect(text.locator('[data-perf="source-chip"]')).toHaveText([`#${issues[0].number}`, `code ×${code}`]);
  await text.locator(`[data-chip="issue:${issues[0].repo}#${issues[0].number}"]`).click();
  const quote = panel(page).locator('[data-perf="source-box"][data-kind="issue"] [data-perf="source-quote"]');
  await expect(quote).toHaveCount(issues.length);
  await expect(quote.first()).toContainText(issues[0].quote.trim().slice(0, 30));
});

test("The plan is made the same way every time: after a reload, the same blocks in the same order and places", async ({ context }) => {
  const page = await signIn(context);
  for (const at of ["", `?sel=${tops[1].id}`]) {
    await open(page, at);
    await settled(page);
    const before = await drawing(page);
    expect(before.length).toBeGreaterThan(0);
    await page.reload();
    await expect(viewport(page)).toHaveAttribute("data-drawn", /.+/, { timeout: 30_000 });
    await settled(page);
    expect(await drawing(page), at).toEqual(before);
  }
});

test("The claim stubs the cases are served with are the server's own: v2's graph against stub over v2's claims", async ({ context }) => {
  const page = await signIn(context);
  // analyses.ts's `stub` repeats the server's split (crates/server/src/analyses/stored.rs): the
  // stack's graph of the recorded v2 holds it to the server's answer.
  const g = (await (await page.request.get("/api/AdvanGrid/beghu/pulls/191/analysis")).json()) as Json;
  expect(g.analysis.claims).toEqual(V2.claims.map(stub));
});

test.describe("the 3× tiled analysis", () => {
  const TILE = "/AdvanGrid/beghu/pull/9003/view";
  /** tomsj's analysis of #9003, uploaded once per stack. */
  const upload = async (page: Page) => {
    if ((await page.request.get("/api/AdvanGrid/beghu/pulls/9003/analysis")).status() !== 200) devCtl(["analyse", "AdvanGrid/beghu#9003", "--version", "tiled-3x", "--as", "tomsj"]);
  };

  test("The fold plan stays within 16 blocks, at the PR and at each purpose; groups fold siblings of one kind, with a breakdown", async ({ context }) => {
    test.setTimeout(120_000);
    const page = await signIn(context);
    await upload(page);
    await open(page, "", { view: TILE, fit: true });
    expect((await blockIds(page)).length).toBeLessThanOrEqual(16);
    const groups = viewport(page).locator('[data-perf="group-block"]:not([hidden] *)');
    expect(await groups.count()).toBeGreaterThan(0);
    const g = groups.first();
    await expect(g.locator('[data-perf="face-name"]')).toHaveText(/^(\S+ in )?\d+ (services|apps|libraries|modules|stores|outside systems|people)$/);
    // How much of it serves the place under its name, never on the top line its dots may cut short.
    await expect(g.locator('[data-perf="face-bottom"]')).toHaveText(/^\d+ of \d+ parts serve a purpose$/);
    await expect(g.locator('[data-perf="face-top"]')).toHaveText(/^\S+ \d+( · \S+ \d+)*$/);
    // A group is a group: its panel lists its parts.
    const gid = (await g.getAttribute("data-item"))!;
    await g.click();
    await expect.poll(() => selOf(page)).toBe(`group:${gid}`);
    await expect(panel(page).locator('[data-perf="group-member"]').first()).toBeVisible();
    // It opens in place into a frame of its parts; Back folds it.
    await g.dblclick();
    await settled(page);
    await expect(item(page, gid)).toHaveAttribute("data-perf", "frame");
    await page.locator('[data-perf="canvas-back"]').click();
    await settled(page);
    await expect(item(page, gid)).toHaveAttribute("data-perf", "group-block");
    // Fold to groups keeps the dots and how much each block serves; Start over returns to the plan.
    const plan = await blockIds(page);
    await page.locator('[data-perf="fold-to-groups"]').click();
    await settled(page);
    const col = item(page, "column:changed");
    await expect(col).toContainText(/\d+ of \d+ parts serve a purpose/);
    await expect(col.locator('[data-perf="dot"]').first()).toBeVisible();
    await page.locator('[data-perf="canvas-start-over"]').click();
    await settled(page);
    expect(await blockIds(page)).toEqual(plan);

    // Every top-level purpose's own fold, within 16 too.
    const tile = (await (await page.request.get("/api/AdvanGrid/beghu/pulls/9003/analysis")).json()) as Json;
    for (const q of tile.analysis.purposes.filter((x: Json) => !x.parent)) {
      await open(page, `?sel=${q.id}`, { view: TILE });
      expect((await blockIds(page)).length, q.id).toBeLessThanOrEqual(16);
    }
  });

  test("A pick of a part inside a group the plan folds unfolds the group, down to it: one Back step", async ({ context }) => {
    test.setTimeout(120_000);
    const page = await signIn(context);
    await upload(page);
    await open(page, "", { view: TILE, fit: true });
    const g = viewport(page).locator('[data-perf="group-block"]:not([hidden] *)').first();
    const gid = (await g.getAttribute("data-item"))!;
    await g.click();
    await expect.poll(() => selOf(page)).toBe(`group:${gid}`);
    const member = panel(page).locator('[data-perf="group-member"]').first();
    const id = (await member.getAttribute("data-id"))!;
    await expect(item(page, id)).toHaveCount(0);
    // Picked from the group's panel: the group opens into a frame of its parts, the part selected in it.
    await member.locator("button").click();
    await expect.poll(() => selOf(page)).toBe(`part:${id}`);
    await settled(page);
    await expect(item(page, gid)).toHaveAttribute("data-perf", "frame");
    await expect(item(page, id)).toHaveAttribute("data-selected", "");
    await expect(page.locator('[data-perf="canvas-undoes"]')).toContainText("undoes: opened down to");
    await page.locator('[data-perf="canvas-back"]').click();
    await settled(page);
    await expect(item(page, gid)).toHaveAttribute("data-perf", "group-block");
    await expect(page.locator('[data-perf="canvas-back"]')).toBeDisabled();
  });
});

test("The unclaimed parts: a history step, each with its reason, the canvas folded to them", async ({ context }) => {
  const page = await signIn(context);
  await open(page);
  await panel(page).locator('[data-perf="to-unclaimed"]').click();
  await expect.poll(() => selOf(page)).toBe("unclaimed");
  const p = panel(page);
  await expect(p.locator('[data-perf="walk-title"]')).toHaveText(`${V2.unclaimed.length} changed parts serve no purpose`);
  const rows = p.locator('[data-perf="unclaimed-row"]');
  await expect(rows).toHaveCount(V2.unclaimed.length);
  for (let i = 0; i < V2.unclaimed.length; i++) await expect(rows.nth(i).locator('[data-perf="unclaimed-reason"]')).toHaveText(V2.unclaimed[i].reason);
  await expect(page.locator('[data-perf="fold-trail"]')).toHaveText(`All purposes › ${V2.unclaimed.length} changed parts serve no purpose`);
  await settled(page);
  // The canvas folds to them: each block holds one, and its card gives the reason.
  const b = viewport(page).locator('[data-perf="block"]:not([hidden] *)').first();
  await expect(b).toContainText(/\d+ of \d+ parts? serves? no purpose/);
  const id = (await b.getAttribute("data-item"))!;
  await b.hover();
  const reasons = V2.unclaimed.filter((u: Json) => u.node === id || u.node.startsWith(`${id}.`));
  await expect(page.locator('[data-perf="hover-card"] [data-perf="card-reason"]').first()).toContainText(reasons[0].reason);
  // Back: the PR again.
  await page.goBack();
  await expect.poll(() => selOf(page)).toBeNull();
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText(`The whole PR · ${tops.length} purposes`);
});

test("The fallback: unbacked leads the PR's panel with All changes unfolded, and the canvas starts in layout A", async ({ context }) => {
  const page = await signIn(context);
  // With a conflict, so the order shows it.
  const a = await serve(page, "unbacked", (x) => {
    const at = x.nodes.find((n: Json) => n.kind !== "system").id;
    x.conflicts = [
      {
        id: "conflict:e2e-fallback",
        kind: "stated-code",
        question: "Does the PR ship its analysis?",
        a: { who: "description", says: "yes", text: "The description says the PR ships it.", claims: [] },
        b: { who: "code", says: "no", text: "No code in the diff ships it.", claims: [] },
        touches: { nodes: [at], edges: [], purposes: [] },
      },
    ];
  });
  await open(page);
  const p = panel(page);
  await expect(p.locator('[data-perf="walk-kind"]')).toHaveText("The whole PR · no purposes");
  // In order: the sentence (no walk), All changes unfolded, Conflicts, then the rest of the reference.
  await expect(p.locator('[data-perf="unbacked"]')).toHaveText(a.unbacked);
  await expect(p.locator('[data-perf="walk-text"]')).toHaveCount(0);
  const order = await p.locator('[data-perf="walk-pr"] > :is([data-perf="unbacked"], [data-perf="walk-reference"], [data-perf="conflicts"])').evaluateAll((els) =>
    els.map((e) => ((e as HTMLElement).dataset.perf === "walk-reference" ? e.querySelector("summary")!.textContent : (e as HTMLElement).dataset.perf)),
  );
  expect(order).toEqual(["unbacked", "All changes, by kind", "conflicts", "The PR, coverage and the facets found"]);
  await expect(p.locator('[data-perf="conflicts"] h3')).toHaveText(`Conflicts (${a.conflicts.length})`);
  const refs = p.locator('[data-perf="walk-reference"] > details');
  await expect(refs.first()).toHaveAttribute("open", "");
  await expect(refs.nth(1)).not.toHaveAttribute("open", "");
  await expect(p.locator('[data-perf="rank-group"]')).toHaveCount(4);
  await expect(p.locator('[data-perf="walk-next"]')).toHaveCount(0);
  // Layout A: no fold bar and its hint, its parts with no lines (this case's lines are all build
  // lines) in the grid it shows when asked, none saying how much of it serves a purpose.
  await expect(page.locator('[data-perf="fold-bar"]')).toHaveCount(0);
  await expect(page.locator('[data-perf="canvas-undoes"]')).toHaveText("Opens and folds you make can be undone here");
  await page.locator('[data-perf="show-lonely"]').click();
  await expect(viewport(page).locator('[data-perf="block"]:not([hidden] *)').first()).toBeVisible();
  await expect(viewport(page).locator("[data-serve]")).toHaveCount(0);
  await expect(viewport(page).locator("[data-fold]")).toHaveCount(0);
});

test("Both themes: the purpose colours, the walk, conflict cards and rest blocks take their tokens' light and dark halves", async ({ context }) => {
  const page = await signIn(context);
  const tokens = readFileSync(fileURLToPath(new URL("../src/tokens.stylex.ts", import.meta.url)), "utf8");
  /** A token's light and dark halves, from its group (`colors`, `graph`) in tokens.stylex.ts. */
  const token = (group: string, name: string) => {
    const from = tokens.slice(tokens.indexOf(`export const ${group} =`));
    return new RegExp(`\\n  ${name}: "light-dark\\((#[0-9a-f]{6}), (#[0-9a-f]{6})\\)"`).exec(from)!.slice(1);
  };
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
  await serve(page, "shared-cause");
  for (const scheme of ["light", "dark"] as const) {
    const half = scheme === "light" ? 0 : 1;
    const is = async (l: Locator, prop: Parameters<typeof colourOf>[1], group: string, name: string) => expect(await colourOf(l, prop), `${scheme} ${group}.${name}`).toBe(rgb(token(group, name)[half]!));
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    const dots = panel(page).locator('[data-perf="walk-next"] [data-perf="purpose-dot"]');
    const n = await dots.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await is(dots.nth(i), "backgroundColor", "graph", `purpose${i % 8}`);
    // The walk: its paragraph, its chips, "Stated, not found in code".
    await is(panel(page).locator('[data-perf="walk-text"]'), "color", "colors", "fg");
    await is(panel(page).locator('[data-perf="source-chip"]').first(), "color", "colors", "muted");
    const stated = panel(page).locator('[data-perf="stated"]');
    if (await stated.count()) await is(stated, "color", "colors", "warn");
    // A conflict card, and its question.
    const card = panel(page).locator('[data-perf="conflicts"] article').first();
    await is(card, "borderTopColor", "colors", "line");
    await is(card.locator('[data-perf="conflict-question"]').first(), "color", "colors", "fg");
    // A rest block: muted words on its fill.
    const rest = viewport(page).locator('[data-perf="rest"]:not([hidden] *)').first();
    await is(rest, "backgroundColor", "graph", "outsideFill");
    await is(rest.locator('[data-perf="face-bottom"]'), "color", "colors", "muted");
  }
});
