// What the status slot says of sync: "resyncing…" while a Resync (or a repair) runs, and "sync
// degraded · Resync" while changes are known to have been missed. Resync is offered at most once
// an hour; until then the slot says when: "Resync available in N min". Its own chunk, loaded only
// once sync is degraded or resyncing (WhileSyncing.tsx).
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, Show } from "solid-js";
import { resync, TooSoon } from "./api";
import { link } from "./bits";
import { writesPaused } from "./live";
import type { SyncStatus } from "./bindings/SyncStatus";

/** Unix seconds now, kept current every 15 s: the countdown's clock. */
function useNow(): () => number {
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
  onCleanup(() => clearInterval(timer));
  return now;
}

export function SyncState(props: { status: SyncStatus }) {
  const now = useNow();
  const wait = () => (props.status.resync_at == null ? 0 : props.status.resync_at - now());
  const [asking, setAsking] = createSignal(false);
  // A Resync that didn't start says why beside the offer, until the next status.
  const [refused, setRefused] = createSignal<string>();
  const ask = async () => {
    setAsking(true);
    setRefused(undefined);
    try {
      // The stream's next status says it's resyncing.
      await resync();
    } catch (e) {
      setRefused(e instanceof TooSoon ? e.message : "Couldn't start a resync");
    } finally {
      setAsking(false);
    }
  };
  return (
    <Show when={!props.status.resyncing} fallback={<span data-perf="sync">resyncing…</span>}>
      <span data-perf="sync">
        sync degraded ·{" "}
        <Show
          when={wait() <= 0}
          fallback={<>Resync available in {Math.max(1, Math.ceil(wait() / 60))} min</>}
        >
          <Show when={refused()}>{(why) => <>{why()} · </>}</Show>
          <button type="button" {...stylex.attrs(link.button)} disabled={asking() || writesPaused()} onClick={() => void ask()}>
            Resync
          </button>
        </Show>
      </span>
    </Show>
  );
}

