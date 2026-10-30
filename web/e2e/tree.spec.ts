// Tree mode in a real browser (#108): `?mode=tree` and the List | Tree toggle through links, Back
// and Forward; a filtered tree's matches inside their dimmed ancestors, opened along each path,
// readable in both themes; the expand state kept per query on this device (any token order, other
// tabs, the 50 queries used last); ← and → on the tree; and dragging to reorder and re-parent,
// with a refused drop saying why at its marker; a live change to the order is held as in the list.
//
// It links fixture issues with no relationships (as relationships.spec.ts does), so it runs with
// the relationship specs, serially (playwright.config.ts). Every link a test makes, it removes
// again, and no issue's `updated_at` changes (a relationship doesn't change it), so the stack is as
// it found it.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { devCtl, status } from "./stack";

test.describe.configure({ mode: "serial" });

interface Unlinked {
  repo: string;
  number: number;
  id: number;
}

async function summary(): Promise<{ unlinked: Unlinked[] }> {
  const { control } = status().urls;
  const { fixture } = (await (await fetch(`${control}/state`)).json()) as { fixture: string };
  return JSON.parse(readFileSync(fixture.replace(/mirror-([^/]*)\.db$/, "fixture-$1.json"), "utf8"));
}

const ref = (u: Unlinked) => `${u.repo}#${u.number}`;
const row = (page: Page, id: number) => page.locator(`[data-perf="row"][data-id="${id}"]`);
const tree = (page: Page) => page.locator('[data-perf="tree"]');
const list = (page: Page) => page.locator('[data-perf="list"]');

