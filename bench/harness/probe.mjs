// Runs inside the page (installed with addInitScript before any candidate code). It timestamps
// the input events the harness sends and checks a condition on every animation frame, so a
// result is "the frame in which the DOM first matched", not "when Playwright noticed".
//
// Times use performance.now() (relative to navigation start) except `date` checks, which use
// Date.now() so they compare with the harness's clock for webhook POSTs.

export function probe(init) {
  const b = (window.__bench = {
    lastInput: null,
    armed: null,
    result: null,
    frames: null,
    longTasks: [],
    // CDP throttles only a page's main thread, never its workers. A candidate that works in a
    // worker reads this rate and slows that work to match (see the README's candidate contract).
    cpuRate: init?.cpuRate ?? 1,
  });

  for (const type of ['click', 'input']) {
    window.addEventListener(type, (e) => (b.lastInput = { type, t: e.timeStamp }), { capture: true });
  }

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) b.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}

  const rows = () => document.querySelectorAll('[data-bench=row]');

  const checks = {
    // The first rows of the list are exactly `ids`, in order (and the list says it's live).
    rows({ ids, ready }) {
      const list = document.querySelector('[data-bench=list]');
      if (!list || (ready && !list.hasAttribute('data-bench-ready'))) return false;
      const r = rows();
      if (ids.length === 0) return r.length === 0 && list.hasAttribute('data-bench-empty');
      if (r.length < ids.length) return false;
      for (let i = 0; i < ids.length; i++) if (r[i].dataset.id !== ids[i]) return false;
      return true;
    },
    // The list is live and shows its first rows (or says it's empty).
    ready() {
      const list = document.querySelector('[data-bench=list]');
      return !!list && list.hasAttribute('data-bench-ready') && (rows().length >= 20 || list.hasAttribute('data-bench-empty'));
    },
    title({ text }) {
      for (const el of document.querySelectorAll('[data-bench=row] [data-bench=title]')) if (el.textContent.trim() === text) return true;
      return false;
    },
    detail({ id, comments }) {
      const d = document.querySelector(`[data-bench=detail][data-id="${id}"]`);
      if (!d) return false;
      const body = d.querySelector('[data-bench=body]');
      return !!body && body.textContent.trim().length > 0 && d.querySelectorAll('[data-bench=comment]').length >= comments;
    },
    label({ name }) {
      return !!document.querySelector(`[data-bench=detail] [data-bench=label][data-value="${CSS.escape(name)}"]`);
    },
    visible({ id }) {
      const el = document.querySelector(`[data-bench=row][data-id="${id}"]`);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    },
  };

  // Arms a check. Each frame it runs until it passes, then records the frame time.
  b.arm = (kind, arg, clock = 'perf') => {
    b.result = null;
    b.lastInput = null;
    b.armed = { kind, arg, clock };
    const tick = () => {
      const a = b.armed;
      if (!a || a.kind !== kind) return;
      let ok = false;
      try {
        ok = checks[kind](arg);
      } catch {}
      if (ok) {
        b.result = { t: clock === 'date' ? Date.now() : performance.now(), input: b.lastInput };
        b.armed = null;
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // Frame-time recording for the scroll scenario.
  b.startFrames = () => {
    b.frames = [];
    b.longTasks = [];
    let last = performance.now();
    const loop = (t) => {
      if (!b.frames) return;
      b.frames.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame((t) => {
      last = t;
      requestAnimationFrame(loop);
    });
  };
  b.stopFrames = () => {
    const f = b.frames;
    b.frames = null;
    return f;
  };

  // Every navigation arms a load check: exact default-view rows for the load scenarios, or just
  // "list is live" for the others (whose earlier writes may have reordered the list).
  if (init?.loadIds) b.arm('rows', { ids: init.loadIds, ready: true });
  else b.arm('ready', {});
}
