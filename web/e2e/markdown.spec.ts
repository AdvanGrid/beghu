// Bodies and comments in the browser: the walker turns the server's AST into DOM, creating only
// what it allows, and the link resolver sends each reference in-app or to GitHub. The server's
// rendering is covered at its HTTP seam (crates/server/tests/markdown.rs); here the detail's
// response is rewritten on its way to the page, to hand the walker an AST the server would never
// send as well as the ones it does.
import { expect, test, type Page } from "@playwright/test";

const rows = (page: Page) => page.locator('[data-perf="row"]');
const body = (page: Page) => page.locator('[data-perf="body"]');

type Row = { id: number; owner: string; repo: string; number: number; title: string };

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
});

test("a body renders allowlisted DOM only, and its references link in-app or to GitHub", async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  const list = (await (await page.request.get("/api/issues")).json()) as { rows: Row[] };
  const [t, x] = [list.rows[0]!, list.rows.find((r, i) => i > 0 && r.owner === list.rows[0]!.owner && r.repo === list.rows[0]!.repo)!];
  const key = `${t.owner}/${t.repo}#${x.number}`.toLowerCase();

  // The detail, and its refetches (`?through=`).
  await page.route(new RegExp(`/api/issues/${t.id}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.body = [
      ["p", 0, "See ", ["ref", { o: t.owner, r: t.repo, n: x.number }], " and ", ["ref", { o: "else", r: "where", n: 7 }], " cc ", ["ref", { u: "ilze-k" }], " ", ["ref", { t: "acme/core" }]],
      ["p", 0, ["ref", { o: t.owner, r: t.repo, n: x.number, c: 12 }], " ", ["ref", { o: "else", r: "where", n: 7, c: 34 }]],
      ["p", 0, ["a", { href: "javascript:window.pwned=1" }, "bad link"], " ", ["a", { href: "https://example.com/x" }, "good link"]],
      ["script", 0, "window.pwned=2"],
      ["img", { src: "javascript:window.pwned=3", onerror: "window.pwned=4" }],
      ["iframe", { src: "https://example.com" }],
      ["p", { style: "color: red", onclick: "window.pwned=5" }, "styled"],
      ["ul", 0, ["li", 0, ["input", { type: "checkbox", checked: "" }], " done"]],
      ["div", { class: "markdown-alert markdown-alert-note" }, ["p", { class: "markdown-alert-title" }, "Note"], ["p", 0, "Heads up"]],
      ["p", 0, ["a", { href: "https://example.com/y" }, "own arrow ↗"], " ", ["a", { href: "https://example.com/z" }, "arrow after"], " ↗ said so"],
    ];
    d.refs = { [key]: { id: x.id, kind: "issue", title: "Stubbed title", state: "closed", state_reason: "not_planned" } };
    await route.fulfill({ response: res, json: d });
  });
  await page.goto(`/issues/${t.id}`);
  await expect(body(page)).toContainText("Heads up");

  // In the mirror: in-app, with its state icon and a hover title.
  const inApp = body(page).locator("p").first().locator('a[data-ref="notPlanned"]');
  await expect(inApp).toHaveText(`#${x.number}`);
  await expect(inApp).toHaveAttribute("href", `/issues/${x.id}`);
  await expect(inApp).toHaveAttribute("title", "Stubbed title · Closed as not planned");
  await expect(inApp.locator("svg")).toHaveCount(1);
  // Anything else: GitHub, marked ↗, which screen readers don't hear.
  const out = body(page).locator("p").first().locator('a[data-ref="out"]');
  await expect(out).toHaveText("else/where#7 ↗");
  await expect(out).toHaveAccessibleName("else/where#7");
  await expect(out.locator('[aria-hidden="true"]')).toHaveText("↗");
  await expect(out).toHaveAttribute("href", "https://github.com/else/where/issues/7");
  await expect(out).toHaveAttribute("target", "_blank");
  // Users and teams too, as pills.
  const user = body(page).getByRole("link", { name: "@ilze-k", exact: true });
  await expect(user).toHaveAttribute("href", "https://github.com/ilze-k");
  await expect(user).toHaveAttribute("title", "Opens on GitHub");
  await expect(user).toHaveAttribute("target", "_blank");
  const team = body(page).getByRole("link", { name: "@acme/core", exact: true });
  await expect(team).toHaveAttribute("href", "https://github.com/orgs/acme/teams/core");
  await expect(team).toHaveAttribute("title", "Opens on GitHub");
  await expect(team).toHaveAttribute("target", "_blank");
  // A link to a comment names it, as GitHub does.
  const comments = body(page).locator("p").nth(1).locator("a");
  await expect(comments.nth(0)).toHaveText(`#${x.number} (comment)`);
  await expect(comments.nth(0)).toHaveAttribute("href", `/issues/${x.id}`);
  await expect(comments.nth(1)).toHaveText("else/where#7 (comment) ↗");
  await expect(comments.nth(1)).toHaveAccessibleName("else/where#7 (comment)");
  await expect(comments.nth(1)).toHaveAttribute("href", "https://github.com/else/where/issues/7#issuecomment-34");

  // Nothing the walker doesn't allow: no script, frame or handler, no unsafe URL, no style.
  await expect(body(page).getByText("bad link")).not.toHaveAttribute("href", /.*/);
  await expect(body(page).getByRole("link", { name: "good link" })).toHaveAttribute("href", "https://example.com/x");

  // A link off GitHub takes a ↗ screen readers don't hear, unless its author wrote an arrow, in
  // its text or just after it.
  const arrowAfter = (name: string) =>
    body(page)
      .getByRole("link", { name, exact: true })
      .evaluate((e) => {
        const next = e.nextElementSibling as HTMLElement | null;
        return next?.dataset.perf === "away" ? next.getAttribute("aria-hidden") : null;
      });
  expect(await arrowAfter("good link")).toBe("true");
  expect(await arrowAfter("own arrow ↗")).toBeNull();
  expect(await arrowAfter("arrow after")).toBeNull();
  expect(await body(page).locator("script, iframe, [onerror], [onclick], [style]").count()).toBe(0);
  await expect(body(page).locator("img")).not.toHaveAttribute("src", /.*/);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();

  // Task lists are read-only; alerts keep their kind.
  const box = body(page).locator('input[type="checkbox"]');
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await expect(body(page).locator('[data-alert="note"]')).toContainText("Heads up");

  // The in-app reference opens its issue in the panel.
  await inApp.click();
  await expect(page).toHaveURL(new RegExp(`/issues/${x.id}$`));
  await expect(page.locator(`[data-perf="detail"][data-id="${x.id}"]`)).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
});

test("a body nested far deeper than the server sends renders, flattened past the walker's depth", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  const list = (await (await page.request.get("/api/issues")).json()) as { rows: Row[] };
  const t = list.rows[0]!;
  const depth = 100_000;
  await page.route(new RegExp(`/api/issues/${t.id}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.body = "BODY";
    // Spelled out as JSON: building it as an array and stringifying it would recurse here.
    const deep = `[${'["blockquote",0,'.repeat(depth)}"deepest"${"]".repeat(depth)}, ["p", 0, "after"]]`;
    await route.fulfill({ response: res, body: JSON.stringify(d).replace('"BODY"', deep), contentType: "application/json" });
  });
  await page.goto(`/issues/${t.id}`);
  await expect(body(page)).toContainText("deepest");
  await expect(body(page)).toContainText("after");
  const nesting = await body(page).evaluate((root) => {
    let deepest = 0;
    const todo: [Element, number][] = [[root, 0]];
    while (todo.length) {
      const [e, d] = todo.pop()!;
      deepest = Math.max(deepest, d);
      for (const k of e.children) todo.push([k, d + 1]);
    }
    return deepest;
  });
  expect(nesting).toBeLessThanOrEqual(102);
  expect(errors).toEqual([]);
});

test("a link to a comment on the open issue scrolls to it, a reference or a link with its own text", async ({ page }) => {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  const list = (await (await page.request.get("/api/issues")).json()) as { rows: Row[] };
  // An issue whose first page of comments holds some.
  let t: Row | undefined;
  let comment = 0;
  for (const r of list.rows) {
    const d = (await (await page.request.get(`/api/issues/${r.id}`)).json()) as { comments: { comments: { id: number }[] } };
    const last = d.comments.comments.at(-1);
    if (last) [t, comment] = [r, last.id];
    if (t) break;
  }
  if (!t) throw new Error("no issue with comments in the list");
  const issue = t;
  const url = `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}#issuecomment-${comment}`;
  await page.route(new RegExp(`/api/issues/${issue.id}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    // A body long enough to push the comments out of view, the links at its top.
    d.body = [
      ["p", 0, ["ref", { o: issue.owner, r: issue.repo, n: issue.number, c: comment }], " ", ["a", { href: url }, "that comment"]],
      ...Array.from({ length: 150 }, () => ["p", 0, "filler"]),
    ];
    d.refs = { [`${issue.owner}/${issue.repo}#${issue.number}`.toLowerCase()]: { id: issue.id, kind: "issue", title: issue.title, state: "open", state_reason: null } };
    await route.fulfill({ response: res, json: d });
  });
  await page.goto(`/issues/${issue.id}`);
  const target = page.locator(`[data-comment-id="${comment}"]`);
  for (const name of [`#${issue.number} (comment)`, "that comment"]) {
    const link = body(page).getByRole("link", { name, exact: true });
    // Back to the top: a refetch may swap the body's nodes as this runs, so it's retried.
    await expect(async () => link.scrollIntoViewIfNeeded({ timeout: 1000 })).toPass();
    await expect(link).toHaveAttribute("href", `/issues/${issue.id}`);
    await expect(target).toBeAttached();
    await expect(target).not.toBeInViewport();
    await link.click();
    await expect(target).toBeInViewport();
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}$`));
  }
});

/** The highlight.js modules a page loaded: `core`, or a language's name (Vite's pre-bundled deps). */
function highlightLoads(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const m = /highlight__js_lib_(?:languages_)?([\w-]+?)\.js/.exec(new URL(r.url()).pathname);
    if (m) seen.push(m[1]!);
  });
  return seen;
}

/** A language chunk's URL, in dev. */
const chunk = (language: string) => new RegExp(`highlight__js_lib_languages_${language}\\.js`);

const block = (lang: string | undefined, code: string) => ["pre", 0, ["code", lang ? { class: `language-${lang}` } : 0, code]];

const RUST = "pub fn apply(&mut self) -> Result<(), Error> {\n    // already applied\n    Ok(())\n}\n";

/**
 * Opens the first listed issue with `body` in place of its own, and plain comments (the fixture's
 * bodies have code; its comments don't, but nothing here relies on that).
 */
async function openWithBody(page: Page, body: unknown[], index = 0): Promise<Row> {
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
  const list = (await (await page.request.get("/api/issues")).json()) as { rows: Row[] };
  const t = list.rows[index]!;
  await page.route(new RegExp(`/api/issues/${t.id}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.body = body;
    for (const c of d.comments.comments) c.body = [["p", 0, "A comment."]];
    await route.fulfill({ response: res, json: d });
  });
  await page.goto(`/issues/${t.id}`);
  return t;
}

