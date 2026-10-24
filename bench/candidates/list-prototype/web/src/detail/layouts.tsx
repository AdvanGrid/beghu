// PROTOTYPE (beghu #54). Three layouts of the issue detail over the same model, switched with
// ?variant=:
//
// - A, side panel: the list stays on the left and the detail is one narrow column on the right.
//   Properties sit in a row of chips under the title; everything else stacks.
// - B, full page: the detail replaces the list (which keeps its place underneath). GitHub's shape:
//   a conversation column of cards and a sidebar of properties and relationships.
// - C, peek drawer: the list stays full width and the detail slides over its right side; ⤢ widens it
//   to the full page. Linear's shape: a main column and a properties rail inside the drawer.
import { For, Show, onSettled, type Element } from 'solid-js';
import { useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import { Avatar } from '../bits';
import { ago } from '../view';
import type { IssueModel } from './model';
import {
  AddRel,
  Assignees,
  AssigneesPicker,
  Body,
  CommentBox,
  Labels,
  LabelsPicker,
  MilestonePicker,
  ParentCrumb,
  RelSection,
  SizeNote,
  StateBadge,
  StateControl,
  Thread,
  Title,
} from './parts';
import { shell } from '../shell';
import { SubIssues } from '../rel/SubIssues';
import { Blocks } from '../rel/Blocks';
import { Gutter, LivePanel } from './livepanel';
import type { Part } from './live';

const ghUrl = (m: IssueModel) => `https://github.com/acme/${m.d().repo}/issues/${m.d().number}`;

/** Back to the list, keeping the view (the query string). */
function useClose() {
  const nav = useNavigate();
  const loc = useLocation();
  return () => nav(`/${stripDetailParams(loc.search)}`, { scroll: false });
}

export function stripDetailParams(search: string) {
  const p = new URLSearchParams(search);
  p.delete('parent');
  p.delete('full');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Opens the new-issue form, as a sub-issue of `parent` when given. */
export function useNewIssue() {
  const nav = useNavigate();
  const loc = useLocation();
  return (parent?: number) => {
    const p = new URLSearchParams(stripDetailParams(loc.search));
    if (parent) p.set('parent', String(parent));
    nav(`/new?${p}`, { scroll: false });
  };
}

function useEscape(fn: () => void) {
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest('input, textarea, select, .popover')) return;
      fn();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

/** j / k (and the arrows on the bar) step through the list's rows without going back to it. */
function useStep(m: IssueModel) {
  const nav = useNavigate();
  const loc = useLocation();
  const step = (d: number) => {
    const rows = shell.rows();
    const i = rows.findIndex((r) => r.id === m.d().id);
    const next = rows[i + d];
    if (next) nav(`/issues/${next.id}${loc.search}`, { scroll: false });
  };
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'j') step(1);
      if (e.key === 'k') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const pos = () => {
    const rows = shell.rows();
    const i = rows.findIndex((r) => r.id === m.d().id);
    return i < 0 ? undefined : { i: i + 1, n: rows.length };
  };
  return { step, pos };
}

/** #66 round 2: one property unit for the held layer (outline in the cue, FLIP on its height,
 * afterglow), apart from its neighbours. */
const lv = (m: IssueModel, part: Part) => (m.plan()?.props.includes(part) ? 'props' : undefined);
const glow = (m: IssueModel, part: Part) => (m.held.glow().has(`p:${part}`) ? 'lv-glow' : '');

function Opened(props: { m: IssueModel }) {
  const d = () => props.m.d();
  return (
    <span class="muted">
      <b class="fg">{d().author ?? 'ghost'}</b> opened {ago(d().created_at)} ago · {d().comments_count} comments
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// A: side panel, one column.

export function DetailA(props: { m: IssueModel }) {
  const m = props.m;
  const d = () => m.d();
  const newIssue = useNewIssue();
  const [search] = useSearchParams();
  // #66: ?variant= picks the shift cue; the phase drives the cue's CSS.
  return (
    <article class={`da v-${search.variant ?? 'A'} ph-${m.held.phase()}`} data-bench="detail" data-id={d().id}>
      <Gutter m={m} />
      <LivePanel m={m} />
      {/* Nothing here moves when a value changes length: the badge has a fixed width and comes
          first, and each property has its own row, so more labels only grow their own row. */}
      <div class="da-top">
        <span class="da-badge">
          <StateBadge state={d().state} reason={d().state_reason} pending={m.pending('state')} />
        </span>
        <span class="mono muted">
          {d().repo}#{d().number}
        </span>
        <span class="flex" />
        <StateControl m={m} compact />
        <a class="ghost small" href={ghUrl(m)} target="_blank" rel="noreferrer" title="Open on GitHub">
          GitHub ↗
        </a>
      </div>
      <div data-k="p:parent" data-live={lv(m, 'parent')} class={glow(m, 'parent')}>
        <ParentCrumb m={m} />
      </div>
      <Title m={m} />
      <div class="da-props">
        <span class="da-key">Assignees</span>
        <AssigneesPicker
          m={m}
          trigger={(t) => (
            <button class={`prop ${glow(m, 'assignees')}`} onClick={t} title="Assignees" data-k="p:assignees" data-live={lv(m, 'assignees')}>
              <Assignees m={m} names empty="+ Assign" />
            </button>
          )}
        />
        <span class="da-key">Labels</span>
        <LabelsPicker
          m={m}
          trigger={(t) => (
            <button class={`prop ${glow(m, 'labels')}`} onClick={t} title="Labels" data-k="p:labels" data-live={lv(m, 'labels')}>
              <Labels m={m} empty="+ Label" />
            </button>
          )}
        />
        <span class="da-key">Milestone</span>
        <MilestonePicker
          m={m}
          trigger={(t) => (
            <button class={`prop ${m.pending('milestone') ? 'pending' : ''} ${glow(m, 'milestone')}`} onClick={t} title="Milestone" data-k="p:milestone" data-live={lv(m, 'milestone')}>
              {d().milestone ?? <span class="muted">+ Milestone</span>}
            </button>
          )}
        />
        <span class="da-key">Links</span>
        <span class="da-links">
          <AddRel m={m} kind="blocked_by" label={<span class="muted">+ Blocked by</span>} />
          <AddRel m={m} kind="blocking" label={<span class="muted">+ Blocking</span>} />
          <AddRel m={m} kind="relates" label={<span class="muted">+ Relates to</span>} />
        </span>
      </div>
      {/* #66 round 2: Blocks and Relates to are units of their own, apart from the property rows. */}
      <div data-k="p:blocks" data-live={lv(m, 'blocks')} class={glow(m, 'blocks')}>
        <Blocks m={m} />
      </div>
      <div data-k="p:relates" data-live={lv(m, 'relates')} class={glow(m, 'relates')}>
        <RelSection m={m} kind="relates" hideEmpty />
      </div>
      <Opened m={m} />
      <Body m={m} />
      <div data-k="p:subs" data-live={lv(m, 'subs')} class={glow(m, 'subs')}>
        <SubIssues m={m} mode="drag" onNew={() => newIssue(d().id)} />
      </div>
      <h3 class="section-h">Comments</h3>
      <Thread m={m} variant="flat" />
      <div class="da-compose">
        <CommentBox m={m} compact withClose />
      </div>
      <SizeNote m={m} />
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// B: full page, conversation + sidebar.

function SideSection(props: { title: string; picker?: (trigger: (t: () => void) => Element) => Element; children: Element }) {
  return (
    <section class="db-side-sec">
      <header>
        <span>{props.title}</span>
        <Show when={props.picker}>
          {props.picker!((t) => (
            <button class="ghost small gear" onClick={t} title={`Edit ${props.title.toLowerCase()}`}>
              ⚙
            </button>
          ))}
        </Show>
      </header>
      {props.children}
    </section>
  );
}

export function DetailB(props: { m: IssueModel }) {
  const m = props.m;
  const d = () => m.d();
  const close = useClose();
  const newIssue = useNewIssue();
  const { step, pos } = useStep(m);
  useEscape(close);
  return (
    <article class="db" data-bench="detail" data-id={d().id}>
      <nav class="db-nav">
        <button class="ghost" onClick={close} title="Back to the list (Esc)">
          ← Back to list
        </button>
        <span class="flex" />
        <Show when={pos()}>
          <span class="muted">
            {pos()!.i} of {pos()!.n}
          </span>
        </Show>
        <button class="ghost small" onClick={() => step(-1)} title="Previous (k)">
          ↑
        </button>
        <button class="ghost small" onClick={() => step(1)} title="Next (j)">
          ↓
        </button>
      </nav>
      <header class="db-head">
        <ParentCrumb m={m} />
        <div class="db-title-row">
          <Title m={m} class="big" />
          <span class="mono muted big-ref">
            {d().repo}#{d().number}
          </span>
        </div>
        <div class="db-sub">
          <StateBadge state={d().state} reason={d().state_reason} pending={m.pending('state')} />
          <Opened m={m} />
        </div>
      </header>
      <div class="db-cols">
        <div class="db-main">
          <div class="card db-body">
            <div class="comment-meta">
              <Avatar login={d().author ?? '?'} size={20} />
              <b>{d().author ?? 'ghost'}</b>
              <span class="muted">opened {ago(d().created_at)} ago</span>
            </div>
            <Body m={m} />
          </div>
          <RelSection m={m} kind="child" heading="card" onNew={() => newIssue(d().id)} empty="No sub-issues" />
          <Thread m={m} variant="cards" />
          <CommentBox m={m} withClose />
          <SizeNote m={m} />
        </div>
        <aside class="db-side">
          <SideSection title="Assignees" picker={(t) => <AssigneesPicker m={m} align="right" trigger={t} />}>
            <Assignees m={m} names empty="No one" />
          </SideSection>
          <SideSection title="Labels" picker={(t) => <LabelsPicker m={m} align="right" trigger={t} />}>
            <Labels m={m} empty="None yet" />
          </SideSection>
          <SideSection title="Milestone" picker={(t) => <MilestonePicker m={m} align="right" trigger={t} />}>
            <span class={m.pending('milestone') ? 'pending' : ''}>{d().milestone ?? <span class="muted">No milestone</span>}</span>
          </SideSection>
          <RelSection m={m} kind="blocked_by" empty="Nothing" />
          <RelSection m={m} kind="blocking" empty="Nothing" />
          <RelSection m={m} kind="relates" empty="Nothing" />
          <section class="db-side-sec">
            <StateControl m={m} />
            <a class="ghost small" href={ghUrl(m)} target="_blank" rel="noreferrer">
              Open on GitHub ↗
            </a>
          </section>
        </aside>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// C: drawer with a properties rail, expandable to the full page.

function Prop(props: { name: string; children: Element }) {
  return (
    <div class="dc-prop">
      <span class="dc-prop-name">{props.name}</span>
      <div class="dc-prop-val">{props.children}</div>
    </div>
  );
}

export function DetailC(props: { m: IssueModel }) {
  const m = props.m;
  const d = () => m.d();
  const close = useClose();
  const newIssue = useNewIssue();
  const [search, setSearch] = useSearchParams();
  const { step } = useStep(m);
  useEscape(close);
  const deps = () => d().rels.blocked_by.filter((x) => x.state === 'open').length;
  return (
    <article class="dc" data-bench="detail" data-id={d().id}>
      <div class="dc-bar">
        <button class="ghost small" onClick={() => step(-1)} title="Previous (k)">
          ↑
        </button>
        <button class="ghost small" onClick={() => step(1)} title="Next (j)">
          ↓
        </button>
        <span class="mono muted">
          {d().repo}#{d().number}
        </span>
        <span class="flex" />
        <a class="ghost small" href={ghUrl(m)} target="_blank" rel="noreferrer" title="Open on GitHub">
          ↗
        </a>
        <button class="ghost small" onClick={() => setSearch({ full: search.full ? undefined : '1' }, { replace: true })} title={search.full ? 'Back to the drawer' : 'Expand to the full page'}>
          {search.full ? '⤡' : '⤢'}
        </button>
        <button class="ghost small" onClick={close} title="Close (Esc)">
          ×
        </button>
      </div>
      <div class="dc-cols">
        <div class="dc-main">
          <ParentCrumb m={m} />
          <Title m={m} class="big" />
          <Show when={deps()}>
            <p class="dc-blocked">
              Blocked by {deps()} open issue{deps() > 1 ? 's' : ''}
            </p>
          </Show>
          <Body m={m} />
          <RelSection m={m} kind="child" onNew={() => newIssue(d().id)} empty="No sub-issues" />
          <h3 class="section-h">Activity</h3>
          <Thread m={m} variant="flat" />
          <CommentBox m={m} />
          <SizeNote m={m} />
        </div>
        <aside class="dc-rail">
          <Prop name="Status">
            <StateBadge state={d().state} reason={d().state_reason} pending={m.pending('state')} />
            <StateControl m={m} compact />
          </Prop>
          <Prop name="Assignees">
            <AssigneesPicker
              m={m}
              align="right"
              trigger={(t) => (
                <button class="prop" onClick={t}>
                  <Assignees m={m} names empty="+ Assign" />
                </button>
              )}
            />
          </Prop>
          <Prop name="Labels">
            <LabelsPicker
              m={m}
              align="right"
              trigger={(t) => (
                <button class="prop" onClick={t}>
                  <Labels m={m} empty="+ Label" />
                </button>
              )}
            />
          </Prop>
          <Prop name="Milestone">
            <MilestonePicker
              m={m}
              align="right"
              trigger={(t) => (
                <button class={`prop ${m.pending('milestone') ? 'pending' : ''}`} onClick={t}>
                  {d().milestone ?? <span class="muted">+ Milestone</span>}
                </button>
              )}
            />
          </Prop>
          <Prop name="Opened">
            <span>
              {d().author} · {ago(d().created_at)} ago
            </span>
          </Prop>
          <RelSection m={m} kind="blocked_by" empty="—" />
          <RelSection m={m} kind="blocking" empty="—" />
          <RelSection m={m} kind="relates" empty="—" />
        </aside>
      </div>
    </article>
  );
}

export const DETAILS = { A: DetailA, B: DetailB, C: DetailC } as const;

export function Placeholder() {
  return (
    <div class="placeholder muted">
      <p>Select an issue to read it here.</p>
      <For each={['j / k step through the list in B and C', 'Esc closes the detail in B and C', 'c starts a new issue']}>{(t) => <p class="small">{t}</p>}</For>
    </div>
  );
}
