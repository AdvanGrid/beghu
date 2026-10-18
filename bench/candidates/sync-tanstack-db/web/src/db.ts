// The browser-side cache as a TanStack DB collection, in the worker. One `issues` collection holds
// every non-stub row (issues and PRs, no bodies). Its sync config is a custom adapter that only
// hands out its begin/write/commit: the worker (worker.ts) decides what to apply, from IndexedDB,
// the stored snapshot, `/api/sync` deltas, or another tab. Queries are live queries; writes are
// optimistic updates that TanStack DB rolls back if the handler throws.
//
// IndexedDB holds the server's responses as they came, one record per snapshot or delta, as in the
// hand-rolled baseline (TanStack DB's own SQLite persistence was too slow at this size; see
// RESULTS.md). Only the tab that syncs writes to it.
//
// The collection runs in one of three sync modes (the variant's page picks it):
// - `eager` (default): every row is in the collection before the cache says it is ready.
// - `on-demand`: TanStack DB's `syncMode: 'on-demand'`. Each live query asks the collection's
//   `loadSubset` for the rows it needs, which fetches them from `/api/issues` (the hybrid's server
//   filter). The stream still applies every change. Nothing is persisted.
// - `progressive`: on-demand until the full snapshot (IndexedDB, else `/api/snapshot`) has been
//   loaded in the background, then answered locally, as eager. TanStack DB core has no mode by
//   that name; it is how its Electric adapter describes this behaviour, built here on `on-demand`.
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
  type LoadSubsetOptions,
} from '@tanstack/db';
import { getIssue, issuesUrl, type CacheRow, type IssueRow, type Label, type Page, type Snapshot, type View } from './api';

export type SyncMode = 'eager' | 'on-demand' | 'progressive';

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
export type LazyPage = Omit<Page, 'total' | 'seq'> & { total: number | null };

// Deltas pile up as records; past this many, the syncing tab replaces them with one record of its
// own state, written in the background.
const MAX_RECORDS = 50;
// The page's first request for a view: `warm` builds the same query.
const FIRST_PAGE = 100;
// Progressive: rows per sync transaction while the full copy loads in the background.
const FILL_CHUNK = 1000;

