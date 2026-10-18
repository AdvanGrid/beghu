// Messages between a page and its worker.
import type { Label, Page, View } from './api';

export type ToWorker =
  | { id: number; view: View; offset: number; limit: number }
  | { fetch: true }
  | { write: { wid: number; id: number; label: Label } };

export type FromWorker =
  | { id: number; page: Page }
  | { changed: number[]; own?: true }
  | { mark: string; at?: number }
  | { written: { wid: number; ok: boolean } };