/**
 * Each element in the body, but what's inside a code block's text: its box. A block's text is
 * where it starts and how tall it is (its width is its longest line's, which splitting the text
 * into spans may round differently, by a fraction of a pixel, moving nothing).
 */
const boxes = (page: Page) =>
  body(page).evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .filter((e) => !e.closest("pre code"))
      .map((e) => {
        const r = e.getBoundingClientRect();
        return [e.tagName, r.x, r.y, r.width, r.height].join(" ");
      })
      .concat([...root.querySelectorAll("pre code")].map((e) => {
        const r = e.getBoundingClientRect();
        return ["CODE", r.x, r.y, r.height].join(" ");
      })),
  );

test("a Rust-only thread loads highlight.js's core and its Rust chunk, and colours the Rust", async ({ page }) => {
  const loads = highlightLoads(page);
  await openWithBody(page, [block("rust", RUST), block(undefined, "plain text\n"), block("zig", "const std = 1;\n")]);
  const rust = body(page).locator("pre").first();
  await expect(rust.locator("span").first()).toBeAttached();
  // A keyword in a colour of its own; the text as written.
  const fn = rust.locator("span", { hasText: /^fn$/ });
  expect(await fn.evaluate((e) => getComputedStyle(e).color)).not.toBe(await rust.evaluate((e) => getComputedStyle(e).color));
  await expect(rust).toHaveText(RUST.replace(/\n$/, ""), { useInnerText: false });
  // The unlabelled block and the unknown language stay plain, with only the label shown.
  await expect(body(page).locator("pre").nth(1).locator("span")).toHaveCount(0);
  await expect(body(page).locator("pre").nth(2).locator("span")).toHaveCount(0);
  await expect(body(page).locator('[data-perf="code-head"]')).toHaveText(["Rust", "zig"]);
  await page.waitForTimeout(500);
  expect(loads.toSorted()).toEqual(["core", "rust"]);
});

