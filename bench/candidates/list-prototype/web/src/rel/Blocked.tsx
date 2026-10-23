// PROTOTYPE (beghu #55). A blocked row gets a red edge and a chip per open blocker (avatar and
// number), coloured by status: amber dashed when nobody is on it, red when it is itself blocked.
// (Round 2 also tried the first blocker's title, and who has it in words; the owner picked chips.)
//
// The chips open a card on hover: each open blocker with its title, owner and status.
// Clicking a blocker opens it in the panel. The row carries up to three blockers, so none of this
// fetches.
import { createSignal, For, Show } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useNavigate, useLocation } from '@solidjs/router';
import type { IssueRow } from '../api';
import type { BlockerRef } from '../../../server/bindings/BlockerRef';
import { Avatar } from '../bits';
import { ago } from '../view';

export const isBlocked = (r: IssueRow) => r.state === 'open' && r.blocked_by > 0;

// The fixture is months old, so "quiet" is 180 days here; on live data it would be more like 14.
const QUIET_DAYS = 180;
type Status = 'chain' | 'nobody' | 'quiet' | 'moving';
const status = (b: BlockerRef): Status =>
  b.open_blockers > 0 ? 'chain' : !b.assignee && !b.stub ? 'nobody' : b.updated_at && Date.now() - Date.parse(b.updated_at) > QUIET_DAYS * 864e5 ? 'quiet' : 'moving';
const say = (b: BlockerRef) =>
  ({
    chain: `itself blocked by ${b.open_blockers}`,
    nobody: 'nobody on it',
    quiet: `quiet for ${ago(b.updated_at ?? '')}`,
    moving: b.stub ? 'not synced' : `updated ${ago(b.updated_at ?? '')} ago`,
  })[status(b)];

function useOpen() {
  const nav = useNavigate();
  const loc = useLocation();
  return (e: MouseEvent, b: BlockerRef) => {
    e.preventDefault();
    e.stopPropagation();
    if (b.stub) window.open(`https://github.com/acme/${b.repo}/issues/${b.number}`, '_blank');
    else nav(`/issues/${b.id}${loc.search}`, { scroll: false });
  };
}

function Card(props: { r: IssueRow; at: DOMRect; keep: () => void; hide: () => void }) {
  const open = useOpen();
  const more = () => props.r.blocked_by - props.r.blockers.length;
  const left = () => Math.max(8, Math.min(props.at.left, innerWidth - 400));
  return (
    <div
      class="wo-card"
      style={{ left: `${left()}px`, top: `${props.at.bottom + 4}px` }}
      onPointerEnter={props.keep}
      onPointerLeave={props.hide}
      onClick={(e) => (e.preventDefault(), e.stopPropagation())}
    >
      <div class="rel-h">
        Waits on {props.r.blocked_by} open issue{props.r.blocked_by > 1 ? 's' : ''}
      </div>
      <For each={props.r.blockers}>
        {(b) => (
          <button class={`wo-item s-${status(b)}`} onClick={(e) => open(e, b)}>
            <Show when={b.assignee} fallback={<span class="wo-noone" title="Nobody assigned" />}>
              <Avatar login={b.assignee!} size={18} />
            </Show>
            <span class="wo-t ellip">{b.title}</span>
            <span class="mono muted wo-ref">
              {b.repo}#{b.number}
            </span>
            <span class="wo-s">
              {b.assignee ? `${b.assignee} · ` : ''}
              {say(b)}
            </span>
          </button>
        )}
      </For>
      <Show when={more() > 0}>
        <p class="muted small">and {more()} more, in the issue</p>
      </Show>
    </div>
  );
}

/** The chips for a blocked row: at most two, then "+n", so the column never overflows. */
export function WaitsOn(props: { r: IssueRow; word?: boolean }) {
  const open = useOpen();
  const [at, setAt] = createSignal<DOMRect>();
  let t: ReturnType<typeof setTimeout> | undefined;
  let el!: HTMLSpanElement;
  const keep = () => clearTimeout(t);
  const hide = () => (clearTimeout(t), (t = setTimeout(() => setAt(undefined), 150)));
  const ref = (b: BlockerRef) => `${b.repo === props.r.repo ? '' : b.repo}#${b.number}`;
  const shown = () => props.r.blockers.slice(0, 2);
  return (
    <Show when={isBlocked(props.r) && props.r.blockers.length}>
      <span
        ref={el}
        class="waits-on"
        onPointerEnter={() => (clearTimeout(t), (t = setTimeout(() => setAt(el.getBoundingClientRect()), 300)))}
        onPointerLeave={hide}
      >
        <Show when={props.word}>
          <span class="wo-k">waits on</span>
        </Show>
        <For each={shown()}>
          {(b) => (
            <span class={`wo-chip s-${status(b)}`} onClick={(e) => open(e, b)}>
              <Show when={b.assignee} fallback={<span class="wo-noone" />}>
                <Avatar login={b.assignee!} size={14} />
              </Show>
              <span class="mono ellip">{ref(b)}</span>
            </span>
          )}
        </For>
        <Show when={props.r.blocked_by > shown().length}>
          <span class="wo-more">+{props.r.blocked_by - shown().length}</span>
        </Show>
        <Show when={at()}>
          <Portal>
            <Card r={props.r} at={at()!} keep={keep} hide={hide} />
          </Portal>
        </Show>
      </span>
    </Show>
  );
}
