// Held changes in the issue detail (#110), in a real browser: outside edits on Fake GitHub reach
// the open issue through its live refetch, and the detail holds what would move text while the
// user may be about to act, then applies it behind the shift cue, animated.
//
// With the live project's one worker (playwright.config.ts): each edit lifts its issue to the top
// of the default list every tab shows. Each test claims an issue below the top and closes it again
// once done, as live.spec.ts does, so it leaves the default list.
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, claimLongThread, issuesBelowTheTop, unique, type Issue } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";
import { devCtl } from "./stack";

test.describe.configure({ mode: "serial" });

const detail = (page: Page) => page.locator('[data-perf="detail"]');
const comments = (page: Page) => page.locator('[data-perf="comment"]');
const commentSaying = (page: Page, text: string) => comments(page).filter({ hasText: text });
const cueLines = (page: Page) => detail(page).locator('[data-perf="cue-line"]');
const total = (page: Page) => page.locator('[data-perf="comment-total"]');

/**
 * Opens `issue` in the panel, with the stream up: its opening reset refetches the issue if it
 * came after the issue's read began, and then that refetch is done too.
 */
async function open(page: Page, issue: Issue): Promise<void> {
  const refetched = page.waitForResponse((r) => r.url().includes(`/api/issues/${issue.id}?through=`) && r.ok(), { timeout: 3000 }).catch(() => {});
  const stream = page.waitForResponse((r) => r.url().includes("/api/stream"));
  await page.goto(`/issues/${issue.id}`);
  await expect(detail(page)).toHaveAttribute("data-id", String(issue.id));
  await stream;
  await refetched;
}

/** Closes `issue` on "GitHub", so it leaves the default list again, and waits until beghu has it. */
async function closeForGood(page: Page, issue: Issue): Promise<void> {
  devCtl(["fake", "edit", issue.ref, "--close"]);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, { timeout: SHOWS_WITHIN_MS })
    .toBe("closed");
}

/**
 * Scrolls the thread's top into view, where a new comment opens (newest first): a change wholly
 * off screen applies at once, unheld.
 */
const toTheThread = (page: Page) => detail(page).evaluate((el) => el.querySelector('[data-k="comments-head"]')!.scrollIntoView({ block: "start" }));

