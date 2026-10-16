// Where the list comes from. The App is the same for every variant; only its Source differs, and
// each variant's entry imports only its own source.
import type { Page, View } from './api';

export interface Source {
  /** One page of the view. Runs inside the list's async memo, so it may return a promise. */
  query(view: View, offset: number, limit: number): Page | Promise<Page>;
  /** Starts live updates. `changed` fires once the source holds the new data. */
  live(changed: (ids: number[]) => void): () => void;
}

export const mark = (name: string) => performance.mark(`bench:${name}`);
