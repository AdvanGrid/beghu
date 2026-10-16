// The idiomatic pass of web/src/cache.ts (one IndexedDB record per row), kept for reference and
// re-runs: copy it over web/src/cache.ts. See OPTIMISATION.md.
// The browser-side cache for the client and worker variants, framework-free so it runs on either
// thread. Every non-stub row (issues and PRs, no bodies) lives in memory, newest first, and in
// IndexedDB for the next visit. A query is a scan of the in-memory list.
import { getSnapshot, type IssueRow, type Page, type Snapshot, type View } from './api';

export type Cached = IssueRow & { pr: boolean };
// `lt` (the lowercased title) is the in-memory index; it isn't persisted.
type Entry = Cached & { lt: string };

const before = (a: Cached, b: Cached) => a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.id > b.id);

function decode(s: Snapshot): Cached[] {
  return s.items.map(([id, number, repo, pr, title, open, updated_at, comments_count, labels, assignees]) => ({
    id,
    number,
    repo: s.repos[repo],
    pr,
    title,
    state: open ? 'open' : 'closed',
    updated_at,
    comments_count,
    labels: labels.map((l) => s.labels[l]),
    assignees: assignees.map((u) => s.users[u]),
  }));
}

const entry = (r: Cached): Entry => ({ ...r, lt: r.title.toLowerCase() });

export class Cache {
  private rows: Entry[] = [];
  private byId = new Map<number, Entry>();
  private chain: Promise<unknown> = Promise.resolve();
  seq = 0;

  private constructor(private db: IDBDatabase) {}

  /** Opens the cache: from IndexedDB when it has a copy, else from a full snapshot. `persisted`
   *  fires once a full snapshot is in IndexedDB (the "cache is warm" moment). */
  static async open(hooks: { start?: () => void; persisted?: () => void } = {}): Promise<Cache> {
    const cache = new Cache(await openDb());
    const saved = await loadSaved(cache.db);
    if (saved) {
      cache.replace(saved.rows);
      cache.seq = saved.seq;
    } else {
      hooks.start?.();
      const snap = await getSnapshot(0);
      const rows = decode(snap);
      cache.replace(rows);
      cache.seq = snap.seq;
      void save(cache.db, rows, snap.seq).then(hooks.persisted);
    }
    return cache;
  }

  query(view: View, offset: number, limit: number): Page {
    const q = view.q.toLowerCase();
    const { state, labels, assignees } = view;
    const rows: IssueRow[] = [];
    let total = 0;
    for (const r of this.rows) {
      if (r.pr || r.state !== state) continue;
      if (q && !r.lt.includes(q)) continue;
      if (labels.length && !labels.every((n) => r.labels.some((l) => l.name === n))) continue;
      if (assignees.length && !assignees.every((a) => r.assignees.includes(a))) continue;
      if (total >= offset && rows.length < limit) rows.push(r);
      total++;
    }
    return { rows, total };
  }

  /** Fetches and applies every row changed since the cursor; resolves with their ids. Calls are
   *  serialised, so a burst of live events never applies a delta twice. */
  catchUp(): Promise<number[]> {
    const run = this.chain.then(async () => {
      const snap = await getSnapshot(this.seq);
      if (!snap.items.length) return [];
      const rows = decode(snap);
      this.patch(rows);
      this.seq = snap.seq;
      await save(this.db, rows, snap.seq);
      return rows.map((r) => r.id);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private replace(rows: Cached[]) {
    this.rows = rows.map(entry).sort((a, b) => (before(a, b) ? -1 : 1));
    this.byId = new Map(this.rows.map((r) => [r.id, r]));
  }

  // Removes each changed row from its old position and binary-inserts the new one.
  private patch(rows: Cached[]) {
    if (rows.length > 1000) return this.replace([...new Map([...this.byId, ...rows.map((r) => [r.id, r] as const)]).values()]);
    for (const r of rows) {
      const old = this.byId.get(r.id);
      if (old) this.rows.splice(this.position(old), 1);
      const e = entry(r);
      this.rows.splice(this.position(e), 0, e);
      this.byId.set(e.id, e);
    }
  }

  // The index of `r` if present, else where it belongs.
  private position(r: Cached) {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(this.rows[mid], r)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// --- IndexedDB -------------------------------------------------------------------------------

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function openDb() {
  const r = indexedDB.open('beghu-cache', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('items');
    r.result.createObjectStore('meta');
  };
  return req(r);
}

async function loadSaved(db: IDBDatabase): Promise<{ rows: Cached[]; seq: number } | null> {
  const tx = db.transaction(['items', 'meta'], 'readonly');
  const [seq, rows] = await Promise.all([req(tx.objectStore('meta').get('seq')), req(tx.objectStore('items').getAll())]);
  return typeof seq === 'number' ? { rows, seq } : null;
}

// One row per record, keyed by id. The cursor is written in the same transaction, so a copy with
// a cursor always holds the rows up to it.
function save(db: IDBDatabase, rows: Cached[], seq: number) {
  const tx = db.transaction(['items', 'meta'], 'readwrite');
  const items = tx.objectStore('items');
  for (const r of rows) items.put(r, r.id);
  tx.objectStore('meta').put(seq, 'seq');
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
