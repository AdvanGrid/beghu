// The browser-side cache as a TanStack DB collection, in the worker. One `issues` collection holds
// every non-stub row (issues and PRs, no bodies). Its sync is a custom adapter over the baseline's
// wire: a stored snapshot, then `/api/sync` deltas from the cursor, with the cursor in the sync
// metadata. Queries are live query collections, one per view; writes are optimistic updates.
//
// `wrap` lets the persisted worker (worker-persisted.ts) wrap the collection's options in TanStack
// DB's SQLite persistence; without it the collection lives in memory and every visit starts from
// the stored snapshot.
import {
  createCollection,
  createLiveQueryCollection,
  configureIndexDevMode,
  eq,
  ilike,
  inArray,
  type Collection,
  type CollectionConfig,
} from '@tanstack/db';
import type { CacheRow, IssueRow, Label, Page, Snapshot, View } from './api';

configureIndexDevMode({ enabled: false });

/** One row of the collection: the server's tuple with its dictionary indexes resolved. */
export type Issue = {
  id: number;
  number: number;
  repo: string;
  pr: boolean;
  title: string;
  open: boolean;
  updated: number;
  comments_count: number;
  labels: Label[];
  labelNames: string[];
  assignees: string[];
};

type Dicts = { repos: string[]; labels: Label[]; users: string[] };
type Cursor = { seq: number; epoch: string };

