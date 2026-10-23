// PROTOTYPE (beghu #52), variant C, the list that won; #54 hosts the detail layouts in it.
// A token bar. Filters live as removable tokens inside one input;
// typing suggests keys and values (with counts) from the facets; plain words search titles. A row
// of preset views sits under it. Rows are a single line, title first.
import { createMemo, createSignal, For, Show, onSettled, Loading, Errored } from 'solid-js';
import type { Ctx } from '../App';
import { viewFromLocation } from '../App';
import { Rows } from '../Rows';
import { TreeRows, ListTreeToggle } from '../Tree';
import type { IssueRow, TreeNode } from '../api';
import type { Element } from 'solid-js';
import { Avatars, RelHints, StateIcon, describeEmpty, href } from '../bits';
import { ago, sameView, toggle, EMPTY, MULTI, type Multi, type View } from '../view';
import { useNewIssue } from '../detail/layouts';
import { useSearchParams } from '@solidjs/router';
import { LabelCell, WaitsOn, isBlocked } from '../rel/Blocked';

type Suggestion = { label: string; hint?: string; color?: string | null; count?: number; apply: () => void };

const KEYS: { key: string; hint: string }[] = [
  { key: 'label', hint: 'has every label' },
  { key: 'assignee', hint: 'assigned to every one' },
  { key: 'repo', hint: 'in any of these repos' },
  { key: 'milestone', hint: 'in any milestone' },
  { key: 'author', hint: 'opened by' },
  { key: 'is', hint: 'open, closed, blocked, pr' },
  { key: 'no', hint: 'label, assignee, milestone' },
  { key: 'sort', hint: 'updated, created, oldest, comments' },
];

const PRESETS: { name: string; view: View }[] = [
  { name: 'All open', view: EMPTY },
  { name: 'Assigned to me', view: { ...EMPTY, assignee: ['me'] } },
  { name: 'Blocked', view: { ...EMPTY, is: ['blocked'] } },
  { name: 'Unassigned bugs', view: { ...EMPTY, label: ['bug'], no: ['assignee'] } },
  { name: 'Newest', view: { ...EMPTY, sort: 'created' } },
  { name: 'Recently closed', view: { ...EMPTY, state: 'closed' } },
];

