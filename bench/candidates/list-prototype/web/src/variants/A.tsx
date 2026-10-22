// PROTOTYPE (beghu #52), variant A: GitHub-style. One query box with typed syntax on top, a
// toolbar of Open/Closed tabs with counts and a dropdown menu per facet, and comfortable
// two-line rows. The menus and the box edit the same view: picking from a menu rewrites the box.
import { createMemo, createSignal, For, Show, onSettled, Loading, Errored } from 'solid-js';
import type { Ctx } from '../App';
import { viewFromLocation } from '../App';
import { Rows } from '../Rows';
import { TreeRows, ListTreeToggle } from '../Tree';
import type { IssueRow, TreeNode } from '../api';
import type { Element } from 'solid-js';
import { Avatars, Comments, LabelPill, RelHints, StateIcon, describeEmpty, href } from '../bits';
import { ago, filterCount, format, parse, toggle, EMPTY, type Multi, type View } from '../view';
import type { Count } from '../api';

const fmt = (n: number | undefined) => (n === undefined ? '…' : n.toLocaleString('en'));

export function VariantA(props: { ctx: Ctx }) {
  const c = props.ctx;
  let box!: HTMLInputElement;
  const set = (v: View) => {
    c.go(v);
    box.value = format(v) + ' ';
  };

  onSettled(() => {
    const onPop = () => (box.value = format(viewFromLocation()) + ' ');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  const row = (r: IssueRow | TreeNode, lead?: Element) => (
              <a class="a-row" href={href(r, c.search())} noscroll aria-current={c.openId() === r.id ? 'page' : undefined}>
{lead}
                <StateIcon r={r} />
                <div class="a-body">
                  <div class="a-line1">
                    <span class="a-title">{r.title}</span>
                    <For each={r.labels}>
                      {(l) => (
                        <LabelPill
                          l={l}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!c.view().label.includes(l.name)) set(toggle(c.view(), 'label', l.name));
                          }}
                        />
                      )}
                    </For>
                  </div>
                  <div class="a-line2">
                    {r.repo}#{r.number} · {r.state === 'open' ? 'opened' : 'closed'} {ago(r.created_at)} ago by {r.author ?? 'ghost'}
                    <Show when={r.milestone}>
                      <span class="a-ms"> · ⚑ {r.milestone}</span>
                    </Show>
                    <Show when={r.parent}>
                      <span class="a-parent" title={`Sub-issue of ${r.parent!.repo}#${r.parent!.number}`}>
                        {' '}
                        · ↳ {r.parent!.title}
                      </span>
                    </Show>
                  </div>
                </div>
                <div class="a-side">
                  <RelHints r={r} />
                  <Avatars logins={r.assignees} />
                  <Comments n={r.comments_count} />
                </div>
              </a>
  );

  return (
    <div class="app a">
      <header class="a-head">
        <div class="a-query">
          <svg viewBox="0 0 16 16" width="14" height="14" class="a-glass">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" />
          </svg>
          {/* Not bound to the view: the URL lags typing. It's written on menu picks and on
              back/forward only. */}
          <input
            ref={(el) => {
              box = el;
              el.value = format(c.view()) + ' ';
            }}
            type="search"
            spellcheck={false}
            autocomplete="off"
            placeholder="Search all issues"
            onInput={(e) => c.go(parse(e.currentTarget.value, true), { replace: true })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') c.go(parse(e.currentTarget.value), { replace: true });
            }}
          />
          <Show when={filterCount(c.view()) > 0 || c.view().state !== 'open'}>
            <button class="a-clear" onClick={() => set(EMPTY)} title="Clear filters">
              Clear
            </button>
          </Show>
        </div>
        <div class="a-toolbar">
          <div class="a-tabs">
            <ListTreeToggle ctx={c} />
            <button class="a-tab" aria-pressed={c.view().state === 'open' ? 'true' : 'false'} onClick={() => set({ ...c.view(), state: 'open' })}>
              Open <span class="count">{fmt(c.facets()?.open)}</span>
            </button>
            <button class="a-tab" aria-pressed={c.view().state === 'closed' ? 'true' : 'false'} onClick={() => set({ ...c.view(), state: 'closed' })}>
              Closed <span class="count">{fmt(c.facets()?.closed)}</span>
            </button>
          </div>
          <div class="a-menus">
            <Menu c={c} set={set} title="Repo" dim="repo" items={c.facets()?.repos} />
            <Menu c={c} set={set} title="Label" dim="label" items={c.facets()?.labels} none="label" />
            <Menu c={c} set={set} title="Assignee" dim="assignee" items={c.facets()?.assignees} none="assignee" me />
            <Menu c={c} set={set} title="Milestone" dim="milestone" items={c.facets()?.milestones} none="milestone" />
            <Menu c={c} set={set} title="Author" dim="author" items={c.facets()?.authors} me />
            <SortMenu c={c} set={set} />
          </div>
        </div>
      </header>
      <main class="a-main">
        <Loading fallback={<div class="list" />}>
          <Show when={c.tree()} fallback={
          <Rows
            rows={c.rows()}
            rowHeight={58}
            onNearEnd={c.loadMore}
            pulseTarget={c.pulseTarget}
            empty={<p class="empty">{describeEmpty(c.view())}</p>}
            row={(r) => row(r)}
          />
          }>
            <TreeRows ctx={c} rowHeight={58} row={(r, lead) => row(r, lead)} />
          </Show>
        </Loading>
        <aside class="detail">
          <Errored fallback={(err) => <p>Couldn't load the issue: {String(err())}</p>}>
            <Loading>{c.detail}</Loading>
          </Errored>
        </aside>
      </main>
    </div>
  );
}

