// Relationship writes in a real browser: the Links row's `+ Blocked by`, `+ Blocking` and
// `+ Relates to` pickers (by `#n`, `repo#n`, a pasted URL), × on hover, `+ Add sub-issue`, and a
// sub-issue's grip and ⋯ menu. Each write shows at once, lands on both ends, and what GitHub would
// refuse is listed with its reason and can't be picked.
//
// It edits, so it runs with relationships.spec.ts, serially (playwright.config.ts). Every link a
// test makes, it removes again, so the stack is as it found it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { status } from "./stack";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

test.describe.configure({ mode: "serial" });

function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(test.info().project.use.baseURL!).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

interface Unlinked {
  repo: string;
  number: number;
  id: number;
}

async function summary(): Promise<{ unlinked: Unlinked[]; unlinked_stubs: number[] }> {
  const { control } = status().urls;
  const { fixture } = (await (await fetch(`${control}/state`)).json()) as { fixture: string };
  return JSON.parse(readFileSync(fixture.replace(/mirror-([^/]*)\.db$/, "fixture-$1.json"), "utf8"));
}

const ref = (u: Unlinked) => `${u.repo}#${u.number}`;

let web: Unlinked[];
let api: Unlinked[];
let stub: number;
test.beforeAll(async () => {
  const s = await summary();
  web = s.unlinked.filter((u) => u.repo === "web");
  api = s.unlinked.filter((u) => u.repo === "api");
  stub = s.unlinked_stubs[0]!;
});

/** Signed in as tomsj (admin everywhere), at issue `id`'s panel. */
async function openIssue(page: Page, id: number): Promise<void> {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await page.goto(`/issues/${id}`);
  await expect(page.locator('[data-perf="detail"]')).toHaveAttribute("data-id", String(id));
  // The writes code (with the composer) is in.
  await expect(page.locator('[data-perf="composer"]')).toBeVisible();
}

/** Opens the picker `button` opens, asks it for `q`, and picks the offer for `pick` (`repo#n`). */
async function pick(page: Page, button: Locator, q: string, pickRef: string): Promise<void> {
  await button.click();
  const picker = page.locator('[data-perf="relationship-picker"]');
  await picker.locator("input").fill(q);
  await picker.locator(`[data-perf="relationship-option"][data-ref="${pickRef}"]`).click();
  await expect(picker).toBeHidden();
}

