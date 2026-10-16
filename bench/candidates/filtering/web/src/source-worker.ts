import type { Page, View } from './api';
import { mark, type Source } from './sources';

export type ToWorker = { id: number; view: View; offset: number; limit: number };
export type FromWorker = { id: number; page: Page } | { changed: number[] } | { mark: string };

/** Holds every row in a Web Worker, which filters and answers with one page at a time. */
export function workerSource(): Source {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, (p: Page) => void>();
  let next = 0;
  let onChanged: (ids: number[]) => void = () => {};
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if ('page' in m) {
      pending.get(m.id)?.(m.page);
      pending.delete(m.id);
    } else if ('changed' in m) onChanged(m.changed);
    else mark(m.mark);
  };
  return {
    query: (view, offset, limit) =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        worker.postMessage({ id, view, offset, limit } satisfies ToWorker);
      }),
    live(changed) {
      onChanged = changed;
      return () => (onChanged = () => {});
    },
  };
}
