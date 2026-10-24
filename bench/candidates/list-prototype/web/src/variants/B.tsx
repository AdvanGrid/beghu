// PROTOTYPE (beghu #52), variant B: a facet rail. Every filter is always on screen as a checkbox
// list with counts for the current view (mail client / store search style); the search box is
// plain text over titles; rows are a dense table with columns.
import { createSignal, For, Show, onSettled, Loading, Errored } from 'solid-js';
import type { Ctx } from '../App';
import { viewFromLocation } from '../App';
import { Rows } from '../Rows';
import { TreeRows, ListTreeToggle } from '../Tree';
import type { IssueRow, TreeNode } from '../api';
import type { Element } from 'solid-js';
import { Avatars, Comments, RelHints, StateIcon, describeEmpty, href } from '../bits';
import { ago, filterCount, toggle, EMPTY, MULTI, type Multi, type View } from '../view';
import type { Count } from '../api';

export function VariantB(props: { ctx: Ctx }) {
  const c = props.ctx;
  let box!: HTMLInputElement;
  onSettled(() => {
    const onPop = () => (box.value = viewFromLocation().q);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });
  const f = () => c.facets();

  const row = (r: IssueRow | TreeNode, lead?: Element) => (
              <a class="b-row" href={href(r, c.search())} noscroll aria-current={c.openId() === r.id ? 'page' : undefined}>
                <span class="b-title">
                  {lead}
                  <StateIcon r={r} />
                  <span class="b-tt">{r.title}</span>
                  <For each={r.labels}>
                    {(l) => <span class="b-ldot" style={{ background: `#${l.color}` }} title={l.name} />}
                  </For>
                </span>
                <span class="mono muted ellip">
                  {r.repo}#{r.number}
                </span>
                <Avatars logins={r.assignees} size={18} />
                <span class="muted ellip">{r.milestone ?? ''}</span>
                <RelHints r={r} />
                <span class="r">
                  <Comments n={r.comments_count} />
                </span>
                <span class="r muted">{ago(r.updated_at)}</span>
              </a>
  );

  return (
    <div class="app b">
      <nav class="b-rail">
        <Section title="State">
          <Radio name="Open" count={f()?.open} on={c.view().state === 'open'} click={() => c.go({ ...c.view(), state: 'open' })} />
          <Radio name="Closed" count={f()?.closed} on={c.view().state === 'closed'} click={() => c.go({ ...c.view(), state: 'closed' })} />
          <Radio name="All" on={c.view().state === 'all'} click={() => c.go({ ...c.view(), state: 'all' })} />
        </Section>
        <Section title="Show">
          <Check name="Assigned to me" on={c.view().assignee.includes('me')} click={() => c.go(toggle(c.view(), 'assignee', 'me'))} />
          <Check name="Blocked" on={c.view().is.includes('blocked')} click={() => c.go(toggle(c.view(), 'is', 'blocked'))} />
          <Check name="No assignee" on={c.view().no.includes('assignee')} click={() => c.go(toggle(c.view(), 'no', 'assignee'))} />
          <Check name="No label" on={c.view().no.includes('label')} click={() => c.go(toggle(c.view(), 'no', 'label'))} />
          <Check name="Include PRs" on={c.view().kind === 'all'} click={() => c.go({ ...c.view(), kind: c.view().kind === 'all' ? 'issue' : 'all' })} />
        </Section>
        <Facet c={c} title="Repos" dim="repo" items={f()?.repos} show={10} />
        <Facet c={c} title="Labels" dim="label" items={f()?.labels} show={12} />
        <Facet c={c} title="Assignees" dim="assignee" items={f()?.assignees} show={6} />
        <Facet c={c} title="Milestones" dim="milestone" items={f()?.milestones} show={5} />
        <Facet c={c} title="Authors" dim="author" items={f()?.authors} show={5} />
      </nav>
      <section class="b-listcol">
        <div class="b-bar">
          {/* Not bound to the view: the URL lags typing. Refilled on back/forward only. */}
          <input
            ref={(el) => {
              box = el;
              el.value = c.view().q;
            }}
            type="search"
            placeholder="Search titles"
            autocomplete="off"
            onInput={(e) => c.go({ ...c.view(), q: e.currentTarget.value }, { replace: true })}
          />
          <ListTreeToggle ctx={c} />
          <select value={c.view().sort} onChange={(e) => c.go({ ...c.view(), sort: e.currentTarget.value as View['sort'] })}>
            <option value="updated">Updated</option>
            <option value="created">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="comments">Comments</option>
          </select>
          <span class="b-total">
            {c.view().state === 'closed' ? f()?.closed?.toLocaleString('en') : c.view().state === 'open' ? f()?.open?.toLocaleString('en') : ''}{' '}
            {c.view().state === 'all' ? '' : 'issues'}
          </span>
        </div>
        <Show when={filterCount(c.view()) > 0}>
          <div class="b-active">
            <For each={MULTI.flatMap((k) => c.view()[k].map((v) => [k, v] as const))}>
              {([k, v]) => (
                <button class="b-chip" onClick={() => c.go(toggle(c.view(), k, v))} title="Remove">
                  {k === 'no' ? `no ${v}` : k === 'is' ? v : `${k}: ${v}`} ×
                </button>
              )}
            </For>
            <button
              class="linkish"
              onClick={() => {
                c.go({ ...EMPTY, state: c.view().state, sort: c.view().sort });
                box.value = '';
              }}
            >
              Clear all
            </button>
          </div>
        </Show>
        <div class="b-th">
          <span>Title</span>
          <span>#</span>
          <span>Assignees</span>
          <span>Milestone</span>
          <span>Links</span>
          <span class="r">Cmts</span>
          <span class="r">Updated</span>
        </div>
        <Loading fallback={<div class="list" />}>
          <Show when={c.tree()} fallback={
          <Rows
            rows={c.rows()}
            rowHeight={32}
            onNearEnd={c.loadMore}
            pulseTarget={c.pulseTarget}
            empty={<p class="empty">{describeEmpty(c.view())}</p>}
            row={(r) => row(r)}
          />
          }>
            <TreeRows ctx={c} rowHeight={32} row={(r, lead) => row(r, lead)} />
          </Show>
        </Loading>
      </section>
      <aside class="detail">
        <Errored fallback={(err) => <p>Couldn't load the issue: {String(err())}</p>}>
          <Loading>{c.detail}</Loading>
        </Errored>
      </aside>
    </div>
  );
}

function Section(props: { title: string; children: any }) {
  return (
    <div class="b-sec">
      <h4>{props.title}</h4>
      {props.children}
    </div>
  );
}

function Radio(props: { name: string; count?: number; on: boolean; click: () => void }) {
  return (
    <button class={`b-opt ${props.on ? 'on' : ''}`} onClick={props.click} role="radio" aria-checked={props.on ? 'true' : 'false'}>
      <span class="b-radio" />
      <span class="b-name">{props.name}</span>
      <Show when={props.count !== undefined}>
        <span class="count">{props.count!.toLocaleString('en')}</span>
      </Show>
    </button>
  );
}

function Check(props: { name: string; color?: string | null; count?: number; on: boolean; click: () => void }) {
  return (
    <button
      class={`b-opt ${props.on ? 'on' : ''} ${props.count === 0 && !props.on ? 'zero' : ''}`}
      onClick={props.click}
      role="checkbox"
      aria-checked={props.on ? 'true' : 'false'}
    >
      <span class="b-box">{props.on ? '✓' : ''}</span>
      <Show when={props.color}>
        <span class="dot" style={{ background: `#${props.color}` }} />
      </Show>
      <span class="b-name">{props.name}</span>
      <Show when={props.count !== undefined}>
        <span class="count">{props.count!.toLocaleString('en')}</span>
      </Show>
    </button>
  );
}

function Facet(props: { c: Ctx; title: string; dim: Multi; items?: Count[]; show: number }) {
  const [all, setAll] = createSignal(false);
  // Selected values stay on top so they never scroll out of reach.
  const items = () => {
    const sel = props.c.view()[props.dim];
    const list = props.items ?? [];
    const top = [...list.filter((i) => sel.includes(i.name)), ...list.filter((i) => !sel.includes(i.name))];
    return all() ? top : top.slice(0, Math.max(props.show, sel.length));
  };
  return (
    <Section title={props.title}>
      <Show when={props.items} fallback={<p class="muted pad">…</p>}>
        <For each={items()}>
          {(i) => (
            <Check
              name={i.name}
              color={i.color}
              count={i.count}
              on={props.c.view()[props.dim].includes(i.name)}
              click={() => props.c.go(toggle(props.c.view(), props.dim, i.name))}
            />
          )}
        </For>
        <Show when={(props.items?.length ?? 0) > props.show}>
          <button class="linkish" onClick={() => setAll(!all())}>
            {all() ? 'Fewer' : `All ${props.items!.length}`}
          </button>
        </Show>
      </Show>
    </Section>
  );
}
