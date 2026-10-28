// Images, attachments and video in posts (#100). The server routes every image through beghu
// (an attachment through /api/attachments/<uuid>, anything else through the signed proxy,
// /api/img?u=&sig=), and sends beside the posts what it knows of each, by `src`: its natural size,
// its type, or why it won't load (the `media` map). So the browser loads nothing from anywhere
// else, reserves each image's box before it loads, and never asks for one known not to load.
//
// - Size: the post's own `width`/`height` win (GitHub's uploader writes both); otherwise the
//   measured size. Either way it's scaled down to 480 px high at most, keeping its proportions.
//   The box comes from the `width`/`height` attributes the browser derives the aspect ratio
//   from, so the thread doesn't move as images land.
// - One placeholder for every failure: the image's box (one line high when its size is unknown),
//   an icon, the alt text and why, "Open original" (an external image) or "Open on GitHub" (an
//   attachment), and a Retry, once. The browser's broken-image icon never shows.
// - A bare attachment is a video (`<video controls preload=metadata>`) or an image, as the server
//   found; before it knows, a link card to GitHub.
// - `user-attachments/files/…` links are file chips to github.com, where the viewer's own login
//   downloads them.
// - Clicking an image opens it in the lightbox (./lightbox.ts, its own chunk), unless the image is
//   inside a link, which it follows. Such an image is a button in the Tab order (Enter or Space
//   opens it), marked `data-zoom`: the keys module's `imageOpen` (`i`, offered by the issue
//   panel) opens the focused one.
import * as stylex from "@stylexjs/stylex";
import type { MediaInfo } from "../bindings/MediaInfo";
import { colors } from "../tokens.stylex";
import type { MdAttrs } from "./ast";
import { icon } from "./icons";
import { safeUrl } from "./links";
import { md as tone } from "./tokens.stylex";

/** How high an image or video may be in the thread: a taller one is scaled down. */
const MAX_HEIGHT = 480;

/** What a post's media resolve against: the `media` map, and the post's page on GitHub. */
export type MediaLinks = {
  media: (src: string) => MediaInfo | undefined;
  /** The post on GitHub, where an attachment opens with the viewer's own login. */
  onGitHub: string;
};

