// PROTOTYPE (beghu #52). Small pieces the variants share: state icon, label pill, avatar,
// relationship hints. Layout stays in each variant.
import { For, Show } from 'solid-js';
import { hue, type View } from './view';
import type { IssueRow, Label } from './api';

export function StateIcon(props: { r: IssueRow }) {
  const kind = () => {
    const r = props.r;
    if (r.kind === 'pr') return r.state === 'open' ? (r.draft ? 'pr-draft' : 'pr-open') : 'pr-closed';
    if (r.state === 'open') return 'open';
    return r.state_reason === 'not_planned' ? 'not-planned' : 'done';
  };
  const title = () =>
    ({ open: 'Open', done: 'Closed as completed', 'not-planned': 'Closed as not planned', 'pr-open': 'Open PR', 'pr-draft': 'Draft PR', 'pr-closed': 'Closed PR' })[kind()];
  return (
    <svg class={`state-icon s-${kind()}`} viewBox="0 0 16 16" width="16" height="16" aria-label={title()} role="img">
      <title>{title()}</title>
      {kind().startsWith('pr') ? (
        <path d="M5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm0 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm9 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM3.5 5v6M12.5 11V6.5a2 2 0 0 0-2-2H8m1.5-1.5L8 4.5 9.5 6" fill="none" stroke="currentColor" stroke-width="1.4" />
      ) : kind() === 'open' ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
        </>
      ) : kind() === 'done' ? (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M5.2 8.2 7.1 10l3.7-4" fill="none" stroke="currentColor" stroke-width="1.5" />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M3.8 12.2 12.2 3.8" stroke="currentColor" stroke-width="1.5" />
        </>
      )}
    </svg>
  );
}

export function LabelPill(props: { l: Label; onClick?: (e: MouseEvent) => void; active?: boolean }) {
  return (
    <span
      class={`pill ${props.onClick ? 'pill-click' : ''} ${props.active ? 'pill-active' : ''}`}
      style={{ '--c': `#${props.l.color}` }}
      onClick={props.onClick}
      title={props.onClick ? `Filter by label:${props.l.name}` : undefined}
    >
      {props.l.name}
    </span>
  );
}

export function Avatar(props: { login: string; size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <span
      class="avatar"
      title={props.login}
      style={{ '--h': String(hue(props.login)), width: `${s()}px`, height: `${s()}px`, 'font-size': `${Math.round(s() * 0.5)}px` }}
    >
      {props.login.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Avatars(props: { logins: string[]; size?: number }) {
  return (
    <span class="avatars">
      <For each={props.logins.slice(0, 3)}>{(l) => <Avatar login={l} size={props.size} />}</For>
    </span>
  );
}

/** Sub-issue progress, open blockers, blocking and relates-to, as compact glyphs. */
export function RelHints(props: { r: IssueRow; verbose?: boolean; noBlocked?: boolean }) {
  const r = () => props.r;
  // In the tree, progress counts every descendant, not only direct children.
  const roll = () => ('total' in props.r ? { done: (props.r as any).done as number, total: (props.r as any).total as number } : { done: r().subs_done, total: r().subs });
  return (
    <span class="rel">
      <Show when={r().blocked_by > 0 && !props.noBlocked}>
        <span class="rel-blocked" title={`Blocked by ${r().blocked_by} open issue${r().blocked_by > 1 ? 's' : ''}`}>
          <svg viewBox="0 0 16 16" width="12" height="12">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path d="M4 12 12 4" stroke="currentColor" stroke-width="1.6" />
          </svg>
          {props.verbose ? `blocked by ${r().blocked_by}` : 'blocked'}
          {!props.verbose && r().blocked_by > 1 ? ` ×${r().blocked_by}` : ''}
        </span>
      </Show>
      <Show when={roll().total > 0}>
        <span class="rel-subs" title={`${roll().done} of ${roll().total} ${'total' in props.r ? 'descendants' : 'sub-issues'} closed`}>
          <Progress done={roll().done} total={roll().total} />
          {roll().done}/{roll().total}
        </span>
      </Show>
      <Show when={r().blocking > 0 && props.verbose}>
        <span title={`Blocking ${r().blocking}`}>blocks {r().blocking}</span>
      </Show>
    </span>
  );
}

export function Progress(props: { done: number; total: number }) {
  const f = () => (props.total ? props.done / props.total : 0);
  return (
    <svg class="progress" viewBox="0 0 16 16" width="12" height="12">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line)" stroke-width="3" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--done)"
        stroke-width="3"
        stroke-dasharray={`${f() * 37.7} 37.7`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

export function Comments(props: { n: number }) {
  return (
    <span class="comments" title={`${props.n} comments`} style={{ visibility: props.n ? 'visible' : 'hidden' }}>
      <svg viewBox="0 0 16 16" width="12" height="12">
        <path d="M2.5 3h11v7.5H8L5 13v-2.5H2.5z" fill="none" stroke="currentColor" stroke-width="1.3" />
      </svg>
      {props.n}
    </span>
  );
}

/** Row href that opens the issue in the pane and keeps the view. */
export const href = (r: IssueRow, search: string) => `/issues/${r.id}${search}`;

export const describeEmpty = (v: View) => (v.q ? `No issues match “${v.q}” with these filters.` : 'No issues match these filters.');
