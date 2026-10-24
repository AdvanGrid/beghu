// PROTOTYPE (beghu #52, #54). The floating bar: cycle variants (← → or the arrows), add read latency,
// pick how GitHub answers writes, switch theme. Not part of any design being judged.
import { createSignal, For, onSettled } from 'solid-js';
import { useSearchParams } from '@solidjs/router';
import { VARIANTS } from './App';
import { fail, lag, setFail, setLag, type Fail } from './api';
import { corpus, walk } from './md/Md';

const LAGS = [0, 150, 400, 1000, 2500];
type Theme = 'light' | 'dark' | 'system';

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function Switcher() {
  const [search, setSearch] = useSearchParams();
  const index = () => Math.max(0, VARIANTS.findIndex((v) => v.key === search.variant));
  const step = (d: number) => setSearch({ variant: VARIANTS[(index() + d + VARIANTS.length) % VARIANTS.length].key }, { replace: true });
  const [ms, setMs] = createSignal(lag);
  const [theme, setTheme] = createSignal<Theme>((localStorage.getItem('proto-theme') as Theme) ?? 'system');

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div class="switcher">
      <button onClick={() => step(-1)} title="Previous variant (←)">
        ‹
      </button>
      <span class="sw-label">
        <b>{VARIANTS[index()].key}</b> — {VARIANTS[index()].name}
      </span>
      <button onClick={() => step(1)} title="Next variant (→)">
        ›
      </button>
      <span class="sw-sep" />
      {/* #68: which real thread stands in for the fixture's text, the icon approach, walk time */}
      <label>
        md{' '}
        <select value={(search.md as string) ?? 'auto'} onChange={(e) => setSearch({ md: e.currentTarget.value === 'auto' ? undefined : e.currentTarget.value }, { replace: true })}>
          <option value="auto">auto (by issue)</option>
          <option value="off">off (fixture text)</option>
          <For each={corpus() ?? []}>{(t) => <option value={t.key}>{t.key.replace('agent:', '🤖 ')}</option>}</For>
        </select>
      </label>
      <label>
        icons{' '}
        <select value={(search.icons as string) ?? 'svg'} onChange={(e) => setSearch({ icons: e.currentTarget.value === 'svg' ? undefined : e.currentTarget.value }, { replace: true })}>
          <option value="svg">svg sprite</option>
          <option value="glyph">unicode glyphs</option>
        </select>
      </label>
      <span class="sw-walk" title="Walker time for the last frame's Markdown (body + comments), before layout">
        walk {walk().ms.toFixed(1)} ms · {walk().docs} docs · {walk().nodes} nodes
      </span>
      <span class="sw-sep" />
      <label>
        lag{' '}
        <select
          value={String(ms())}
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            setLag(v);
            setMs(v);
          }}
        >
          <For each={LAGS}>{(l) => <option value={String(l)}>{l} ms</option>}</For>
        </select>
      </label>
      <label>
        writes{' '}
        <select value={fail} onChange={(e) => setFail(e.currentTarget.value as Fail)} title="How GitHub answers writes (each takes ~300 ms)">
          <option value="">succeed</option>
          <option value="422">fail 422</option>
          <option value="409">body 409</option>
          <option value="down">GitHub down</option>
        </select>
      </label>
      <select
        value={theme()}
        onChange={(e) => {
          const t = e.currentTarget.value as Theme;
          localStorage.setItem('proto-theme', t);
          setTheme(t);
          applyTheme(t);
        }}
      >
        <option value="system">system</option>
        <option value="light">light</option>
        <option value="dark">dark</option>
      </select>
    </div>
  );
}