const ROUTED = /^\/api\/(?:img\?u=[^\s,"'<>]+&sig=[A-Za-z0-9_-]+|attachments\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;

/** A media URL the walker may load: beghu's attachment route or its signed proxy, nothing else. */
export function mediaSrc(raw: string | undefined): string | undefined {
  return raw !== undefined && ROUTED.test(raw) ? raw : undefined;
}

/** A size written as a number of pixels (`640`, `640px`), or undefined. */
function pixels(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/px$/, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `w` × `h` scaled down to the height cap, if it's over it. */
function capped(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_HEIGHT / h);
  return { w: w * scale, h: h * scale };
}

/** The box an image gets, from the post's size or else the measured one, under the height cap. */
function box(a: MdAttrs, info: MediaInfo | undefined): { w: number; h: number } | undefined {
  const [aw, ah] = [pixels(a.width), pixels(a.height)];
  const [nw, nh] = [info?.w, info?.h];
  if (aw && ah) return capped(aw, ah);
  if (nw && nh) {
    if (aw) return capped(aw, (aw * nh) / nw);
    if (ah) return capped((ah * nw) / nh, ah);
    return capped(nw, nh);
  }
  return undefined;
}

const REASON: Record<string, string> = {
  too_large: "Too large to preview",
  not_image: "Not an image",
  blocked: "Can't be loaded from there",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: stylex.StyleXStyles, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = stylex.props(style).className ?? "";
  e.append(...kids);
  return e;
}

function outward(a: HTMLAnchorElement): void {
  a.target = "_blank";
  a.rel = "noopener noreferrer";
}

/** Where a failed image opens: its own URL (an external one), or the post on GitHub. */
function original(a: MdAttrs, links: MediaLinks): { href: string; label: string } {
  const orig = safeUrl(typeof a.orig === "string" ? a.orig : "");
  return orig ? { href: orig, label: "Open original" } : { href: links.onGitHub, label: "Open on GitHub" };
}

/**
 * The placeholder for an image that won't show: the image's box when its size is known, one line
 * otherwise. `why` from the server, known before any load; without it the image failed to load,
 * and `retry` (if given) offers one more try.
 */
function placeholder(a: MdAttrs, size: ReturnType<typeof box>, links: MediaLinks, why: string | undefined, retry?: (self: HTMLElement) => void): HTMLElement {
  const alt = typeof a.alt === "string" && a.alt.trim() ? a.alt.trim() : "Image";
  const floated = a.align === "left" ? s.floatLeft : a.align === "right" ? s.floatRight : false;
  const p = el("span", [s.placeholder, size ? s.sized : s.line, floated]);
  p.dataset.perf = "media-failed";
  if (why) p.dataset.reason = why;
  if (size) {
    // A canvas the image's size holds the box: its width and height give it the image's aspect
    // ratio, scaled down with the column like the image would be.
    const c = el("canvas", s.holder);
    c.width = Math.round(size.w);
    c.height = Math.round(size.h);
    c.setAttribute("aria-hidden", "true");
    p.append(c);
  }
  const { href, label } = original(a, links);
  const open = el("a", s.action, label);
  open.href = href;
  outward(open);
  const body = el("span", s.body, icon("image", s.icon), el("span", s.alt, alt), el("span", s.why, why ? (REASON[why] ?? "Can't be shown") : "Couldn't load"), open);
  if (retry) {
    const again = el("button", s.action, "Retry");
    again.type = "button";
    again.addEventListener("click", () => retry(p), { once: true });
    body.append(again);
  }
  p.append(body);
  return p;
}

/** Whether `parent` is inside a link: an image there follows it rather than opening the lightbox. */
function inLink(parent: Node): boolean {
  return parent instanceof Element && parent.closest("a") !== null;
}

/** Opens `img` in the lightbox, loading its chunk the first time. */
export function openLightbox(img: HTMLImageElement): void {
  import("./lightbox")
    .then((m) => m.open(img))
    .catch(() => {
      // The viewer's chunk didn't load (a deploy, the network): say so beside the image.
      const note = el("span", s.note, "Couldn't load · ");
      const again = el("button", s.action, "Retry");
      again.type = "button";
      again.addEventListener("click", () => {
        note.remove();
        openLightbox(img);
      });
      note.append(again);
      img.after(note);
    });
}

/**
 * An image as a post shows it: its box reserved, loaded through beghu, and replaced by the
 * placeholder if it can't be shown. Returns what goes in the post: the image in a wrapper, or the
 * image alone inside a `<picture>` (whose placeholder then takes the picture's place).
 */
export function image(a: MdAttrs, parent: Node, links: MediaLinks, copy: (e: HTMLElement) => void): HTMLElement {
  const src = mediaSrc(typeof a.src === "string" ? a.src : undefined);
  const info = src ? links.media(src) : undefined;
  const size = box(a, info);
  const inPicture = parent.nodeName === "PICTURE";
  const known = info?.unavailable;
  if (!src || known) {
    const p = placeholder(a, size, links, known ?? "blocked");
    if (inPicture) queueMicrotask(() => (parent as Element).replaceWith(p));
    return p;
  }
  // `align`: the image floats, with the text beside it.
  const floated = a.align === "left" ? s.floatLeft : a.align === "right" ? s.floatRight : false;
  const make = (retry: boolean): HTMLImageElement => {
    const img = el("img", [s.img, !size && s.capped, inPicture && floated]);
    copy(img);
    // A percentage stays as written; a size in pixels is set from the box.
    for (const k of ["width", "height"] as const) {
      const v = a[k];
      if (typeof v === "string" && v.endsWith("%")) img.setAttribute(k, v);
    }
    if (size) {
      img.width = Math.round(size.w);
      img.height = Math.round(size.h);
    }
    img.alt = typeof a.alt === "string" ? a.alt : "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.dataset.perf = "media";
    if (!inLink(parent)) {
      img.classList.add(...(stylex.props(s.zoom).className ?? "").split(" ").filter(Boolean));
      img.addEventListener("click", () => openLightbox(img));
      // Reachable by keyboard, for `imageOpen`, and a button to assistive tech: Enter or Space
      // on it opens it, as on any button (a widget's own keys, as a picker's are).
      img.tabIndex = 0;
      img.dataset.zoom = "";
      img.setAttribute("role", "button");
      const alt = typeof a.alt === "string" ? a.alt.trim() : "";
      img.setAttribute("aria-label", alt ? `Open image: ${alt}` : "Open image");
      img.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          openLightbox(img);
        }
      });
    }
    img.addEventListener(
      "error",
      () => {
        // In a picture the placeholder takes the picture's place; a retry is a plain image.
        const target = inPicture && img.parentElement?.nodeName === "PICTURE" ? img.parentElement : (img.parentElement ?? img);
        target.replaceWith(placeholder(a, size, links, undefined, retry ? (ph) => ph.replaceWith(el("span", [s.frame, floated], make(false))) : undefined));
      },
      { once: true },
    );
    img.src = src;
    return img;
  };
  // A picture's image stays its direct child; any other is in a wrapper the placeholder replaces.
  const img = make(true);
  return inPicture ? img : el("span", [s.frame, floated], img);
}

