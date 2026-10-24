// PROTOTYPE (beghu #66). Live changes in the issue detail as held changes.
//
// A live push refetches the open issue. What the refetch changes splits in two:
// - in place, at once: anything that doesn't move layout (title, state, counts, your own comment);
// - held: new or removed comments, a changed body, and (knob) property rows and relationships.
//
// Held changes wait in intent mode. In reading mode (pointer still for `rest` s, no press, no
// selection, no key) the detail shows a shift cue, then animates the change, then commits the
// refetched copy. A change wholly off-screen moves nothing visible, so (knob) it applies at once
// with scroll compensation. ?variant= picks the cue's form; the knobs here pick everything else.
import { createSignal, flush } from 'solid-js';
import type { Comment, Detail } from '../api';

// ---------- knobs (session-scoped, set from the live panel) ----------

function knob<T extends string>(key: string, def: T) {
  const [get, set] = createSignal<string>(sessionStorage.getItem(`proto-live-${key}`) ?? def);
  return [get as unknown as () => T, (v: T) => (sessionStorage.setItem(`proto-live-${key}`, v), set(v as string))] as const;
}

export const knobs = {
  rest: knob<'5' | '3' | '2'>('rest', '5'),
  cue: knob<'400' | '700' | '1200'>('cue', '700'),
  anim: knob<'150' | '250' | '400'>('anim', '250'),
  /** Intent during a cue: cancel it and hold again, or finish what started. */
  interrupt: knob<'cancel' | 'finish'>('interrupt', 'cancel'),
  /** Property rows and the Blocks section: held like the body, or updated in place. */
  props: knob<'held' | 'in place'>('props', 'held'),
  /** Off-screen changes: apply at once with scroll compensation, or hold like the rest. */
  offscreen: knob<'now' | 'hold'>('offscreen', 'now'),
  /** A visible change: push what's below it down, or let the nearer viewport edge absorb it. */
  absorb: knob<'push' | 'nearer edge'>('absorb', 'push'),
  order: knob<'newest' | 'oldest'>('order', 'newest'),
  motion: knob<'os' | 'reduce'>('motion', 'os'),
};

export const reduced = () => knobs.motion[0]() === 'reduce' || matchMedia('(prefers-reduced-motion: reduce)').matches;
export const cueMs = () => (reduced() ? 900 : Number(knobs.cue[0]()));
export const animMs = () => (reduced() ? 0 : Number(knobs.anim[0]()));
export const GLOW_MS = 1600;

// ---------- intent / reading ----------

export type Mode = 'intent' | 'reading';
const [mode, setMode] = createSignal<Mode>('intent');
const [restFor, setRestFor] = createSignal(0);
export { mode, restFor };

let last = performance.now();
let pressing = false;
let outside = false;
let lastX = -1;
let lastY = -1;
const listeners = new Set<(m: Mode) => void>();
export const onMode = (fn: (m: Mode) => void) => (listeners.add(fn), () => listeners.delete(fn));

const intent = () => {
  last = performance.now();
  tick();
};
function selecting() {
  const s = document.getSelection();
  return !!s && !s.isCollapsed && s.toString().length > 0;
}
function tick() {
  const rest = (performance.now() - last) / 1000;
  setRestFor(rest);
  const m: Mode = !pressing && !selecting() && (outside || rest >= Number(knobs.rest[0]())) ? 'reading' : 'intent';
  if (m !== mode()) {
    setMode(m);
    for (const fn of listeners) fn(m);
  }
}
window.addEventListener('pointermove', (e) => {
  // Ignore sub-pixel jitter and the synthetic move some browsers fire on scroll.
  if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) < 3) return;
  lastX = e.clientX;
  lastY = e.clientY;
  outside = false;
  intent();
});
window.addEventListener('pointerdown', () => ((pressing = true), intent()));
window.addEventListener('pointerup', () => ((pressing = false), intent()));
window.addEventListener('pointercancel', () => ((pressing = false), intent()));
window.addEventListener('keydown', intent);
window.addEventListener('wheel', intent, { passive: true });
document.addEventListener('selectionchange', tick);
// The pointer left the window: nothing can be clicked by accident, so it counts as reading.
document.documentElement.addEventListener('pointerleave', () => ((outside = true), tick()));
setInterval(tick, 200);

