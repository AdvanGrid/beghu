// The worker variant's thread: owns the cache, the live connection and every query.
import { Cache } from './cache';
import type { FromWorker, ToWorker } from './source-worker';

const post = (m: FromWorker) => postMessage(m);

const opening = Cache.open({ start: () => post({ mark: 'cache-start' }), persisted: () => post({ mark: 'cache-warm' }) });

onmessage = async (e: MessageEvent<ToWorker>) => {
  const { id, view, offset, limit } = e.data;
  post({ id, page: (await opening).query(view, offset, limit) });
};

void opening.then((c) => {
  const catchUp = () => c.catchUp().then((ids) => ids.length && post({ changed: ids }));
  new EventSource('/events').onmessage = catchUp;
  void catchUp();
});