/** The name a `files/<id>/<name>` link's URL ends in. */
function fileName(href: string): string {
  const last = href.split("/").pop() ?? "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const FILES = /^https:\/\/github\.com\/user-attachments\/files\/\d+\/[^/?#]+$/;

/** Whether `href` is a file attachment on GitHub. */
export function isFile(href: string): boolean {
  return FILES.test(href);
}

/**
 * A file attachment: a chip with an icon, its name (the link's own text, or the file name when
 * that's just the URL) and ↗, to github.com in a new tab, where the viewer's login downloads it.
 */
export function fileChip(href: string, text: string): HTMLAnchorElement {
  const a = el("a", s.chip, icon("file", s.icon), el("span", s.chipName, text.trim() === href || !text.trim() ? fileName(href) : text.trim()));
  const arrow = el("span", s.arrow, "↗");
  arrow.setAttribute("aria-hidden", "true");
  a.append(arrow);
  a.href = href;
  a.title = "Opens on GitHub";
  a.dataset.perf = "file";
  outward(a);
  return a;
}

/** A bare attachment: a video, an image, or (before the server knows which) a link card. */
export function attachment(a: MdAttrs, parent: Node, links: MediaLinks, copy: (e: HTMLElement) => void): HTMLElement {
  const src = mediaSrc(typeof a.src === "string" ? a.src : undefined);
  const href = safeUrl(typeof a.href === "string" ? a.href : "");
  const info = src ? links.media(src) : undefined;
  if (src && info?.type?.startsWith("video/") && !info.unavailable) {
    const size = info.w && info.h ? capped(info.w, info.h) : undefined;
    // A video that fails to load gets the placeholder, with one Retry, as an image does.
    const make = (retry: boolean): HTMLVideoElement => {
      const v = el("video", s.video);
      v.controls = true;
      v.preload = "metadata";
      if (size) {
        v.width = Math.round(size.w);
        v.height = Math.round(size.h);
      }
      v.dataset.perf = "media";
      v.addEventListener(
        "error",
        () => v.replaceWith(placeholder({ alt: "Video" }, size, links, undefined, retry ? (ph) => ph.replaceWith(make(false)) : undefined)),
        { once: true },
      );
      v.src = src;
      return v;
    };
    return el("span", s.block, make(true));
  }
  if (src && info && (info.type?.startsWith("image/") || info.unavailable)) {
    return el("span", s.block, image({ src, alt: "Image" }, parent, links, copy));
  }
  // Not known yet: a card to the attachment on GitHub.
  const card = el("a", s.chip, icon("file", s.icon), el("span", s.chipName, "Attachment"));
  const arrow = el("span", s.arrow, "↗");
  arrow.setAttribute("aria-hidden", "true");
  card.append(arrow);
  card.href = href ?? links.onGitHub;
  card.title = "Opens on GitHub";
  card.dataset.perf = "attachment";
  outward(card);
  return el("span", s.block, card);
}

const s = stylex.create({
  frame: { display: "inline-block", verticalAlign: "middle", maxWidth: "100%", },
  img: {
    display: "block",
    height: "auto",
    maxWidth: "100%",
  },
  // An image of a size not known yet: never taller than the thread allows.
  capped: { maxHeight: MAX_HEIGHT },
  zoom: { cursor: "zoom-in" },
  floatLeft: { float: "left", marginInlineEnd: 8 },
  floatRight: { float: "right", marginInlineStart: 8 },
  block: { display: "block", marginBottom: { default: "0.7em", ":last-child": 0 } },
  video: { display: "block", height: "auto", maxHeight: MAX_HEIGHT, maxWidth: "100%" },
  placeholder: {
    borderRadius: 6,
    backgroundColor: tone.codeBg,
    color: tone.muted,
    display: "inline-grid",
    fontSize: "0.9em",
    verticalAlign: "middle",
    maxWidth: "100%",
  },
  sized: { alignItems: "center", justifyItems: "center" },
  line: { paddingBlock: 4, paddingInline: 8 },
  // The box's size, invisible; the message sits over it, in the same grid cell.
  holder: {
    gridArea: "1 / 1",
    visibility: "hidden",
    height: "auto",
    maxWidth: "100%",
  },
  body: {
    gridArea: "1 / 1",
    padding: 8,
    gap: 6,
    alignItems: "center",
    display: "inline-flex",
    flexWrap: "wrap",
  },
  icon: { height: "1.1em", width: "1.1em" },
  alt: { color: colors.fg, fontWeight: 550 },
  why: {},
  action: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: { default: "none", ":hover": "underline" },
    backgroundColor: "transparent",
    color: tone.link,
    cursor: "pointer",
  },
  note: { color: tone.muted, fontSize: "0.85em", marginInlineStart: 6 },
  chip: {
    borderColor: tone.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 6,
    paddingBlock: 2,
    paddingInline: 8,
    textDecoration: { default: "none", ":hover": "underline" },
    alignItems: "center",
    color: tone.link,
    display: "inline-flex",
    verticalAlign: "middle",
    maxWidth: "100%",
  },
  chipName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  arrow: { color: tone.muted, fontSize: "0.8em" },
});
