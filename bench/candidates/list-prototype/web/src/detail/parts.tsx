// PROTOTYPE (beghu #54). The pieces every detail layout uses: inline title and body edit, the
// thread with its folded middle, the comment box, the pickers, close/reopen and relationship
// lists. Layout stays in each variant.
import { createMemo, createSignal, For, onSettled, Show, type Element } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { lookup, type Label, type RelItem } from '../api';
import { Avatar, LabelPill, Progress } from '../bits';
import { ago } from '../view';
import type { IssueModel, RelKind } from './model';
import { highlight, segments } from './code';

// ---------- small things ----------

export function IssueStateIcon(props: { state: string; reason?: string | null; size?: number }) {
  const kind = () => (props.state === 'open' ? 'open' : props.reason === 'not_planned' ? 'not-planned' : 'done');
  const s = () => props.size ?? 16;
  return (
    <svg class={`state-icon s-${kind()}`} viewBox="0 0 16 16" width={s()} height={s()} role="img" aria-label={kind()}>
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      {kind() === 'open' ? (
        <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      ) : kind() === 'done' ? (
        <path d="M5.2 8.2 7.1 10l3.7-4" fill="none" stroke="currentColor" stroke-width="1.5" />
      ) : (
        <path d="M3.8 12.2 12.2 3.8" stroke="currentColor" stroke-width="1.5" />
      )}
    </svg>
  );
}

export function StateBadge(props: { state: string; reason?: string | null; pending?: boolean }) {
  const kind = () => (props.state === 'open' ? 'open' : props.reason === 'not_planned' ? 'not-planned' : 'done');
  return (
    <span class={`state-badge sb-${kind()} ${props.pending ? 'pending' : ''}`}>
      <IssueStateIcon state={props.state} reason={props.reason} size={14} />
      {props.state === 'open' ? 'Open' : props.reason === 'not_planned' ? 'Not planned' : 'Closed'}
    </span>
  );
}

export const ExternalIcon = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="M6 3H3v10h10v-3M9 3h4v4M13 3 7 9" fill="none" stroke="currentColor" stroke-width="1.4" />
  </svg>
);

/** Href to another issue that keeps the list's view. */
export function useIssueHref() {
  const loc = useLocation();
  return (id: number) => `/issues/${id}${loc.search}`;
}

// ---------- title ----------

