// PROTOTYPE (beghu #68). Real GitHub threads (md-corpus/build.mjs) stand in for the fixture's lorem
// bodies, so every open issue shows Markdown worth styling. ?md= picks the thread: `auto` (by issue
// id, the default), a thread key (`kitchen` is every element at once), or `off` (the fixture's own
// text, as #54 rendered it). ?variant= picks the style, ?icons=svg|glyph the icon approach.
import { createEffect, createSignal } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { render, type Opts } from './render';
import type { IconMode } from './icons';
import './md.css';
import './frames.css';

export type CorpusComment = { author: string; created_at: string; ast: any[] };
export type CorpusThread = { key: string; title: string; repo: string; body: any[]; comments: CorpusComment[] };

const [corpus, setCorpus] = createSignal<CorpusThread[] | undefined>(undefined);
fetch('/md-corpus.json')
  .then((r) => r.json())
  .then((c) => setCorpus(c));
export { corpus };

/** The thread shown for an issue, or undefined for the fixture's own text. */
export function useThread(id: () => number): () => CorpusThread | undefined {
  const [search] = useSearchParams();
  return () => {
    const ts = corpus();
    const pick = (search.md as string | undefined) ?? 'auto';
    if (!ts || pick === 'off') return undefined;
    if (pick !== 'auto') return ts.find((t) => t.key === pick) ?? ts[0];
    return ts[id() % ts.length];
  };
}

// Walk time, summed over every Md that renders in one frame (the body plus a page of comments).
const [walk, setWalk] = createSignal<{ ms: number; docs: number; nodes: number }>({ ms: 0, docs: 0, nodes: 0 });
export { walk };
let acc = { ms: 0, docs: 0, nodes: 0 };
let queued = false;
function report(ms: number, nodes: number) {
  acc.ms += ms;
  acc.docs++;
  acc.nodes += nodes;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    setWalk(acc);
    acc = { ms: 0, docs: 0, nodes: 0 };
  });
}

export function Md(props: { ast: any[]; repo: string }) {
  const [search] = useSearchParams();
  let host!: HTMLDivElement;
  // Round 3: the style is B; ?variant= picks the heading treatment.
  const opts = (): Opts => ({
    variant: 'B',
    heads: (search.variant as string) ?? 'T',
    icons: (search.icons === 'glyph' ? 'glyph' : 'svg') as IconMode,
    repo: props.repo,
  });
  createEffect(
    () => ({ o: opts(), ast: props.ast }),
    ({ o, ast }) => {
      const t0 = performance.now();
      const f = render(ast, o);
      host.replaceChildren(f);
      report(performance.now() - t0, host.getElementsByTagName('*').length);
    },
  );
  return <div class={`md md-${opts().variant} hv-${opts().heads} md-ic-${opts().icons}`} ref={(e) => (host = e)} />;
}
