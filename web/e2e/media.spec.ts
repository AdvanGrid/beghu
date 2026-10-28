// Images, attachments and video in a real browser (#100): attachments uploaded to Fake GitHub and
// images on its stand-in for the web's image hosts, in a comment written there, rendered by the
// server and drawn by the walker. Every image loads through beghu, sized before it loads; one
// known not to load is never asked for and says why; one that fails shows one placeholder with a
// Retry, once (a video too); a video plays in-app; a file is a chip to GitHub; and a click, or `i`
// or Enter on a focused image, opens an image in the lightbox unless it's inside a link. The
// routes themselves (the guard, caps, Range, sessions) are tested at the server's HTTP seam
// (crates/server/tests/media.rs).
//
// It comments on an issue, which moves it to the top of the list for every tab, so it runs with
// the specs that edit (playwright.config.ts), on an issue of its own below the top, which it
// leaves closed (writes.spec.ts's rules).
import { expect, test, type Page } from "@playwright/test";
import { claimBelowTheTop, shared, type Issue } from "./claims";
import { SHOWS_WITHIN_MS } from "./push";
import { devCtl, status } from "./stack";

type Upload = { uuid: string; url: string; markdown: string };

function upload(kind: "image" | "video", ...size: string[]): Upload {
  return JSON.parse(devCtl(["fake", "upload", kind, ...size, "--json"])) as Upload;
}

const thread = (page: Page, marker: string) => page.locator('[data-perf="comment"]', { hasText: marker });

let release: () => void = () => {};

test.beforeEach(async ({ page }) => {
  release = await shared();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/auth/login?login=tomsj");
  await page.waitForURL((u) => u.pathname === "/");
});

test.afterEach(() => release());