// ---------- the held layer ----------

/** A block of the body: a fenced code block, or a paragraph. */
export type Block = { text: string; state: 'same' | 'add' | 'del' };

export type Plan = {
  addComments: Comment[];
  delComments: number[];
  body: Block[] | null;
  props: boolean;
  /** What the cue says, for the B gutter and the live panel. */
  summary: string;
};

export type Phase = 'idle' | 'held' | 'cue' | 'anim';

export function blocks(text: string): string[] {
  const out: string[] = [];
  const re = /^```[^\n]*\n[\s\S]*?(?:^```[ \t]*$|(?![\s\S]))/gm;
  let at = 0;
  const prose = (s: string) => s.split(/\n{2,}/).forEach((p) => p.trim() && out.push(p.replace(/^\n+|\n+$/g, '')));
  for (let m; (m = re.exec(text)); ) {
    prose(text.slice(at, m.index));
    out.push(m[0].replace(/\n$/, ''));
    at = re.lastIndex;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  prose(text.slice(at));
  return out;
}

/** Block-level LCS diff; a rewritten paragraph comes out as a del followed by an add. */
export function diffBody(a: string, b: string): Block[] {
  const x = blocks(a);
  const y = blocks(b);
  const n = x.length;
  const m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: Block[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) out.push({ text: x[i++], state: 'same' }), j++;
    else if (i < n && (j >= m || t[i + 1][j] >= t[i][j + 1])) out.push({ text: x[i++], state: 'del' });
    else out.push({ text: y[j++], state: 'add' });
  }
  return out;
}

const propsKey = (d: Detail) =>
  JSON.stringify([
    d.labels.map((l) => l.name),
    d.assignees,
    d.milestone,
    d.rels.parent?.id ?? null,
    d.rels.blocked_by.map((r) => r.id),
    d.rels.blocking.map((r) => r.id),
    d.rels.relates.map((r) => r.id),
    d.rels.children.map((r) => r.id),
  ]);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function planFor(cur: Detail, nxt: Detail, me: string): Plan | null {
  const had = new Set(cur.comments.map((c) => c.id));
  const has = new Set(nxt.comments.map((c) => c.id));
  // Your own comment is already on screen as a pending one: confirming it moves nothing.
  const addComments = nxt.comments.filter((c) => !had.has(c.id) && c.author !== me);
  const delComments = cur.comments.filter((c) => !has.has(c.id)).map((c) => c.id);
  const body = cur.body === nxt.body ? null : diffBody(cur.body, nxt.body);
  // Same blocks in the same order (a typo fix inside a paragraph) still re-flows that paragraph;
  // only a change that leaves every block's text alone would be layout-free, which can't happen.
  const props = knobs.props[0]() === 'held' && propsKey(cur) !== propsKey(nxt);
  if (!addComments.length && !delComments.length && !body && !props) return null;
  const parts: string[] = [];
  if (addComments.length) parts.push(addComments.length === 1 ? `${addComments[0].author} commented` : plural(addComments.length, 'new comment'));
  if (delComments.length) parts.push(plural(delComments.length, 'comment') + ' removed');
  if (body) {
    const add = body.filter((b) => b.state === 'add').length;
    const del = body.filter((b) => b.state === 'del').length;
    parts.push(add && del ? 'description edited' : add ? 'description grew' : del ? 'description shrank' : 'description edited');
  }
  if (props) parts.push('properties changed');
  return { addComments, delComments, body, props, summary: parts.join(' · ') };
}

/** The refetched copy with every layout-moving part taken from what's on screen. */
function inPlace(shown: Detail, fresh: Detail, me: string): Detail {
  const had = new Set(shown.comments.map((c) => c.id));
  const own = fresh.comments.filter((c) => !had.has(c.id) && c.author === me);
  const held: Detail = { ...fresh, body: shown.body, comments: [...shown.comments, ...own], hidden: shown.hidden };
  if (knobs.props[0]() === 'held') Object.assign(held, { labels: shown.labels, assignees: shown.assignees, milestone: shown.milestone, rels: shown.rels });
  return held;
}

