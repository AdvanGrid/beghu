import { getIssues, type Changed } from './api';
import type { Source } from './sources';

/** Filters in SQLite on every change of the view. */
export function serverSource(): Source {
  return {
    query: getIssues,
    live(changed) {
      const events = new EventSource('/events');
      events.onmessage = (e) => changed((JSON.parse(e.data) as Changed).ids);
      return () => events.close();
    },
  };
}
