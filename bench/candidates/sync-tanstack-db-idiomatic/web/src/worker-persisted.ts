// The worker, with the collection in TanStack DB's SQLite persistence (wa-sqlite on OPFS): rows and
// the sync cursor survive to the next visit, and the coordinator elects one tab to own the
// database. The idiomatic pass's persistence.
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  openBrowserWASQLiteOPFSDatabase,
  persistedCollectionOptions,
} from '@tanstack/browser-db-sqlite-persistence';
import { openDb } from './db';
import { run } from './run';

const database = openBrowserWASQLiteOPFSDatabase({ databaseName: 'beghu.sqlite' });

run(
  async (hooks) => {
    const coordinator = new BrowserCollectionCoordinator({ dbName: 'beghu' });
    const persistence = createBrowserWASQLitePersistence({ database: await database, coordinator });
    hooks.phase('cache-idb-open');
    return openDb(hooks, (o) => persistedCollectionOptions({ ...o, persistence, schemaVersion: 1 }));
  },
  // Stored once SQLite holds the cursor the collection has reached. The wrapper has no hook for
  // that, so this polls its metadata table.
  async (db) => {
    const d = await database;
    for (;;) {
      const rows = await d.execute<{ value: string }>(`SELECT value FROM collection_metadata WHERE collection_id = 'issues' AND key = 'cursor'`);
      const stored = rows[0] ? (JSON.parse(String(rows[0].value)) as { seq: number }).seq : 0;
      if (stored && stored >= db.cursor()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  },
);
