// The browser-side cache for the client and worker variants, framework-free so it runs on either
// thread. Every non-stub row (issues and PRs, no bodies) lives in memory, newest first, and in
// IndexedDB for the next visit. A query is a scan of the in-memory list, or of the last query's
// matches when it only narrows them.
//
// IndexedDB holds the server's responses as they came: one record per snapshot or delta, each the
// raw JSON text. Storing a string is a copy, where storing 25k row objects is 25k structured
// clones; that was most of the idiomatic build's load time (see OPTIMISATION.md).
import type { CacheRow, IssueRow, Label, Page, Snapshot, View } from './api';

// A row is the server's tuple as parsed, with three slots added: the lowercased title (the search
// index) and bitmasks of its label names and assignees. Its repo, label and user slots hold
// indexes into the cache's own dictionaries. No row object is built until a query returns the row
// (see `issue`).
type Row = [...CacheRow, string, number, number];
const ID = 0, REPO = 2, PR = 3, TITLE = 4, OPEN = 5, UPDATED = 6, LABELS = 8, USERS = 9, LT = 10, LMASK = 11, UMASK = 12;

// Bitmasks hold 31 label names and 31 users; past that, queries check the index arrays instead.
const BITS = 31;

const subset = (a: string[], b: string[]) => a.every((x) => b.includes(x));

const before = (a: Row, b: Row) => a[UPDATED] > b[UPDATED] || (a[UPDATED] === b[UPDATED] && a[ID] > b[ID]);

// Maps each index of a snapshot's dictionary to the cache's index for the same entry, adding
// entries the cache hasn't seen. `null` when every index maps to itself, the usual case.
function merge<T>(into: T[], ix: Map<string, number>, from: T[], key: (t: T) => string): number[] | null {
  let same = true;
  const map = from.map((t, i) => {
    const k = key(t);
    let j = ix.get(k);
    if (j === undefined) ix.set(k, (j = into.push(t) - 1));
    if (j !== i) same = false;
    return j;
  });
  return same ? null : map;
}

// Deltas pile up as records; past this many, the next visit replaces them with one snapshot.
const MAX_RECORDS = 50;

