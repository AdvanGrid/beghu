// PROTOTYPE (beghu #55), variant C. The detail's relationships as one map: the parent above, what
// this issue waits on to the left, what waits on it to the right, sub-issues below, relates-to as
// a row of chips. Every node opens that issue in the panel, so the map re-centres on it and a chain
// can be walked. A node that is itself blocked says so (⊘ n). "+" in each column links an issue.
import { For, Show } from 'solid-js';
import type { RelItem } from '../api';
import type { IssueModel, RelKind } from '../detail/model';
import { AddRel, ExternalIcon, IssueStateIcon, useIssueHref } from '../detail/parts';
import { Progress } from '../bits';

function Node(props: { it: RelItem; m: IssueModel; kind: RelKind }) {
  const href = useIssueHref();
  const it = () => props.it;
  const pending = () => props.m.pending(`rel:${props.kind}:${it().id}`);
  return (
    <div class={`map-node ${it().stub ? 'stub' : ''} ${it().state} ${pending() ? 'pending' : ''}`}>
      <IssueStateIcon state={it().state} reason={it().state_reason} size={13} />
      <Show
        when={!it().stub}
        fallback={
          <a class="map-title" href={it().url} target="_blank" rel="noreferrer" title="Not synced: opens on GitHub">
            {it().title} <ExternalIcon />
          </a>
        }
      >
        <a class="map-title" href={href(it().id)} noscroll title={it().title}>
          {it().title}
        </a>
      </Show>
      <span class="map-meta">
        <span class="mono muted">
          {it().repo}#{it().number}
        </span>
        <Show when={it().stub}>
          <span class="stub-tag">not synced</span>
        </Show>
        <Show when={it().state === 'open' && it().open_blockers > 0}>
          <span class="map-chain" title={`Itself blocked by ${it().open_blockers} open issue${it().open_blockers > 1 ? 's' : ''}`}>
            ⊘ {it().open_blockers}
          </span>
        </Show>
        <button class="rel-x" title="Remove link" onClick={() => props.m.send({ op: 'rel_remove', kind: props.kind, other: it().id })}>
          ×
        </button>
      </span>
    </div>
  );
}

export function RelMap(props: { m: IssueModel }) {
  const m = props.m;
  const d = () => m.d();
  const r = () => d().rels;
  const openBlockers = () => r().blocked_by.filter((x) => x.state === 'open').length;
  const col = (kind: RelKind, title: string, items: RelItem[], empty: string) => (
    <div class={`map-col map-${kind}`}>
      <header>
        <span class="rel-h">{title}</span>
        <AddRel m={m} kind={kind} align={kind === 'blocking' ? 'right' : 'left'} />
      </header>
      <For each={items}>{(it) => <Node it={it} m={m} kind={kind} />}</For>
      <Show when={!items.length}>
        <p class="muted map-empty">{empty}</p>
      </Show>
    </div>
  );
  return (
    <section class="relmap card">
      <div class="map-grid">
        {col('blocked_by', 'Waits on', r().blocked_by, 'Nothing')}
        <div class="map-self">
          <span class="map-arrow" aria-hidden="true">
            →
          </span>
          <div class={`map-me ${openBlockers() ? 'is-blocked' : ''}`}>
            <IssueStateIcon state={d().state} reason={d().state_reason} size={14} />
            <span class="mono">
              {d().repo}#{d().number}
            </span>
            <span class="map-status">{openBlockers() ? `blocked by ${openBlockers()}` : d().state === 'open' ? 'ready' : 'closed'}</span>
          </div>
          <span class="map-arrow" aria-hidden="true">
            →
          </span>
        </div>
        {col('blocking', 'Holds up', r().blocking, 'Nothing')}
      </div>
      <Show when={r().relates.length}>
        <div class="map-relates">
          <span class="rel-h">Relates to</span>
          <For each={r().relates}>{(it) => <Node it={it} m={m} kind="relates" />}</For>
        </div>
      </Show>
      <div class="map-foot">
        <AddRel m={m} kind="relates" label={<span class="muted">+ Relates to</span>} />
        <Show when={r().children.length}>
          <span class="muted">
            <Progress done={r().children.filter((x) => x.state === 'closed').length} total={r().children.length} /> sub-issues below
          </span>
        </Show>
      </div>
    </section>
  );
}
