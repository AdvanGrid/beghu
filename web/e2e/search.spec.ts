// Search in a real browser against the ./dev-ctl stack: the hint bar's syntax while the box has
// focus, the matched-field icons on rows, the Match dropdown and its `match:` token, and the
// detail marking the words and scrolling to the first match, on opening, on a new search and
// once comment page 2 brings it, in rendered Markdown too. Words come from the fixture's own
// text, so nothing is edited but where a test says so.
import { expect, test, type Page } from "@playwright/test";
import type { CommentPage } from "../src/bindings/CommentPage";
import type { IssueDetail } from "../src/bindings/IssueDetail";
import type { IssuePage } from "../src/bindings/IssuePage";
import { matchSpans, searchOf } from "../src/highlight";
import type { Md, MdNode } from "../src/md/ast";

/** A post's text nodes, as the walker marks them: one by one. */
function texts(md: Md): string[] {
  const out: string[] = [];
  const todo: MdNode[] = [...md];
  for (let n = todo.pop(); n !== undefined; n = todo.pop()) {
    if (typeof n === "string") out.push(n);
    else if (n[0] !== "ref") todo.push(...(n.slice(2) as MdNode[]));
  }
  return out;
}

const q = (page: Page) => new URL(page.url()).searchParams.get("q");

/**
 * How long a new search's view may take to land. Each keystroke asks for a full-text search,
 * and on a loaded machine one took over 5 s; until it lands the page shows the view before it.
 */
const VIEW_LANDS_WITHIN_MS = 20_000;

test.beforeEach(async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.locator('[data-perf="row"]').first()).toBeVisible();
});

test("the hint bar shows the search syntax while the filter box has focus", async ({ page }) => {
  const hints = page.locator('[data-perf="hints"]');
  await expect(hints).toBeVisible();
  await expect(hints).not.toContainText("in:title,body,comments");
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.click();
  await expect(hints).toBeVisible();
  for (const syntax of ['"a phrase"', "-word", "in:title,body,comments", "match:blend|best|off"]) {
    await expect(hints).toContainText(syntax);
  }
  // Leaving the box puts the list's keys back.
  await box.evaluate((el) => el.blur());
  await expect(hints).not.toContainText("in:title,body,comments");
});

test("rows show an icon for each field the search matched in", async ({ page }) => {
  await page.goto("/?q=" + encodeURIComponent("is:open spinner"));
  const rows = page.locator('[data-perf="row"]');
  await expect(rows.first().locator('[data-perf="matched"]')).toBeVisible();
  const fields = await rows.evaluateAll((els) => els.map((el) => el.querySelector('[data-perf="matched"]')?.getAttribute("data-fields") ?? ""));
  // Every row matched somewhere, each field in order, each icon named for its field.
  for (const f of fields) expect(f).toMatch(/^(title)? ?(body)? ?(comments)?$/);
  expect(fields.every((f) => f.length > 0)).toBe(true);
  expect(fields.some((f) => f.includes("body"))).toBe(true);
  const icon = rows.first().locator('[data-perf="matched"] svg').first();
  await expect(icon).toHaveAttribute("aria-label", /^Matched in /);

  // `in:` narrows the icons with the search.
  await page.goto("/?q=" + encodeURIComponent("is:open spinner in:comments"));
  await expect(rows.first().locator('[data-perf="matched"]')).toHaveAttribute("data-fields", "comments");

  // No free text, no icons.
  await page.goto("/?q=is:open");
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('[data-perf="matched"]')).toHaveCount(0);
});

test("the Match dropdown and the match: token stay in sync, and wait for free text", async ({ page }) => {
  const match = page.getByRole("combobox", { name: "Match" });
  await expect(match).toBeDisabled();
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(" spinner");
  await box.press("Enter");
  await expect(match).toBeEnabled({ timeout: VIEW_LANDS_WITHIN_MS });
  await expect(match).toHaveValue("blend");
  await match.selectOption("best");
  await expect.poll(() => q(page)).toBe("is:open spinner match:best");
  await expect(box).toHaveValue("is:open spinner match:best");
  await match.selectOption("blend");
  await expect.poll(() => q(page)).toBe("is:open spinner");
  // Back restores the token, and the dropdown follows the URL.
  await page.goBack();
  await expect.poll(() => q(page)).toBe("is:open spinner match:best");
  await expect(match).toHaveValue("best");
});

