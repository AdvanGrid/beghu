// What the status slot says of sync, behind the louder states: "resyncing…", or "sync degraded
// · Resync". The words and the Resync button are their own chunk (Sync.tsx), loaded only once the
// account's sync is degraded or resyncing, so a tab that never sees either doesn't carry them.
import { Errored, lazy, Loading, Show } from "solid-js";
import { gettingReady } from "./api";
import { Importing } from "./WhileImporting";
import { importing, sync } from "./live";

const SyncState = lazy(() => import("./Sync"), { export: "SyncState" });

/** The status slot's sync state while it's degraded or resyncing. */
export function Syncing() {
  return (
    <Show when={sync()}>
      {(status) => (
        // A chunk that fails to load leaves nothing, as the import's words do: the next status
        // (or a reload) tries again.
        <Errored fallback={null}>
          <Loading fallback={null}>
            <SyncState status={status()} />
          </Loading>
        </Errored>
      )}
    </Show>
  );
}

/**
 * The status slot's quietest states, once nothing louder shows: a read waiting for beghu to have
 * the account's data ready (api.ts), the import, else sync.
 */
export function Background() {
  return (
    <Show when={!gettingReady()} fallback={<span data-perf="getting-ready">Getting this account ready…</span>}>
      <Show when={importing()} fallback={<Syncing />}>
        <Importing />
      </Show>
    </Show>
  );
}
