// The browser-side cache as a TanStack DB collection, in the worker. One `issues` collection holds
// every non-stub row (issues and PRs, no bodies). Its sync config is a custom adapter that only
// hands out its begin/write/commit: the worker (worker.ts) decides what to apply, from IndexedDB,
// the stored snapshot, `/api/sync` deltas, or another tab. Queries are live queries; writes are
// optimistic updates that TanStack DB rolls back if the handler throws.
//
// IndexedDB holds the server's responses as they came, one record per snapshot or delta, as in the
// hand-rolled baseline (TanStack DB's own SQLite persistence was too slow at this size; see
// RESULTS.md). Only the tab that syncs writes to it.
import {
  BTreeIndex,
  configureIndexDevMode,
  count,
  createCollection,
  createLiveQueryCollection,
  eq,
  ilike,
  inArray,
  type ChangeMessageOrDeleteKeyMessage,
  type Collection,
} from '@tanstack/db';
import type { CacheRow, IssueRow, Label, Page, Snapshot, View } from './api';

configureIndexDevMode({ enabled: false });

/** One row of the collection: the server's tuple with its dictionary indexes resolved. `k` is the
 *  list's sort key (`updated_at` desc, `id` desc) as one string, so one index serves the order. */
export type Issue = {
  id: number;
  number: number;
  repo: string;
  pr: boolean;
  title: string;
  open: boolean;
  updated: number;
  k: string;
  comments_count: number;
  labels: Label[];
  labelNames: string[];
  assignees: string[];
};

type Dicts = { repos: string[]; labels: Label[]; users: string[] };

/** A page whose total isn't counted yet (`null`); the worker posts it when it is. */
export type LazyPage = Omit<Page, 'total'> & { total: number | null };

// Deltas pile up as records; past this many, the syncing tab replaces them with one record of its
// own state, written in the background.
const MAX_RECORDS = 50;
// The page's first request for a view: `warm` builds the same query.
const FIRST_PAGE = 100;

