// PROTOTYPE (beghu #55), round 2. A blocked row gets a red edge and a "waits on" note; the variants
// try what the note says, since the issue number alone told you nothing:
//
// - A, what: the first blocker's title.
// - B, who and how: who the first blocker is with, or that nobody is on it, or that it is itself
//   blocked, or that it has gone quiet.
// - C, every blocker: a chip per open blocker (avatar and number), coloured by the same status.
//
// Every variant opens the same card on hover: each open blocker with its title, owner and status.
// Clicking a blocker opens it in the panel. The row carries up to three blockers, so none of this
// fetches.
import { createSignal, For, Show } from 'solid-js';
import { Portal } from '@solidjs/web';
import { useNavigate, useLocation } from '@solidjs/router';
import type { IssueRow } from '../api';
import type { BlockerRef } from '../../../server/bindings/BlockerRef';
import { Avatar } from '../bits';
import { ago } from '../view';
import type { RelVariant } from '../App';

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

export function WaitsOn(props: { r: IssueRow; v: RelVariant }) {
  const open = useOpen();
  const [at, setAt] = createSignal<DOMRect>();
  let t: ReturnType<typeof setTimeout> | undefined;
  let el!: HTMLSpanElement;
  const keep = () => clearTimeout(t);
  const hide = () => (clearTimeout(t), (t = setTimeout(() => setAt(undefined), 150)));
  const first = () => props.r.blockers[0];
  const ref = (b: BlockerRef) => `${b.repo === props.r.repo ? '' : b.repo}#${b.number}`;
  const more = () => (props.r.blocked_by > 1 ? <span class="wo-more">+{props.r.blocked_by - 1}</span> : null);
  return (
    <Show when={isBlocked(props.r) && first()}>
      <span
        ref={el}
        class={`waits-on wo-${props.v}`}
        onPointerEnter={() => (clearTimeout(t), (t = setTimeout(() => setAt(el.getBoundingClientRect()), 300)))}
        onPointerLeave={hide}
      >
        <Show when={props.v === 'A'}>
          <span class="wo-lead" onClick={(e) => open(e, first()!)}>
            <span class="wo-k">waits on</span>
            <span class="ellip wo-title">{first()!.title}</span>
            {more()}
          </span>
        </Show>
        <Show when={props.v === 'B'}>
          <span class={`wo-lead s-${status(first()!)}`} onClick={(e) => open(e, first()!)}>
            <span class="wo-k">waits on</span>
            <Show when={first()!.assignee}>
              <Avatar login={first()!.assignee!} size={14} />
            </Show>
            <span class="wo-who">
              {first()!.assignee ?? <span class="mono">{ref(first()!)}</span>}
              <Show when={status(first()!) !== 'moving'}>
                <span class="wo-why">{{ chain: ', itself blocked', nobody: ', nobody on it', quiet: `, quiet ${ago(first()!.updated_at ?? '')}`, moving: '' }[status(first()!)]}</span>
              </Show>
            </span>
            {more()}
          </span>
        </Show>
        <Show when={props.v === 'C'}>
          <span class="wo-k">waits on</span>
          <For each={props.r.blockers}>
            {(b) => (
              <span class={`wo-chip s-${status(b)}`} onClick={(e) => open(e, b)}>
                <Show when={b.assignee} fallback={<span class="wo-noone" />}>
                  <Avatar login={b.assignee!} size={14} />
                </Show>
                <span class="mono">{ref(b)}</span>
              </span>
            )}
          </For>
          <Show when={props.r.blocked_by > props.r.blockers.length}>
            <span class="wo-more">+{props.r.blocked_by - props.r.blockers.length}</span>
          </Show>
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