function Menu(props: { c: Ctx; set: (v: View) => void; title: string; dim: Multi; items?: Count[]; none?: string; me?: boolean }) {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal('');
  const selected = () => props.c.view()[props.dim];
  const items = createMemo(() => {
    const f = filter().toLowerCase();
    return (props.items ?? []).filter((i) => i.name.toLowerCase().includes(f));
  });
  let root!: HTMLDivElement;
  onSettled(() => {
    const close = (e: Event) => !root.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  });
  const active = () => selected().length > 0 || (props.none && props.c.view().no.includes(props.none));
  return (
    <div class="menu" ref={root}>
      <button class={`menu-btn ${active() ? 'menu-active' : ''}`} onClick={() => setOpen(!open())}>
        {props.title}
        <Show when={selected().length}>
          <span class="badge">{selected().length}</span>
        </Show>{' '}
        ▾
      </button>
      <Show when={open()}>
        <div class="menu-pop">
          <input class="menu-filter" placeholder={`Filter ${props.title.toLowerCase()}s`} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} ref={(el) => queueMicrotask(() => el.focus())} />
          <div class="menu-items">
            <Show when={props.none}>
              <MenuItem
                checked={props.c.view().no.includes(props.none!)}
                name={`No ${props.title.toLowerCase()}`}
                onClick={() => props.set(toggle(props.c.view(), 'no', props.none!))}
              />
            </Show>
            <Show when={props.me}>
              <MenuItem checked={selected().includes('me')} name="Me" onClick={() => props.set(toggle(props.c.view(), props.dim, 'me'))} />
            </Show>
            <Show when={props.items} fallback={<p class="muted pad">Loading…</p>}>
              <For each={items()}>
                {(i) => (
                  <MenuItem
                    checked={selected().includes(i.name)}
                    name={i.name}
                    color={i.color}
                    count={i.count}
                    onClick={() => props.set(toggle(props.c.view(), props.dim, i.name))}
                  />
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function MenuItem(props: { checked: boolean; name: string; color?: string | null; count?: number; onClick: () => void }) {
  return (
    <button class={`menu-item ${props.count === 0 && !props.checked ? 'zero' : ''}`} onClick={props.onClick}>
      <span class="check">{props.checked ? '✓' : ''}</span>
      <Show when={props.color}>
        <span class="dot" style={{ background: `#${props.color}` }} />
      </Show>
      <span class="menu-name">{props.name}</span>
      <Show when={props.count !== undefined}>
        <span class="count">{props.count!.toLocaleString('en')}</span>
      </Show>
    </button>
  );
}

function SortMenu(props: { c: Ctx; set: (v: View) => void }) {
  const names = { updated: 'Recently updated', created: 'Newest', oldest: 'Oldest', comments: 'Most commented' } as const;
  return (
    <label class="a-sort">
      Sort{' '}
      <select value={props.c.view().sort} onChange={(e) => props.set({ ...props.c.view(), sort: e.currentTarget.value as View['sort'] })}>
        <For each={Object.entries(names)}>{([k, n]) => <option value={k}>{n}</option>}</For>
      </select>
    </label>
  );
}