/** A spot over the issue's text, in the panel. */
async function overTheIssue(page: Page): Promise<{ x: number; y: number }> {
  const box = (await detail(page).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Puts the pointer outside the panel, over the page's header. */
const pointerAway = (page: Page) => page.mouse.move(5, 5);

/**
 * Keeps the pointer moving over the issue, as a hand on the mouse does, until the result is
 * called: between two spots, so no move repeats the last one's coordinates.
 */
async function keepMoving(page: Page): Promise<() => Promise<void>> {
  const { x, y } = await overTheIssue(page);
  let on = true;
  let i = 0;
  await page.mouse.move(x, y);
  const loop = (async () => {
    while (on) {
      await page.mouse.move(x + (++i % 2) * 7, y);
      await page.waitForTimeout(150);
    }
  })();
  return async () => {
    on = false;
    await loop;
  };
}

/** One frame of the detail, as `record` keeps it whenever something it looks at changes. */
type Frame = {
  at: number;
  /** Each cue line's text, after its unit's name when it's in one (`blocks:blocker added`). */
  lines: string[];
  /** Each outlined part: its unit, or what it is, and how (`labels=change`). */
  marked: string[];
  /** Whether the comment saying the text watched for is in the thread. */
  has: boolean;
  /** What a scripted animation (a height opening or closing) runs on: its key. */
  anims: string[];
  /** The Blocks unit's height. */
  blocks: number;
  /** How many labels the Labels row shows. */
  labels: number;
  /** Where the watched comment, or else the reference element, sits from the scroller's top. */
  y?: number;
};
type Record = { lastMove: number; frames: Frame[] };

/**
 * From now on, in the page, per frame: what the detail cues, whether a comment saying `text` is
 * there, what animates, and where `[data-k="<ref>"]` sits (or the comment, without `ref`); and when
 * the pointer last moved to new coordinates. Call the result to read them.
 */
async function record(page: Page, text: string, ref?: string): Promise<() => Promise<Record>> {
  await page.evaluate(
    ([text, ref]) => {
      const r: Record = { lastMove: -Infinity, frames: [] };
      (window as unknown as { rec: Record }).rec = r;
      let at = { x: NaN, y: NaN };
      addEventListener(
        "pointermove",
        (e) => {
          if (e.clientX === at.x && e.clientY === at.y) return;
          at = { x: e.clientX, y: e.clientY };
          r.lastMove = performance.now();
        },
        true,
      );
      let last = "";
      const frame = () => {
        const d = document.querySelector<HTMLElement>('[data-perf="detail"]');
        if (d) {
          const lines = [...d.querySelectorAll('[data-perf="cue-line"]')].map((l) => {
            const unit = l.closest("[data-unit]")?.getAttribute("data-unit");
            return `${unit ? `${unit}:` : ""}${l.textContent}`;
          });
          const marked = [...d.querySelectorAll("[data-cue]")].map((e) => `${e.getAttribute("data-unit") ?? e.getAttribute("data-perf") ?? e.getAttribute("data-k")}=${e.getAttribute("data-cue")}`);
          const mine = [...d.querySelectorAll<HTMLElement>('[data-perf="comment"]')].find((c) => c.textContent?.includes(text));
          const anims = document
            .getAnimations()
            .filter((a) => !(a instanceof CSSAnimation) && !(a instanceof CSSTransition) && a.playState === "running")
            .map((a) => (a.effect as KeyframeEffect | null)?.target)
            .filter((t): t is Element => !!t && d.contains(t))
            .map((t) => t.getAttribute("data-k") ?? "?");
          const blocks = d.querySelector('[data-unit="blocks"]')?.getBoundingClientRect().height ?? -1;
          const watched = ref ? d.querySelector(`[data-k="${ref}"]`) : mine;
          const y = watched ? watched.getBoundingClientRect().top - d.getBoundingClientRect().top : undefined;
          const labels = d.querySelectorAll('[data-perf="labels"] [data-perf="label"]').length;
          const f = { lines, marked, has: !!mine, anims, blocks, labels, y };
          const sig = JSON.stringify(f);
          if (sig !== last) r.frames.push({ at: performance.now(), ...f });
          last = sig;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    [text, ref] as const,
  );
  return () => page.evaluate(() => (window as unknown as { rec: Record }).rec);
}

/** Until nothing in the detail animates. */
const settled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(() => {
        const d = document.querySelector('[data-perf="detail"]');
        return document.getAnimations().filter((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return !(a instanceof CSSAnimation) && !!t && !!d?.contains(t);
        }).length;
      }),
    )
    .toBe(0);

/** A comment long enough that its opening takes about a second. */
const longComment = (text: string) => [text, ...[...Array(40).keys()].map((i) => `Line ${i} of a long comment.`)].join("\n\n");

/**
 * From now on, in the page: how the first opening of a comment's slot goes, `running` once it
 * has started, then how it ended first (`finished`, `cancelled`); call the result to read it.
 */
async function watchOpening(page: Page): Promise<() => Promise<string | undefined>> {
  await page.evaluate(() => {
    const w = window as unknown as { opening?: string };
    delete w.opening;
    const look = () => {
      const a = document
        .getAnimations()
        .find((a) => !(a instanceof CSSAnimation) && ((a.effect as KeyframeEffect | null)?.target as Element | null)?.getAttribute("data-k")?.startsWith("c:"));
      if (!a) return requestAnimationFrame(look);
      w.opening = "running";
      a.addEventListener("finish", () => (w.opening = w.opening === "running" ? "finished" : w.opening));
      a.addEventListener("cancel", () => (w.opening = w.opening === "running" ? "cancelled" : w.opening));
    };
    requestAnimationFrame(look);
  });
  return () => page.evaluate(() => (window as unknown as { opening?: string }).opening);
}

/**
 * Slows every animation in the page to a fifth of its speed (Chrome's own playback rate, as its
 * devtools set it): a change's opening, about a second at most, lasts long enough for a test to
 * act in the middle of it however loaded the machine is.
 */
async function slowMotion(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.2 });
}

/** The first frame that `test` holds for. */
const first = (r: Record, test: (f: Frame) => boolean) => r.frames.find(test);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
});

