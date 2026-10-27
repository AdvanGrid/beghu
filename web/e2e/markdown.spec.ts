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
  // Anything else: GitHub, marked ↗.
  const out = body(page).locator("p").first().locator('a[data-ref="out"]');
  await expect(out).toHaveText("else/where#7 ↗");
  await expect(out).toHaveAttribute("href", "https://github.com/else/where/issues/7");
  await expect(out).toHaveAttribute("target", "_blank");
  // Users and teams too.
  const user = body(page).getByRole("link", { name: "@ilze-k ↗" });
  await expect(user).toHaveAttribute("href", "https://github.com/ilze-k");
  await expect(user).toHaveAttribute("title", "Opens on GitHub");
  await expect(user).toHaveAttribute("target", "_blank");
  const team = body(page).getByRole("link", { name: "@acme/core ↗" });
  await expect(team).toHaveAttribute("href", "https://github.com/orgs/acme/teams/core");
  await expect(team).toHaveAttribute("title", "Opens on GitHub");
  await expect(team).toHaveAttribute("target", "_blank");
  // A link to a comment names it, as GitHub does.
  const comments = body(page).locator("p").nth(1).locator("a");
  await expect(comments.nth(0)).toHaveText(`#${x.number} (comment)`);
  await expect(comments.nth(0)).toHaveAttribute("href", `/issues/${x.id}`);
  await expect(comments.nth(1)).toHaveText("else/where#7 (comment) ↗");
  await expect(comments.nth(1)).toHaveAttribute("href", "https://github.com/else/where/issues/7#issuecomment-34");

  // Nothing the walker doesn't allow: no script, frame or handler, no unsafe URL, no style.
  await expect(body(page).getByText("bad link")).not.toHaveAttribute("href", /.*/);
  await expect(body(page).getByRole("link", { name: "good link" })).toHaveAttribute("href", "https://example.com/x");
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
