// PROTOTYPE (beghu #66). The B cue (a band over what's about to move) and the live panel: what
// mode you're in, what's held, buttons that make a teammate change the open issue, and the knobs.
import { createSignal, For, onSettled, Show } from 'solid-js';
import type { IssueModel } from './model';
import { knobs, mode, restFor, variant, where } from './live';

/**
 * B: for each change, a band from where it happens to the edge that will move: down to the
 * viewport's bottom when what's below gets pushed, up to its top when the top edge absorbs it.
 * A label says what and how much. Drawn once when the cue starts.
 */
export function Gutter(props: { m: IssueModel }) {
  const [bands, setBands] = createSignal<{ top: number; height: number; label: string; dir: string }[]>([]);
  const draw = (host: HTMLElement) =>
    requestAnimationFrame(() => {
      const sc = document.querySelector<HTMLElement>('.detail');
      const da = host.parentElement;
      if (!sc || !da) return;
      const base = da.getBoundingClientRect().top;
      const vt = sc.getBoundingClientRect().top - base;
      const vb = vt + sc.clientHeight;
      const out: { top: number; height: number; label: string; dir: string }[] = [];
      for (const el of sc.querySelectorAll<HTMLElement>('[data-live]')) {
        const r = el.getBoundingClientRect();
        const y = r.top - base;
        const w = where(sc, el);
        const kind = el.dataset.live;
        const lines = Math.max(1, Math.round((kind === 'add' ? el.scrollHeight : r.height) / 21));
        const what = kind === 'add' ? `+${lines} lines` : kind === 'del' ? `−${lines} lines` : 'properties';
        if (w === 'down') out.push({ top: y, height: Math.max(24, vb - y), label: `↓ ${what}`, dir: 'down' });
        else if (w === 'up') out.push({ top: vt, height: Math.max(24, y + (kind === 'add' ? 0 : r.height) - vt), label: `↑ ${what}`, dir: 'up' });
        else if (w === 'above') out.push({ top: vt, height: 24, label: `↑ ${what} above`, dir: 'edge' });
        else out.push({ top: vb - 24, height: 24, label: `↓ ${what} below`, dir: 'edge' });
      }
      setBands(out);
    });
  return (
    <Show when={props.m.held.phase() === 'cue' && variant() === 'B'}>
      <div class="lv-gutter" ref={draw} aria-hidden="true">
        <For each={bands()}>
          {(b) => (
            <div class={`lv-band ${b.dir}`} style={{ top: `${b.top}px`, height: `${b.height}px` }}>
              <span>{b.label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

const KINDS: [string, string][] = [
  ['comment', 'comment'],
  ['agent', 'agent comment'],
  ['body_add', 'body +¶'],
  ['body_remove', 'body −¶'],
  ['body_rewrite', 'body ✎¶'],
  ['body_typo', 'body typo'],
  ['label', '+ label'],
  ['unlabel', '− label'],
  ['assign', '+ assignee'],
  ['blocker', '+ blocker'],
];

function Knob<T extends string>(props: { name: string; k: readonly [() => T, (v: T) => void]; options: T[]; title?: string }) {
  return (
    <label title={props.title}>
      {props.name}{' '}
      <select value={props.k[0]()} onChange={(e) => props.k[1](e.currentTarget.value as T)}>
        <For each={props.options}>{(o) => <option value={o}>{o}</option>}</For>
      </select>
    </label>
  );
}

export function LivePanel(props: { m: IssueModel }) {
  const [open, setOpen] = createSignal(sessionStorage.getItem('proto-live-open') !== '0');
  const [delay, setDelay] = createSignal(Number(sessionStorage.getItem('proto-live-delay') ?? 0));
  const [auto, setAuto] = createSignal(false);
  const [sent, setSent] = createSignal('');
  const fire = (kind: string) => {
    const id = props.m.d().id;
    setSent(delay() ? `${kind} in ${delay()} s…` : `${kind} sent`);
    setTimeout(() => fetch(`/api/proto/teammate/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) }).then(() => setSent(`${kind} sent`)), delay() * 1000);
  };
  onSettled(() => {
    // Auto: a teammate change every 8–20 s, picked at random.
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        if (auto()) fire(KINDS[Math.floor(Math.random() * KINDS.length)][0]);
        loop();
      }, 8000 + Math.random() * 12000);
    };
    loop();
    return () => clearTimeout(t);
  });
  const rest = () => Number(knobs.rest[0]());
  return (
    <div class={`live-panel ${open() ? '' : 'closed'}`}>
      <header>
        <b>Live changes</b>
        <span class={`lp-mode ${mode()}`}>
          {mode() === 'reading' ? 'reading' : `intent · ${Math.max(0, rest() - restFor()).toFixed(1)} s`}
        </span>
        <span class="lp-phase">{props.m.held.phase()}</span>
        <span class="flex" />
        <button class="ghost small" onClick={() => (setOpen(!open()), sessionStorage.setItem('proto-live-open', open() ? '1' : '0'))}>
          {open() ? '–' : '+'}
        </button>
      </header>
      <Show when={open()}>
        <div class="lp-held muted">{props.m.plan()?.summary ?? 'nothing held'}</div>
        <div class="lp-kinds">
          <For each={KINDS}>{([k, label]) => <button onClick={() => fire(k)}>{label}</button>}</For>
        </div>
        <div class="lp-row">
          <label title="Wait before the teammate's change lands, so you can scroll or rest first">
            after{' '}
            <select value={String(delay())} onChange={(e) => (setDelay(Number(e.currentTarget.value)), sessionStorage.setItem('proto-live-delay', e.currentTarget.value))}>
              <For each={[0, 3, 8]}>{(d) => <option value={String(d)}>{d} s</option>}</For>
            </select>
          </label>
          <label title="A random teammate change every 8–20 s">
            <input type="checkbox" checked={auto()} onChange={(e) => setAuto(e.currentTarget.checked)} /> auto
          </label>
          <span class="muted small">{sent()}</span>
        </div>
        <div class="lp-knobs">
          <Knob name="rest" k={knobs.rest} options={['5', '3', '2']} title="Seconds of stillness before reading mode (5 is the decided value)" />
          <Knob name="cue" k={knobs.cue} options={['400', '700', '1200']} title="How long the shift cue shows (ms)" />
          <Knob name="anim" k={knobs.anim} options={['150', '250', '400']} title="How long the change animates (ms)" />
          <Knob name="on intent" k={knobs.interrupt} options={['cancel', 'finish']} title="Intent during a cue: cancel it and hold again, or finish" />
          <Knob name="props" k={knobs.props} options={['held', 'in place']} title="Property rows and Blocks: held like the body, or changed at once" />
          <Knob name="off-screen" k={knobs.offscreen} options={['now', 'hold']} title="A change wholly off-screen: apply at once, keeping the reading position, or hold it" />
          <Knob name="visible" k={knobs.absorb} options={['push', 'nearer edge']} title="A visible change pushes what's below it, or the nearer viewport edge absorbs it" />
          <Knob name="order" k={knobs.order} options={['newest', 'oldest']} title="Comment order" />
          <Knob name="motion" k={knobs.motion} options={['os', 'reduce']} title="Force prefers-reduced-motion" />
        </div>
      </Show>
    </div>
  );
}