export type Where = 'above' | 'below' | 'up' | 'down';

/** Where a change at `el` sits: wholly off-screen above or below, or visible and growing up (the
 * top edge absorbs it, scroll compensates) or down (what's below it moves). */
export function where(scroller: HTMLElement, el: Element): Where {
  const box = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - box.top;
  // A zero-height insertion point counts by its position; anything else by its whole extent.
  if (r.bottom - box.top <= 0 && top < 0) return 'above';
  if (top >= scroller.clientHeight) return 'below';
  if (knobs.absorb[0]() === 'push' || scroller.scrollTop === 0) return 'down';
  return top < scroller.clientHeight / 2 ? 'up' : 'down';
}

export const variant = () => new URLSearchParams(location.search).get('variant') ?? 'A';

/** The first keyed element at the viewport's top, and its offset, to put back after a commit. */
function anchor(sc: HTMLElement) {
  const top = sc.getBoundingClientRect().top;
  for (const el of sc.querySelectorAll<HTMLElement>('[data-k]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) return { k: el.dataset.k!, y: r.top - top };
  }
  return undefined;
}
function restore(sc: HTMLElement, a: ReturnType<typeof anchor>) {
  if (!a) return;
  const el = sc.querySelector<HTMLElement>(`[data-k="${CSS.escape(a.k)}"]`);
  if (el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - a.y;
}

/** Run the plan's height animations: adds open, dels close, over `ms`. Elements that grow upward
 * (`where` = up) are compensated by scrolling, in one loop so several don't fight. */
function animatePlan(sc: HTMLElement, ms: number) {
  const els = [...sc.querySelectorAll<HTMLElement>('[data-live="add"], [data-live="del"]')];
  const ups = els.filter((el) => where(sc, el) === 'up').map((el) => ({ el, h0: el.getBoundingClientRect().height }));
  for (const el of els) {
    const h = el.scrollHeight;
    const add = el.dataset.live === 'add';
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ height: `${add ? 0 : h}px` }, { height: `${add ? h : 0}px` }], { duration: ms, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' });
  }
  if (!ups.length) return;
  const base = sc.scrollTop;
  const step = () => {
    // Stop once the commit has swapped the animated copies for the real ones.
    if (!ups.every((u) => u.el.isConnected)) return;
    sc.scrollTop = base + ups.reduce((s, u) => s + u.el.getBoundingClientRect().height - u.h0, 0);
    if (ups.some((u) => u.el.getAnimations().some((a) => a.playState === 'running'))) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Props rows change by FLIP on their height: old height → new, over `ms`. */
function flipProps(sc: HTMLElement, before: Map<Element, number>, ms: number) {
  for (const [el, h0] of before) {
    if (!el.isConnected) continue;
    const h1 = (el as HTMLElement).getBoundingClientRect().height;
    if (Math.abs(h1 - h0) < 1) continue;
    (el as HTMLElement).animate([{ height: `${h0}px`, overflow: 'hidden' }, { height: `${h1}px`, overflow: 'hidden' }], { duration: ms, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }
}

export type Held = ReturnType<typeof createHeld>;

/**
 * `get`/`set` are the detail's server copy; `view` lays this tab's pending ops over a copy (so a
 * confirmed op of yours never counts as someone else's change); `committed(started)` runs once a
 * refetch that started at `started` is the one on screen.
 */
export function createHeld(o: {
  get: () => Detail;
  set: (d: Detail) => void;
  view: (d: Detail) => Detail;
  committed: (started: number) => void;
  scroller: () => HTMLElement | undefined;
}) {
  const [phase, setPhase] = createSignal<Phase>('idle');
  const [plan, setPlan] = createSignal<Plan | null>(null);
  /** Keys of what just changed (`c:<id>`, `b:<text>`, `props`), for the afterglow. */
  const [glow, setGlow] = createSignal<Set<string>>(new Set());
  let pending: { fresh: Detail; started: number } | undefined;
  let next: { fresh: Detail; started: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);

  function offer(fresh: Detail, started: number) {
    if (fresh.id !== o.get().id) return;
    if (phase() === 'anim') {
      // Mid-animation: let it finish; this one becomes the next held change.
      next = { fresh, started };
      return;
    }
    const me = fresh.me;
    const p = planFor(o.view(o.get()), o.view(fresh), me);
    if (!p) {
      stop();
      pending = undefined;
      setPlan(null);
      setPhase('idle');
      o.set(fresh);
      o.committed(started);
      return;
    }
    pending = { fresh, started };
    const wasCue = phase() === 'cue';
    stop();
    o.set(inPlace(o.get(), fresh, me));
    setPlan(p);
    setPhase('held');
    flush();
    if (document.hidden) return commit(false);
    if (knobs.offscreen[0]() === 'now' && allOffscreen()) return commit(false);
    // A new change mid-cue joins it: the cue restarts with both.
    if (wasCue || mode() === 'reading') startCue();
  }

  /** True when every part of the plan sits wholly above or below the viewport. */
  function allOffscreen() {
    const sc = o.scroller();
    if (!sc) return false;
    const marks = [...sc.querySelectorAll('[data-live]')];
    return marks.length > 0 && marks.every((el) => ['above', 'below'].includes(where(sc, el)));
  }

  function startCue() {
    setPhase('cue');
    flush();
    const sc = o.scroller();
    // C: the cue is the motion: ghosts open (and dels close) slowly, over the whole cue.
    if (sc && variant() === 'C' && !reduced()) animatePlan(sc, cueMs());
    timer = setTimeout(() => commit(true), cueMs());
  }

  function cancelCue() {
    stop();
    const sc = o.scroller();
    sc?.querySelectorAll<HTMLElement>('[data-live]').forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    setPhase('held');
  }

  /** Animate the change (or not), then put the refetched copy on screen. */
  function commit(animate: boolean) {
    stop();
    if (!pending || pending.fresh.id !== o.get().id) return void (pending = undefined);
    const { fresh, started } = pending;
    const p = plan();
    const sc = o.scroller();
    const a = !animate && sc ? anchor(sc) : undefined;
    const done = () => {
      pending = undefined;
      const keys = new Set<string>();
      p?.addComments.forEach((c) => keys.add(`c:${c.id}`));
      p?.body?.forEach((b) => b.state === 'add' && keys.add(`b:${b.text}`));
      if (p?.props) keys.add('props');
      const an = animate && sc ? anchor(sc) : a;
      setPlan(null);
      setPhase('idle');
      o.set(fresh);
      o.committed(started);
      flush();
      // Off-screen changes above, and the swap from animated copies to the real ones: keep
      // whatever is at the viewport's top where it was.
      if (sc) restore(sc, an);
      if (animate) {
        setGlow(keys);
        setTimeout(() => setGlow((g) => (g === keys ? new Set<string>() : g)), GLOW_MS);
      }
      // Another change landed meanwhile: it's held now, and cued if the user is still reading.
      if (next) {
        const n = next;
        next = undefined;
        offer(n.fresh, n.started);
      }
    };
    if (!animate || !sc) return done();
    // Props first, by FLIP, since they have no copies to animate.
    if (p?.props) {
      const before = new Map([...sc.querySelectorAll('[data-live="props"]')].map((el) => [el, el.getBoundingClientRect().height]));
      o.set({ ...o.get(), labels: fresh.labels, assignees: fresh.assignees, milestone: fresh.milestone, rels: fresh.rels });
      flush();
      flipProps(sc, before, animMs());
    }
    setPhase('anim');
    flush();
    if (variant() !== 'C' && animMs()) animatePlan(sc, animMs());
    timer = setTimeout(done, animMs() + (variant() === 'C' ? 120 : 30));
  }

  onMode((m) => {
    if (m === 'reading' && phase() === 'held') {
      if (knobs.offscreen[0]() === 'now' && allOffscreen()) commit(false);
      else startCue();
    }
    if (m === 'intent' && phase() === 'cue' && knobs.interrupt[0]() === 'cancel') cancelCue();
  });

  return {
    phase,
    plan,
    glow,
    offer,
    /** Navigation: a different issue drops whatever was held for the old one. */
    reset() {
      stop();
      pending = next = undefined;
      setPlan(null);
      setPhase('idle');
    },
  };
}