test("the detail marks the search's words and scrolls to the first match it has loaded", async ({ page }) => {
  // A comment-only search, so the first match is below the description.
  await page.goto("/?q=" + encodeURIComponent("is:open spinner in:comments"));
  const row = page.locator('[data-perf="row"]').first();
  await row.click();
  const detail = page.locator('[data-perf="detail"]');
  await expect(detail).toBeVisible();
  const marks = detail.locator('[data-perf="match"]');
  await expect(marks.first()).toBeVisible();
  // Only the fields searched are marked.
  await expect(detail.locator('[data-perf="body"] [data-perf="match"]')).toHaveCount(0);
  await expect(detail.locator("h2 [data-perf=match]")).toHaveCount(0);
  // Every mark is the word, as typed or not.
  for (const t of await marks.allTextContents()) expect(t.toLowerCase()).toMatch(/^spinner/);
  // The first one is on screen.
  await expect(marks.first()).toBeInViewport({ timeout: VIEW_LANDS_WITHIN_MS });
  expect(await detail.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // Diacritics and case fold: `SPÍNNER` marks the same words.
  await page.goto("/?q=" + encodeURIComponent("is:open SPÍNNER in:body"));
  await page.locator('[data-perf="row"]').first().click();
  await expect(detail.locator('[data-perf="body"] [data-perf="match"]').first()).toBeVisible();
});

test("under a sort Blend can't use, the Match dropdown shows Best match and says why", async ({ page }) => {
  const match = page.getByRole("combobox", { name: "Match" });
  const blend = match.locator('option[value="blend"]');
  for (const sort of ["created-asc", "comments", "comments-asc"]) {
    await page.goto("/?q=" + encodeURIComponent(`is:open spinner sort:${sort}`));
    await expect(match).toBeEnabled({ timeout: VIEW_LANDS_WITHIN_MS });
    await expect(match, sort).toHaveValue("best");
    // (Playwright's toBeDisabled doesn't read an <option>'s own state.)
    await expect.poll(() => blend.evaluate((o: HTMLOptionElement) => o.disabled), sort).toBe(true);
    await expect(match, sort).toHaveAttribute("title", /Blend needs a newest-first time sort/);
  }
  // Asked for by name, it's still Best that runs.
  await page.goto("/?q=" + encodeURIComponent("is:open spinner sort:created-asc match:blend"));
  await expect(match).toHaveValue("best");
  // Off stays Off.
  await page.goto("/?q=" + encodeURIComponent("is:open spinner sort:created-asc match:off"));
  await expect(match).toHaveValue("off");
  // A descending time sort: Blend again.
  await page.goto("/?q=" + encodeURIComponent("is:open spinner sort:created"));
  await expect(match).toHaveValue("blend");
  expect(await blend.evaluate((o: HTMLOptionElement) => o.disabled)).toBe(false);
});

/**
 * An open issue with more than one page of comments, and a phrase (two words: the fixture's
 * comments share one vocabulary) whose first match in its comments, as the detail marks them, is
 * on page 2.
 */
async function matchOnPage2(page: Page): Promise<{ id: number; word: string }> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await page.request.get(path);
    expect(res.ok(), path).toBe(true);
    return (await res.json()) as T;
  };
  const list = await get<IssuePage>("/api/issues?q=" + encodeURIComponent("is:open sort:comments"));
  for (const row of list.rows.slice(0, 20)) {
    const d = await get<IssueDetail>(`/api/issues/${row.id}`);
    if (d.comments.next === null) continue;
    const more = await get<CommentPage>(`/api/issues/${row.id}/comments?order=${d.comment_order}&after=${d.comments.next}`);
    const first = d.comments.comments.flatMap((c) => texts(c.body)).join("\n");
    // Phrases within one text node: the walker marks no phrase across two.
    const pairs = more.comments.flatMap((c) =>
      texts(c.body).flatMap((t) => {
        const w = t.toLowerCase().match(/\p{L}+/gu) ?? [];
        return w.slice(1).map((b, i) => `"${w[i]} ${b}"`);
      }),
    );
    for (const word of new Set(pairs)) {
      const terms = searchOf(word).terms;
      if (matchSpans(first, terms).length === 0) return { id: row.id, word };
    }
  }
  throw new Error("no issue has a phrase first in its second page of comments");
}

