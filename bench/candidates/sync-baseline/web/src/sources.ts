// Where the list comes from, and where writes go.
import type { Label, Page, View } from './api';

export interface Source {
  /** One page of the view. Runs inside the list's async memo, so it may return a promise. */
  query(view: View, offset: number, limit: number): Page | Promise<Page>;
  /** Starts live updates. `changed` fires once the source holds the new data; `own` when the
   *  change is this page's own optimistic write or its rollback, which the page already shows. */
  live(changed: (ids: number[], own?: boolean) => void): () => void;
  /** Adds a label; rejects if the server refused it, after the cache has rolled it back. */
  write(id: number, label: Label): Promise<void>;
}

/** A `bench:` performance mark, now or at `at` (epoch ms, for times taken on a worker's clock). */
export const mark = (name: string, at?: number) =>
  performance.mark(`bench:${name}`, at === undefined ? undefined : { startTime: at - performance.timeOrigin });

/** The benchmark's CPU rate rides in the worker's name, so the worker can slow its own work to
 *  match: CDP throttles only the main thread (see Cache's `cpu` option). */
export const workerName = (suffix = '') => `cpu=${(window as { __bench?: { cpuRate?: number } }).__bench?.cpuRate ?? 1}${suffix}`;