const text = (r: Response) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`)));
const fetchText = (since: number) => fetch(`/api/snapshot?since=${since}`).then(text);
// The cursor, epoch and dictionaries, without rows (on-demand and progressive start from it).
const fetchHead = () => fetch('/api/head').then(text);

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

// A row of a server page (`/api/issues`, issues only) as a collection row.
const fromRow = (r: IssueRow): Issue => {
  const updated = Date.parse(r.updated_at) / 1000;
  return {
    id: r.id,
    number: r.number,
    repo: r.repo,
    pr: false,
    title: r.title,
    open: r.state === 'open',
    updated,
    k: pad(updated) + pad(r.id),
    comments_count: r.comments_count,
    labels: r.labels,
    labelNames: r.labels.map((l) => l.name),
    assignees: r.assignees,
  };
};

// The view a subset request is for, from its `where`, in the order the query added its filters,
// so its key matches the page's. `null` for a request that isn't a view: the tie at a page's
// boundary (`eq(k, …)`, one row, since `k` is unique and already loaded), or a count.
function viewOf(where: any): View | null {
  const v: View = { state: 'open', labels: [], assignees: [], q: '' };
  let state = false;
  const field = (e: any) => (e?.type === 'ref' ? e.path[e.path.length - 1] : undefined);
  const visit = (e: any): boolean => {
    if (e.type !== 'func') return false;
    const [a, b] = e.args;
    switch (e.name) {
      case 'and':
        return e.args.every(visit);
      case 'eq':
        if (field(a) === 'pr') return true;
        if (field(a) === 'open') return (v.state = b.value ? 'open' : 'closed'), (state = true);
        return false;
      case 'in':
        if (field(b) === 'labelNames') return v.labels.push(a.value), true;
        if (field(b) === 'assignees') return v.assignees.push(a.value), true;
        return false;
      case 'ilike':
        return (v.q = String(b.value).slice(1, -1)), field(a) === 'title';
      default:
        return false;
    }
  };
  return where && visit(where) && state ? v : null;
}

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
  dicts: Dicts = { repos: [], labels: [], users: [] };
  /** Every row is in the collection (always, eager; after the background load, progressive). */
  full: boolean;
  /** Set while rows are written that aren't changes (a page loaded, the background load): the
   *  worker doesn't tell the page about them. */
  quiet = false;
  // On-demand and progressive: the `seq` each row was last written at (pages and deltas arrive in
  // either order, and an older copy must not replace a newer one), how many leading rows of each
  // view are loaded, and each view's total as the server last counted it.
  private rowSeq = new Map<number, number>();
  private coverage = new Map<string, number>();
  private loading = new Map<string, Promise<void>>();
  readonly totals = new Map<string, number>();
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
    readonly mode: SyncMode,
  ) {
    this.full = mode === 'eager';
    this.issues = createCollection<Issue, number>({
      id: 'issues',
      getKey: (i) => i.id,
      syncMode: mode === 'eager' ? 'eager' : 'on-demand',
      sync: {
        rowUpdateMode: 'full',
        sync: ({ begin, write, commit, truncate, markReady }) => {
          this.sink = { begin, write, commit, truncate, markReady };
          return mode === 'eager' ? undefined : { loadSubset: (o) => this.loadSubset(o) };
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
    ({ query: this.query, warm: this.warm } = mode === 'eager' ? views(this.issues, cpu) : subsetViews(this));
  }

  get cpuRate() {
    return this.cpu;
  }

  private start(head: Snapshot) {
    this.epoch = head.epoch;
    this.seq = head.seq;
    if (head.repos && head.labels && head.users) this.dicts = { repos: head.repos, labels: head.labels, users: head.users };
  }

  /** On-demand and progressive: makes sure the collection holds the first `offset + limit` rows of
   *  the view a live query asks for, fetching what's missing from `/api/issues`. TanStack DB asks
   *  for a page as a prefix (offset 0, limit offset + limit), so only the rows past what this view
   *  has loaded are fetched. */
  private loadSubset(o: LoadSubsetOptions): true | Promise<void> {
    if (this.full) return true;
    const view = viewOf(o.where);
    if (!view) return true;
    const key = JSON.stringify(view);
    const want = o.limit === undefined ? Infinity : (o.offset ?? 0) + o.limit;
    if (want <= (this.coverage.get(key) ?? 0)) return true;
    const run = (this.loading.get(key) ?? Promise.resolve()).then(() => this.loadRange(view, key, want));
    this.loading.set(key, run.catch(() => {}));
    return run;
  }

  private async loadRange(view: View, key: string, want: number) {
    let have = this.coverage.get(key) ?? 0;
    while (have < want && !this.full) {
      const n = Math.min(500, want - have);
      const body = await fetch(issuesUrl(view, have, n)).then(text);
      const page = throttled(this.cpu, () => JSON.parse(body)) as Page;
      if (have === 0) this.totals.set(key, page.total);
      const receipt = throttled(this.cpu, () => {
        const { begin, write, commit } = this.sink;
        this.quiet = true;
        try {
          begin();
          for (const r of page.rows) {
            if ((this.rowSeq.get(r.id) ?? -1) > page.seq) continue;
            this.rowSeq.set(r.id, page.seq);
            write({ type: this.issues.has(r.id) ? 'update' : 'insert', value: fromRow(r) });
          }
          return commit() as unknown;
        } finally {
          this.quiet = false;
        }
      });
      await receipt;
      have += page.rows.length;
      this.coverage.set(key, page.rows.length < n ? Infinity : have);
      if (page.rows.length < n) break;
    }
  }

  /** Writes row `id` from `/api/issues/{id}` unless a change has written it meanwhile. */
  private async loadRow(id: number) {
    const row = await getIssue(id);
    if (this.issues.has(id)) return;
    const receipt = throttled(this.cpu, () => {
      const { begin, write, commit } = this.sink;
      this.quiet = true;
      try {
        begin();
        write({ type: 'insert', value: fromRow(row) });
        return commit() as unknown;
      } finally {
        this.quiet = false;
      }
    });
    await receipt;
  }

  /** Opens the cache: from IndexedDB when it has a copy, else from the stored snapshot, fetched
   *  once `fetchAfter` resolves. `persisted` fires once a full snapshot is in IndexedDB. */
  static async open(hooks: {
    start: () => void;
    persisted: () => void;
    fetchAfter: Promise<void>;
    persist: () => boolean;
    cpu: number;
    mode: SyncMode;
    phase: (name: string) => void;
  }): Promise<Store> {
    const { phase, cpu, mode } = hooks;
    const store = new Store(await openIdb(), cpu, mode);
    if (mode !== 'eager') {
      // The stream starts at the server's cursor now; pages load as queries ask for them.
      store.start(store.parse(await fetchHead()));
      phase('cache-head');
      store.sink.markReady();
      if (mode === 'progressive') void store.fill(hooks);
      // Nothing to store: `cache-warm` (a full snapshot persisted) has no meaning here.
      else hooks.persisted();
      return store;
    }
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

  /** Progressive: loads every row in the background, as eager does (IndexedDB, else the stored
   *  snapshot once the page has painted), catches up from that copy's cursor, then answers every
   *  query locally. The stream keeps applying changes meanwhile; `rowSeq` keeps the newer copy. The
   *  syncing tab then persists the collection as one record. */
  private async fill(hooks: { fetchAfter: Promise<void>; persist: () => boolean; persisted: () => void; phase: (name: string) => void }) {
    const ctx = { dicts: { repos: [], labels: [], users: [] } as Dicts };
    let seq = 0;
    let epoch = '';
    let used = 0;
    // In chunks, yielding between them, and outside `serial`: deltas, queries and writes go on
    // meanwhile (`rowSeq` keeps whichever copy is newer).
    const load = async (snap: Snapshot) => {
      for (let i = 0; i < snap.items.length || i === 0; i += FILL_CHUNK) {
        const last = i + FILL_CHUNK >= snap.items.length;
        this.quiet = true;
        try {
          this.apply({ ...snap, items: snap.items.slice(i, i + FILL_CHUNK), deleted: last ? snap.deleted : [] }, ctx);
        } finally {
          this.quiet = false;
        }
        await new Promise((r) => setTimeout(r));
      }
      seq = Math.max(seq, snap.seq);
      epoch = snap.epoch;
    };
    for (const text of await loadSaved(this.db)) {
      const snap = this.parse(text);
      if (used ? snap.from > seq || snap.epoch !== epoch : snap.from !== 0) break;
      await load(snap);
      used++;
    }
    if (!used) {
      await hooks.fetchAfter;
      await load(this.parse(await fetchText(0)));
    }
    hooks.phase('cache-filled');
    // From the copy's cursor to now; these are real changes, so the page hears of them.
    const since = await fetchText(seq);
    await this.serial(() => this.apply(this.parse(since), ctx));
    this.full = true;
    hooks.phase('cache-full');
    // Eager's route, built now rather than on the next query.
    await this.warm();
    if (hooks.persist()) {
      this.records = MAX_RECORDS + 1;
      this.compactSoon(hooks.persisted);
    }
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

  // Writes a snapshot or delta into the collection in one sync transaction. `ctx` holds the
  // dictionaries its rows index: the live ones, or (progressive's background load) its own.
  // Outside eager, a row a newer page or delta already wrote is left alone.
  private apply(snap: Snapshot, ctx: { dicts: Dicts } = this) {
    const guard = this.mode !== 'eager';
    const newer = (id: number) => guard && (this.rowSeq.get(id) ?? -1) > snap.seq;
    throttled(this.cpu, () => {
      if (ctx === this) this.epoch = snap.epoch;
      if (snap.repos && snap.labels && snap.users) ctx.dicts = { repos: snap.repos, labels: snap.labels, users: snap.users };
      const { begin, write, commit } = this.sink;
      begin();
      for (const r of snap.items) {
        if (newer(r[0])) continue;
        if (guard) this.rowSeq.set(r[0], snap.seq);
        const row = toIssue(r, ctx.dicts);
        write({ type: this.issues.has(row.id) ? 'update' : 'insert', value: row });
      }
      for (const id of snap.deleted) {
        if (newer(id)) continue;
        if (guard) this.rowSeq.set(id, snap.seq);
        if (this.issues.has(id)) write({ type: 'delete', key: id });
      }
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

  /** Stores a delta the cache has applied. Past MAX_RECORDS, a compaction follows. Only a full
   *  collection is persisted: before that, there's no snapshot for deltas to follow. */
  async persist(text: string) {
    if (!this.full) return;
    await append(this.db, text, false);
    this.records++;
    this.compactSoon();
  }

  /** Replaces the stored records with the cache's own state, a while from now, if there are too
   *  many. Only the syncing tab calls it. */
  compactSoon(done?: () => void) {
    if (!this.full || this.records <= MAX_RECORDS || this.compacting) return;
    this.compacting = true;
    const later = () =>
      setTimeout(() => {
        if (this.writing.size) return later();
        void this.serial(async () => {
          await append(this.db, throttled(this.cpu, () => this.ownSnapshot()), true);
          this.records = 1;
          done?.();
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

  /** Starts over from a fresh snapshot: the server's mirror changed epoch. On-demand and
   *  progressive (not exercised by the benchmark) drop what they loaded and start again from the
   *  new cursor; queries already open stay empty until they're asked again. */
  async reset(persist: boolean) {
    if (this.mode !== 'eager') {
      throttled(this.cpu, () => {
        this.sink.begin();
        this.sink.truncate();
        this.sink.commit();
      });
      this.rowSeq.clear();
      this.coverage.clear();
      this.totals.clear();
      this.full = false;
      this.start(this.parse(await fetchHead()));
      return;
    }
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
    // On-demand and progressive: the page can show a row (server-rendered, or opened by link)
    // before any query has loaded it here, so fetch that one row first.
    if (!this.issues.has(id) && !this.full) await this.loadRow(id);
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

// Eager: a view's rows come from a live query over the state's derived collection (non-PR rows of one
// state, indexed on the sort key), with `limit`, so TanStack DB walks the index only until the
// page is full. The total is a separate count query, built after the page is answered: it has to
// see every row. Recent queries stay alive, so a live change re-reads maintained results.
function views(issues: Collection<Issue, number>, cpu: number) {
  const route = stateRoute(issues, cpu);
  return pagedViews(issues, cpu, () => route, () => true);
}

/** How a view's pages and total are queried: its filtered query, its order, its total when that
 *  isn't counted locally (`undefined`: count it), and a tag naming the route in cache keys. */
type Route = {
  filtered: (view: View) => (q: any) => any;
  order: (q: any, by: (r: any) => unknown) => any;
  serverTotal: (key: string) => number | null | undefined;
  tag: string;
};

function stateRoute(issues: Collection<Issue, number>, cpu: number): Route {
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
  return { filtered, order: (q, f) => q.orderBy(f, 'desc'), serverTotal: () => undefined, tag: 'state' };
}

// Pages, totals and the warm-up over the current route. `warmClosed`: whether warming up also
// builds the closed state, in the background.
function pagedViews(issues: Collection<Issue, number>, cpu: number, route: () => Route, warmClosed: () => boolean) {
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
    const { filtered, order, serverTotal, tag } = route();
    const lq = pages(`${tag}|${key}|${offset}|${limit}`, () =>
      throttled(cpu, () =>
        createLiveQueryCollection({
          startSync: true,
          query: (q) =>
            order(filtered(view)(q), ({ i }: any) => i.k)
              .offset(offset)
              .limit(limit),
        }) as unknown as Collection<Issue, number>,
      ),
    );
    const total = (): number | null => {
      const server = serverTotal(key);
      if (server !== undefined) return server;
      const c = counts(`${tag}|${key}`, () =>
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
    await first('open', () => warmClosed() && setTimeout(() => void first('closed', () => {})));
  };
  return { query, warm };
}

// On-demand and progressive: until the collection is full, one live query per view and page,
// straight on the collection, so TanStack DB passes its `where`, order and limit to `loadSubset`.
// The sort key is compared lexically, in the query and in its index: TanStack DB only builds a
// page cursor from a string it can compare that way, and otherwise loads every row of the view.
// A view's total is the server's, from the first page it loaded.
//
// Once progressive's collection is full, new queries take eager's route (per-state derived
// collections, counted locally). Straight on a full collection, a change that moves a row out of
// a page's window cost 0.1–0.6 s to repair (TanStack DB's on-demand window loading); over a
// derived collection it costs what it does in eager.
function subsetViews(store: Store) {
  const { issues } = store;
  const cpu = store.cpuRate;
  const lexical = { direction: 'desc', nulls: 'first', stringSort: 'lexical' } as const;
  issues.createIndex((i) => i.k, { indexType: BTreeIndex, options: { compareOptions: { ...lexical, direction: 'asc' } } } as any);
  const filtered = (view: View) => (q: any) => {
    let b = q
      .from({ i: issues })
      .where(({ i }: any) => eq(i.pr, false))
      .where(({ i }: any) => eq(i.open, view.state === 'open'));
    for (const l of view.labels) b = b.where(({ i }: any) => inArray(l, i.labelNames));
    for (const a of view.assignees) b = b.where(({ i }: any) => inArray(a, i.assignees));
    if (view.q) b = b.where(({ i }: any) => ilike(i.title, `%${view.q}%`));
    return b;
  };
  const direct: Route = { filtered, order: (q, f) => q.orderBy(f, lexical), serverTotal: (key) => store.totals.get(key) ?? null, tag: 'direct' };
  let full: Route | undefined;
  const route = () => (store.full ? (full ??= stateRoute(issues, cpu)) : direct);
  return pagedViews(issues, cpu, route, () => store.full);
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
