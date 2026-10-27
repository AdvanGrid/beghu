// Timing a change made on GitHub to the screen, for the specs that make one.
//
// #86 asks for an outside change to show "within 1–2 s". The path has three legs: GitHub's
// delivery (Fake GitHub holds each about a second, as GitHub does), the server applying it and
// pushing the ids, and the tab refetching and drawing them. The server's legs are timed in
// crates/server/tests; on a loaded test machine they alone can take over 2 s, which says nothing
// about the tab. So the browser suite holds the tab's share to the whole 2 s budget, timed in the
// page from the push that brought the change (the last one naming the issue before it showed:
// a cross-repo change pushes once for the delivery, which can't name the other end, and again
// once the read-back has it) to the first frame showing it, and waits for the change itself
// (that it shows at all, with no reload) far longer.
import { expect, type Page } from "@playwright/test";

/** #86's budget for an outside change to show, held here to the tab's share of it. */
export const BUDGET_MS = 2000;

/**
 * How long an outside change may take to reach the screen at all, on a loaded machine: the
 * server's apply of one delivery took 11 s while the disk was stalled.
 */
export const SHOWS_WITHIN_MS = 20_000;

type Timing = { pushes: { at: number; ids: number[] }[]; since?: number; shownAt?: number };

/** From the page's next load on, records when each `ids` push reaches the tab. */
export async function recordPushes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { pushTiming: Timing };
    w.pushTiming = { pushes: [] };
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        // Added before the app's own listener, so it's the push's arrival.
        this.addEventListener("ids", (e) => {
          w.pushTiming.pushes.push({ at: performance.now(), ids: (JSON.parse((e as MessageEvent<string>).data) as { ids: number[] }).ids });
        });
      }
    };
  });
}

/**
 * Starts watching, every frame, for `shown(arg)` to hold; call it before the change is made, on
 * a page `recordPushes` was set up on. The result waits for the change to show, then holds the
 * time from the last push naming `id` before that frame to the budget.
 */
export async function timeFromPush<A>(page: Page, id: number | string, shown: (arg: A) => boolean, arg: A): Promise<() => Promise<void>> {
  await page.evaluate(
    ([src, arg]) => {
      const w = window as unknown as { pushTiming: Timing };
      const test = new Function(`return (${src})`)() as (a: unknown) => boolean;
      w.pushTiming.since = performance.now();
      delete w.pushTiming.shownAt;
      const frame = () => {
        if (test(arg)) w.pushTiming.shownAt = performance.now();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    [shown.toString(), arg] as const,
  );
  return async () => {
    const timing = () => page.evaluate(() => (window as unknown as { pushTiming: Timing }).pushTiming);
    await expect.poll(async () => (await timing()).shownAt, { timeout: SHOWS_WITHIN_MS }).toBeDefined();
    const t = await timing();
    const push = t.pushes.filter((p) => p.at >= t.since! && p.at <= t.shownAt! && p.ids.includes(Number(id))).at(-1);
    expect(push, `a push named ${id} before it showed`).toBeDefined();
    expect(t.shownAt! - push!.at, "ms from the push reaching the tab to the change on screen").toBeLessThanOrEqual(BUDGET_MS);
  };
}