/** The Links row's marker slot: no write on its way, none failed. */
async function settled(page: Page): Promise<void> {
  const note = page.locator('[data-perf="links"] [data-perf="prop-note"]');
  await expect(note.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(note.locator('[data-perf="pick-failed"]')).toHaveCount(0);
}

const item = (page: Page, side: string, id: number) => page.locator(`[data-perf="${side}"] [data-perf="block-item"][data-id="${id}"]`);
const relates = (page: Page, id: number) => page.locator(`[data-perf="relates"] [data-perf="rel-item"][data-id="${id}"]`);
const subRows = (page: Page) => page.locator('[data-perf="sub-issues"] [data-perf="sub-row"]');

test("each relationship kind is picked from the Links row, shows on both ends, and × on hover removes it", async ({ page }) => {
  const [me, other] = [web[0]!, web[1]!];
  const far = api[1]!;
  try {
    await openIssue(page, me.id);
    // Blocked by, across repos, by `repo#n`; it shows at once.
    await pick(page, page.locator('[data-perf="add-blocked_by"]'), ref(far), ref(far));
    await expect(item(page, "blocked_by", far.id)).toBeVisible();
    // Blocking, by `#n` in this repo, from its key.
    await page.locator('[data-perf="detail"]').focus();
    await page.keyboard.press("Shift+B");
    const picker = page.locator('[data-perf="relationship-picker"][data-kind="blocking"]');
    await expect(picker).toBeVisible();
    await picker.locator("input").fill(`#${other.number}`);
    await picker.locator(`[data-perf="relationship-option"][data-ref="${ref(other)}"]`).click();
    await expect(item(page, "blocking", other.id)).toBeVisible();
    // Relates to.
    await pick(page, page.locator('[data-perf="add-relates"]'), `#${other.number}`, ref(other));
    await expect(relates(page, other.id)).toBeVisible();
    await settled(page);

    // The other ends show it, from GitHub's data.
    await page.goto(`/issues/${other.id}`);
    await expect(item(page, "blocked_by", me.id)).toBeVisible();
    await expect(relates(page, me.id)).toBeVisible();
    await page.goto(`/issues/${far.id}`);
    await expect(item(page, "blocking", me.id)).toBeVisible();

    // × on hover removes each, here and on the other end.
    await page.goto(`/issues/${me.id}`);
    for (const row of [item(page, "blocked_by", far.id), item(page, "blocking", other.id), relates(page, other.id)]) {
      const x = row.locator('[data-perf="remove-relationship"]');
      // Away from every row (the last removal moved the next one under the pointer).
      await page.mouse.move(0, 0);
      await expect(x).toHaveCSS("opacity", "0");
      await row.hover();
      await expect(x).toHaveCSS("opacity", "1");
      await x.click();
      await expect(row).toBeHidden();
    }
    await settled(page);
    await page.goto(`/issues/${other.id}`);
    await expect(page.locator('[data-perf="blocks"]')).toBeHidden();
    await expect(page.locator('[data-perf="relates"]')).toBeHidden();
  } finally {
    devCtl(["fake", "edit", ref(me), "--remove-blocked-by", `api#${far.number}`, "--unrelate", ref(other)]);
    devCtl(["fake", "edit", ref(other), "--remove-blocked-by", ref(me)]);
  }
});

test("a pasted URL of an unsynced repo's issue relates a stub; a refused write reverts with the reason", async ({ page }) => {
  const me = web[2]!;
  const sdk = `partner-sdk#${stub}`;
  try {
    await openIssue(page, me.id);
    await page.locator('[data-perf="add-relates"]').click();
    const picker = page.locator('[data-perf="relationship-picker"]');
    await picker.locator("input").fill(`https://github.com/acme/partner-sdk/issues/${stub}`);
    const offer = picker.locator(`[data-perf="relationship-option"][data-ref="${sdk}"]`);
    await expect(offer).toContainText("not synced");
    await expect(picker.locator('[data-perf="relationship-group"]')).toHaveText("acme/partner-sdk");
    await offer.click();
    const linked = page.locator('[data-perf="relates"] [data-perf="rel-item"]');
    await expect(linked).toContainText("not synced");
    await settled(page);
    await expect(linked.locator("a")).toHaveAttribute("href", `https://github.com/acme/partner-sdk/issues/${stub}`);
    await linked.hover();
    await linked.locator('[data-perf="remove-relationship"]').click();
    await expect(page.locator('[data-perf="relates"]')).toBeHidden();
    await settled(page);

    // GitHub refuses the next relates-to: it shows, then reverts, with the reason and Retry.
    devCtl(["fake", "fail", "POST /repos/*/*/issues/*/relates_to", "422"]);
    await pick(page, page.locator('[data-perf="add-relates"]'), `#${web[3]!.number}`, ref(web[3]!));
    const failed = page.locator('[data-perf="links"] [data-perf="pick-failed"]');
    await expect(failed).toContainText(`Couldn't relate to ${ref(web[3]!)}`);
    await expect(page.locator('[data-perf="relates"]')).toBeHidden();
    await failed.getByRole("button", { name: "Dismiss" }).click();
    await expect(failed).toBeHidden();
  } finally {
    devCtl(["fake", "clear"]);
    devCtl(["fake", "edit", ref(me), "--unrelate", sdk, "--unrelate", ref(web[3]!)]);
  }
});

test("sub-issues reorder by their grip and their ⋯ menu (by pointer or keys), move to another parent, and × removes one", async ({ page }) => {
  const [me, a, b, c, there] = [web[4]!, web[5]!, web[6]!, web[7]!, api[2]!];
  const order = async () => (await subRows(page).evaluateAll((rs) => rs.map((r) => Number(r.getAttribute("data-id")))));
  try {
    await openIssue(page, me.id);
    for (const child of [a, b, c]) await pick(page, page.locator('[data-perf="add-sub"]'), `#${child.number}`, ref(child));
    await expect(subRows(page)).toHaveCount(3);
    await settled(page);
    expect(await order()).toEqual([a.id, b.id, c.id]);

    // a's grip, dropped on the lower half of c: [b, c, a].
    const grip = page.locator(`[data-perf="sub-row"][data-id="${a.id}"] [data-perf="grip"]`);
    const target = page.locator(`[data-perf="sub-row"][data-id="${c.id}"]`);
    const box = (await target.boundingBox())!;
    await grip.dragTo(target, { targetPosition: { x: 40, y: box.height - 4 } });
    await expect.poll(order).toEqual([b.id, c.id, a.id]);
    await settled(page);
    // GitHub has it: a fresh page shows the same.
    await page.reload();
    await expect.poll(order).toEqual([b.id, c.id, a.id]);

    // The menu: c to the top, then b to the bottom.
    const menu = (id: number) => page.locator(`[data-perf="sub-row"][data-id="${id}"] [data-perf="sub-menu"]`);
    await menu(c.id).click();
    await page.getByRole("menuitem", { name: "Move to top" }).click();
    await expect.poll(order).toEqual([c.id, b.id, a.id]);
    await menu(b.id).click();
    await page.getByRole("menuitem", { name: "Move to bottom" }).click();
    await expect.poll(order).toEqual([c.id, a.id, b.id]);
    await settled(page);

    // The same menu by keys: ↓ on ⋯ opens it on its first item, ↓ moves on, Enter picks.
    await menu(b.id).focus();
    await page.keyboard.press("ArrowDown");
    const items = page.locator(`[data-perf="sub-row"][data-id="${b.id}"] [role="menu"]`);
    await expect(items).toBeVisible();
    await expect(items.getByRole("menuitem", { name: "Move to top" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.getByRole("menuitem", { name: "Move up" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(items).toBeHidden();
    await expect.poll(order).toEqual([c.id, b.id, a.id]);
    await settled(page);
    // Enter opens it too; End and Home go to the ends, ↑ wraps; Escape closes it, back on ⋯.
    await menu(b.id).focus();
    await page.keyboard.press("Enter");
    await expect(items.getByRole("menuitem", { name: "Move to top" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.getByRole("menuitem", { name: "Remove" })).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect(items.getByRole("menuitem", { name: "Remove" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(items).toBeHidden();
    await expect(menu(b.id)).toBeFocused();
    // Tab closes it and moves on.
    await page.keyboard.press("ArrowDown");
    await expect(items).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(items).toBeHidden();
    await expect.poll(order).toEqual([c.id, b.id, a.id]);

    // b to another parent, across repos: it leaves this list, and the new parent lists it.
    await menu(b.id).click();
    await page.getByRole("menuitem", { name: "Move to another parent…" }).click();
    const picker = page.locator('[data-perf="relationship-picker"][data-kind="parent"]');
    await picker.locator("input").fill(ref(there));
    await picker.locator(`[data-perf="relationship-option"][data-ref="${ref(there)}"]`).click();
    await expect.poll(order).toEqual([c.id, a.id]);
    await settled(page);
    await page.goto(`/issues/${b.id}`);
    await expect(page.locator('[data-perf="parent"]')).toContainText(ref(there));

    // Remove, from the menu.
    await page.goto(`/issues/${me.id}`);
    await menu(a.id).click();
    await page.getByRole("menuitem", { name: "Remove" }).click();
    await expect.poll(order).toEqual([c.id]);
    await settled(page);

    // × on hover removes one too.
    const last = page.locator(`[data-perf="sub-row"][data-id="${c.id}"]`);
    const x = last.locator('[data-perf="remove-relationship"]');
    await page.mouse.move(0, 0);
    await expect(x).toHaveCSS("opacity", "0");
    await last.hover();
    await expect(x).toHaveCSS("opacity", "1");
    await x.click();
    await expect.poll(order).toEqual([]);
    await settled(page);
  } finally {
    // Whichever links the test got to: each removal on its own, as one that isn't there fails.
    for (const [parent, child] of [[me, a], [me, b], [me, c], [there, b]] as const) {
      try {
        devCtl(["fake", "edit", ref(parent), "--remove-sub-issue", ref(child)]);
      } catch {
        // Not there.
      }
    }
  }
});

test("a relationship GitHub would refuse is listed with its reason and can't be picked", async ({ page }) => {
  const [parent, child] = [web[0]!, web[1]!];
  try {
    devCtl(["fake", "edit", ref(parent), "--add-sub-issue", ref(child)]);
    await openIssue(page, child.id);
    await expect(page.locator('[data-perf="parent"]')).toContainText(ref(parent), { timeout: 20_000 });
    await page.locator('[data-perf="add-sub"]').click();
    const picker = page.locator('[data-perf="relationship-picker"]');
    await picker.locator("input").fill(`#${parent.number}`);
    const offer = picker.locator(`[data-perf="relationship-option"][data-ref="${ref(parent)}"]`);
    await expect(offer).toHaveAttribute("aria-disabled", "true");
    await expect(offer.locator('[data-perf="why-not"]')).toHaveText("That would make a loop of sub-issues");
    // A click on it (Playwright won't, as it's disabled: the event alone) and Enter do nothing.
    await offer.dispatchEvent("click");
    await picker.locator("input").press("Enter");
    await expect(picker).toBeVisible();
    await expect(page.locator('[data-perf="sub-issues"] [data-perf="sub-row"]')).toHaveCount(0);
    await expect(page.locator('[data-perf="links"] [data-perf="pending"]')).toHaveCount(0);
  } finally {
    devCtl(["fake", "edit", ref(parent), "--remove-sub-issue", ref(child)]);
  }
});
