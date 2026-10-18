// The worker: owns the TanStack DB store, the sync connection, writes and every query. The sync
// orchestration is the hand-rolled baseline's: of all the tabs open on beghu, one syncs. Its worker
// holds the `beghu-sync` Web Lock, keeps the `/api/sync` stream open from its cursor, persists
// each delta to IndexedDB and passes it on over a BroadcastChannel. The others apply what it
// passes on, and catch up over HTTP when they find a gap. When the syncing tab closes, the lock
// goes to a waiting tab, which opens the stream from its own cursor.
import { Store } from './db';
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
const opening = Store.open({
  start: () => phase('cache-start'),
  persisted: () => phase('cache-warm'),
  persist: () => leader,
  phase,
  fetchAfter,
  cpu,
});

let ready = false;
const markReady = () => {
  if (ready) return;
  ready = true;
  void opening
    .then((s) => s.warm())
    .then(() => post({ mark: 'cache-ready' }));
};

// Every change the page might show: from the server, another tab, or an optimistic write. A change
// to a row with a write in flight is the page's own: it shows the label in the detail already, so
// it only re-asks for the list.
void opening.then((s) =>
  s.issues.subscribeChanges((changes) => {
    const ids = [...new Set(changes.map((c) => c.key))];
    if (!ids.length) return;
    post(ids.every((id) => s.writing.has(id)) ? { changed: ids, own: true } : { changed: ids });
  }),
);

// --- following the syncing tab ---------------------------------------------------------------

const channel = new BroadcastChannel('beghu-sync');
channel.onmessage = (e: MessageEvent<string>) => {
  if (leader) return;
  void opening.then((s) => s.serial(async () => s.receive(e.data) ?? (await s.catchUp(false))));
};

// --- syncing ---------------------------------------------------------------------------------

const BACKOFF = [250, 500, 1000];
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect(s: Store) {
  retry = undefined;
  phase('sync-connect');
  const es = new EventSource(`/api/sync?since=${s.seq}&epoch=${encodeURIComponent(s.epoch)}`);
  let first = true;
  es.onopen = () => phase('sync-open');
  es.addEventListener('delta', (e) => {
    const text = (e as MessageEvent<string>).data;
    void s.serial(async () => {
      const ids = s.receive(text);
      if (ids === null) await s.catchUp(true);
      else if (ids.length) {
        await s.persist(text);
        channel.postMessage(text);
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
    void s.serial(() => s.reset(true)).then(() => connect(s));
  });
  // EventSource retries some failures itself but gives up on others (a 503); reconnect by hand
  // either way, from the cursor the cache has now: after 0.25 and 0.5 s, then every second.
  es.onerror = () => {
    es.close();
    phase('sync-lost');
    retry = setTimeout(() => connect(s), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  };
  reconnectNow = () => {
    if (retry === undefined) return;
    clearTimeout(retry);
    connect(s);
  };
}
let reconnectNow = () => {};
self.addEventListener('online', () => reconnectNow());

async function lead(s: Store) {
  leader = true;
  phase('sync-leader');
  connect(s);
  s.compactSoon();
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

void opening.then(async (s) => {
  if (await leading) return;
  // Another tab syncs. Ready once the cache is at least as new as the server was when this tab
  // opened; then follow, and take over the stream if that tab goes.
  await s.serial(() => s.catchUp(false)).catch(() => {});
  markReady();
  void navigator.locks.request('beghu-sync', () => lead(s));
});

// --- the page's requests ---------------------------------------------------------------------

onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if ('fetch' in m) return allowFetch();
  const s = await opening;
  if ('write' in m) {
    const { wid, id, label } = m.write;
    const ok = await s.addLabel(id, label).then(
      () => true,
      () => false,
    );
    post({ written: { wid, ok } });
    return;
  }
  const { id, view, offset, limit } = m;
  // A page may be answered before its total is counted; the total follows on its own.
  post({ id, page: await s.query(view, offset, limit, (n) => post({ counted: { view: JSON.stringify(view), n } })) });
};
