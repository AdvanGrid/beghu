// A worker's body: owns the TanStack DB collection, its sync, writes and every query. `open`
// builds the collection (in memory, or persisted: see worker.ts and worker-persisted.ts).
import { throttled, type Db, type Hooks } from './db';
import type { FromWorker, ToWorker } from './protocol';

export function run(open: (hooks: Hooks) => Db | Promise<Db>, persisted?: (db: Db) => Promise<void>) {
  const post = (m: FromWorker) => postMessage(m);
  // Progress marks carry the worker's clock, so a busy page doesn't delay them. `cache-ready` doesn't:
  // the page starts asking the worker when it receives it, and that moment is what it marks.
  const phase = (name: string) => post({ mark: name, at: performance.timeOrigin + performance.now() });
  phase('worker-boot');
  self.addEventListener('unhandledrejection', (e) => console.error('worker:', e.reason?.stack ?? e.reason));

  const cpu = Number(/cpu=([\d.]+)/.exec(self.name)?.[1] ?? 1);
  let allowFetch = () => {};
  const fetchAfter = new Promise<void>((r) => (allowFetch = r));

  let ready = false;
  const markReady = () => {
    if (ready) return;
    ready = true;
    post({ mark: 'cache-ready' });
  };

  const opening = Promise.resolve(open({
    cpu,
    phase,
    fetchAfter,
    caughtUp: markReady,
  }));
  // Rows with a write in flight: their changes are the page's own (it shows the label in the detail
  // already), so the page only re-asks for the list.
  const writing = new Set<number>();

  void opening.then(async ({ issues }) => {
    // Every change the page might show, from the server, another tab or an optimistic write.
    issues.subscribeChanges((changes) => {
      const ids = [...new Set(changes.map((c) => c.key))];
      if (!ids.length) return;
      const own = ids.every((id) => writing.has(id));
      post(own ? { changed: ids, own } : { changed: ids });
    });
    await issues.toArrayWhenReady();
    // A tab that doesn't sync is ready once its collection is.
    markReady();
  });
  // `cache-warm`: the snapshot is stored for the next visit. In memory there is nothing to store.
  void opening.then(async (db) => {
    await db.issues.toArrayWhenReady();
    await persisted?.(db);
    phase('cache-warm');
  });

  onmessage = async (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    if ('fetch' in m) return allowFetch();
    const db = await opening;
    if ('write' in m) {
      const { wid, id, label } = m.write;
      if (!db.issues.has(id)) {
        post({ written: { wid, ok: false } });
        return;
      }
      writing.add(id);
      const tx = throttled(cpu, () =>
        db.issues.update(id, (d) => {
          if (d.labelNames.includes(label.name)) return;
          d.labels.push(label);
          d.labelNames.push(label.name);
        }),
      );
      try {
        await tx.isPersisted.promise;
        post({ written: { wid, ok: true } });
      } catch {
        post({ written: { wid, ok: false } });
      } finally {
        writing.delete(id);
      }
      return;
    }
    const { id, view, offset, limit } = m;
    post({ id, page: await db.query(view, offset, limit) });
  };
}
