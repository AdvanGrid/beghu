// PROTOTYPE (beghu #54). Toasts for writes GitHub refused: what was undone, with Retry.
import { createSignal, For, Show } from 'solid-js';

type Toast = { id: number; text: string; retry?: () => void };
const [toasts, setToasts] = createSignal<Toast[]>([]);
let n = 0;

export function toast(t: Omit<Toast, 'id'>) {
  const id = ++n;
  setToasts((all) => [...all, { ...t, id }]);
  setTimeout(() => dismiss(id), 8000);
}
const dismiss = (id: number) => setToasts((all) => all.filter((t) => t.id !== id));

export function Toasts() {
  return (
    <div class="toasts" role="status">
      <For each={toasts()}>
        {(t) => (
          <div class="toast">
            <span>{t.text}</span>
            <Show when={t.retry}>
              <button
                onClick={() => {
                  t.retry!();
                  dismiss(t.id);
                }}
              >
                Retry
              </button>
            </Show>
            <button class="toast-x" onClick={() => dismiss(t.id)} title="Dismiss">
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
