import { getIssues, type Changed, type View } from './api';
import type { Source } from './sources';

/** Filters in SQLite on every change of the view. */
export function serverSource(): Source {
  // Marks <html> while a list request the user asked for has been out for over 200 ms; the list
  // pulses (app.css) and keeps showing the old rows. A new view object or a further page is the
  // user; the same view at offset 0 again is a live refetch, which loads quietly.
  let pending = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastView: View | undefined;
  const root = document.documentElement;
  return {
    query(view, offset, limit) {
      const refetch = view === lastView && offset === 0;
      lastView = view;
      if (refetch) return getIssues(view, offset, limit);
      if (pending++ === 0) timer = setTimeout(() => root.setAttribute('data-list-loading', ''), 200);
      return getIssues(view, offset, limit).finally(() => {
        if (--pending > 0) return;
        clearTimeout(timer);
        root.removeAttribute('data-list-loading');
      });
    },
    live(changed) {
      const events = new EventSource('/events');
      events.onmessage = (e) => changed((JSON.parse(e.data) as Changed).ids);
      return () => events.close();
    },
  };
}