test("a comment arriving while the pointer moves over the issue is held, then applies after 5 s of rest behind the cue and an animation", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    await toTheThread(page);
    const stop = await keepMoving(page);
    const text = unique("A teammate's comment");
    const read = await record(page, text);
    devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "ilze-k"]);

    // The count updates in place at once; the comment waits while the pointer moves.
    await expect(total(page)).toHaveText(String(issue.comments + 1), { timeout: SHOWS_WITHIN_MS });
    await page.waitForTimeout(2000);
    await expect(commentSaying(page, text)).toHaveCount(0);
    expect((await read()).frames.filter((f) => f.lines.length > 0 || f.marked.length > 0)).toEqual([]);

    // At rest, it applies: the cue first, a line where it opens, then the comment opens.
    await stop();
    await expect(commentSaying(page, text)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await settled(page);
    const r = await read();
    const cue = first(r, (f) => f.lines.length > 0)!;
    expect(cue.lines).toEqual(["ilze-k commented"]);
    expect(cue.at - r.lastMove, "ms from the pointer's last move to the cue").toBeGreaterThanOrEqual(5000);
    const shown = first(r, (f) => f.has)!;
    expect(shown.at - cue.at, "ms the cue showed").toBeGreaterThanOrEqual(690);
    // It opened: its slot's height animated, and it's the newest, on top.
    expect(r.frames.some((f) => f.has && f.anims.some((k) => k.startsWith("c:")))).toBe(true);
    await expect(comments(page).first()).toContainText(text);
  } finally {
    await closeForGood(page, issue);
  }
});

test("scrolled deep in a long thread, a comment arriving above the viewport keeps the reading position to the pixel", async ({ page }) => {
  const issue = await claimLongThread(page, 30);
  try {
    await open(page, issue);
    // Page 2 is in: 30 comments.
    await expect.poll(() => comments(page).count(), { timeout: SHOWS_WITHIN_MS }).toBeGreaterThanOrEqual(30);
    // The 20th comment at the top of the viewport.
    const deep = await comments(page).nth(19).getAttribute("data-id");
    await detail(page).evaluate((el, id) => {
      const c = el.querySelector(`[data-k="c:${id}"]`)!;
      el.scrollTop += c.getBoundingClientRect().top - el.getBoundingClientRect().top + 40;
    }, deep);
    // Its layout has settled (the comments it passed lay out as they come near).
    await page.waitForTimeout(500);
    const stop = await keepMoving(page);
    try {
      const text = unique("Arrives above");
      const read = await record(page, text, `c:${deep}`);
      devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "ilze-k"]);
      // Off screen, so it applies at once, though the pointer moves: newest first, on top.
      await expect(commentSaying(page, text)).toHaveCount(1, { timeout: SHOWS_WITHIN_MS });
      await expect(comments(page).first()).toContainText(text);
      await page.waitForTimeout(300);
      const r = await read();
      const ys = [...new Set(r.frames.map((f) => f.y))];
      expect(ys, "where the comment at the viewport's top sat, each frame").toHaveLength(1);
      expect(r.frames.filter((f) => f.lines.length > 0)).toEqual([]);
    } finally {
      await stop();
    }
  } finally {
    await closeForGood(page, issue);
  }
});

test("a label added on GitHub cues only the Labels line, then the row takes it", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  const d = (await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { repo_id: number; labels: { name: string }[] };
  const all = (await (await page.request.get(`/api/repos/${d.repo_id}/labels`)).json()) as { name: string }[];
  const label = all.map((l) => l.name).find((n) => !d.labels.some((l) => l.name === n) && /^[\w-]+$/.test(n))!;
  expect(label, "a label the issue doesn't have").toBeDefined();
  try {
    await open(page, issue);
    await pointerAway(page);
    const read = await record(page, "");
    const had = d.labels.length;
    devCtl(["fake", "edit", issue.ref, "--label", label]);
    const labels = detail(page).locator('[data-perf="labels"] [data-perf="label"]');
    await expect(labels.filter({ hasText: label })).toHaveCount(1, { timeout: SHOWS_WITHIN_MS });
    await settled(page);
    const r = await read();
    const cues = r.frames.filter((f) => f.lines.length > 0 || f.marked.length > 0);
    expect(cues.length).toBeGreaterThan(0);
    // Only its own line, outlined; nothing else is marked, and the row still shows what it had.
    for (const f of cues) {
      expect(f.lines).toEqual([]);
      expect(f.marked).toEqual(["labels=change"]);
      expect(f.labels).toBe(had);
    }
    expect(r.frames.at(-1)!.labels).toBe(had + 1);
    // The cue showed before the label did.
    const cue = first(r, (f) => f.marked.length > 0)!;
    expect(cue.at).toBeLessThan(r.frames.at(-1)!.at);
  } finally {
    devCtl(["fake", "edit", issue.ref, "--unlabel", label]);
    await closeForGood(page, issue);
  }
});

