// PROTOTYPE (beghu #55). How a blocked issue is marked in the list, one way per variant:
//
// - A: the "blocked" chip next to the progress (as #52 had it).
// - B: the state icon itself turns into a blocked icon, so the row gains no width. Hovering it shows
//   the open blockers, read from /api/issues/:id/rels once and cached per row.
// - C: a red edge on the row and "waits on repo#n" in place of the chip; clicking that opens the
//   blocker in the panel.
import { createSignal, For, Show } from 'solid-js';
import { useNavigate, useLocation } from '@solidjs/router';
import type { IssueRow, Rels } from '../api';
import { StateIcon } from '../bits';
import { IssueStateIcon } from '../detail/parts';

const cache = new Map<number, Promise<Rels>>();
const rels = (id: number) => {
  if (!cache.has(id)) cache.set(id, fetch(`/api/issues/${id}/rels`).then((r) => r.json()));
  return cache.get(id)!;
};
window.addEventListener('issues-changed', () => cache.clear());

export const isBlocked = (r: IssueRow) => r.state === 'open' && r.blocked_by > 0;

export function BlockedStateIcon(props: { r: IssueRow }) {
  const [list, setList] = createSignal<Rels['blocked_by']>();
  const [show, setShow] = createSignal(false);
  let t: ReturnType<typeof setTimeout> | undefined;
  return (
    <Show when={isBlocked(props.r)} fallback={<StateIcon r={props.r} />}>
      <span
        class="blocked-icon"
        onPointerEnter={() => {
          t = setTimeout(() => {
            setShow(true);
            rels(props.r.id).then((x) => setList(x.blocked_by.filter((b) => b.state === 'open')));
          }, 250);
        }}
        onPointerLeave={() => (clearTimeout(t), setShow(false))}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" role="img" aria-label={`Open, blocked by ${props.r.blocked_by}`}>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M5 8h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <Show when={show()}>
          <div class="blocked-pop" onClick={(e) => e.preventDefault()}>
            <div class="rel-h">Blocked by</div>
            <Show when={list()} fallback={<p class="muted">…</p>}>
              <For each={list()}>
                {(b) => (
                  <div class="blocked-item">
                    <IssueStateIcon state={b.state} reason={b.state_reason} size={13} />
                    <span class="ellip">{b.title}</span>
                    <span class="mono muted">
                      {b.repo}#{b.number}
                    </span>
                    <Show when={b.stub}>
                      <span class="stub-tag">not synced</span>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </span>
    </Show>
  );
}

export function WaitsOn(props: { r: IssueRow }) {
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <Show when={isBlocked(props.r) && props.r.first_blocker}>
      <span
        class="waits-on"
        title={`Waits on ${props.r.blocked_by} open issue${props.r.blocked_by > 1 ? 's' : ''}; click to open ${props.r.first_blocker}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          nav(`/issues/${props.r.first_blocker_id}${loc.search}`, { scroll: false });
        }}
      >
        waits on <span class="mono">{props.r.first_blocker}</span>
        {props.r.blocked_by > 1 ? ` +${props.r.blocked_by - 1}` : ''}
      </span>
    </Show>
  );
}