let web: Unlinked[];
test.beforeAll(async () => {
  web = (await summary()).unlinked.filter((u) => u.repo === "web");
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
}

/** The parent of each of `ids` as the mirror has it (from each one's detail). */
async function parents(page: Page, ids: number[]): Promise<(number | null)[]> {
  return Promise.all(
    ids.map(async (id) => {
      const d = (await (await page.request.get(`/api/issues/${id}`)).json()) as { relationships: { parent: { id: number } | null } };
      return d.relationships.parent?.id ?? null;
    }),
  );
}

/** `parent`'s sub-issues as the mirror has them, in GitHub's order. */
async function subs(page: Page, parent: number): Promise<number[]> {
  const d = (await (await page.request.get(`/api/issues/${parent}`)).json()) as { relationships: { sub_issues: { id: number }[] } };
  return d.relationships.sub_issues.map((s) => s.id);
}

/** Links `child` under `parent` on GitHub, and waits for the mirror to have it. */
async function nest(page: Page, parent: Unlinked, child: Unlinked): Promise<void> {
  devCtl(["fake", "edit", ref(parent), "--add-sub-issue", ref(child)]);
  await expect.poll(async () => (await parents(page, [child.id]))[0], { timeout: 15_000 }).toBe(parent.id);
}

/** Takes every link among `issues` apart again, whatever the test left. */
async function unlinkAll(page: Page, issues: Unlinked[]): Promise<void> {
  const ps = await parents(page, issues.map((u) => u.id));
  issues.forEach((u, i) => {
    const p = issues.find((x) => x.id === ps[i]);
    if (p) devCtl(["fake", "edit", ref(p), "--remove-sub-issue", ref(u)]);
  });
  await expect.poll(async () => (await parents(page, issues.map((u) => u.id))).every((p) => p === null), { timeout: 15_000 }).toBe(true);
}

/** A query matching only `u`: its title as a phrase, in its repo. */
async function only(page: Page, u: Unlinked): Promise<string> {
  const d = (await (await page.request.get(`/api/issues/${u.id}`)).json()) as { title: string };
  return `is:open repo:web "${d.title.replace(/"/g, "")}"`;
}

const treeAt = (q: string) => `/?${new URLSearchParams({ q, mode: "tree" })}`;

/** The contrast of `el`'s text against the page behind it, as WCAG computes it. */
async function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    let bg = "rgba(0, 0, 0, 0)";
    for (let at: Element | null = el; at && /rgba\(.*, 0\)$|transparent/.test(bg); at = at.parentElement) bg = getComputedStyle(at).backgroundColor;
    const [a, b] = [lum(getComputedStyle(el).color), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test("?mode=tree round-trips through the toggle, its key, links, Back and Forward", async ({ page }) => {
  await signIn(page);
  await expect(list(page)).toBeVisible();
  await page.locator('[data-perf="mode-tree"]').click();
  await expect(page).toHaveURL(/[?&]mode=tree/);
  await expect(tree(page).locator('[data-perf="row"]').first()).toBeVisible();
  await expect(page.locator('[data-perf="mode-tree"]')).toHaveAttribute("aria-pressed", "true");
  // A row is a link that keeps the mode.
  const first = tree(page).locator('[data-perf="row"]').first();
  const id = await first.getAttribute("data-id");
  await first.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${id}\\?.*mode=tree`));
  await expect(tree(page)).toBeVisible();
  // Back to the tree without the issue, back to the list, and forward again.
  await page.goBack();
  await expect(page).toHaveURL((u) => u.pathname === "/" && u.searchParams.get("mode") === "tree");
  await expect(tree(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL((u) => u.searchParams.get("mode") === null);
  await expect(list(page)).toBeVisible();
  await page.goForward();
  await expect(tree(page)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/issues/${id}\\?`));
  // A reload, and a link straight to it, open the tree.
  await page.reload();
  await expect(tree(page)).toBeVisible();
  await expect(page.locator('[data-perf="detail"]')).toHaveAttribute("data-id", id!);
  // The toggle's key switches back, keeping the issue open.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  await page.keyboard.press("t");
  await expect(list(page)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issues/${id}$`));
});

test("a filtered tree shows matches inside dimmed ancestors opened along each path, readable in both themes, with ← and → as ARIA's tree has them", async ({ page }) => {
  const [top, mid, low] = [web[0]!, web[1]!, web[2]!];
  await signIn(page);
  try {
    await nest(page, top, mid);
    await nest(page, mid, low);
    const q = await only(page, low);
    await page.goto(treeAt(q));
    // Context, opened along the path, then the match.
    await expect(row(page, low.id)).toBeVisible();
    for (const [u, level, context, expanded] of [
      [top, "1", true, "true"],
      [mid, "2", true, "true"],
      [low, "3", false, null],
    ] as const) {
      const r = row(page, u.id);
      await expect(r).toHaveAttribute("role", "treeitem");
      await expect(r).toHaveAttribute("aria-level", level);
      if (context) await expect(r).toHaveAttribute("data-context", "");
      else await expect(r).not.toHaveAttribute("data-context");
      if (expanded) await expect(r).toHaveAttribute("aria-expanded", expanded);
      else await expect(r).not.toHaveAttribute("aria-expanded");
    }
    // Dimmed, and still readable (WCAG AA) in both themes.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      expect(await contrast(page, `[data-perf="row"][data-id="${top.id}"]`), scheme).toBeGreaterThanOrEqual(4.5);
    }
    await page.emulateMedia({ colorScheme: null });

    // Context is selectable: it opens in the panel. ← on an open node closes it, on a closed one
    // steps to its parent; → opens it, then steps to its first child.
    await row(page, mid.id).click();
    await expect(page).toHaveURL(new RegExp(`/issues/${mid.id}\\?`));
    await row(page, mid.id).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, mid.id)).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, low.id)).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(new RegExp(`/issues/${top.id}\\?`));
    await page.keyboard.press("ArrowDown");
    await expect(page).toHaveURL(new RegExp(`/issues/${mid.id}\\?`));
    await page.keyboard.press("ArrowRight");
    await expect(row(page, low.id)).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/issues/${low.id}\\?`));

    // Switching to the tree keeps the selection, or moves it to the nearest ancestor shown: in the
    // unfiltered tree, `top` is a closed root, so the issue under it shows as it.
    await page.goto(`/issues/${low.id}`);
    await expect(page.locator('[data-perf="detail"]')).toHaveAttribute("data-id", String(low.id));
    await page.locator('[data-perf="mode-tree"]').click();
    await expect(page).toHaveURL(new RegExp(`/issues/${top.id}\\?.*mode=tree`));
    await expect(row(page, top.id)).toHaveAttribute("aria-selected", "true");
  } finally {
    await unlinkAll(page, [top, mid, low]);
  }
});

