import { createSignal, For } from 'solid-js';
import { revalidate, type RouteProps } from '@solidjs/router';
import { addLabel, getIssue, type IssueDetail } from './api';

export function IssueRoute(props: RouteProps<'/issues/:id'>) {
  // A writable async memo over the query: the optimistic label is a plain write that lands at once,
  // and a failed write revalidates. A live change revalidates the same key from the SSE handler.
  const [detail, setDetail] = createSignal<IssueDetail>(() => getIssue(Number(props.params.id)));

  async function addLabelTo(d: IssueDetail, name: string) {
    const label = d.repo_labels.find((l) => l.name === name)!;
    setDetail({ ...d, labels: [...d.labels, label] }); // optimistic
    try {
      await addLabel(d.id, name);
    } catch {
      revalidate(getIssue.keyFor(d.id));
    }
  }

  return <Detail d={detail()} onAddLabel={(name) => addLabelTo(detail(), name)} />;
}

function Detail(props: { d: IssueDetail; onAddLabel: (name: string) => void }) {
  const missing = () => props.d.repo_labels.filter((l) => !props.d.labels.some((x) => x.name === l.name));
  return (
    <article data-bench="detail" data-id={props.d.id}>
      <h2>
        <span class="repo">
          {props.d.repo}#{props.d.number}
        </span>{' '}
        {props.d.title}
      </h2>
      <div class="chips">
        <For each={props.d.labels}>
          {(l) => (
            <span class="label" data-bench="label" data-value={l.name} style={{ '--c': `#${l.color}` }}>
              {l.name}
            </span>
          )}
        </For>
      </div>
      <div class="chips">
        Add:{' '}
        <For each={missing()}>
          {(l) => (
            <button data-bench="add-label" data-value={l.name} onClick={() => props.onAddLabel(l.name)}>
              {l.name}
            </button>
          )}
        </For>
      </div>
      <pre data-bench="body">{props.d.body}</pre>
      <For each={props.d.comments}>
        {(c) => (
          <div class="comment" data-bench="comment">
            <div class="meta">
              {c.author} · {c.created_at}
            </div>
            <pre>{c.body}</pre>
          </div>
        )}
      </For>
    </article>
  );
}