export function Title(props: { m: IssueModel; class?: string }) {
  const [editing, setEditing] = createSignal(false);
  let input!: HTMLInputElement;
  const save = () => {
    const v = input.value.trim();
    setEditing(false);
    if (v && v !== props.m.d().title) props.m.send({ op: 'title', value: v });
  };
  return (
    <Show
      when={editing()}
      fallback={
        <h1 class={`title ${props.class ?? ''} ${props.m.pending('title') ? 'pending' : ''}`} title="Click to edit" onClick={() => setEditing(true)}>
          {props.m.d().title}
        </h1>
      }
    >
      <input
        class={`title-input ${props.class ?? ''}`}
        ref={(el) => {
          input = el;
          el.value = props.m.d().title;
          queueMicrotask(() => (el.focus(), el.select()));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={save}
      />
    </Show>
  );
}

// ---------- body ----------

/** Pre-wrapped text with ``` fenced blocks coloured by language. The rest of markdown is its own
 * ticket. */
export function Text(props: { text: string; class?: string }) {
  return (
    <div class={`text ${props.class ?? ''}`}>
      <Show when={props.text} fallback={<span class="muted">No description.</span>}>
        <For each={segments(props.text)}>
          {(s) =>
            'code' in s ? (
              <pre class="code" data-lang={s.lang || undefined}>
                <Show when={highlight(s.code, s.lang)} fallback={<code>{s.code}</code>}>
                  {(html) => <code class="hljs" innerHTML={html()} />}
                </Show>
              </pre>
            ) : (
              <div>{s.text}</div>
            )
          }
        </For>
      </Show>
    </div>
  );
}

export function Body(props: { m: IssueModel; card?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const [conflict, setConflict] = createSignal<string | undefined>(undefined);
  let base = '';
  let area!: HTMLTextAreaElement;
  const start = () => {
    base = props.m.server().body; // what GitHub has now; a different body at save time is a 409
    setConflict(undefined);
    setEditing(true);
  };
  const save = (overwrite?: boolean) => {
    const value = area.value;
    if (overwrite) base = props.m.server().body;
    setEditing(false);
    if (value === props.m.d().body) return;
    props.m.send(
      { op: 'body', value, base },
      {
        onConflict: (msg) => {
          // Keep the user's text and show theirs next to it.
          setConflict(msg);
          setEditing(true);
          queueMicrotask(() => (area.value = value));
        },
      },
    );
  };
  return (
    <div class={`body ${props.card ? 'card' : ''} ${props.m.pending('body') ? 'pending' : ''}`}>
      <Show
        when={editing()}
        fallback={
          <>
            <Text text={props.m.d().body} />
            <button class="ghost small edit-body" onClick={start}>
              Edit
            </button>
          </>
        }
      >
        <Show when={conflict()}>
          <div class="conflict">
            <b>{conflict()}.</b> Your text is kept below. Their version:
            <Text text={props.m.server().body} class="theirs" />
          </div>
        </Show>
        <textarea
          class="editor"
          rows={10}
          ref={(el) => {
            area = el;
            el.value = props.m.d().body;
            queueMicrotask(() => el.focus());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <div class="row-actions">
          <button class="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <Show when={conflict()} fallback={<button class="primary" onClick={() => save()}>Save</button>}>
            <button class="primary" onClick={() => save(true)}>
              Overwrite theirs
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ---------- thread ----------

export function Thread(props: { m: IssueModel; variant?: 'cards' | 'flat' }) {
  const d = () => props.m.d();
  const shown = createMemo(() => {
    const extra = props.m.extra();
    if (!extra || !d().hidden) return { head: d().comments.slice(0, d().hidden ? 1 : d().comments.length), gap: d().hidden, tail: d().hidden ? d().comments.slice(1) : [] };
    return { head: [d().comments[0], ...extra, ...d().comments.slice(1)], gap: 0, tail: [] };
  });
  const [loading, setLoading] = createSignal(false);
  const one = (c: { author: string | null; body: string; created_at: string }, extra?: Element, cls = '') => (
    <div class={`comment ${props.variant === 'flat' ? 'flat' : 'card'} ${cls}`}>
      <div class="comment-meta">
        <Avatar login={c.author ?? '?'} size={20} />
        <b>{c.author ?? 'ghost'}</b>
        <span class="muted">{ago(c.created_at)} ago</span>
        {extra}
      </div>
      <Text text={c.body} />
    </div>
  );
  return (
    <div class="thread">
      <For each={shown().head}>{(c) => one(c)}</For>
      <Show when={shown().gap}>
        <button
          class="gap"
          onClick={async () => {
            setLoading(true);
            await props.m.loadHidden().finally(() => setLoading(false));
          }}
        >
          {loading() ? 'Loading…' : `${shown().gap} more comments`}
        </button>
      </Show>
      <For each={shown().tail}>{(c) => one(c)}</For>
      <For each={d().pendingComments}>
        {(c) =>
          one(
            c,
            c.p.status === 'failed' ? (
              <span class="failed-actions">
                <span class="err">Not sent: {c.p.error}</span>
                <button class="ghost small" onClick={() => props.m.retryComment(c.p.op_id)}>
                  Retry
                </button>
                <button class="ghost small" onClick={() => props.m.discardComment(c.p.op_id)}>
                  Discard
                </button>
              </span>
            ) : (
              <span class="muted">sending…</span>
            ),
            c.p.status === 'failed' ? 'failed' : 'pending',
          )
        }
      </For>
    </div>
  );
}

export function CommentBox(props: { m: IssueModel; withClose?: boolean; compact?: boolean }) {
  let area!: HTMLTextAreaElement;
  const [text, setText] = createSignal('');
  const post = () => {
    const body = area.value.trim();
    if (!body) return;
    props.m.send({ op: 'comment', body });
    area.value = '';
    setText('');
  };
  const open = () => props.m.d().state === 'open';
  return (
    <div class={`comment-box ${props.compact ? 'compact' : ''}`}>
      <textarea
        ref={area}
        rows={props.compact ? 2 : 4}
        placeholder="Leave a comment  (⌘/Ctrl + Enter to send)"
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post();
        }}
      />
      <div class="row-actions">
        <Show when={props.withClose}>
          <button
            class="ghost"
            onClick={() => {
              if (text().trim()) post();
              props.m.send(open() ? { op: 'state', state: 'closed', reason: 'completed' } : { op: 'state', state: 'open', reason: null });
            }}
          >
            {open() ? (text().trim() ? 'Close with comment' : 'Close issue') : text().trim() ? 'Reopen with comment' : 'Reopen issue'}
          </button>
        </Show>
        <button class="primary" disabled={!text().trim()} onClick={post}>
          Comment
        </button>
      </div>
    </div>
  );
}

// ---------- popover + pickers ----------

export function Popover(props: { trigger: (toggle: () => void, open: boolean) => Element; children: (close: () => void) => Element; align?: 'left' | 'right'; class?: string }) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  onSettled(() => {
    const onDown = (e: PointerEvent) => open() && !root.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open() && (e.stopPropagation(), setOpen(false));
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  });
  return (
    <div class={`popover-root ${props.class ?? ''}`} ref={root}>
      {props.trigger(() => setOpen(!open()), open())}
      <Show when={open()}>
        <div class={`popover ${props.align === 'right' ? 'right' : ''}`}>{props.children(() => setOpen(false))}</div>
      </Show>
    </div>
  );
}

type Choice = { key: string; label: Element; on: boolean; search: string };

/** A filterable list of choices; clicking one sends its op at once. */
export function ChoiceList(props: { choices: Choice[]; onPick: (key: string, on: boolean) => void; placeholder: string; single?: boolean; close: () => void }) {
  const [q, setQ] = createSignal('');
  const [hi, setHi] = createSignal(0);
  const list = createMemo(() => props.choices.filter((c) => c.search.toLowerCase().includes(q().toLowerCase())));
  const pick = (c: Choice) => {
    props.onPick(c.key, !c.on);
    if (props.single) props.close();
  };
  return (
    <div class="choices">
      <input
        placeholder={props.placeholder}
        ref={(el) => queueMicrotask(() => el.focus())}
        onInput={(e) => (setQ(e.currentTarget.value), setHi(0))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHi(Math.min(hi() + 1, list().length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setHi(Math.max(hi() - 1, 0)));
          if (e.key === 'Enter' && list()[hi()]) pick(list()[hi()]);
        }}
      />
      <div class="choice-items">
        <For each={list()}>
          {(c, i) => (
            <button class={`choice ${i() === hi() ? 'hi' : ''}`} onPointerMove={() => setHi(i())} onClick={() => pick(c)}>
              <span class="check">{c.on ? '✓' : ''}</span>
              {c.label}
            </button>
          )}
        </For>
        <Show when={!list().length}>
          <p class="muted pad">Nothing matches.</p>
        </Show>
      </div>
    </div>
  );
}

export function LabelsPicker(props: { m: IssueModel; trigger: (toggle: () => void) => Element; align?: 'left' | 'right' }) {
  const choices = () =>
    props.m.d().meta.labels.map((l) => ({
      key: l.name,
      search: l.name,
      on: props.m.d().labels.some((x) => x.name === l.name),
      label: (
        <>
          <span class="dot" style={{ background: `#${l.color}` }} />
          {l.name}
        </>
      ),
    }));
  return (
    <Popover align={props.align} trigger={(t) => props.trigger(t)}>
      {(close) => <ChoiceList choices={choices()} placeholder="Filter labels" close={close} onPick={(name, on) => props.m.send(on ? { op: 'label_add', name } : { op: 'label_remove', name })} />}
    </Popover>
  );
}

export function AssigneesPicker(props: { m: IssueModel; trigger: (toggle: () => void) => Element; align?: 'left' | 'right' }) {
  const choices = () => {
    const all = [...new Set([...props.m.d().assignees, ...props.m.d().meta.assignable])];
    return all.map((login) => ({
      key: login,
      search: login,
      on: props.m.d().assignees.includes(login),
      label: (
        <>
          <Avatar login={login} size={18} />
          {login}
          {login === props.m.me() ? <span class="muted"> (you)</span> : ''}
        </>
      ),
    }));
  };
  return (
    <Popover align={props.align} trigger={(t) => props.trigger(t)}>
      {(close) => <ChoiceList choices={choices()} placeholder="Assign someone" close={close} onPick={(login, on) => props.m.send(on ? { op: 'assignee_add', login } : { op: 'assignee_remove', login })} />}
    </Popover>
  );
}

export function MilestonePicker(props: { m: IssueModel; trigger: (toggle: () => void) => Element; align?: 'left' | 'right' }) {
  const choices = () => [
    ...props.m.d().meta.milestones.map((t) => ({ key: t, search: t, on: props.m.d().milestone === t, label: <>{t}</> })),
    ...(props.m.d().milestone ? [{ key: '', search: 'none clear', on: false, label: <span class="muted">Clear milestone</span> }] : []),
  ];
  return (
    <Popover align={props.align} trigger={(t) => props.trigger(t)}>
      {(close) => <ChoiceList single choices={choices()} placeholder="Set milestone" close={close} onPick={(t, on) => props.m.send({ op: 'milestone', title: t && on ? t : null })} />}
    </Popover>
  );
}

/** Close as completed / not planned, or reopen. */
export function StateControl(props: { m: IssueModel; compact?: boolean }) {
  const d = () => props.m.d();
  return (
    <Show
      when={d().state === 'open'}
      fallback={
        <button class={`ghost ${props.m.pending('state') ? 'pending' : ''}`} onClick={() => props.m.send({ op: 'state', state: 'open', reason: null })}>
          Reopen
        </button>
      }
    >
      <Popover
        align="right"
        trigger={(t) => (
          <button class={`ghost split ${props.m.pending('state') ? 'pending' : ''}`} onClick={t}>
            <IssueStateIcon state="closed" reason="completed" size={14} /> {props.compact ? 'Close' : 'Close issue'} ▾
          </button>
        )}
      >
        {(close) => (
          <div class="menu-list">
            <button onClick={() => (close(), props.m.send({ op: 'state', state: 'closed', reason: 'completed' }))}>
              <IssueStateIcon state="closed" reason="completed" size={14} /> Close as completed
            </button>
            <button onClick={() => (close(), props.m.send({ op: 'state', state: 'closed', reason: 'not_planned' }))}>
              <IssueStateIcon state="closed" reason="not_planned" size={14} /> Close as not planned
            </button>
          </div>
        )}
      </Popover>
    </Show>
  );
}

export function Labels(props: { m: IssueModel; empty?: string }) {
  return (
    <span class="labels-wrap">
      <For each={props.m.d().labels}>
        {(l: Label) => (
          <span class={props.m.pending(`label:${l.name}`) ? 'pending' : ''}>
            <LabelPill l={l} />
          </span>
        )}
      </For>
      <Show when={!props.m.d().labels.length && props.empty}>
        <span class="muted">{props.empty}</span>
      </Show>
    </span>
  );
}

export function Assignees(props: { m: IssueModel; names?: boolean; empty?: string }) {
  return (
    <span class="assignees-wrap">
      <For each={props.m.d().assignees}>
        {(a) => (
          <span class={`assignee ${props.m.pending(`assignee:${a}`) ? 'pending' : ''}`}>
            <Avatar login={a} size={18} />
            <Show when={props.names}>{a}</Show>
          </span>
        )}
      </For>
      <Show when={!props.m.d().assignees.length && props.empty}>
        <span class="muted">{props.empty}</span>
      </Show>
    </span>
  );
}

// ---------- relationships ----------

/** One related issue: openable when synced; a stub shows its title and links out to GitHub. */
export function RelRow(props: { item: RelItem; pending?: boolean; onRemove?: () => void; progress?: boolean }) {
  const href = useIssueHref();
  const it = () => props.item;
  return (
    <div class={`rel-row ${it().stub ? 'stub' : ''} ${props.pending ? 'pending' : ''}`}>
      <IssueStateIcon state={it().state} reason={it().state_reason} size={14} />
      <Show
        when={!it().stub}
        fallback={
          <a class="rel-title" href={it().url} target="_blank" rel="noreferrer" title="In a repo beghu doesn't sync: opens on GitHub">
            {it().title} <ExternalIcon />
          </a>
        }
      >
        <a class="rel-title" href={href(it().id)} noscroll>
          {it().title}
        </a>
      </Show>
      <span class="rel-ref mono muted">
        {it().repo}#{it().number}
      </span>
      <Show when={it().stub}>
        <span class="stub-tag" title="This repo isn't synced, so beghu only knows the title">
          not synced
        </span>
      </Show>
      <Show when={props.progress && it().subs > 0}>
        <span class="rel-progress muted">
          <Progress done={it().subs_done} total={it().subs} /> {it().subs_done}/{it().subs}
        </span>
      </Show>
      <Show when={!it().stub && it().assignees.length}>
        <Avatar login={it().assignees[0]} size={16} />
      </Show>
      <Show when={props.onRemove}>
        <button class="rel-x" title="Remove link" onClick={props.onRemove}>
          ×
        </button>
      </Show>
    </div>
  );
}

/** Search box to link another issue: `repo#12`, `#12`, words from the title, or a GitHub link.
 * #55: results are grouped by repo, this issue's repo first; a link into a repo beghu doesn't sync
 * links a stub. */
export function LinkSearch(props: { onPick: (item: RelItem) => void; exclude: number[]; placeholder?: string; close?: () => void; repo?: string }) {
  const [items, setItems] = createSignal<RelItem[]>([]);
  const [hi, setHi] = createSignal(0);
  const [q, setQ] = createSignal('');
  let t: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const pick = (it: RelItem) => (props.onPick(it), props.close?.());
  // Grouped, then flattened, so the arrow keys walk the groups in order.
  const groups = createMemo(() => {
    const by = new Map<string, RelItem[]>();
    for (const it of items()) by.set(it.repo, [...(by.get(it.repo) ?? []), it]);
    return [...by.entries()].sort(([a], [b]) => (a === props.repo ? -1 : b === props.repo ? 1 : 0));
  });
  const flat = createMemo(() => groups().flatMap(([, list]) => list));
  return (
    <div class="choices link-search">
      <input
        placeholder={props.placeholder ?? 'repo#123, words from the title, or a GitHub link'}
        ref={(el) => queueMicrotask(() => el.focus())}
        onInput={(e) => {
          const v = e.currentTarget.value;
          setQ(v);
          clearTimeout(t);
          t = setTimeout(async () => {
            const n = ++seq;
            const r = v.trim() ? await lookup(v) : [];
            if (n === seq) (setItems(r.filter((x) => !props.exclude.includes(x.id))), setHi(0));
          }, 120);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHi(Math.min(hi() + 1, flat().length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setHi(Math.max(hi() - 1, 0)));
          if (e.key === 'Enter' && flat()[hi()]) pick(flat()[hi()]);
        }}
      />
      <div class="choice-items">
        <For each={groups()}>
          {([repo, list]) => (
            <>
              <div class="choice-group">
                {repo}
                {list[0].stub ? ' · not synced' : repo === props.repo ? ' · this repo' : ''}
              </div>
              <For each={list}>
                {(it) => (
                  <button
                    class={`choice ${flat()[hi()]?.id === it.id ? 'hi' : ''} ${it.stub ? 'stub' : ''}`}
                    onPointerMove={() => setHi(flat().indexOf(it))}
                    onClick={() => pick(it)}
                  >
                    <IssueStateIcon state={it.state} reason={it.state_reason} size={14} />
                    <span class="ellip">{it.title}</span>
                    <span class="mono muted">#{it.number}</span>
                  </button>
                )}
              </For>
            </>
          )}
        </For>
        <Show when={q().trim() && !items().length}>
          <p class="muted choice-hint">No synced issue matches. For a repo beghu doesn't sync, paste its GitHub link (try partner-sdk#12).</p>
        </Show>
      </div>
    </div>
  );
}

export const REL_TITLES: Record<RelKind, string> = {
  parent: 'Parent',
  child: 'Sub-issues',
  blocked_by: 'Blocked by',
  blocking: 'Blocking',
  relates: 'Relates to',
};

export function relItems(m: IssueModel, kind: RelKind): RelItem[] {
  const r = m.d().rels;
  return kind === 'parent' ? (r.parent ? [r.parent] : []) : kind === 'child' ? r.children : r[kind];
}

/** The add button for a relationship kind: link an existing issue (and, for sub-issues, make a new one). */
export function AddRel(props: { m: IssueModel; kind: RelKind; label?: Element; align?: 'left' | 'right'; onNew?: () => void }) {
  const exclude = () => [props.m.d().id, ...relItems(props.m, props.kind).map((x) => x.id)];
  return (
    <Popover
      align={props.align}
      trigger={(t) => (
        <button class="ghost small add" onClick={t} title={`Add ${REL_TITLES[props.kind].toLowerCase()}`}>
          {props.label ?? '+'}
        </button>
      )}
    >
      {(close) => (
        <>
          <LinkSearch close={close} repo={props.m.d().repo} exclude={exclude()} onPick={(item) => props.m.send({ op: 'rel_add', kind: props.kind, other: item.id }, { item })} />
          <Show when={props.onNew}>
            <button class="choice new-sub" onClick={() => (close(), props.onNew!())}>
              + Create a new sub-issue
            </button>
          </Show>
        </>
      )}
    </Popover>
  );
}

/** A titled list of one relationship kind with add and remove. */
export function RelSection(props: { m: IssueModel; kind: RelKind; onNew?: () => void; hideEmpty?: boolean; heading?: 'small' | 'card'; empty?: string }) {
  const items = () => relItems(props.m, props.kind);
  const done = () => items().filter((x) => x.state === 'closed').length;
  return (
    <Show when={!props.hideEmpty || items().length}>
      <section class={`rel-section ${props.heading === 'card' ? 'card' : ''}`}>
        <header class="rel-head">
          <span class="rel-h">{REL_TITLES[props.kind]}</span>
          <Show when={props.kind === 'child' && items().length}>
            <span class="muted">
              <Progress done={done()} total={items().length} /> {done()} of {items().length} done
            </span>
          </Show>
          <span class="flex" />
          <AddRel m={props.m} kind={props.kind} align="right" onNew={props.onNew} />
        </header>
        <For each={items()}>
          {(it) => (
            <RelRow
              item={it}
              progress={props.kind === 'child'}
              pending={props.m.pending(`rel:${props.kind}:${it.id}`)}
              onRemove={() => props.m.send({ op: 'rel_remove', kind: props.kind, other: it.id })}
            />
          )}
        </For>
        <Show when={!items().length}>
          <p class="muted rel-empty">{props.empty ?? 'None'}</p>
        </Show>
      </section>
    </Show>
  );
}

/** The parent as a breadcrumb above the title. */
export function ParentCrumb(props: { m: IssueModel }) {
  const href = useIssueHref();
  const p = () => props.m.d().rels.parent;
  return (
    <div class="crumb">
      <Show
        when={p()}
        fallback={
          <AddRel m={props.m} kind="parent" label={<span class="muted">+ Set parent</span>} />
        }
      >
        <span class={`crumb-in ${props.m.pending(`rel:parent:${p()!.id}`) ? 'pending' : ''}`}>
          <span class="muted">↑</span>
          <Show when={!p()!.stub} fallback={<a href={p()!.url} target="_blank" rel="noreferrer">{p()!.title} <ExternalIcon /></a>}>
            <a href={href(p()!.id)} noscroll>
              {p()!.title}
            </a>
          </Show>
          <span class="mono muted">
            {p()!.repo}#{p()!.number}
          </span>
          <span class="muted">
            <Progress done={p()!.subs_done} total={p()!.subs} />
          </span>
          <button class="rel-x" title="Remove parent" onClick={() => props.m.send({ op: 'rel_remove', kind: 'parent', other: p()!.id })}>
            ×
          </button>
        </span>
      </Show>
    </div>
  );
}

/** Size of the detail response, against the 14 KB budget. */
export function SizeNote(props: { m: IssueModel }) {
  const d = () => props.m.server();
  return (
    <p class="size-note muted">
      PROTOTYPE · detail response {(d().bytes / 1024).toFixed(1)} KB JSON, {(d().wire / 1024).toFixed(1)} KB on the wire
      {d().hidden ? ` · ${d().hidden} comments folded to fit` : ''}
    </p>
  );
}