test("a first blocker opens from the zero-height spot of the empty Blocks section", async ({ page }) => {
  type Rels = { relationships: { blocked_by: unknown[]; blocking: unknown[] } };
  const free = async (i: Issue) => {
    const d = (await (await page.request.get(`/api/issues/${i.id}`)).json()) as Rels;
    return d.relationships.blocked_by.length === 0 && d.relationships.blocking.length === 0;
  };
  // The first unclaimed issue below the top with an empty Blocks section.
  let issue: Issue | undefined;
  for (const c of await issuesBelowTheTop(page)) {
    if (!(await free(c))) continue;
    issue = await claimBelowTheTop(page, (r) => r.id === c.id).catch(() => undefined);
    if (issue) break;
  }
  if (!issue) throw new Error("no unclaimed issue below the top without dependencies");
  const blocker = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    const unit = detail(page).locator('[data-unit="blocks"]');
    expect((await unit.boundingBox())!.height).toBe(0);
    await pointerAway(page);
    const read = await record(page, "");
    devCtl(["fake", "edit", issue.ref, "--add-blocked-by", blocker.ref]);
    const item = detail(page).locator(`[data-perf="blocked_by"] [data-perf="block-item"][data-id="${blocker.id}"]`);
    await expect(item).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await settled(page);
    const r = await read();
    // The cue: a labelled line in the empty section's spot, which takes no room.
    const cue = first(r, (f) => f.lines.length > 0)!;
    expect(cue.lines).toEqual(["blocks:blocker added"]);
    expect(cue.blocks).toBe(0);
    // Then the section opened from nothing, gap and all.
    const opening = r.frames.filter((f) => f.anims.includes("u:blocks"));
    expect(opening.length).toBeGreaterThan(0);
    expect(opening[0]!.blocks).toBeLessThan(r.frames.at(-1)!.blocks);
    expect(r.frames.at(-1)!.blocks).toBeGreaterThan(20);
  } finally {
    devCtl(["fake", "edit", issue.ref, "--remove-blocked-by", blocker.ref]);
    await closeForGood(page, issue);
    await closeForGood(page, blocker);
  }
});

test("moving the pointer during the cue cancels it, and an animation that has started finishes", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    await toTheThread(page);
    await pointerAway(page);
    const text = unique("A long comment");
    const long = longComment(text);
    const opening = await watchOpening(page);
    devCtl(["fake", "edit", issue.ref, "--comment", long, "--as", "ilze-k"]);

    // The cue shows; the pointer moves onto the issue, and the cue goes: nothing applied.
    await expect(cueLines(page)).toHaveCount(1, { timeout: SHOWS_WITHIN_MS });
    const stop = await keepMoving(page);
    await expect(cueLines(page)).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expect(commentSaying(page, text)).toHaveCount(0);
    await stop();

    // Away again: the cue, then the opening. The pointer moves onto the issue meanwhile, and the
    // opening still runs to its end.
    await pointerAway(page);
    await expect.poll(opening, { timeout: SHOWS_WITHIN_MS }).toBe("running");
    const again = await keepMoving(page);
    try {
      await expect.poll(opening).toBe("finished");
      await expect(commentSaying(page, text)).toBeVisible();
      const slot = commentSaying(page, text).locator("xpath=..");
      expect(await slot.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(500);
    } finally {
      await again();
    }
  } finally {
    await closeForGood(page, issue);
  }
});

test("your own pending comment changes nothing when GitHub confirms it, while the pointer moves", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    await toTheThread(page);
    const composer = page.locator('[data-perf="composer"]');
    const text = unique("My own comment");
    await composer.locator("textarea").fill(text);
    const stop = await keepMoving(page);
    const read = await record(page, text);
    try {
      // GitHub takes its time, so the comment shows as pending first.
      devCtl(["fake", "latency", `POST /repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments`, "1500", "--count", "1"]);
      await composer.getByRole("button", { name: "Comment", exact: true }).click();
      const mine = commentSaying(page, text);
      await expect(mine.locator('[data-perf="pending"]')).toBeVisible();
      // Confirmed, and the thread's own read shows it, though the pointer never rests.
      await expect(mine.locator('[data-perf="pending"]')).toHaveCount(0, { timeout: SHOWS_WITHIN_MS });
      await expect.poll(async () => Number(await mine.getAttribute("data-id")), { timeout: SHOWS_WITHIN_MS }).toBeGreaterThan(0);
    } finally {
      await stop();
    }
    // At rest, past when a held change would have shown its cue and opened: nothing was held.
    await pointerAway(page);
    await page.waitForTimeout(700 + 1500 + 800);
    {
      const r = await read();
      const shown = r.frames.filter((f) => f.has);
      // No cue, no animation, and it never moved.
      expect(r.frames.filter((f) => f.lines.length > 0 || f.marked.length > 0)).toEqual([]);
      expect(r.frames.filter((f) => f.anims.length > 0)).toEqual([]);
      expect([...new Set(shown.map((f) => f.y))]).toHaveLength(1);
    }
  } finally {
    await closeForGood(page, issue);
  }
});