test("images load through beghu at their size, a bad one says why, a video plays, a file is a chip", async ({ page }) => {
  const issue: Issue = await claimBelowTheTop(page);
  const fake = status().urls.fake;
  const shot = upload("image", "--width", "400", "--height", "300");
  const video = upload("video");
  const marker = `media ${Date.now()}`;
  const md = [
    marker,
    shot.markdown,
    video.url,
    `Tall, unsized: ![tall](${fake}/ext/img/300x900.png)`,
    `Too large: ![big](${fake}/ext/big.png) and not one: ![page](${fake}/ext/page.html)`,
    `Missing: <img width="360" height="120" alt="gone" src="${fake}/ext/img/0x0.png">`,
    `A badge: [![badge](${fake}/ext/img/90x20.png)](https://example.com/build)`,
    `Logs: [build logs](https://github.com/user-attachments/files/4242/build.log.zip)`,
    `Last, tall and sized: <img width="200" height="1200" alt="authored" src="${fake}/ext/img/200x1200.png">`,
  ].join("\n\n");
  // Every request the page makes for an image or attachment.
  const asked: string[] = [];
  page.on("request", (r) => {
    if (/\/api\/(img|attachments)/.test(r.url())) asked.push(decodeURIComponent(r.url()));
  });
  // The images answer late, so their boxes can be measured before any has loaded. The video's
  // requests fail, as a network blip would, until its Retry: every one of them, since Chromium's
  // media loader tries a failed load again by itself before it gives up.
  let videoDown = true;
  await page.route(/\/api\/(img|attachments)/, async (route) => {
    if (route.request().url().includes(video.uuid) && videoDown) {
      await route.abort();
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  try {
    devCtl(["fake", "edit", issue.ref, "--comment", md]);
    // Once the server has the comment and has measured its images (its webhook's push waits for
    // them), the issue opens.
    await expect
      .poll(
        async () => {
          const page1 = (await (await page.request.get(`/api/issues/${issue.id}/comments?order=newest`)).json()) as {
            media: Record<string, { unavailable?: string; type?: string; h?: number }>;
          };
          return Object.values(page1.media).map((m) => `${m.unavailable ?? m.type} ${m.h ?? ""}`.trim());
        },
        { timeout: SHOWS_WITHIN_MS },
      )
      .toEqual(expect.arrayContaining(["image/png 900", "too_large", "not_image", "video/webm 180"]));
    await page.goto(`/issues/${issue.id}`);
    const c = thread(page, marker);
    await expect(c).toBeVisible({ timeout: SHOWS_WITHIN_MS });
    const media = c.locator('img[data-perf="media"]');

    // Sized before a byte arrives: the uploader's size, and the measured one capped at 480 px.
    const attachment = media.nth(0);
    await expect(attachment).toHaveAttribute("src", `/api/attachments/${shot.uuid}`);
    // A zoomable image is a button, named for what it opens.
    const tall = c.getByRole("button", { name: "Open image: tall" });
    await expect(tall).toHaveAttribute("height", "480", { timeout: SHOWS_WITHIN_MS });
    await expect(tall).toHaveAttribute("width", "160");
    const before = await c.evaluate((e) => e.getBoundingClientRect().height);
    expect(await attachment.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(false);
    expect((await attachment.boundingBox())!.height).toBeCloseTo(300, 0);
    expect((await tall.boundingBox())!.height).toBeCloseTo(480, 0);
    // The post's own size is capped too, its proportions kept.
    const authored = c.getByRole("button", { name: "Open image: authored" });
    await expect(authored).toHaveAttribute("height", "480");
    await expect(authored).toHaveAttribute("width", "80");
    expect((await authored.boundingBox())!.height).toBeCloseTo(480, 0);
    // Loaded, and the thread didn't move.
    await expect.poll(() => attachment.evaluate((e: HTMLImageElement) => e.naturalWidth), { timeout: SHOWS_WITHIN_MS }).toBe(400);
    await expect.poll(() => tall.evaluate((e: HTMLImageElement) => e.naturalHeight), { timeout: SHOWS_WITHIN_MS }).toBe(900);
    expect(await c.evaluate((e) => e.getBoundingClientRect().height)).toBe(before);

    // Known not to load: the reason, a link to the original, and no request at all.
    const failed = c.locator('[data-perf="media-failed"]');
    await expect(failed.filter({ hasText: "big" })).toContainText("Too large to preview");
    await expect(failed.filter({ hasText: "page" })).toContainText("Not an image");
    await expect(failed.filter({ hasText: "big" }).getByRole("link", { name: "Open original" })).toHaveAttribute("href", `${fake}/ext/big.png`);
    expect(asked.filter((u) => u.includes("/ext/big.png") || u.includes("/ext/page.html"))).toEqual([]);

    // Failed as it loaded: one placeholder in the image's box (it grows only for a message that
    // doesn't fit), with a Retry, once.
    const gone = failed.filter({ hasText: "gone" });
    // In view, so its lazy load starts (the panel's rows may push it below the fold).
    await gone.or(c.locator('img[alt="gone"]')).scrollIntoViewIfNeeded();
    await expect(gone).toContainText("Couldn't load", { timeout: SHOWS_WITHIN_MS });
    const box = (await gone.boundingBox())!;
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([360, 120]);
    await gone.getByRole("button", { name: "Retry" }).click();
    await expect(failed.filter({ hasText: "gone" })).toContainText("Couldn't load", { timeout: SHOWS_WITHIN_MS });
    await expect(failed.filter({ hasText: "gone" }).getByRole("button", { name: "Retry" })).toHaveCount(0);
    expect(asked.filter((u) => u.includes("/ext/img/0x0.png"))).toHaveLength(2);

    // A video that failed to load: the placeholder, whose Retry loads it again.
    const stalled = failed.filter({ hasText: "Video" });
    await expect(stalled).toContainText("Couldn't load", { timeout: SHOWS_WITHIN_MS });
    videoDown = false;
    await stalled.getByRole("button", { name: "Retry" }).click();
    // The video plays in-app, through the attachment route.
    const player = c.locator('video[data-perf="media"]');
    await expect(player).toHaveAttribute("src", `/api/attachments/${video.uuid}`);
    await expect(player).toHaveAttribute("controls", "");
    await expect(player).toHaveAttribute("preload", "metadata");
    await expect.poll(() => player.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: SHOWS_WITHIN_MS }).toBe(320);

    // A file is a chip to GitHub, where the viewer's own login downloads it.
    const chip = c.locator('[data-perf="file"]');
    await expect(chip).toHaveText("build logs↗");
    await expect(chip).toHaveAttribute("href", "https://github.com/user-attachments/files/4242/build.log.zip");
    await expect(chip).toHaveAttribute("target", "_blank");

    // Nothing loaded from anywhere but beghu.
    const elsewhere = await c.evaluate((e) =>
      [...e.querySelectorAll("img, video, source")].map((m) => m.getAttribute("src") ?? m.getAttribute("srcset") ?? "").filter((s) => s && !s.startsWith("/api/")),
    );
    expect(elsewhere).toEqual([]);

    // A click opens the lightbox at the image's natural size; Escape closes it.
    await attachment.click();
    const lightbox = page.locator('dialog[data-perf="lightbox"]');
    await expect(lightbox).toBeVisible();
    const big = lightbox.locator("img");
    await expect.poll(() => big.evaluate((e: HTMLImageElement) => e.naturalWidth), { timeout: SHOWS_WITHIN_MS }).toBe(400);
    expect((await big.boundingBox())!.width).toBeCloseTo(400, 0);
    // A click on the image keeps the focus in the lightbox: the list's keys still don't act.
    await big.click();
    await expect(lightbox).toBeFocused();
    await expect(page.locator('[data-perf="hints"]')).toHaveAttribute("data-area", "lightbox");
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    // Enter on a focused image opens it, as on a button.
    await tall.focus();
    await page.keyboard.press("Enter");
    await expect(lightbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(tall).toBeFocused();
    // A click outside the image closes it too.
    await tall.click();
    await expect(lightbox).toBeVisible();
    await lightbox.click({ position: { x: 5, y: 5 } });
    await expect(lightbox).toBeHidden();
    // By keyboard: an image takes the focus, `i` opens it, and Escape closes it, the focus back
    // on the image. While it's open, the list's keys don't move the selection behind it.
    await attachment.focus();
    await page.keyboard.press("i");
    await expect(lightbox).toBeVisible();
    await expect.poll(() => big.evaluate((e: HTMLImageElement) => e.naturalWidth), { timeout: SHOWS_WITHIN_MS }).toBe(400);
    await expect(page.locator('[data-perf="hints"]')).toHaveAttribute("data-area", "lightbox");
    const at = page.url();
    await page.keyboard.press("j");
    await page.keyboard.press("ArrowDown");
    expect(page.url()).toBe(at);
    await expect(lightbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    await expect(attachment).toBeFocused();
    expect(page.url()).toBe(at);
    // With no image focused, `i` opens the first one in view.
    await page.locator('[data-perf="detail"]').focus();
    await tall.scrollIntoViewIfNeeded();
    await page.keyboard.press("i");
    await expect(lightbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();
    // An image inside a link follows the link: no lightbox.
    const badge = c.getByRole("img", { name: "badge" });
    await expect(badge).toHaveCSS("cursor", "pointer");
    expect(await badge.evaluate((e) => e.closest("a")?.getAttribute("href"))).toBe("https://example.com/build");
  } finally {
    // Out of the default list again: it rose to the top.
    devCtl(["fake", "edit", issue.ref, "--close"]);
    await expect
      .poll(async () => ((await (await page.request.get(`/api/issues/${issue.id}`)).json()) as { state: string }).state, {
        timeout: SHOWS_WITHIN_MS,
      })
      .toBe("closed");
  }
});
