// PROTOTYPE (beghu #54). The detail routes: /issues/:id renders the layout ?variant= picks, over
// one model; /new is the create form in that layout's shape.
import { createSignal, createMemo, For, onSettled, Show } from 'solid-js';
import { useLocation, useNavigate, useSearchParams, type RouteProps } from '@solidjs/router';
import { createIssue, getIssue, getRepos, WriteError, type Detail, type RepoMeta } from './api';
import { issueModel } from './detail/model';
import { DETAILS, stripDetailParams } from './detail/layouts';
import { ChoiceList, Popover, IssueStateIcon } from './detail/parts';
import { Avatar, LabelPill } from './bits';
import { toast } from './detail/toasts';
import { viewFromLocation } from './App';

export function IssueRoute(props: RouteProps<'/issues/:id'>) {
  const [server, setServer] = createSignal<Detail>(() => getIssue(Number(props.params.id)));
  const m = issueModel(server, setServer);
  const [search] = useSearchParams();

  // A live push for this issue refetches it (the App's SSE handler raises the event).
  onSettled(() => {
    const onChange = (e: Event) => (e as CustomEvent<number[]>).detail.includes(server().id) && m.refresh();
    window.addEventListener('issues-changed', onChange);
    return () => window.removeEventListener('issues-changed', onChange);
  });

  const Layout = () => {
    const L = DETAILS[(search.variant as keyof typeof DETAILS) ?? 'A'] ?? DETAILS.A;
    return <L m={m} />;
  };
  return <Layout />;
}

// ---------------------------------------------------------------------------------------------

/** The new-issue form. The issue only appears once GitHub has it: no temp row; the form shows
 * "Creating…" while the request is open, then navigates to the real id. A failed create keeps
 * everything typed and never retries on its own. */