const fetchText = (since: number) =>
  fetch(`/api/snapshot?since=${since}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))));

// Benchmark only: CDP's CPU throttle reaches the main thread but not workers, so synchronous work
// spins for `cpu - 1` times as long as it took. It wraps every call into TanStack DB that does
// its work synchronously: applying a sync transaction (and the live queries it updates) and
// building a live query.
export function throttled<T>(cpu: number, f: () => T): T {
  if (cpu <= 1) return f();
  const t0 = performance.now();
  const out = f();
  const until = t0 + (performance.now() - t0) * cpu;
  while (performance.now() < until);
  return out;
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
    comments_count,
    labels: ls,
    labelNames: ls.map((l) => l.name),
    assignees: users.map((u) => d.users[u]),
  };
};

export const toRow = (i: Issue): IssueRow => ({
  id: i.id,
  number: i.number,
  repo: i.repo,
  title: i.title,
  state: i.open ? 'open' : 'closed',
  updated_at: new Date(i.updated * 1000).toISOString().replace('.000Z', 'Z'),
  comments_count: i.comments_count,
  labels: i.labels,
  assignees: i.assignees,
});

export type Hooks = {
  cpu: number;
  phase: (name: string) => void;
  /** A first visit fetches its snapshot only once this resolves (after the page's first paint). */
  fetchAfter: Promise<void>;
  /** The stream's first delta (the catch-up) has been applied. */
  caughtUp: () => void;
};

export type Options = CollectionConfig<Issue, number> & { sync: NonNullable<CollectionConfig<Issue, number>['sync']> };

export type Db = ReturnType<typeof openDb>;

export function openDb(hooks: Hooks, wrap: (o: Options) => object = (o) => o) {
  const { cpu, phase } = hooks;

  let cursor: Cursor = { seq: 0, epoch: '' };
  // Writes wait for the stream to pass the `seq` the server gave them.
  const waiters: { seq: number; done: () => void }[] = [];
  const passed = () => {
    for (let i = waiters.length - 1; i >= 0; i--)
      if (waiters[i].seq <= cursor.seq) waiters.splice(i, 1)[0].done();
  };

  const issues: Collection<Issue, number> = createCollection(
    wrap({
      id: 'issues',
      getKey: (i) => i.id,
      sync: {
        rowUpdateMode: 'full',
        sync: ({ begin, write, commit, markReady, truncate, metadata, collection }) => {
          if (!metadata) throw new Error('sync metadata unavailable');
          let dicts: Dicts | undefined;
          // The rows and cursor a past visit left in SQLite, when persisted. Hydrating them is the
          // persistence wrapper's adapter protocol (marked internal and unstable); without the
          // call, sync starts with neither. The SQLite reads run in the persistence's own worker,
          // which the benchmark can't slow, so the wait is stretched as a whole.
          const resume = async () => {
            if (!metadata.persistence) return;
            const t0 = performance.now();
            await metadata.persistence.hydrateBaseline();
            const until = performance.now() + (performance.now() - t0) * (cpu - 1);
            while (performance.now() < until);
            cursor = (metadata.collection.get('cursor') as Cursor | undefined) ?? { seq: 0, epoch: '' };
            dicts = metadata.collection.get('dicts') as Dicts | undefined;
          };
          let closed = false;
          let es: EventSource | undefined;
          let retry: ReturnType<typeof setTimeout> | undefined;
          let attempt = 0;
          // Deltas apply one at a time, in order; a catch-up over HTTP holds the next ones back.
          let chain: Promise<unknown> = Promise.resolve();
          const serial = (f: () => Promise<unknown> | unknown) => (chain = chain.then(f).catch((e) => console.error(e)));

          // Applies a snapshot or delta. Returns the ids it changed, `[]` if it was already
          // applied, or `null` if it starts past the cursor (something was missed).
          const apply = (snap: Snapshot): number[] | null => {
            if (snap.epoch === cursor.epoch && snap.seq <= cursor.seq) return [];
            if (snap.from > cursor.seq || (cursor.epoch && snap.epoch !== cursor.epoch)) return null;
            throttled(cpu, () => {
              if (snap.repos && snap.labels && snap.users) dicts = { repos: snap.repos, labels: snap.labels, users: snap.users };
              begin();
              for (const r of snap.items) {
                const row = toIssue(r, dicts!);
                write(collection.has(row.id) ? { type: 'update', value: row } : { type: 'insert', value: row });
              }
              for (const id of snap.deleted) {
                const old = collection.get(id);
                if (old) write({ type: 'delete', value: old });
              }
              cursor = { seq: snap.seq, epoch: snap.epoch };
              metadata.collection.set('cursor', cursor);
              if (snap.repos) metadata.collection.set('dicts', dicts);
              commit();
            });
            passed();
            return [...snap.items.map((r) => r[0]), ...snap.deleted];
          };
          const parse = (text: string): Snapshot => throttled(cpu, () => JSON.parse(text));

          const reset = async () => {
            cursor = { seq: 0, epoch: '' };
            const snap = parse(await fetchText(0));
            throttled(cpu, () => {
              begin();
              truncate();
              commit();
            });
            apply(snap);
          };
          const catchUp = async () => {
            const ids = apply(parse(await fetchText(cursor.seq)));
            if (ids === null) await reset();
          };

          const connect = () => {
            retry = undefined;
            if (closed) return;
            phase('sync-connect');
            es = new EventSource(`/api/sync?since=${cursor.seq}&epoch=${encodeURIComponent(cursor.epoch)}`);
            let first = true;
            es.onopen = () => phase('sync-open');
            es.addEventListener('delta', (e) => {
              const text = (e as MessageEvent<string>).data;
              void serial(async () => {
                if (apply(parse(text)) === null) await catchUp();
                if (first) {
                  first = false;
                  attempt = 0;
                  phase('sync-caught-up');
                  hooks.caughtUp();
                }
              });
            });
            es.addEventListener('reset', () => {
              es?.close();
              void serial(async () => {
                await reset();
                connect();
              });
            });
            es.onerror = () => {
              es?.close();
              phase('sync-lost');
              retry = setTimeout(connect, [250, 500, 1000][Math.min(attempt++, 2)]);
            };
          };
          self.addEventListener('online', () => {
            if (retry === undefined) return;
            clearTimeout(retry);
            connect();
          });

          void (async () => {
            await resume();
            phase(cursor.seq ? 'cache-decoded' : 'cache-start');
            if (!cursor.seq) {
              await hooks.fetchAfter;
              const text = await fetchText(0);
              phase('cache-fetched');
              apply(parse(text));
            }
            markReady();
            phase('sync-leader');
            connect();
          })();

          return () => {
            closed = true;
            es?.close();
            if (retry !== undefined) clearTimeout(retry);
          };
        },
      },
      // An optimistic label: the handler posts it, then holds the optimistic row until the stream
      // has passed the write's `seq`. A throw rolls the row back.
      onUpdate: async ({ transaction }) => {
        for (const m of transaction.mutations) {
          const added = m.modified.labelNames.filter((n) => !m.original.labelNames.includes(n));
          for (const name of added) {
            const r = await fetch(`/api/issues/${m.key}/labels`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            if (!r.ok) throw new Error(`${r.status}`);
            const { seq } = (await r.json()) as { seq: number };
            if (seq > cursor.seq) await new Promise<void>((done) => waiters.push({ seq, done }));
          }
        }
      },
    }) as Options,
  ) as unknown as Collection<Issue, number>;

  return { issues, cursor: () => cursor.seq, query: views(issues, cpu) };
}

// One live query per view, sorted like the server's list. The last few stay alive, so going back
// to a view (or paging through it) reads its maintained result.
function views(issues: Collection<Issue, number>, cpu: number) {
  const KEEP = 4;
  const live = new Map<string, Collection<Issue, number>>();
  const build = (view: View) =>
    createLiveQueryCollection({
      startSync: true,
      gcTime: 0,
      query: (q) => {
        let b = q
          .from({ i: issues })
          .where(({ i }) => eq(i.pr, false))
          .where(({ i }) => eq(i.open, view.state === 'open'));
        for (const l of view.labels) b = b.where(({ i }) => inArray(l, i.labelNames));
        for (const a of view.assignees) b = b.where(({ i }) => inArray(a, i.assignees));
        if (view.q) b = b.where(({ i }) => ilike(i.title, `%${view.q}%`));
        return b.orderBy(({ i }) => i.updated, 'desc').orderBy(({ i }) => i.id, 'desc');
      },
    }) as unknown as Collection<Issue, number>;

  return async (view: View, offset: number, limit: number): Promise<Page> => {
    const key = JSON.stringify(view);
    let lq = live.get(key);
    if (lq) live.delete(key);
    else lq = throttled(cpu, () => build(view));
    live.set(key, lq);
    for (const [k, old] of live) {
      if (live.size <= KEEP) break;
      live.delete(k);
      void old.cleanup();
    }
    const all = await lq.toArrayWhenReady();
    const rows = throttled(cpu, () => all.slice(offset, offset + limit).map(toRow));
    return { rows, total: lq.size };
  };
}
