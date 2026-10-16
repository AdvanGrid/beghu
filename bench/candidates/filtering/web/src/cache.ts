// The browser-side cache for the client and worker variants, framework-free so it runs on either
// thread. Every non-stub row (issues and PRs, no bodies) lives in memory, newest first, and in
// IndexedDB for the next visit. A query is a scan of the in-memory list.
//
// IndexedDB holds the server's responses as they came: one record per snapshot or delta, each the
// raw JSON text. Storing a string is a copy, where storing 25k row objects is 25k structured
// clones; that was most of the idiomatic build's load time (see OPTIMISATION.md).
import type { IssueRow, Page, Snapshot, View } from './api';

// `lt` (the lowercased title) is the in-memory index.
type Entry = IssueRow & { pr: boolean; lt: string };

const before = (a: Entry, b: Entry) => a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.id > b.id);

function decode(s: Snapshot): Entry[] {
  const out: Entry[] = new Array(s.items.length);
  for (let i = 0; i < s.items.length; i++) {
    const [id, number, repo, pr, title, open, updated_at, comments_count, labels, assignees] = s.items[i];
    out[i] = {
      id,
      number,
      repo: s.repos[repo],
      pr,
      title,
      lt: title.toLowerCase(),
      state: open ? 'open' : 'closed',
      updated_at,
      comments_count,
      labels: labels.map((l) => s.labels[l]),
      assignees: assignees.map((u) => s.users[u]),
    };
  }
  return out;
}

// Deltas pile up as records; past this many, the next visit replaces them with one snapshot.
const MAX_RECORDS = 50;

const fetchText = (since: number) =>
  fetch(`/api/snapshot?since=${since}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))));

export class Cache {
  private rows: Entry[] = [];
  private byId = new Map<number, Entry>();
  private chain: Promise<unknown> = Promise.resolve();
  seq = 0;

  private constructor(private db: IDBDatabase) {}

  /** Opens the cache: from IndexedDB when it has a copy, else from a full snapshot. `persisted`
   *  fires once a full snapshot is in IndexedDB (the "cache is warm" moment). Writes wait for
   *  `idle`, so they never delay the first render. */
  static async open(hooks: { start?: () => void; persisted?: () => void; idle?: () => Promise<void> } = {}): Promise<Cache> {
    const cache = new Cache(await openDb());
    const idle = hooks.idle ?? (() => Promise.resolve());
    const saved = await loadSaved(cache.db);
    if (saved.length) {
      for (const text of saved) cache.apply(JSON.parse(text));
      if (saved.length > MAX_RECORDS) void idle().then(() => cache.compact());
    } else {
      hooks.start?.();
      const text = await fetchText(0);
      cache.apply(JSON.parse(text));
      void idle()
        .then(() => append(cache.db, text, true))
        .then(hooks.persisted);
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
      const text = await fetchText(this.seq);
      const snap: Snapshot = JSON.parse(text);
      if (!snap.items.length) return [];
      this.apply(snap);
      await append(this.db, text, false);
      return snap.items.map((r) => r[0]);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private apply(snap: Snapshot) {
    const rows = decode(snap);
    if (!this.rows.length) {
      // A full snapshot arrives newest first; sort only if it didn't.
      this.rows = rows.every((r, i) => i === 0 || before(rows[i - 1], r)) ? rows : rows.sort((a, b) => (before(a, b) ? -1 : 1));
      this.byId = new Map(this.rows.map((r) => [r.id, r]));
    } else if (rows.length > 1000) {
      for (const r of rows) this.byId.set(r.id, r);
      this.rows = [...this.byId.values()].sort((a, b) => (before(a, b) ? -1 : 1));
    } else {
      for (const r of rows) {
        const old = this.byId.get(r.id);
        if (old) this.rows.splice(this.position(old), 1);
        this.rows.splice(this.position(r), 0, r);
        this.byId.set(r.id, r);
      }
    }
    this.seq = Math.max(this.seq, snap.seq);
  }

  // Replaces the stored records with one fresh snapshot.
  private compact() {
    return (this.chain = this.chain.then(async () => append(this.db, await fetchText(0), true)).catch(() => {}));
  }

  // The index of `r` if present, else where it belongs.
  private position(r: Entry) {
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
  const r = indexedDB.open('beghu-cache', 2);
  r.onupgradeneeded = () => {
    for (const name of [...r.result.objectStoreNames]) r.result.deleteObjectStore(name);
    r.result.createObjectStore('responses', { autoIncrement: true });
  };
  return req(r);
}

// Every stored response, oldest first, so applying them in order rebuilds the cache.
const loadSaved = (db: IDBDatabase) => req<string[]>(db.transaction('responses', 'readonly').objectStore('responses').getAll());

// Adds one response; a full snapshot (`replace`) clears the older ones in the same transaction.
function append(db: IDBDatabase, text: string, replace: boolean) {
  const tx = db.transaction('responses', 'readwrite');
  const store = tx.objectStore('responses');
  if (replace) store.clear();
  store.add(text);
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
