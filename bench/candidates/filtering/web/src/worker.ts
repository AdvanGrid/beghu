// The worker variant's thread: owns the cache, the live connection and every query.
import { Cache } from './cache';
import type { FromWorker, ToWorker } from './source-worker';

const post = (m: FromWorker) => postMessage(m);
// Progress marks carry the worker's clock, so a busy page doesn't delay them. `cache-ready` doesn't:
// the page starts asking the worker when it receives it, and that moment is what it marks.
const phase = (name: string) => post({ mark: name, at: performance.timeOrigin + performance.now() });
phase('worker-boot');

const cpu = Number(/cpu=([\d.]+)/.exec(self.name)?.[1] ?? 1);
// A worker named `…;defer` (the hybrid's) reads IndexedDB at once but fetches a full snapshot only
// once the page posts `{ fetch: true }`, so the download doesn't compete with its first page.
let allowFetch = () => {};
const fetchAfter = self.name.includes('defer') ? new Promise<void>((r) => (allowFetch = r)) : undefined;
const opening = Cache.open({
  start: () => phase('cache-start'),
  persisted: () => phase('cache-warm'),
  phase,
  fetchAfter,
  cpu,
});

onmessage = async (e: MessageEvent<ToWorker>) => {
  if ('fetch' in e.data) return allowFetch();
  const { id, view, offset, limit } = e.data;
  post({ id, page: (await opening).query(view, offset, limit) });
};

void opening.then(async (c) => {
  const catchUp = () => c.catchUp().then((ids) => ids.length && post({ changed: ids }));
  new EventSource('/events').onmessage = catchUp;
  // Ready once the cache is at least as new as the server was when this tab opened.
  await catchUp().catch(() => {});
  post({ mark: 'cache-ready' });
});