export function NewIssue() {
  const [search, setSearch] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const [repos] = createSignal<RepoMeta[]>(() => getRepos());
  const variant = () => (search.variant as string) ?? 'A';
  const parent = () => (search.parent ? Number(search.parent) : undefined);

  // Default repo: the view's repo filter, else the last one used.
  const firstRepo = () => viewFromLocation().repo[0] ?? localStorage.getItem('proto-last-repo') ?? 'web';
  const [repo, setRepo] = createSignal(firstRepo());
  const meta = createMemo(() => repos().find((r) => r.repo === repo()) ?? repos()[0]);
  const [labels, setLabels] = createSignal<string[]>([]);
  const [assignees, setAssignees] = createSignal<string[]>([]);
  const [milestone, setMilestone] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [more, setMore] = createSignal(false);
  let title!: HTMLInputElement;
  let body!: HTMLTextAreaElement;
  let opId = Math.random().toString(36).slice(2);

  const close = () => nav(`/${stripDetailParams(loc.search)}`, { scroll: false });

  async function submit() {
    if (!title.value.trim() || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await createIssue({
        op_id: opId,
        repo: repo(),
        title: title.value.trim(),
        body: body.value,
        labels: labels(),
        assignees: assignees(),
        milestone: milestone() ?? null,
        parent: parent() ?? null,
      });
      localStorage.setItem('proto-last-repo', repo());
      opId = Math.random().toString(36).slice(2);
      if (more()) {
        toast({ text: `Created ${repo()}#${created.number}.` });
        title.value = '';
        body.value = '';
        title.focus();
      } else {
        nav(`/issues/${created.id}${stripDetailParams(loc.search)}`, { scroll: false });
      }
    } catch (e) {
      setError(e instanceof WriteError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

  const pickers = () => (
    <div class={`new-props ${variant() === 'B' ? 'stacked' : ''}`}>
      <label class="prop">
        Repo{' '}
        <select value={repo()} onChange={(e) => (setRepo(e.currentTarget.value), setLabels([]), setMilestone(undefined))}>
          <For each={repos()}>{(r) => <option value={r.repo}>{r.repo}</option>}</For>
        </select>
      </label>
      <Popover
        trigger={(t) => (
          <button class="prop" onClick={t}>
            <Show when={labels().length} fallback={<span class="muted">+ Labels</span>}>
              <For each={labels()}>{(n) => <LabelPill l={meta()?.labels.find((l) => l.name === n) ?? { name: n, color: '888888' }} />}</For>
            </Show>
          </button>
        )}
      >
        {(c) => (
          <ChoiceList
            close={c}
            placeholder="Filter labels"
            choices={(meta()?.labels ?? []).map((l) => ({
              key: l.name,
              search: l.name,
              on: labels().includes(l.name),
              label: (
                <>
                  <span class="dot" style={{ background: `#${l.color}` }} />
                  {l.name}
                </>
              ),
            }))}
            onPick={(k, on) => setLabels(toggle(labels(), k, on))}
          />
        )}
      </Popover>
      <Popover
        trigger={(t) => (
          <button class="prop" onClick={t}>
            <Show when={assignees().length} fallback={<span class="muted">+ Assignees</span>}>
              <For each={assignees()}>{(a) => <Avatar login={a} size={18} />}</For>
            </Show>
          </button>
        )}
      >
        {(c) => (
          <ChoiceList
            close={c}
            placeholder="Assign someone"
            choices={(meta()?.assignable ?? []).map((a) => ({
              key: a,
              search: a,
              on: assignees().includes(a),
              label: (
                <>
                  <Avatar login={a} size={18} />
                  {a}
                </>
              ),
            }))}
            onPick={(k, on) => setAssignees(toggle(assignees(), k, on))}
          />
        )}
      </Popover>
      <Popover
        trigger={(t) => (
          <button class="prop" onClick={t}>
            {milestone() ?? <span class="muted">+ Milestone</span>}
          </button>
        )}
      >
        {(c) => (
          <ChoiceList
            single
            close={c}
            placeholder="Set milestone"
            choices={(meta()?.milestones ?? []).map((t) => ({ key: t, search: t, on: milestone() === t, label: <>{t}</> }))}
            onPick={(k, on) => setMilestone(on ? k : undefined)}
          />
        )}
      </Popover>
    </div>
  );

  const form = () => (
    <div class={`new-issue nv-${variant()}`} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit()}>
      <header class="new-head">
        <IssueStateIcon state="open" size={16} />
        <b>New issue</b>
        <Show when={parent()}>
          <span class="muted">as a sub-issue of #{parent()}</span>
          <button class="ghost small" title="Not a sub-issue" onClick={() => setSearch({ parent: undefined })}>
            ×
          </button>
        </Show>
        <span class="flex" />
        <button class="ghost small" onClick={close} title="Cancel (Esc)">
          ×
        </button>
      </header>
      <Show when={variant() !== 'B'}>{pickers()}</Show>
      <input class="title-input big" placeholder="Title" ref={(el) => ((title = el), queueMicrotask(() => el.focus()))} disabled={busy()} />
      <textarea class="editor" rows={variant() === 'C' ? 6 : 10} placeholder="Description (optional)" ref={body} disabled={busy()} />
      <Show when={error()}>
        <p class="err">Couldn't create the issue: {error()}. Nothing you typed was lost.</p>
      </Show>
      <div class="row-actions">
        <Show when={variant() === 'C'}>
          <label class="muted small create-more">
            <input type="checkbox" checked={more()} onChange={(e) => setMore(e.currentTarget.checked)} /> Create more
          </label>
        </Show>
        <span class="flex" />
        <button class="ghost" onClick={close}>
          Cancel
        </button>
        <button class="primary" onClick={submit} disabled={busy()}>
          {busy() ? 'Creating…' : error() ? 'Try again' : 'Create issue'}
        </button>
      </div>
    </div>
  );

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest('.popover') && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <Show
      when={variant() === 'B'}
      fallback={
        variant() === 'C' ? (
          <div class="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
            <div class="modal">{form()}</div>
          </div>
        ) : (
          form()
        )
      }
    >
      <div class="db new-page">
        <nav class="db-nav">
          <button class="ghost" onClick={close}>
            ← Back to list
          </button>
        </nav>
        <div class="db-cols">
          <div class="db-main">{form()}</div>
          <aside class="db-side">{pickers()}</aside>
        </div>
      </div>
    </Show>
  );
}