const fetchText = (since: number) =>
  fetch(`/api/snapshot?since=${since}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))));

// Benchmark only: CDP's CPU throttle reaches the main thread but not workers, so a worker's cache
// spins after each synchronous chunk of work (parse, decode, scan) for `cpu - 1` times as long as
// the chunk took. That makes a 6× profile slow the worker as it slows the page.
function throttled<T>(cpu: number, f: () => T): T {
  if (cpu <= 1) return f();
  const t0 = performance.now();
  const out = f();
  const until = t0 + (performance.now() - t0) * cpu;
  while (performance.now() < until);
  return out;
}

export class Cache {
  private rows: Row[] = [];
  private cpu = 1;
  private chain: Promise<unknown> = Promise.resolve();
  // The dictionaries every row indexes into, and a lookup by key for merging deltas.
  private repos: string[] = [];
  private labels: Label[] = [];
  private users: string[] = [];
  private repoIx = new Map<string, number>();
  private labelIx = new Map<string, number>();
  private userIx = new Map<string, number>();
  // Label name to bit, and each label index's bit (-1 past BITS names).
  private nameBit = new Map<string, number>();
  private labelBit: number[] = [];
  // The last query's full match list. A query that only narrows it (same state, a longer search,
  // more labels or assignees), or pages through it, scans those rows instead of every row.
  private last: { view: View; q: string; matches: Row[] } | undefined;
  // A query's result rows, built once per row and reused while the row is unchanged.
  private issues = new WeakMap<Row, IssueRow>();
  seq = 0;

  private constructor(private db: IDBDatabase) {}

  /** Opens the cache: from IndexedDB when it has a copy, else from a full snapshot, fetched once
   *  `fetchAfter` resolves. `persisted` fires once a full snapshot is in IndexedDB (the "cache is
   *  warm" moment). Writes wait for `idle`, so they never delay the first render. */
  static async open(
    hooks: {
      start?: () => void;
      persisted?: () => void;
      idle?: () => Promise<void>;
      fetchAfter?: Promise<void>;
      cpu?: number;
      phase?: (name: string) => void;
    } = {},
  ): Promise<Cache> {
    const phase = hooks.phase ?? (() => {});
    const cache = new Cache(await openDb());
    cache.cpu = hooks.cpu ?? 1;
    const idle = hooks.idle ?? (() => Promise.resolve());
    const saved = await loadSaved(cache.db);
    phase('cache-idb-read');
    if (saved.length) {
      for (const text of saved) cache.applyText(text);
      phase('cache-decoded');
      if (saved.length > MAX_RECORDS) void idle().then(() => cache.compact());
    } else {
      hooks.start?.();
      await hooks.fetchAfter;
      const text = await fetchText(0);
      phase('cache-fetched');
      cache.applyText(text);
      phase('cache-decoded');
      void idle()
        .then(() => append(cache.db, text, true))
        .then(hooks.persisted);
    }
    return cache;
  }

  query(view: View, offset: number, limit: number): Page {
    return throttled(this.cpu, () => this.scan(view, offset, limit));
  }

  private scan(view: View, offset: number, limit: number): Page {
    const q = view.q.toLowerCase();
    const last = this.last;
    const narrows =
      last &&
      last.view.state === view.state &&
      q.startsWith(last.q) &&
      subset(last.view.labels, view.labels) &&
      subset(last.view.assignees, view.assignees);
    let matches: Row[];
    if (narrows && last.q === q && last.view.labels.length === view.labels.length && last.view.assignees.length === view.assignees.length) {
      matches = last.matches; // the same view: another page
    } else {
      matches = this.match(narrows ? last.matches : this.rows, view, q);
      this.last = { view, q, matches };
    }
    const rows = matches.slice(offset, offset + limit).map((r) => this.issue(r));
    return { rows, total: matches.length };
  }

  private match(from: Row[], view: View, q: string): Row[] {
    const open = view.state === 'open' ? 1 : 0;
    const masks = this.nameBit.size <= BITS && this.users.length <= BITS;
    // Required bits, or (past BITS) each label name as the label indexes that carry it, and each
    // assignee as a user index. An unknown name matches nothing.
    let lmask = 0;
    let umask = 0;
    let none = false;
    for (const n of view.labels) {
      const bit = this.nameBit.get(n);
      if (bit === undefined) none = true;
      else lmask |= 1 << bit;
    }
    for (const a of view.assignees) {
      const u = this.userIx.get(a);
      if (u === undefined) none = true;
      else umask |= 1 << u;
    }
    if (none) return [];
    const labels = masks ? [] : view.labels.map((n) => new Set(this.labels.flatMap((l, i) => (l.name === n ? [i] : []))));
    const users = masks ? [] : view.assignees.map((a) => this.userIx.get(a)!);
    const out: Row[] = [];
    for (const r of from) {
      if (r[PR] || r[OPEN] !== open) continue;
      if (masks) {
        if ((r[LMASK] & lmask) !== lmask || (r[UMASK] & umask) !== umask) continue;
      } else {
        if (labels.length && !labels.every((set) => r[LABELS].some((l) => set.has(l)))) continue;
        if (users.length && !users.every((u) => r[USERS].includes(u))) continue;
      }
      if (q && !r[LT].includes(q)) continue;
      out.push(r);
    }
    return out;
  }

  private issue(r: Row): IssueRow {
    let out = this.issues.get(r);
    if (!out) {
      const [id, number, repo, , title, open, updated_at, comments_count, labels, users] = r;
      out = {
        id,
        number,
        repo: this.repos[repo],
        title,
        state: open ? 'open' : 'closed',
        updated_at: new Date(updated_at * 1000).toISOString().replace('.000Z', 'Z'),
        comments_count,
        labels: labels.map((l) => this.labels[l]),
        assignees: users.map((u) => this.users[u]),
      };
      this.issues.set(r, out);
    }
    return out;
  }

  /** Fetches and applies every row changed since the cursor; resolves with their ids. Calls are
   *  serialised, so a burst of live events never applies a delta twice. */
  catchUp(): Promise<number[]> {
    const run = this.chain.then(async () => {
      const text = await fetchText(this.seq);
      const snap: Snapshot = throttled(this.cpu, () => JSON.parse(text));
      if (!snap.items.length) return [];
      throttled(this.cpu, () => this.apply(snap));
      await append(this.db, text, false);
      return snap.items.map((r) => r[0]);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private applyText(text: string) {
    throttled(this.cpu, () => this.apply(JSON.parse(text)));
  }

  private apply(snap: Snapshot) {
    const repos = merge(this.repos, this.repoIx, snap.repos, (r) => r);
    const labels = merge(this.labels, this.labelIx, snap.labels, (l) => `${l.name}\u0000${l.color}`);
    const users = merge(this.users, this.userIx, snap.users, (u) => u);
    for (let i = this.labelBit.length; i < this.labels.length; i++) {
      const name = this.labels[i].name;
      if (!this.nameBit.has(name)) this.nameBit.set(name, this.nameBit.size);
      const bit = this.nameBit.get(name)!;
      this.labelBit.push(bit < BITS ? bit : -1);
    }
    const rows = snap.items as unknown as Row[];
    for (const r of rows) {
      if (repos) r[REPO] = repos[r[REPO]];
      if (labels) r[LABELS] = r[LABELS].map((l) => labels[l]);
      if (users) r[USERS] = r[USERS].map((u) => users[u]);
      r[LT] = r[TITLE].toLowerCase();
      let lmask = 0;
      for (const l of r[LABELS]) if (this.labelBit[l] >= 0) lmask |= 1 << this.labelBit[l];
      let umask = 0;
      for (const u of r[USERS]) if (u < BITS) umask |= 1 << u;
      r[LMASK] = lmask;
      r[UMASK] = umask;
    }
    this.last = undefined;
    if (!this.rows.length) {
      // A full snapshot arrives newest first; sort only if it didn't.
      this.rows = rows.every((r, i) => i === 0 || before(rows[i - 1], r)) ? rows : rows.sort((a, b) => (before(a, b) ? -1 : 1));
    } else if (rows.length > 1000) {
      const byId = new Map(this.rows.map((r) => [r[ID], r]));
      for (const r of rows) byId.set(r[ID], r);
      this.rows = [...byId.values()].sort((a, b) => (before(a, b) ? -1 : 1));
    } else {
      // No id index: building one costs more at load than a small delta's scans for its old rows.
      const ids = new Set(rows.map((r) => r[ID]));
      this.rows = this.rows.filter((r) => !ids.has(r[ID]));
      for (const r of rows) this.rows.splice(this.position(r), 0, r);
    }
    this.seq = Math.max(this.seq, snap.seq);
  }

  // Replaces the stored records with one fresh snapshot.
  private compact() {
    return (this.chain = this.chain.then(async () => append(this.db, await fetchText(0), true)).catch(() => {}));
  }

  // The index of `r` if present, else where it belongs.
  private position(r: Row) {
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