test("opening the next issue while a change animates leaves nothing of it on the new issue", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    await toTheThread(page);
    await pointerAway(page);
    await slowMotion(page);
    const opening = await watchOpening(page);
    devCtl(["fake", "edit", issue.ref, "--comment", longComment(unique("A long comment")), "--as", "ilze-k"]);
    await expect.poll(opening, { timeout: SHOWS_WITHIN_MS }).toBe("running");

    // Mid-animation, the next issue opens by its key: a neighbour the keys read ahead, so the
    // panel shows it in place.
    await page.keyboard.press("j");
    await expect(detail(page)).not.toHaveAttribute("data-id", String(issue.id));
    await pointerAway(page);
    // From here on, per frame: its scroll position, and what animates or keeps a tint in it.
    const frames = await page.evaluate(
      () =>
        new Promise<{ top: number; anims: number }[]>((done) => {
          const out: { top: number; anims: number }[] = [];
          const until = performance.now() + 2500;
          const frame = () => {
            const d = document.querySelector('[data-perf="detail"]')!;
            const anims = document.getAnimations().filter((a) => {
              const t = (a.effect as KeyframeEffect | null)?.target;
              return !!t && d.contains(t);
            }).length;
            out.push({ top: d.scrollTop, anims });
            if (performance.now() < until) requestAnimationFrame(frame);
            else done(out);
          };
          requestAnimationFrame(frame);
        }),
    );
    // It opened at its top and stayed there, with nothing clipped or tinted.
    expect([...new Set(frames.map((f) => f.top))]).toEqual([0]);
    expect(frames.filter((f) => f.anims > 0)).toEqual([]);
  } finally {
    await closeForGood(page, issue);
  }
});

test("scrolling during an animation keeps the user's scroll; the animation still finishes", async ({ page }) => {
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    await toTheThread(page);
    await pointerAway(page);
    await slowMotion(page);
    const opening = await watchOpening(page);
    devCtl(["fake", "edit", issue.ref, "--comment", longComment(unique("A long comment")), "--as", "ilze-k"]);
    await expect.poll(opening, { timeout: SHOWS_WITHIN_MS }).toBe("running");

    // The user scrolls down meanwhile, by the wheel over the issue.
    const before = await detail(page).evaluate((el) => el.scrollTop);
    const { x, y } = await overTheIssue(page);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 400);
    await expect.poll(() => detail(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 200);
    await expect.poll(opening, { timeout: 15_000 }).toBe("finished");
    await settled(page);
    await page.waitForTimeout(300);
    // Where the user scrolled to stays: the app didn't scroll it back.
    expect(await detail(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 200);
  } finally {
    await closeForGood(page, issue);
  }
});

test("with reduced motion, the cue is a still mark for about 900 ms and the change swaps in unanimated", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const issue = await claimBelowTheTop(page);
  try {
    await open(page, issue);
    await toTheThread(page);
    await pointerAway(page);
    const text = unique("A comment, still");
    const read = await record(page, text);
    devCtl(["fake", "edit", issue.ref, "--comment", text, "--as", "ilze-k"]);
    await expect(commentSaying(page, text)).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    await page.waitForTimeout(500);
    const r = await read();
    const cue = first(r, (f) => f.lines.length > 0)!;
    expect(cue.lines).toEqual(["ilze-k commented"]);
    const shown = first(r, (f) => f.has)!;
    // Its 900 ms, longer than the moving cue's 700, as frames on a loaded machine time them.
    expect(shown.at - cue.at, "ms the still mark showed").toBeGreaterThanOrEqual(800);
    // No height animated, and no tint.
    expect(r.frames.filter((f) => f.anims.length > 0)).toEqual([]);
    expect(
      await page.evaluate(() => {
        const d = document.querySelector('[data-perf="detail"]')!;
        return document.getAnimations().filter((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return !!t && d.contains(t);
        }).length;
      }),
    ).toBe(0);
  } finally {
    await closeForGood(page, issue);
  }
});