export function VariantC(props: { ctx: Ctx }) {
  const c = props.ctx;
  let box!: HTMLInputElement;
  // #55: the divider between the list and the detail drags; the width is remembered per browser.
  const [detailW, setDetailW] = createSignal<number | undefined>(
    (() => {
      try {
        return Number(localStorage.getItem('beghu.detailW')) || undefined;
      } catch {
        return undefined;
      }
    })(),
  );
  let mainEl!: HTMLElement;
  // #55: how many stacked columns (two slots each) the labels and blockers get, from the list's
  // width. Wider list, more of each before "+n".
  const [listW, setListW] = createSignal(800);
  onSettled(() => {
    const measure = () => {
      const l = mainEl.querySelector('.list') as HTMLElement | null;
      if (l) setListW(l.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(mainEl);
    const mo = new MutationObserver(() => {
      const l = mainEl.querySelector('.list');
      if (l) ro.observe(l);
      measure();
    });
    mo.observe(mainEl, { childList: true });
    const l = mainEl.querySelector('.list');
    if (l) ro.observe(l);
    measure();
    return () => (ro.disconnect(), mo.disconnect());
  });
  const LAB_COL = 96;
  const CHIP_COL = 100;
  const dens = createMemo(() => {
    const w = listW();
    const lc = w >= 1500 ? 3 : w >= 900 ? 2 : 1;
    const bc = w >= 1800 ? 3 : w >= 1200 ? 2 : 1;
    return { lc, bc };
  });
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const h = e.currentTarget as HTMLElement;
    h.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const r = mainEl.getBoundingClientRect();
      setDetailW(Math.round(Math.min(r.width - 360, Math.max(360, r.right - ev.clientX))));
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem('beghu.detailW', String(detailW() ?? ''));
      } catch {}
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  };
  const resetResize = () => {
    setDetailW(undefined);
    try {
      localStorage.removeItem('beghu.detailW');
    } catch {}
  };
  const [text, setText] = createSignal(c.view().q);
  const [focused, setFocused] = createSignal(false);
  const [hi, setHi] = createSignal(0);

  const newIssue = useNewIssue();
  const [sp] = useSearchParams();
  // c starts a new issue from anywhere outside a text field.
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'c') (e.preventDefault(), newIssue());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  onSettled(() => {
    const onPop = () => {
      box.value = viewFromLocation().q;
      setText(box.value);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  // The last word, when it looks like `key:` or `key:val`, is a token being typed; the rest is
  // free text that searches titles live.
  const split = (t: string) => {
    const m = /(?:^|\s)(\w+):(\S*)$/.exec(t);
    return m ? { free: t.slice(0, m.index).trim(), key: m[1].toLowerCase(), val: m[2] } : { free: t.trim(), key: undefined, val: undefined };
  };
  const word = () => /(\S*)$/.exec(text())![1];

  const pick = (v: View) => {
    const s = split(box.value);
    const rest = s.key ? s.free : box.value.replace(/\S*$/, '').trimEnd();
    box.value = rest ? rest + ' ' : '';
    setText(box.value);
    c.go({ ...v, q: rest });
    setHi(0);
    box.focus();
  };

  const tokens = createMemo(() => {
    const v = c.view();
    const t: { text: string; remove: View }[] = [];
    if (v.state !== 'all') t.push({ text: `is:${v.state}`, remove: { ...v, state: 'all' } });
    if (v.kind !== 'issue') t.push({ text: v.kind === 'pr' ? 'is:pr' : 'type:any', remove: { ...v, kind: 'issue' } });
    for (const k of MULTI) for (const x of v[k]) t.push({ text: `${k}:${x}`, remove: toggle(v, k, x) });
    if (v.sort !== 'updated') t.push({ text: `sort:${v.sort}`, remove: { ...v, sort: 'updated' } });
    return t;
  });

  const suggestions = createMemo<Suggestion[]>(() => {
    const v = c.view();
    const f = c.facets();
    const s = split(text());
    const values = (dim: Multi, items: { name: string; color?: string | null; count: number }[] | undefined, q: string) =>
      (items ?? [])
        .filter((i) => i.name.toLowerCase().includes(q.toLowerCase()) && !v[dim].includes(i.name))
        .slice(0, 8)
        .map((i) => ({ label: `${dim}:${i.name}`, color: i.color, count: i.count, apply: () => pick(toggle(v, dim, i.name)) }));
    if (s.key) {
      const q = s.val ?? '';
      switch (s.key) {
        case 'label':
          return values('label', f?.labels, q);
        case 'assignee':
          return [...('me'.startsWith(q) && !v.assignee.includes('me') ? [{ label: 'assignee:me', hint: f?.me, apply: () => pick(toggle(v, 'assignee', 'me')) }] : []), ...values('assignee', f?.assignees, q)];
        case 'repo':
          return values('repo', f?.repos, q);
        case 'milestone':
          return values('milestone', f?.milestones, q);
        case 'author':
          return values('author', f?.authors, q);
        case 'is':
          return [
            { label: 'is:open', count: f?.open, apply: () => pick({ ...v, state: 'open' }) },
            { label: 'is:closed', count: f?.closed, apply: () => pick({ ...v, state: 'closed' }) },
            { label: 'is:blocked', hint: 'has an open blocker', apply: () => pick(toggle(v, 'is', 'blocked')) },
            { label: 'is:pr', hint: 'pull requests', apply: () => pick({ ...v, kind: 'pr' }) },
          ].filter((x) => x.label.startsWith(`is:${q}`));
        case 'no':
          return ['label', 'assignee', 'milestone']
            .filter((x) => x.startsWith(q) && !v.no.includes(x))
            .map((x) => ({ label: `no:${x}`, apply: () => pick(toggle(v, 'no', x)) }));
        case 'sort':
          return (['updated', 'created', 'oldest', 'comments'] as const)
            .filter((x) => x.startsWith(q))
            .map((x) => ({ label: `sort:${x}`, apply: () => pick({ ...v, sort: x }) }));
      }
      return [];
    }
    const w = word();
    const keys = KEYS.filter((k) => k.key.startsWith(w.toLowerCase())).map((k) => ({
      label: `${k.key}:`,
      hint: k.hint,
      apply: () => {
        box.value = box.value.replace(/\S*$/, `${k.key}:`);
        setText(box.value);
        setHi(0);
        box.focus();
      },
    }));
    if (!w) return keys;
    // A plain word also matches values across every facet, so "bug" offers label:bug.
    const across = [
      ...values('label', f?.labels, w),
      ...values('repo', f?.repos, w),
      ...values('assignee', f?.assignees, w),
      ...values('milestone', f?.milestones, w),
    ].slice(0, 6);
    return [...keys.slice(0, 3), ...across];
  });

  const showPop = () => focused() && suggestions().length > 0;

  const row = (r: IssueRow | TreeNode, lead?: Element) => (
              <a
                class={`c-row cols ${isBlocked(r) ? 'edge-blocked' : ''}`}
                href={href(r, c.search())}
                noscroll
                aria-current={c.openId() === r.id ? 'page' : undefined}
              >
                <span class="k-main">
                  {lead}
                  <StateIcon r={r} />
                  <span class="c-title">{r.title}</span>
                </span>
                <LabelCell r={r as IssueRow} cap={dens().lc * 2} />
                <span class="k-wait">
                  <WaitsOn r={r as IssueRow} cap={dens().bc * 2} />
                </span>
                <span class="k-hint">
                  <RelHints r={r} noBlocked />
                </span>
                <span class="k-ref muted mono">
                  {r.repo}#{r.number}
                </span>
                <span class="k-asg">
                  <Avatars logins={r.assignees} size={18} />
                </span>
                <span class="k-when muted">{ago(r.updated_at)}</span>
              </a>
  );

  return (
    <div class={`app c cols-${c.rel()}`}>
      <header class="c-head">
        <div class="c-bar" onClick={() => box.focus()}>
          <For each={tokens()}>
            {(t) => (
              <span class="c-token">
                {t.text}
                <button
                  class="c-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    c.go(t.remove);
                  }}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            )}
          </For>
          {/* Holds free text plus a token being typed. Not bound to the view; refilled on
              back/forward only. */}
          <input
            ref={(el) => {
              box = el;
              el.value = c.view().q;
            }}
            spellcheck={false}
            autocomplete="off"
            placeholder={tokens().length ? 'Filter or search…' : 'Type label:, assignee:, repo:… or search titles'}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setHi(0);
              c.go({ ...c.view(), q: split(e.currentTarget.value).free }, { replace: true });
            }}
            onKeyDown={(e) => {
              const list = suggestions();
              if (e.key === 'ArrowDown' && showPop()) {
                e.preventDefault();
                setHi((hi() + 1) % list.length);
              } else if (e.key === 'ArrowUp' && showPop()) {
                e.preventDefault();
                setHi((hi() - 1 + list.length) % list.length);
              } else if ((e.key === 'Enter' || e.key === 'Tab') && showPop() && (split(text()).key || e.key === 'Tab')) {
                e.preventDefault();
                list[hi()]?.apply();
              } else if (e.key === 'Backspace' && e.currentTarget.value === '' && tokens().length) {
                c.go(tokens()[tokens().length - 1].remove);
              } else if (e.key === 'Escape') {
                box.blur();
              }
            }}
          />
        </div>
        <Show when={showPop()}>
          <div class="c-pop">
            <For each={suggestions()}>
              {(s, i) => (
                <button class={`c-sug ${i() === hi() ? 'hi' : ''}`} onPointerDown={(e) => (e.preventDefault(), s.apply())} onPointerMove={() => setHi(i())}>
                  <Show when={s.color}>
                    <span class="dot" style={{ background: `#${s.color}` }} />
                  </Show>
                  <span class="mono">{s.label}</span>
                  <span class="muted">{s.hint ?? ''}</span>
                  <Show when={s.count !== undefined}>
                    <span class="count">{s.count!.toLocaleString('en')}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="c-presets">
          <For each={PRESETS}>
            {(p) => (
              <button
                class="c-preset"
                aria-pressed={sameView({ ...c.view(), q: '' }, p.view) ? 'true' : 'false'}
                onClick={() => {
                  box.value = '';
                  setText('');
                  c.go(p.view);
                }}
              >
                {p.name}
              </button>
            )}
          </For>
          <ListTreeToggle ctx={c} />
          <button class="primary small new-btn" onClick={() => newIssue()} title="New issue (c)">
            New issue
          </button>
          <span class="c-count muted">
            {c.view().state === 'open' ? `${c.facets()?.open?.toLocaleString('en') ?? '…'} open` : c.view().state === 'closed' ? `${c.facets()?.closed?.toLocaleString('en') ?? '…'} closed` : ''}
          </span>
        </div>
      </header>
      <main
        ref={mainEl}
        class={`c-main layout-${c.layout()} ${c.openId() || c.creating() ? 'has-detail' : ''}`}
        style={{
          ...(detailW() ? { '--detail-w': `${detailW()}px` } : {}),
          '--lab-w': `${dens().lc * LAB_COL}px`,
          '--wait-w': `${dens().bc * CHIP_COL}px`,
        }}
      >
        <Loading fallback={<div class="list" />}>
          <Show when={c.tree()} fallback={
          <Rows
            rows={c.rows()}
            rowHeight={34}
            onNearEnd={c.loadMore}
            pulseTarget={c.pulseTarget}
            empty={<p class="empty">{describeEmpty(c.view())}</p>}
            row={(r) => row(r)}
          />
          }>
            <TreeRows ctx={c} rowHeight={34} row={(r, lead) => row(r, lead)} />
          </Show>
        </Loading>
        {/* A: always beside the list. B: over the list, which keeps its scroll underneath. C: a drawer
            over the list's right side; ?full=1 widens it. */}
        {/* #55: always the side panel. */}
        <div class="split-handle" onPointerDown={startResize} onDblClick={resetResize} title="Drag to resize; double-click to reset" />
        <Show when={true}>
          <aside class={`detail detail-${c.layout()} ${sp.full ? 'full' : ''}`}>
            <Errored fallback={(err) => <p>Couldn't load the issue: {String(err())}</p>}>
              <Loading>{c.detail}</Loading>
            </Errored>
          </aside>
        </Show>
      </main>
    </div>
  );
}
