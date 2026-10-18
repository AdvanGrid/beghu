// The worker: owns the cache, the sync connection, writes and every query.
//
// Of all the tabs open on beghu, one syncs: its worker holds the `beghu-sync` Web Lock, keeps the
// `/api/sync` stream open from its cursor, persists each delta to IndexedDB and passes it on over
// a BroadcastChannel. The others apply what it passes on, and catch up over HTTP when they find a
// gap. When the syncing tab closes, the lock goes to a waiting tab, which opens the stream from
// its own cursor.
import { addLabel } from './api';
import { Cache } from './cache';
import type { FromWorker, ToWorker } from './protocol';

const post = (m: FromWorker) => postMessage(m);
// Progress marks carry the worker's clock, so a busy page doesn't delay them. `cache-ready` doesn't:
// the page starts asking the worker when it receives it, and that moment is what it marks.
const phase = (name: string) => post({ mark: name, at: performance.timeOrigin + performance.now() });
phase('worker-boot');

const cpu = Number(/cpu=([\d.]+)/.exec(self.name)?.[1] ?? 1);
// The worker reads IndexedDB at once but fetches a full snapshot only once the page posts
// `{ fetch: true }`, after its first paint, so the download doesn't compete with the first page.
let allowFetch = () => {};
const fetchAfter = new Promise<void>((r) => (allowFetch = r));
let leader = false;
let cache: Cache | undefined;
const opening = Cache.open({
  start: () => phase('cache-start'),
  persisted: () => phase('cache-warm'),
  persist: () => leader,
  phase,
  fetchAfter,
  cpu,
}).then((c) => (cache = c));

const changed = (ids: number[] | 'reset') => {
  if (ids === 'reset' || ids.length) post({ changed: ids === 'reset' ? [] : ids });
};

let ready = false;
const markReady = () => {
  if (ready) return;
  ready = true;
  post({ mark: 'cache-ready' });
};

// --- following the syncing tab ---------------------------------------------------------------

const channel = new BroadcastChannel('beghu-sync');
channel.onmessage = (e: MessageEvent<string>) => {
  if (leader) return;
  void opening.then((c) => c.serial(async () => changed(c.receive(e.data) ?? (await c.catchUp(false)))));
};

// --- syncing ---------------------------------------------------------------------------------

const BACKOFF = [250, 500, 1000];
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect(c: Cache) {
  retry = undefined;
  phase('sync-connect');
  const es = new EventSource(`/api/sync?since=${c.seq}&epoch=${encodeURIComponent(c.epoch)}`);
  let first = true;
  es.onopen = () => phase('sync-open');
  es.addEventListener('delta', (e) => {
    const text = (e as MessageEvent<string>).data;
    void c.serial(async () => {
      const ids = c.receive(text);
      if (ids === null) changed(await c.catchUp(true));
      else if (ids.length) {
        await c.persist(text);
        channel.postMessage(text);
        changed(ids);
      }
      if (first) {
        first = false;
        attempt = 0;
        phase('sync-caught-up');
        markReady();
      }
    });
  });
  es.addEventListener('reset', () => {
    es.close();
    void c.serial(() => c.reset(true)).then(() => {
      changed('reset');
      connect(c);
    });
  });
  // EventSource retries some failures itself but gives up on others (a 503); reconnect by hand
  // either way, from the cursor the cache has now: after 0.25 and 0.5 s, then every second. A
  // reconnect costs one small delta, so a few users retrying every second cost nothing.
  es.onerror = () => {
    es.close();
    phase('sync-lost');
    retry = setTimeout(() => connect(c), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  };
  reconnectNow = () => {
    if (retry === undefined) return;
    clearTimeout(retry);
    connect(c);
  };
}
let reconnectNow = () => {};
self.addEventListener('online', () => reconnectNow());

async function lead(c: Cache) {
  leader = true;
  phase('sync-leader');
  connect(c);
  c.compactSoon();
  await new Promise(() => {}); // holds the lock until the tab closes
}

// Asked at boot, so a first visit knows whether to persist its snapshot.
const leading = new Promise<boolean>((resolve) => {
  void navigator.locks.request('beghu-sync', { ifAvailable: true }, async (lock) => {
    leader = !!lock;
    resolve(leader);
    if (lock) await lead(await opening);
  });
});

void opening.then(async (c) => {
  if (await leading) return;
  // Another tab syncs. Ready once the cache is at least as new as the server was when this tab
  // opened; then follow, and take over the stream if that tab goes.
  await c.serial(async () => changed(await c.catchUp(false))).catch(() => {});
  markReady();
  void navigator.locks.request('beghu-sync', () => lead(c));
});

// --- the page's requests ---------------------------------------------------------------------

onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if ('fetch' in m) return allowFetch();
  if ('write' in m) {
    const { wid, id, label } = m.write;
    // Shown in the list at once if the cache holds the row; the page shows it in the detail.
    // `own`: the page already shows this change in its detail, so it only re-asks for the list.
    if (cache?.optimistic(wid, id, label)) post({ changed: [id], own: true });
    try {
      const { seq } = await addLabel(id, label.name);
      cache?.confirm(wid, seq);
      post({ written: { wid, ok: true } });
    } catch {
      const rolled = cache?.rollback(wid);
      if (rolled !== undefined) post({ changed: [rolled], own: true });
      post({ written: { wid, ok: false } });
    }
    return;
  }
  const { id, view, offset, limit } = m;
  post({ id, page: (await opening).query(view, offset, limit) });
};