test("a thread whose only code is unlabelled loads no highlighting at all", async ({ page }) => {
  const loads = highlightLoads(page);
  await openWithBody(page, [["p", 0, "Logs:"], block(undefined, "[12:00:01] sse: connected\n")]);
  await expect(body(page).locator("pre")).toHaveText("[12:00:01] sse: connected");
  await expect(body(page).locator('[data-perf="code-head"]')).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(loads).toEqual([]);
});

test("highlighting colours code in place: nothing in the post moves", async ({ page }) => {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route(chunk("rust"), async (route) => {
    await released;
    await route.continue();
  });
  await openWithBody(page, [["p", 0, "Before"], block("rust", RUST.repeat(3)), ["p", 0, "After"]]);
  await expect(body(page)).toContainText("After");
  const pre = body(page).locator("pre");
  await expect(pre.locator("span")).toHaveCount(0);
  const before = await boxes(page);
  const height = await page.locator('[data-perf="detail"]').evaluate((e) => e.scrollHeight);
  release();
  await expect(pre.locator("span").first()).toBeAttached();
  expect(await boxes(page)).toEqual(before);
  expect(await page.locator('[data-perf="detail"]').evaluate((e) => e.scrollHeight)).toBe(height);
});

test("a language chunk that fails to load leaves its block plain, the page in place, and the next block tries again", async ({ page }) => {
  await page.route(chunk("rust"), (route) => route.abort());
  const t = await openWithBody(page, [block("rust", RUST)]);
  // Gone if the page reloads.
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
  const stayed = () => page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed === true);
  const pre = body(page).locator("pre");
  await expect(pre).toHaveText(RUST.replace(/\n$/, ""));
  await expect(body(page).locator('[data-perf="code-head"]')).toHaveText("Rust");
  await page.waitForTimeout(1000);
  await expect(pre.locator("span")).toHaveCount(0);
  // No reload, and none coming: a failed language isn't a failed route.
  expect(await stayed()).toBe(true);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("beghu.chunk-reload:")))).toEqual([]);
  await expect(page.locator(`[data-perf="detail"][data-id="${t.id}"]`)).toBeVisible();

  // With the chunk back, the next issue with Rust in it is coloured, in the same page.
  await page.unroute(chunk("rust"));
  const list = (await (await page.request.get("/api/issues")).json()) as { rows: Row[] };
  const next = list.rows[1]!;
  await page.route(new RegExp(`/api/issues/${next.id}(\\?.*)?$`), async (route) => {
    const res = await route.fetch();
    const d = await res.json();
    d.body = [block("rust", RUST)];
    await route.fulfill({ response: res, json: d });
  });
  await rows(page).nth(1).click();
  await expect(page.locator(`[data-perf="detail"][data-id="${next.id}"]`)).toBeVisible();
  await expect(body(page).locator("pre span").first()).toBeAttached();
  expect(await stayed()).toBe(true);
});