test("expand state survives a reload in any token order, reaches other tabs, and is kept for the 50 queries used last", async ({ page, context }) => {
  test.setTimeout(240_000);
  const [top, child] = [web[3]!, web[4]!];
  await signIn(page);
  try {
    await nest(page, top, child);
    const q = await only(page, top);
    await page.goto(treeAt(q));
    // The match starts closed; its chevron opens it.
    await expect(row(page, top.id)).toHaveAttribute("aria-expanded", "false");
    await row(page, top.id).locator('[data-perf="chevron"]').click();
    await expect(row(page, child.id)).toBeVisible();
    // The same query, its tokens in another order and case: still open after a reload.
    // Its tokens: the two qualifiers, then the quoted title.
    const phrase = q.slice(q.indexOf('"'));
    const reordered = `${phrase} REPO:web is:open`;
    await page.goto(treeAt(reordered));
    await expect(row(page, child.id)).toBeVisible();

    // Another tab on the query follows a change made here.
    const other = await context.newPage();
    await other.goto(treeAt(q));
    await expect(row(other, child.id)).toBeVisible();
    await row(page, top.id).locator('[data-perf="chevron"]').click();
    await expect(row(page, child.id)).toHaveCount(0);
    await expect(row(other, child.id)).toHaveCount(0);
    await row(other, top.id).locator('[data-perf="chevron"]').click();
    await expect(row(page, child.id)).toBeVisible();
    await other.close();

    // 50 more queries opened after it: it's the 51st used, and its state goes; the next one's stays.
    const nth = (i: number) => `${q} -zzqx${i}`;
    for (let i = 1; i <= 50; i++) {
      await page.goto(treeAt(nth(i)));
      await row(page, top.id).locator('[data-perf="chevron"]').click();
      await expect(row(page, child.id)).toBeVisible();
    }
    await page.goto(treeAt(q));
    await expect(row(page, top.id)).toHaveAttribute("aria-expanded", "false");
    await expect(row(page, child.id)).toHaveCount(0);
    await page.goto(treeAt(nth(2)));
    await expect(row(page, child.id)).toBeVisible();
  } finally {
    await unlinkAll(page, [top, child]);
  }
});

test("two tabs on different queries, each with its own expand state, leave each other's trees alone", async ({ page, context }) => {
  const [top, child] = [web[3]!, web[4]!];
  await signIn(page);
  try {
    await nest(page, top, child);
    const q = await only(page, top);
    const other = await context.newPage();
    // The same issue, matched under is:open in one tab and under every state in the other.
    for (const [p, view] of [
      [page, q],
      [other, q.replace("is:open ", "")],
    ] as const) {
      await p.goto(treeAt(view));
      await row(p, top.id).locator('[data-perf="chevron"]').click();
      await expect(row(p, child.id)).toBeVisible();
    }
    // Each tab uses its own query again (a reload, as coming back to it does).
    await page.reload();
    await expect(row(page, child.id)).toBeVisible();
    // Left alone, neither asks for its tree again.
    let reads = 0;
    for (const p of [page, other]) p.on("request", (r) => void (new URL(r.url()).pathname === "/api/tree" && reads++));
    await page.waitForTimeout(4000);
    expect(reads).toBe(0);
    await other.close();
  } finally {
    await unlinkAll(page, [top, child]);
  }
});

