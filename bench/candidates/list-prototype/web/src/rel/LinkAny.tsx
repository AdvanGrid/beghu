// PROTOTYPE (beghu #55), variant A. One "+ Link issue" button for every relationship kind: pick the
// kind first (a segmented row), then the issue. Replaces #54's three "+ Blocked by / + Blocking /
// + Relates to" buttons; Parent and Sub-issue are in the same picker.
import { createSignal, For } from 'solid-js';
import type { IssueModel, RelKind } from '../detail/model';
import { LinkSearch, Popover, relItems } from '../detail/parts';

const KINDS: { kind: RelKind; label: string; hint: string }[] = [
  { kind: 'child', label: 'Sub-issue', hint: 'This issue is its parent' },
  { kind: 'parent', label: 'Parent', hint: 'Replaces the current parent' },
  { kind: 'blocked_by', label: 'Blocked by', hint: 'This issue waits on it' },
  { kind: 'blocking', label: 'Blocking', hint: 'It waits on this issue' },
  { kind: 'relates', label: 'Relates to', hint: 'No order between them' },
];

export function LinkAny(props: { m: IssueModel; initial?: RelKind }) {
  const [kind, setKind] = createSignal<RelKind>(props.initial ?? 'blocked_by');
  const exclude = () => [props.m.d().id, ...relItems(props.m, kind()).map((x) => x.id)];
  return (
    <Popover
      trigger={(t) => (
        <button class="ghost small add" onClick={t}>
          <span class="muted">+ Link issue</span>
        </button>
      )}
    >
      {(close) => (
        <div class="link-any">
          <div class="kind-tabs" role="tablist">
            <For each={KINDS}>
              {(k) => (
                <button role="tab" aria-selected={kind() === k.kind ? 'true' : 'false'} title={k.hint} onClick={() => setKind(k.kind)}>
                  {k.label}
                </button>
              )}
            </For>
          </div>
          <p class="muted kind-hint">{KINDS.find((k) => k.kind === kind())!.hint}</p>
          {/* Keyed on the kind so the search box refocuses and its results refilter. */}
          {((k) => (
            <LinkSearch
              close={close}
              repo={props.m.d().repo}
              exclude={exclude()}
              onPick={(item) => props.m.send({ op: 'rel_add', kind: k, other: item.id }, { item })}
            />
          ))(kind())}
        </div>
      )}
    </Popover>
  );
}
