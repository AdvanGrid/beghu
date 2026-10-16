import { getIssues, type Changed, type Page, type View } from './api';
import { mark, workerName, type Source } from './sources';
import type { FromWorker, ToWorker } from './source-worker';

/** Paints from the server, as the server variant does, while the worker variant's cache warms in
 *  the background; once it is ready, every query goes to it. The worker starts at once, so a
 *  returning tab reads IndexedDB alongside the first page, but a first visit's snapshot download
 *  waits until the first rows are painted. */
export function hybridSource(): Source {
  // The cache starts filling only after the first paint; mark now that this page will fill one.
  mark('cache-start');
  let painted = false;
  let local = false;
  const pending = new Map<number, (p: Page) => void>();
  let next = 0;
  let onChanged: (ids: number[]) => void = () => {};
  let events: EventSource | undefined;
  // What the list shows, to check the switchover against.
  let shown: { view: View; ids: number[] } | undefined;

  const ask = (view: View, offset: number, limit: number) =>
    new Promise<Page>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      worker.postMessage({ id, view, offset, limit } satisfies ToWorker);
    });

  // The worker caught up past the server's first page. If the cache gives the rows on screen in
  // the same order, nothing re-renders; otherwise the list refetches, as on a live change.
  async function switchOver() {
    local = true;
    events?.close();
    const s = shown;
    if (!s) return;
    const page = await ask(s.view, 0, s.ids.length);
    const same = page.rows.length === s.ids.length && page.rows.every((r, i) => r.id === s.ids[i]);
    mark(same ? 'switch-same' : 'switch-differs');
    if (!same) onChanged([]);
  }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: workerName(';defer') });
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if ('page' in m) {
      pending.get(m.id)?.(m.page);
      pending.delete(m.id);
    } else if ('changed' in m) {
      if (local) onChanged(m.changed);
    } else {
      mark(m.mark, m.at);
      if (m.mark === 'cache-ready') void switchOver();
    }
  };

  return {
    async query(view, offset, limit) {
      const page = local ? await ask(view, offset, limit) : await getIssues(view, offset, limit);
      const ids = page.rows.map((r) => r.id);
      if (offset === 0) shown = { view, ids };
      else if (shown?.view === view) shown = { view, ids: [...shown.ids, ...ids] };
      if (!painted) {
        painted = true;
        // After the frame that paints the first rows.
        requestAnimationFrame(() => setTimeout(() => worker.postMessage({ fetch: true } satisfies ToWorker)));
      }
      return page;
    },
    live(changed) {
      onChanged = changed;
      events = new EventSource('/events');
      events.onmessage = (e) => !local && changed((JSON.parse(e.data) as Changed).ids);
      return () => {
        events?.close();
        onChanged = () => {};
      };
    },
  };
}
