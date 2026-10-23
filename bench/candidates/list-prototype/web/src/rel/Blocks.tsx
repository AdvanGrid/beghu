// PROTOTYPE (beghu #55), round 2. The detail's dependencies as one "Blocks" section above the body:
// what this issue is blocked by on the left, what it is blocking on the right, mirrored so each
// side reads from its outer edge. Each item is two lines, so the title gets the full column width:
// state icon and title on top, number and owner under it. A blocker that is itself blocked says so.
// Closed ones sink to the bottom, dimmed. Hover an item for × (on the inner edge).
import { For, Show } from 'solid-js';
import type { RelItem } from '../api';
import type { IssueModel, RelKind } from '../detail/model';
import { AddRel, ExternalIcon, IssueStateIcon, useIssueHref } from '../detail/parts';
import { Avatar } from '../bits';

const order = (xs: RelItem[]) => [...xs].sort((a, b) => (a.state === 'closed' ? 1 : 0) - (b.state === 'closed' ? 1 : 0));

function Item(props: { it: RelItem; m: IssueModel; kind: RelKind }) {
  const href = useIssueHref();
  const it = () => props.it;
  // On the blocking side this issue is one of its blockers, so count the others.
  const others = () => it().open_blockers - (props.kind === 'blocking' && props.m.d().state === 'open' ? 1 : 0);
  const chain = () => it().state === 'open' && others() > 0;
  return (
    <div class={`blk-item ${it().state} ${it().stub ? 'stub' : ''} ${props.m.pending(`rel:${props.kind}:${it().id}`) ? 'pending' : ''}`}>
      <span class="blk-icon">
        <IssueStateIcon state={it().state} reason={it().state_reason} size={14} />
      </span>
      <Show
        when={!it().stub}
        fallback={
          <a class="blk-title" href={it().url} target="_blank" rel="noreferrer" title="Not synced: opens on GitHub">
            {it().title} <ExternalIcon />
          </a>
        }
      >
        <a class="blk-title" href={href(it().id)} noscroll title={it().title}>
          {it().title}
        </a>
      </Show>
      <span class="blk-meta">
        <span class="mono">
          {it().repo}#{it().number}
        </span>
        <Show when={it().stub}>
          <span class="stub-tag">not synced</span>
        </Show>
        <Show when={chain()}>
          <span class="blk-chain">{props.kind === 'blocking' ? `also waits on ${others()} more` : `itself blocked by ${others()}`}</span>
        </Show>
        <Show when={!it().stub}>
          <Show when={it().assignees[0]} fallback={<Show when={it().state === 'open'}><span class="blk-nobody">unassigned</span></Show>}>
            <span class="blk-who">
              <Avatar login={it().assignees[0]} size={14} />
              {it().assignees[0]}
            </span>
          </Show>
        </Show>
      </span>
      <button class="rel-x blk-x" title="Remove link" onClick={() => props.m.send({ op: 'rel_remove', kind: props.kind, other: it().id })}>
        ×
      </button>
    </div>
  );
}

function Side(props: { m: IssueModel; kind: 'blocked_by' | 'blocking' }) {
  const items = () => order(props.m.d().rels[props.kind]);
  const open = () => items().filter((x) => x.state === 'open').length;
  const right = () => props.kind === 'blocking';
  return (
    <div class={`blk-side ${right() ? 'blk-r' : 'blk-l'}`}>
      <header>
        <span class="rel-h">{right() ? 'Blocking' : 'Blocked by'}</span>
        <Show when={items().length}>
          <span class={`blk-count ${!right() && open() ? 'hot' : ''}`}>{open() === items().length ? open() : `${open()} of ${items().length} open`}</span>
        </Show>
        <AddRel m={props.m} kind={props.kind} align={right() ? 'right' : 'left'} />
      </header>
      <For each={items()}>{(it) => <Item it={it} m={props.m} kind={props.kind} />}</For>
      <Show when={!items().length}>
        <p class="muted blk-empty">{right() ? 'Nothing waits on this' : 'Nothing; ready to start'}</p>
      </Show>
    </div>
  );
}

export function Blocks(props: { m: IssueModel }) {
  const r = () => props.m.d().rels;
  return (
    <Show when={r().blocked_by.length || r().blocking.length}>
      <section class="blk">
        <Side m={props.m} kind="blocked_by" />
        <div class="blk-mid" aria-hidden="true">
          <span>→</span>
        </div>
        <Side m={props.m} kind="blocking" />
      </section>
    </Show>
  );
}
