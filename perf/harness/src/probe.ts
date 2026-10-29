// Runs inside the page, installed before any app code: it notes each input event's time and
// checks a condition on every animation frame, so a result is the frame in which the DOM first
// showed the outcome, not the moment the harness noticed. It reads only the `data-perf` hooks
// (and ARIA), which production builds keep. Ported from bench/harness/probe.mjs.

export interface Outcome {
  /** `performance.now()` of the frame (from navigation start). */
  t: number;
  /** `Date.now()` of the frame, to compare with the harness's clock. */
  date: number;
  /** The last input event before it (`performance.now()` timestamp). */
  input: { type: string; t: number } | null;
}

export type Check =
  | { kind: "rows"; ids: number[] }
  | { kind: "more"; than: number }
  | { kind: "title"; id: number; text: string }
  | { kind: "detail"; id: number; comments: number }
  | { kind: "comment"; text: string };

declare global {
  interface Window {
    __perf: {
      lastInput: { type: string; t: number } | null;
      result: Outcome | null;
      armed: Check | null;
      longTasks: { start: number; duration: number }[];
      frames: { gaps: number[]; maxRows: number } | null;
      arm(check: Check): void;
      startFrames(): void;
      stopFrames(): { gaps: number[]; maxRows: number; longTasks: number[]; window: number };
    };
  }
}

/** The page script: passed to `addInitScript`, so it must not close over anything. */
export function probe(initial: Check | null): void {
  const p: Window["__perf"] = (window.__perf = {
    lastInput: null,
    result: null,
    armed: null,
    longTasks: [],
    frames: null,
    arm: () => {},
    startFrames: () => {},
    stopFrames: () => ({ gaps: [], maxRows: 0, longTasks: [], window: 0 }),
  });
  for (const type of ["click", "input", "keydown", "wheel"]) {
    window.addEventListener(type, (e) => (p.lastInput = { type, t: e.timeStamp }), { capture: true, passive: true });
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) p.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}

  const rows = () => document.querySelectorAll<HTMLElement>('[data-perf="row"]');
  const list = () => document.querySelector<HTMLElement>('[data-perf="list"]:not([aria-busy="true"])');
  const checks = {
    rows(c: { ids: number[] }) {
      if (!list()) return false;
      const r = rows();
      if (r.length < c.ids.length) return false;
      return c.ids.every((id, i) => r[i]!.dataset.id === String(id));
    },
    more(c: { than: number }) {
      return Number(list()?.dataset.perfRows ?? 0) > c.than;
    },
    title(c: { id: number; text: string }) {
      const row = document.querySelector(`[data-perf="row"][data-id="${c.id}"]`);
      return !!row && (row.textContent ?? "").includes(c.text);
    },
    detail(c: { id: number; comments: number }) {
      const d = document.querySelector(`[data-perf="detail"][data-id="${c.id}"]`);
      if (!d) return false;
      if (c.comments === 0) return true;
      return Number(d.querySelector<HTMLElement>('[data-perf="comments"]')?.dataset.perfLoaded ?? 0) >= c.comments;
    },
    comment(c: { text: string }) {
      return [...document.querySelectorAll('[data-perf="comment"]')].some((el) => (el.textContent ?? "").includes(c.text));
    },
  } as const;

  p.arm = (check) => {
    p.result = null;
    p.lastInput = null;
    p.armed = check;
    const tick = () => {
      if (p.armed !== check) return;
      let ok = false;
      try {
        ok = (checks[check.kind] as (c: Check) => boolean)(check);
      } catch {}
      if (ok) {
        p.result = { t: performance.now(), date: Date.now(), input: p.lastInput };
        p.armed = null;
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  p.startFrames = () => {
    const f = (p.frames = { gaps: [] as number[], maxRows: 0 });
    p.longTasks = [];
    let last = 0;
    const loop = (t: number) => {
      if (p.frames !== f) return;
      if (last) f.gaps.push(t - last);
      last = t;
      f.maxRows = Math.max(f.maxRows, rows().length);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };
  p.stopFrames = () => {
    const f = p.frames ?? { gaps: [], maxRows: 0 };
    p.frames = null;
    const box = list();
    const height = rows()[0]?.getBoundingClientRect().height || 1;
    return {
      ...f,
      longTasks: p.longTasks.map((l) => l.duration),
      // The rows a viewport of the list holds.
      window: box ? Math.ceil(box.clientHeight / height) : 0,
    };
  };

  if (initial) p.arm(initial);
}