test("dragging in the tree reorders and re-parents, and a refused drop says why at its marker", async ({ page }) => {
  const [top, a, b, c] = [web[5]!, web[6]!, web[7]!, web[1]!];
  await signIn(page);
  try {
    for (const u of [a, b, c]) await nest(page, top, u);
    await page.goto(treeAt(await only(page, top)));
    await row(page, top.id).locator('[data-perf="chevron"]').click();
    await expect(row(page, c.id)).toBeVisible();
    const order = async () => {
      const ids = await page.locator('[data-perf="row"]').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.id)));
      return ids.filter((id) => [a.id, b.id, c.id].includes(id));
    };
    await expect.poll(order).toEqual([a.id, b.id, c.id]);

    // b by its grip onto a's top edge: it goes before a, at once and on GitHub.
    const grip = (u: Unlinked) => row(page, u.id).locator('[data-perf="tree-grip"]');
    await grip(b).dragTo(row(page, a.id), { targetPosition: { x: 300, y: 3 } });
    await expect.poll(order).toEqual([b.id, a.id, c.id]);
    await expect.poll(() => subs(page, top.id), { timeout: 15_000 }).toEqual([b.id, a.id, c.id]);

    // c onto a's middle: under a.
    await grip(c).dragTo(row(page, a.id), { targetPosition: { x: 300, y: 17 } });
    await expect.poll(() => parents(page, [c.id]), { timeout: 15_000 }).toEqual([a.id]);
    await expect(row(page, a.id).locator('[data-perf="chevron"]')).toBeVisible();

    // Refused drops: the marker says why, and letting go sends nothing.
    const writes: string[] = [];
    page.on("request", (r) => void (new URL(r.url()).pathname === "/api/ops" && writes.push(r.url())));
    const marker = page.locator('[data-perf="drop-marker"]');
    const refusedAt = async (u: Unlinked, onto: Unlinked, y: (h: number) => number, why: string) => {
      const box = (await row(page, onto.id).boundingBox())!;
      const from = (await grip(u).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + y(box.height), { steps: 6 });
      await expect(marker).toHaveAttribute("data-refused", "");
      await expect(marker.locator('[data-perf="drop-refusal"]')).toHaveText(why);
      await page.mouse.up();
      await expect(marker).toHaveCount(0);
    };
    // top onto its own sub-issue: a loop.
    await refusedAt(top, a, (h) => h / 2, "That would make a loop of sub-issues");
    // b beside the root, top: roots have no order of their own.
    await refusedAt(b, top, () => 3, "Top-level issues follow the view's sort; remove its parent from the issue's panel");
    await page.waitForTimeout(500);
    expect(writes).toEqual([]);
    await expect.poll(() => parents(page, [a.id, b.id])).toEqual([top.id, top.id]);

    // A drop GitHub refuses goes back, and the failure says so.
    devCtl(["fake", "fail", "PATCH /repos/*/*/issues/*/sub_issues/priority", "422"]);
    await grip(a).dragTo(row(page, b.id), { targetPosition: { x: 300, y: 3 } });
    // The failed write, in the status slot (no issue is open), names the parent it was under, and
    // the rows are back as they were (GitHub answers at once here, so the move may never paint).
    await expect(page.locator('[data-perf="status"]')).toContainText(`${top.repo}#${top.number}`);
    await expect.poll(order, { timeout: 15_000 }).toEqual([b.id, a.id]);
    await expect.poll(() => subs(page, top.id)).toEqual([b.id, a.id]);

    // A change made on GitHub that takes a row out waits while the pointer moves over the tree
    // (a held change, as in the list), and applies once it rests.
    devCtl(["fake", "edit", ref(top), "--remove-sub-issue", ref(b)]);
    const box = (await row(page, a.id).boundingBox())!;
    let x = 0;
    const wiggle = () => page.mouse.move(box.x + 200 + (x++ % 2) * 40, box.y + 5);
    for (let i = 0; (await parents(page, [b.id]))[0] !== null; i++) {
      expect(i, "the removal reaches the mirror").toBeLessThan(60);
      await wiggle();
      await page.waitForTimeout(250);
    }
    for (let i = 0; i < 6; i++) {
      await wiggle();
      await page.waitForTimeout(250);
    }
    await expect(row(page, b.id)).toBeVisible();
    await expect(row(page, b.id)).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await unlinkAll(page, [top, a, b, c]);
  }
});