const fetchText = (since: number) =>
  fetch(`/api/snapshot?since=${since}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))));

// Benchmark only: CDP's CPU throttle reaches the main thread but not workers, so synchronous work
// spins for `cpu - 1` times as long as it took. It wraps every call into TanStack DB that does its
// work synchronously: applying a sync transaction (and the live queries it updates) and building
// a live query. Nested calls (a page's query building its state's collection) spin once, in the
// outermost call.
let depth = 0;
export function throttled<T>(cpu: number, f: () => T): T {
  if (cpu <= 1 || depth > 0) return f();
  const t0 = performance.now();
  depth++;
  let out: T;
  try {
    out = f();
  } finally {
    depth--;
  }
  const until = t0 + (performance.now() - t0) * cpu;
  while (performance.now() < until);
  return out;
}

const pad = (n: number) => String(n).padStart(12, '0');

const toIssue = (r: CacheRow, d: Dicts): Issue => {
  const [id, number, repo, pr, title, open, updated, comments_count, labels, users] = r;
  const ls = labels.map((l) => d.labels[l]);
  return {
    id,
    number,
    repo: d.repos[repo],
    pr: pr === 1,
    title,
    open: open === 1,
    updated,
    k: pad(updated) + pad(id),
    comments_count,
    labels: ls,
    labelNames: ls.map((l) => l.name),
    assignees: users.map((u) => d.users[u]),
  };
};

type Sink = {
  begin: () => void;
  write: (m: ChangeMessageOrDeleteKeyMessage<Issue, number>) => void;
  commit: () => void;
  truncate: () => void;
  markReady: () => void;
};

export class Store {
  readonly issues: Collection<Issue, number>;
  seq = 0;
  epoch = '';
  private dicts: Dicts = { repos: [], labels: [], users: [] };
  private sink!: Sink;
  private chain: Promise<unknown> = Promise.resolve();
  private records = 0;
  private compacting = false;
  // Writes wait for the cache to pass the `seq` the server gave them.
  private waiters: { seq: number; done: () => void }[] = [];
  /** Rows with a write in flight; compaction waits for them, since the collection only shows
   *  their optimistic copy. */
  readonly writing = new Set<number>();
  readonly query: (view: View, offset: number, limit: number, counted: (n: number) => void) => LazyPage | Promise<LazyPage>;
  /** Builds the default view's query before the cache says it is ready, and the other state's
   *  after: built on first use instead, each costs a following tab's first change or a state
   *  switch about 0.6 s at 1×. */
  readonly warm: () => Promise<void>;

  private constructor(
    private db: IDBDatabase,
    private cpu: number,
  ) {
    this.issues = createCollection<Issue, number>({
      id: 'issues',
      getKey: (i) => i.id,
      sync: {
        rowUpdateMode: 'full',
        sync: ({ begin, write, commit, truncate, markReady }) => {
          this.sink = { begin, write, commit, truncate, markReady };
        },
      },
      // An optimistic label: post it, then hold the optimistic row until the cache has passed the
      // write's `seq` (the server's copy then carries the label). A throw rolls the row back.
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          for (const name of m.modified.labelNames.filter((n) => !m.original.labelNames.includes(n))) {
            const r = await fetch(`/api/issues/${m.key}/labels`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            if (!r.ok) throw new Error(`${r.status}`);
            const { seq } = (await r.json()) as { seq: number };
            if (seq > this.seq) await new Promise<void>((done) => this.waiters.push({ seq, done }));
          }
        }
      },
    });
    this.issues.startSyncImmediate();
    ({ query: this.query, warm: this.warm } = views(this.issues, cpu));
  }

  /** Opens the cache: from IndexedDB when it has a copy, else from the stored snapshot, fetched
   *  once `fetchAfter` resolves. `persisted` fires once a full snapshot is in IndexedDB. */
  static async open(hooks: {
    start: () => void;
    persisted: () => void;
    fetchAfter: Promise<void>;
    persist: () => boolean;
    cpu: number;
    phase: (name: string) => void;
  }): Promise<Store> {
    const { phase, cpu } = hooks;
    const store = new Store(await openIdb(), cpu);
    const saved = await loadSaved(store.db);
    phase('cache-idb-read');
    // Records chain: a full snapshot, then deltas that each start at or before the cursor the ones
    // before reached. Stop at a gap; the stream catches up from there.
    let used = 0;
    for (const text of saved) {
      const snap = store.parse(text);
      if (used ? snap.from > store.seq || snap.epoch !== store.epoch : snap.from !== 0) break;
      store.apply(snap);
      used++;
    }
    store.records = used < saved.length ? MAX_RECORDS + 1 : used;
    if (used) {
      phase('cache-decoded');
    } else {
      hooks.start();
      await hooks.fetchAfter;
      const text = await fetchText(0);
      phase('cache-fetched');
      store.apply(store.parse(text));
      phase('cache-decoded');
      if (hooks.persist()) {
        store.records = 1;
        void append(store.db, text, true).then(hooks.persisted);
      }
    }
    store.sink.markReady();
    return store;
  }

  /** Runs `f` after every earlier call has finished, so deltas apply one at a time, in order. */
  serial<T>(f: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(f);
    this.chain = run.catch(() => {});
    return run;
  }

  private parse(text: string): Snapshot {
    return throttled(this.cpu, () => JSON.parse(text));
  }

  // Writes a snapshot or delta into the collection in one sync transaction.
  private apply(snap: Snapshot) {
    throttled(this.cpu, () => {
      this.epoch = snap.epoch;
      if (snap.repos && snap.labels && snap.users) this.dicts = { repos: snap.repos, labels: snap.labels, users: snap.users };
      const { begin, write, commit } = this.sink;
      begin();
      for (const r of snap.items) {
        const row = toIssue(r, this.dicts);
        write({ type: this.issues.has(row.id) ? 'update' : 'insert', value: row });
      }
      for (const id of snap.deleted) if (this.issues.has(id)) write({ type: 'delete', key: id });
      commit();
    });
    this.seq = Math.max(this.seq, snap.seq);
    for (let i = this.waiters.length - 1; i >= 0; i--)
      if (this.waiters[i].seq <= this.seq) this.waiters.splice(i, 1)[0].done();
  }

  /** Applies a delta from the stream or another tab: the ids it changed, or `null` when it starts
   *  after the cursor (something was missed: catch up over HTTP). Call inside `serial`. */
  receive(text: string): number[] | null {
    const snap = this.parse(text);
    if (snap.seq <= this.seq && snap.epoch === this.epoch) return [];
    if (snap.from > this.seq || snap.epoch !== this.epoch) return null;
    this.apply(snap);
    return [...snap.items.map((r) => r[0]), ...snap.deleted];
  }

  /** Fetches and applies every row changed since the cursor; starts over if the mirror changed
   *  epoch. Only the syncing tab persists the response. Call inside `serial`. */
  async catchUp(persist: boolean) {
    const text = await fetchText(this.seq);
    const ids = this.receive(text);
    if (ids === null) await this.reset(persist);
    else if (persist && ids.length) await this.persist(text);
  }

  /** Stores a delta the cache has applied. Past MAX_RECORDS, a compaction follows. */
  async persist(text: string) {
    await append(this.db, text, false);
    this.records++;
    this.compactSoon();
  }

  /** Replaces the stored records with the cache's own state, a while from now, if there are too
   *  many. Only the syncing tab calls it. */
  compactSoon() {
    if (this.records <= MAX_RECORDS || this.compacting) return;
    this.compacting = true;
    const later = () =>
      setTimeout(() => {
        if (this.writing.size) return later();
        void this.serial(async () => {
          await append(this.db, throttled(this.cpu, () => this.ownSnapshot()), true);
          this.records = 1;
        }).finally(() => (this.compacting = false));
      }, 2000);
    later();
  }

  // The cache as one full snapshot in the server's format.
  private ownSnapshot(): string {
    const repos = new Map<string, number>();
    const labels = new Map<string, number>();
    const users = new Map<string, number>();
    const d: Dicts = { repos: [], labels: [], users: [] };
    const ix = <T>(m: Map<string, number>, into: T[], key: string, v: T) => {
      let i = m.get(key);
      if (i === undefined) m.set(key, (i = into.push(v) - 1));
      return i;
    };
    const items: CacheRow[] = [];
    for (const i of this.issues.values())
      items.push([
        i.id,
        i.number,
        ix(repos, d.repos, i.repo, i.repo),
        i.pr ? 1 : 0,
        i.title,
        i.open ? 1 : 0,
        i.updated,
        i.comments_count,
        i.labels.map((l) => ix(labels, d.labels, `${l.name}\u0000${l.color}`, l)),
        i.assignees.map((u) => ix(users, d.users, u, u)),
      ]);
    const snap: Snapshot = { epoch: this.epoch, from: 0, seq: this.seq, ...d, items, deleted: [] };
    return JSON.stringify(snap);
  }

  /** Starts over from a fresh snapshot: the server's mirror changed epoch. */
  async reset(persist: boolean) {
    const text = await fetchText(0);
    throttled(this.cpu, () => {
      this.sink.begin();
      this.sink.truncate();
      this.sink.commit();
    });
    this.seq = 0;
    this.apply(this.parse(text));
    if (persist) {
      await append(this.db, text, true);
      this.records = 1;
    }
  }

  /** Adds `label` to row `id` at once; resolves once the server has it, rejects (after the
   *  collection has rolled it back) if it refused. */
  async addLabel(id: number, label: Label) {
    if (!this.issues.has(id)) throw new Error('not in the cache');
    this.writing.add(id);
    try {
      const tx = throttled(this.cpu, () =>
        this.issues.update(id, (d) => {
          if (d.labelNames.includes(label.name)) return;
          d.labels.push(label);
          d.labelNames.push(label.name);
        }),
      );
      await tx.isPersisted.promise;
    } finally {
      this.writing.delete(id);
    }
  }
}

// A view's rows come from a live query over the state's derived collection (non-PR rows of one
// state, indexed on the sort key), with `limit`, so TanStack DB walks the index only until the
// page is full. The total is a separate count query, built after the page is answered: it has to
// see every row. Recent queries stay alive, so a live change re-reads maintained results.
function views(issues: Collection<Issue, number>, cpu: number) {
  const states = new Map<boolean, Collection<Issue, number>>();
  const state = (open: boolean) => {
    let c = states.get(open);
    if (!c) {
      c = throttled(cpu, () => {
        const lq = createLiveQueryCollection({
          startSync: true,
          gcTime: 24 * 3600_000,
          query: (q) =>
            q
              .from({ i: issues })
              .where(({ i }) => eq(i.pr, false))
              .where(({ i }) => eq(i.open, open)),
        }) as unknown as Collection<Issue, number>;
        lq.createIndex((i) => i.k, { indexType: BTreeIndex });
        return lq;
      });
      states.set(open, c);
    }
    return c;
  };
  const filtered = (view: View) => (q: any) => {
    let b = q.from({ i: state(view.state === 'open') });
    for (const l of view.labels) b = b.where(({ i }: any) => inArray(l, i.labelNames));
    for (const a of view.assignees) b = b.where(({ i }: any) => inArray(a, i.assignees));
    if (view.q) b = b.where(({ i }: any) => ilike(i.title, `%${view.q}%`));
    return b;
  };

  const lru = <T extends { cleanup: () => Promise<void> }>(keep: number) => {
    const m = new Map<string, T>();
    return (key: string, make: () => T) => {
      let v = m.get(key);
      if (v) m.delete(key);
      else v = make();
      m.set(key, v);
      for (const [k, old] of m) {
        if (m.size <= keep) break;
        m.delete(k);
        void old.cleanup();
      }
      return v;
    };
  };
  const pages = lru<Collection<Issue, number>>(8);
  const counts = lru<Collection<{ n: number }, string | number>>(4);
  const counting = new WeakSet<object>();
  // Row objects for the page, kept per collection row so a re-read gives the page the same
  // objects for unchanged rows and Solid keeps their DOM.
  const rowsOf = new WeakMap<Issue, IssueRow>();
  const toRow = (r: Issue): IssueRow => {
    const src = issues.get(r.id) ?? r;
    let out = rowsOf.get(src);
    if (!out) {
      out = {
        id: r.id,
        number: r.number,
        repo: r.repo,
        title: r.title,
        state: r.open ? 'open' : 'closed',
        updated_at: new Date(r.updated * 1000).toISOString().replace('.000Z', 'Z'),
        comments_count: r.comments_count,
        labels: r.labels,
        assignees: r.assignees,
      };
      rowsOf.set(src, out);
    }
    return out;
  };

  const query = (view: View, offset: number, limit: number, counted: (n: number) => void): LazyPage | Promise<LazyPage> => {
    const key = JSON.stringify(view);
    const lq = pages(`${key}|${offset}|${limit}`, () =>
      throttled(cpu, () =>
        createLiveQueryCollection({
          startSync: true,
          query: (q) =>
            filtered(view)(q)
              .orderBy(({ i }: any) => i.k, 'desc')
              .offset(offset)
              .limit(limit),
        }) as unknown as Collection<Issue, number>,
      ),
    );
    const total = (): number | null => {
      const c = counts(key, () =>
        createLiveQueryCollection({ query: (q) => filtered(view)(q).select(({ i }: any) => ({ n: count(i.id) })) }) as unknown as Collection<{ n: number }, string | number>,
      );
      if (c.status === 'ready') return c.toArray[0]?.n ?? 0;
      // Counted once, after this page is answered; the worker posts the total when it's ready.
      if (c.status === 'idle' && !counting.has(c)) {
        counting.add(c);
        setTimeout(() => {
          throttled(cpu, () => c.startSyncImmediate());
          void c.toArrayWhenReady().then(() => counted(c.toArray[0]?.n ?? 0));
        });
      }
      return null;
    };
    const answer = (): LazyPage => {
      const rows = throttled(cpu, () => lq.toArray.map(toRow));
      return { rows, total: total() };
    };
    return lq.status === 'ready' ? answer() : lq.toArrayWhenReady().then(answer);
  };
  // Before the cache says it's ready: the open state and its first page, which the page's
  // switch-over and a following tab's first change ask for. Then, in the background, that page's
  // total and the closed state.
  const first = (state: View['state'], counted: () => void) =>
    query({ state, labels: [], assignees: [], q: '' }, 0, FIRST_PAGE, counted);
  const warm = async () => {
    await first('open', () => setTimeout(() => void first('closed', () => {})));
  };
  return { query, warm };
}

// --- IndexedDB -------------------------------------------------------------------------------

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function openIdb() {
  const r = indexedDB.open('beghu-cache', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('responses', { autoIncrement: true });
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
