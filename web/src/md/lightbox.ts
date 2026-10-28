// The lightbox: an image from a post at its natural size, over the page, scrolling when it's
// larger than the window. Its own chunk, loaded the first time an image is clicked (./media.ts).
// A modal <dialog>: the browser keeps focus inside it and gives it back on close. While it's open
// it offers the keys module's `imageClose` (Escape), and its `data-keys="lightbox"` area keeps
// every other key (j/k, the list's) from acting on the page behind it. A click outside the image
// or on the close button closes it too.
import * as stylex from "@stylexjs/stylex";
import { touch } from "../keys";
import { colors } from "../tokens.stylex";
import { md as tone } from "./tokens.stylex";

let dialog: HTMLDialogElement | undefined;
/** Withdraws the open lightbox's `imageClose` offer. */
let withdraw: (() => void) | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style: stylex.StyleXStyles): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = stylex.props(style).className ?? "";
  return e;
}

/** The dialog, made once and kept in the document. */
function shell(): HTMLDialogElement {
  if (dialog?.isConnected) return dialog;
  const d = el("dialog", s.dialog);
  d.setAttribute("aria-label", "Image");
  d.dataset.perf = "lightbox";
  d.dataset.keys = "lightbox";
  // Focusable itself, so a click on the image (which isn't) leaves the focus on the dialog, in
  // the lightbox's area, rather than on the page behind it.
  d.tabIndex = -1;
  // A click on the dialog itself, not on the image or the close button, is outside the image.
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target === d.firstElementChild) d.close();
  });
  // Whatever closed it, it holds no image after, and Escape is no longer its.
  d.addEventListener("close", () => {
    d.querySelector("img")?.remove();
    withdraw?.();
    withdraw = undefined;
  });
  const scroller = el("div", s.scroller);
  const close = el("button", s.close);
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => d.close());
  d.append(scroller, close);
  document.body.append(d);
  dialog = d;
  return d;
}

/** Shows `from` (an image in a post) in the lightbox, from the same URL. */
export function open(from: HTMLImageElement): void {
  const d = shell();
  const scroller = d.firstElementChild as HTMLElement;
  scroller.replaceChildren();
  const img = el("img", s.img);
  img.alt = from.alt;
  img.referrerPolicy = "no-referrer";
  img.src = from.currentSrc || from.src;
  scroller.append(img);
  if (!d.open) {
    d.showModal();
    withdraw = touch("imageClose", () => d.close());
  }
}

const s = stylex.create({
  dialog: {
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: tone.scrim,
    position: "fixed",
    height: "100vh",
    maxHeight: "100vh",
    maxWidth: "100vw",
    width: "100vw",
    "::backdrop": { backgroundColor: "transparent" },
  },
  scroller: {
    padding: 24,
    overflow: "auto",
    alignItems: "safe center",
    boxSizing: "border-box",
    display: "flex",
    justifyContent: "safe center",
    height: "100%",
    width: "100%",
  },
  img: { display: "block", flexShrink: 0 },
  close: {
    borderRadius: 6,
    borderWidth: 0,
    paddingBlock: 2,
    paddingInline: 10,
    backgroundColor: tone.tint,
    color: colors.fg,
    cursor: "pointer",
    fontSize: 22,
    insetInlineEnd: 12,
    lineHeight: 1.2,
    position: "fixed",
    top: 12,
  },
});
