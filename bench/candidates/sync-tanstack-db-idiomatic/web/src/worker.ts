// The worker, with the collection in memory: every visit loads the stored snapshot.
import { openDb } from './db';
import { run } from './run';

run((hooks) => openDb(hooks));
