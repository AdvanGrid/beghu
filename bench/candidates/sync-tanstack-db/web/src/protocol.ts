// Messages between a page and its worker.
import type { Label, View } from './api';
import type { LazyPage } from './db';

export type ToWorker =
  | { id: number; view: View; offset: number; limit: number }
  | { fetch: true }
  | { write: { wid: number; id: number; label: Label } };

export type FromWorker =
  | { id: number; page: LazyPage }
  | { changed: number[]; own?: true }
  | { counted: { view: string; n: number } }
  | { mark: string; at?: number }
  | { written: { wid: number; ok: boolean } };