test("the detail scrolls to a first match that comment page 2 brings", async ({ page }) => {
  const { id, word } = await matchOnPage2(page);
  await page.goto(`/issues/${id}?q=` + encodeURIComponent(`is:open ${word} in:comments`));
  const detail = page.locator('[data-perf="detail"]');
  const comments = detail.locator('[data-perf="comment"]');
  await expect.poll(() => comments.count()).toBeGreaterThan(15);
  const mark = detail.locator('[data-perf="match"]').first();
  await expect(mark).toBeInViewport({ timeout: VIEW_LANDS_WITHIN_MS });
  // On page 2: the 16th comment or later.
  const at = await mark.evaluate((m) => {
    const c = m.closest('[data-perf="comment"]')!;
    return [...document.querySelectorAll('[data-perf="detail"] [data-perf="comment"]')].indexOf(c);
  });
  expect(at).toBeGreaterThanOrEqual(15);
});

test("a new search on the open issue scrolls to its first match", async ({ page }) => {
  const { id, word } = await matchOnPage2(page);
  await page.goto(`/issues/${id}?q=is:open`);
  const detail = page.locator('[data-perf="detail"]');
  await expect.poll(() => detail.locator('[data-perf="comment"]').count()).toBeGreaterThan(15);
  expect(await detail.evaluate((el) => el.scrollTop)).toBe(0);
  const box = page.getByRole("combobox", { name: "Filter issues" });
  await box.click();
  await box.press("End");
  await box.pressSequentially(` ${word} in:comments`);
  await box.press("Enter");
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/issues/${id}`);
  await expect(detail.locator('[data-perf="match"]').first()).toBeInViewport({ timeout: VIEW_LANDS_WITHIN_MS });
  expect(await detail.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("the detail marks the search's words inside a rendered body's markup, and scrolls to the first", async ({ page }) => {
  const list = (await (await page.request.get("/api/issues")).json()) as IssuePage;
  const t = list.rows[0]!;
  await page.route(new RegExp(`/api/issues/${t.id}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    // Far enough down that the first match starts off screen.
    d.body = [
      ...Array.from({ length: 150 }, () => ["p", 0, "filler"]),
      ["p", 0, "A ", ["strong", 0, "Spinner"], " in bold, ", ["code", 0, "spinner()"], " in code, and ", ["a", { href: "https://example.com" }, "a spinner link"]],
      ["ul", 0, ["li", 0, "a spinner in a list"]],
      // A reference's label is never the author's text: never marked.
      ["p", 0, "the ", ["em", 0, "spinner"], ["ref", { u: "spinner" }]],
    ];
    await route.fulfill({ response: res, json: d });
  });
  await page.goto(`/issues/${t.id}?q=` + encodeURIComponent("spinner in:body"));
  const body = page.locator('[data-perf="detail"] [data-perf="body"]');
  const marks = body.locator('[data-perf="match"]');
  await expect(marks).toHaveCount(5);
  for (const m of await marks.allTextContents()) expect(m.toLowerCase()).toBe("spinner");
  for (const inside of ["strong", "code", "a", "li", "em"]) await expect(body.locator(`${inside} [data-perf="match"]`)).toHaveCount(1);
  const mention = body.getByRole("link", { name: "@spinner", exact: true });
  await expect(mention).toHaveCount(1);
  await expect(mention.locator('[data-perf="match"]')).toHaveCount(0);
  await expect(marks.first()).toBeInViewport();
});
