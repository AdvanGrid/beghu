import { Cache } from './cache';
import { mark, type Source } from './sources';

/** Holds every row on the main thread and filters in memory. */
export function clientSource(): Source {
  let ready: Cache | undefined;
  const opening = Cache.open({
    start: () => mark('cache-start'),
    persisted: () => mark('cache-warm'),
    // Persist once the first rows are on screen and the thread has a moment.
    idle: () => new Promise((r) => requestIdleCallback(() => r(), { timeout: 2000 })),
  }).then((c) => (ready = c));
  return {
    query: (view, offset, limit) => (ready ? ready.query(view, offset, limit) : opening.then((c) => c.query(view, offset, limit))),
    live(changed) {
      let events: EventSource | undefined;
      let closed = false;
      void opening.then((c) => {
        if (closed) return;
        const catchUp = () => c.catchUp().then((ids) => ids.length && changed(ids));
        events = new EventSource('/events');
        events.onmessage = catchUp;
        void catchUp(); // whatever changed while this tab was closed
      });
      return () => {
        closed = true;
        events?.close();
      };
    },
  };
}
