// PROTOTYPE — throwaway. Question: what should diff mode for a body's older versions look like,
// and how should its two ends move? Three variants of the body slot on the issue detail,
// switched from the floating bar at the bottom (kept in sessionStorage, not the URL: the URL's
// search is the list's filter):
//   A — Inline rendered: the body as it renders, removed blocks above added ones, a compact
//       "base → head" bar on the post.
//   B — Source lines: the body's text line by line, code-review style, changed words marked,
//       a version timeline with a stepper on each end.
//   C — Folded: rendered like A, unchanged runs folded, the ends and prev/next change in a bar
//       that sticks while the body scrolls.
// The mirror keeps no body history yet: the versions are made up from the current body's blocks
// (a seeded run of edits backwards from it), so every issue has eight.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Md, MdNode } from "./md/ast";
import type { Links } from "./md/links";
import { Markdown } from "./md/Markdown";
import type { User } from "./bindings/User";
import { ago, fullDate } from "./time";
import { colors, fonts } from "./tokens.stylex";

// ---------------------------------------------------------------------------------------------
// Mode and variant

const [diffOn, setDiffOn] = createSignal(false);
export { diffOn };
export const toggleDiff = () => setDiffOn((v) => !v);

const VARIANTS = [
  { key: "A", name: "Inline rendered" },
  { key: "B", name: "Source lines + timeline" },
  { key: "C", name: "Timeline + folded rendered" },
] as const;
type VariantKey = (typeof VARIANTS)[number]["key"];
const [variant, setVariantRaw] = createSignal<VariantKey>(
  (sessionStorage.getItem("diff-proto-variant") as VariantKey | null) ?? "C",
);
const setVariant = (v: VariantKey) => {
  sessionStorage.setItem("diff-proto-variant", v);
  setVariantRaw(v);
};

/** The DIFF button: in the status row, and on the sticky bar once the title scrolls away. */
export function DiffToggle(props: {
  onEnable?: () => void;
  floating?: boolean;
  shown?: boolean;
}) {
  return (
    <button
      type="button"
      {...stylex.attrs(
        s.toggle,
        diffOn() && s.toggleOn,
        props.floating && s.toggleFloating,
        props.floating && !props.shown && s.hidden,
      )}
      aria-pressed={diffOn() ? "true" : "false"}
      title={
        diffOn()
          ? "Back to the current body"
          : "Compare the body with its earlier versions"
      }
      onClick={() => {
        toggleDiff();
        if (diffOn()) props.onEnable?.();
      }}
    >
      Diff
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Made-up versions

type Version = { md: Md; author: string; at: number };

const NAMES = ["tomsjansons", "anna-k", "rbergs", "mlace"];

function rng(seed: number) {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The longest text leaf in `node`, as a path of child indices, for an edit to land on. */
function longestLeaf(
  node: MdNode,
  path: number[] = [],
): { path: number[]; len: number } | undefined {
  if (typeof node === "string") return { path, len: node.length };
  let best: { path: number[]; len: number } | undefined;
  for (let i = 2; i < node.length; i++) {
    const r = longestLeaf(node[i] as MdNode, [...path, i]);
    if (r && (!best || r.len > best.len)) best = r;
  }
  return best;
}

function reword(node: MdNode, pick: () => number): MdNode {
  const leaf = longestLeaf(node);
  if (!leaf || leaf.len < 12) return node;
  const out = clone(node);
  let parent = out as unknown as MdNode[];
  for (const i of leaf.path.slice(0, -1))
    parent = parent[i] as unknown as MdNode[];
  const at = leaf.path[leaf.path.length - 1];
  if (at === undefined)
    return typeof out === "string" ? swapWords(out, pick) : out;
  parent[at] = swapWords(parent[at] as string, pick);
  return out;
}

const SWAPS = [
  "probably",
  "the old",
  "a first",
  "draft:",
  "maybe",
  "roughly",
  "initially",
];
function swapWords(text: string, pick: () => number): string {
  const words = text.split(" ");
  const keep = Math.max(2, Math.floor(words.length * (0.5 + pick() * 0.4)));
  const word = SWAPS[Math.floor(pick() * SWAPS.length)]!;
  const cut = words.slice(0, keep);
  cut.splice(Math.floor(pick() * cut.length), 0, word);
  return cut.join(" ");
}

function dropListItem(node: MdNode): MdNode | undefined {
  if (typeof node === "string" || (node[0] !== "ul" && node[0] !== "ol"))
    return undefined;
  const items = node.slice(2).filter((c) => typeof c !== "string");
  if (items.length < 2) return undefined;
  const out = clone(node);
  for (let i = out.length - 1; i >= 2; i--) {
    if (typeof out[i] !== "string") {
      out.splice(i, 1);
      break;
    }
  }
  return out;
}

/** Eight versions, current first: each older one undoes a made-up edit of the one after it. */
function versionsOf(
  body: Md,
  seed: number,
  author: string,
  created: number,
): Version[] {
  const pick = rng(seed);
  const now = Date.now() / 1000;
  const span = Math.max(3600, now - created);
  const out: Version[] = [{ md: body, author, at: now - span * 0.02 }];
  let md = body;
  const N = 8;
  for (let step = 1; step < N; step++) {
    const next = [...md];
    const idx = () => Math.floor(pick() * Math.max(1, next.length));
    switch (step % 6) {
      case 1:
      case 4: {
        const i = idx();
        if (next[i] !== undefined) next[i] = reword(next[i]!, pick);
        break;
      }
      case 2: {
        if (next.length > 2)
          next.splice(Math.max(1, next.length - 2 - Math.floor(pick() * 2)), 1);
        break;
      }
      case 3: {
        next.splice(Math.min(next.length, 1 + idx()), 0, [
          "p",
          0,
          ["em", 0, "TBD: write this part once the design pass is done."],
        ]);
        break;
      }
      case 5: {
        const i = next.findIndex((b) => dropListItem(b) !== undefined);
        if (i >= 0) next[i] = dropListItem(next[i]!)!;
        else if (next[0] !== undefined) next[0] = reword(next[0], pick);
        break;
      }
      case 0: {
        next.splice(Math.ceil(next.length / 2));
        break;
      }
    }
    if (step === N - 1) {
      next.splice(2);
      next.push(["p", 0, "Initial draft."]);
    }
    md = next;
    out.push({
      md,
      author:
        step === N - 1 ? author : NAMES[Math.floor(pick() * NAMES.length)]!,
      at: now - span * (0.02 + (step / (N - 1)) * 0.95),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Diffing

type Op<T> = {
  kind: "same" | "del" | "add";
  item: T;
  old?: number;
  new?: number;
};

/** An LCS diff of `a` (older) into `b`, each run of changes as its removals, then its additions. */
function diff<T>(a: T[], b: T[], key: (t: T) => string): Op<T>[] {
  const ka = a.map(key);
  const kb = b.map(key);
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i]![j] =
        ka[i] === kb[j]
          ? t[i + 1]![j + 1]! + 1
          : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: Op<T>[] = [];
  let dels: Op<T>[] = [];
  let adds: Op<T>[] = [];
  const flush = () => {
    out.push(...dels, ...adds);
    dels = [];
    adds = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) {
      flush();
      out.push({ kind: "same", item: b[j]!, old: i, new: j });
      i++;
      j++;
    } else if (j < m && (i === n || t[i]![j + 1]! >= t[i + 1]![j]!)) {
      adds.push({ kind: "add", item: b[j]!, new: j });
      j++;
    } else {
      dels.push({ kind: "del", item: a[i]!, old: i });
      i++;
    }
  }
  flush();
  return out;
}

const blockKey = (b: MdNode) => JSON.stringify(b);

function textOf(node: MdNode): string {
  if (typeof node === "string") return node;
  if (node[0] === "br") return "\n";
  return node
    .slice(2)
    .map((c) => textOf(c as MdNode))
    .join("");
}

/** A block as source-ish lines: headings with #, list items with -, code as its lines. */
function linesOf(block: MdNode): string[] {
  if (typeof block === "string") return block.split("\n");
  const [tag] = block;
  const kids = block.slice(2) as MdNode[];
  const h = /^h([1-6])$/.exec(tag);
  if (h) return [`${"#".repeat(Number(h[1]))} ${textOf(block)}`];
  if (tag === "ul" || tag === "ol") {
    return kids
      .filter((k) => typeof k !== "string")
      .flatMap((li, n) =>
        textOf(li)
          .trim()
          .split("\n")
          .map((l, k) =>
            k === 0 ? `${tag === "ol" ? `${n + 1}.` : "-"} ${l}` : `  ${l}`,
          ),
      );
  }
  if (tag === "pre")
    return ["```", ...textOf(block).replace(/\n$/, "").split("\n"), "```"];
  if (tag === "blockquote")
    return textOf(block)
      .trim()
      .split("\n")
      .map((l) => `> ${l}`);
  if (tag === "hr") return ["---"];
  return textOf(block).split("\n");
}

function sourceLines(md: Md): string[] {
  const out: string[] = [];
  md.forEach((b, i) => {
    if (i > 0) out.push("");
    out.push(...linesOf(b));
  });
  return out;
}

type Piece = { text: string; changed: boolean };
/** `from` → `to` word by word: the pieces of each side, changed words flagged. */
function wordDiff(from: string, to: string): { del: Piece[]; add: Piece[] } {
  const ops = diff(from.split(/(\s+)/), to.split(/(\s+)/), (w) => w);
  return {
    del: ops
      .filter((o) => o.kind !== "add")
      .map((o) => ({ text: o.item, changed: o.kind === "del" })),
    add: ops
      .filter((o) => o.kind !== "del")
      .map((o) => ({ text: o.item, changed: o.kind === "add" })),
  };
}

// ---------------------------------------------------------------------------------------------
// The two ends

/** Versions by age: 0 is the current body, `n - 1` the first. The base is older than the head. */
function createEnds(count: () => number) {
  const [base, setBase] = createSignal(1);
  const [head, setHead] = createSignal(0);
  return {
    base,
    head,
    baseOlder: () => base() < count() - 1 && setBase(base() + 1),
    baseNewer: () => base() - 1 > head() && setBase(base() - 1),
    headOlder: () => head() + 1 < base() && setHead(head() + 1),
    headNewer: () => head() > 0 && setHead(head() - 1),
    can: {
      baseOlder: () => base() < count() - 1,
      baseNewer: () => base() - 1 > head(),
      headOlder: () => head() + 1 < base(),
      headNewer: () => head() > 0,
    },
    reset: () => {
      setBase(1);
      setHead(0);
    },
  };
}
type Ends = ReturnType<typeof createEnds>;

const label = (age: number) => (age === 0 ? "current" : `−${age}`);

function Stepper(props: {
  which: "base" | "head";
  ends: Ends;
  versions: Version[];
  wide?: boolean;
}) {
  const age = () =>
    props.which === "base" ? props.ends.base() : props.ends.head();
  const v = () => props.versions[age()]!;
  const older = () =>
    props.which === "base" ? props.ends.baseOlder() : props.ends.headOlder();
  const newer = () =>
    props.which === "base" ? props.ends.baseNewer() : props.ends.headNewer();
  const canOlder = () =>
    props.which === "base"
      ? props.ends.can.baseOlder()
      : props.ends.can.headOlder();
  const canNewer = () =>
    props.which === "base"
      ? props.ends.can.baseNewer()
      : props.ends.can.headNewer();
  return (
    <span
      {...stylex.attrs(
        s.stepper,
        props.which === "base" ? s.stepperBase : s.stepperHead,
      )}
    >
      <button
        type="button"
        {...stylex.attrs(s.step)}
        disabled={!canOlder()}
        onClick={older}
        title="An older version"
      >
        ‹
      </button>
      <span {...stylex.attrs(s.stepLabel)} title={fullDate(v().at)}>
        <b>{label(age())}</b>
        <Show when={props.wide}>
          <span {...stylex.attrs(s.muted)}>
            {" "}
            · {v().author} · {ago(v().at)} ago
          </span>
        </Show>
      </span>
      <button
        type="button"
        {...stylex.attrs(s.step)}
        disabled={!canNewer()}
        onClick={newer}
        title="A newer version"
      >
        ›
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The slot

export function BodyDiffPrototype(props: {
  body: Md;
  id: number;
  author: User | null;
  created: number;
  links: Links;
}) {
  const versions = createMemo(() =>
    versionsOf(
      props.body,
      props.id,
      props.author?.login ?? "ghost",
      props.created,
    ),
  );
  const ends = createEnds(() => versions().length);
  const from = () => versions()[ends.base()]!;
  const to = () => versions()[ends.head()]!;
  return (
    <div data-perf="body-diff">
      <Show when={variant() === "A"}>
        <VariantA
          from={from()}
          to={to()}
          ends={ends}
          versions={versions()}
          links={props.links}
        />
      </Show>
      <Show when={variant() === "B"}>
        <VariantB from={from()} to={to()} ends={ends} versions={versions()} />
      </Show>
      <Show when={variant() === "C"}>
        <VariantC
          from={from()}
          to={to()}
          ends={ends}
          versions={versions()}
          links={props.links}
        />
      </Show>
    </div>
  );
}

type VariantProps = {
  from: Version;
  to: Version;
  ends: Ends;
  versions: Version[];
};

function counts<T>(ops: Op<T>[]) {
  return {
    add: ops.filter((o) => o.kind === "add").length,
    del: ops.filter((o) => o.kind === "del").length,
  };
}

function Block(props: { op: Op<MdNode>; links: Links }) {
  return (
    <div
      {...stylex.attrs(
        s.blockRow,
        props.op.kind === "add" && s.addRow,
        props.op.kind === "del" && s.delRow,
      )}
    >
      <span
        {...stylex.attrs(
          s.sign,
          props.op.kind === "add" && s.signAdd,
          props.op.kind === "del" && s.signDel,
        )}
      >
        {props.op.kind === "add" ? "+" : props.op.kind === "del" ? "−" : ""}
      </span>
      <div {...stylex.attrs(s.blockBody, props.op.kind === "del" && s.delBody)}>
        <Markdown md={[props.op.item]} links={props.links} terms={[]} />
      </div>
    </div>
  );
}

// A — the body as it renders, changes in place.
function VariantA(props: VariantProps & { links: Links }) {
  const ops = createMemo(() => diff(props.from.md, props.to.md, blockKey));
  const n = () => counts(ops());
  return (
    <>
      <div {...stylex.attrs(s.barA)}>
        <Stepper
          which="base"
          ends={props.ends}
          versions={props.versions}
          wide
        />
        <span {...stylex.attrs(s.muted)}>→</span>
        <Stepper
          which="head"
          ends={props.ends}
          versions={props.versions}
          wide
        />
        <span {...stylex.attrs(s.spacer)} />
        <span {...stylex.attrs(s.signAdd)}>+{n().add}</span>{" "}
        <span {...stylex.attrs(s.signDel)}>−{n().del}</span>
      </div>
      <Show
        when={n().add + n().del > 0}
        fallback={
          <p {...stylex.attrs(s.muted)}>No change between these versions.</p>
        }
      >
        <For each={ops()} keyed={false}>
          {(op) => <Block op={op()} links={props.links} />}
        </For>
      </Show>
    </>
  );
}

// B — source lines, with a timeline of every version.
function VariantB(props: VariantProps) {
  const ops = createMemo(() =>
    diff(sourceLines(props.from.md), sourceLines(props.to.md), (l) => l),
  );
  const n = () => counts(ops());
  // A run's i-th removed line pairs with its i-th added line, for the word marks.
  const pairs = createMemo(() => {
    const words = new Map<number, Piece[]>();
    const list = ops();
    let k = 0;
    while (k < list.length) {
      if (list[k]!.kind !== "del") {
        k++;
        continue;
      }
      const d0 = k;
      while (k < list.length && list[k]!.kind === "del") k++;
      const a0 = k;
      while (k < list.length && list[k]!.kind === "add") k++;
      for (let p = 0; p < Math.min(a0 - d0, k - a0); p++) {
        const w = wordDiff(list[d0 + p]!.item, list[a0 + p]!.item);
        words.set(d0 + p, w.del);
        words.set(a0 + p, w.add);
      }
    }
    return words;
  });
  return (
    <>
      <Timeline ends={props.ends} versions={props.versions} />
      <div {...stylex.attrs(s.summaryB)}>
        <span {...stylex.attrs(s.signAdd)}>+{n().add}</span>{" "}
        <span {...stylex.attrs(s.signDel)}>−{n().del}</span> lines ·{" "}
        <span {...stylex.attrs(s.muted)}>
          {label(props.ends.base())} by {props.from.author},{" "}
          {ago(props.from.at)} ago → {label(props.ends.head())} by{" "}
          {props.to.author}, {ago(props.to.at)} ago
        </span>
      </div>
      <div {...stylex.attrs(s.source)}>
        <For each={ops()} keyed={false}>
          {(op, i) => (
            <div
              {...stylex.attrs(
                s.line,
                op().kind === "add" && s.addRow,
                op().kind === "del" && s.delRow,
              )}
            >
              <span {...stylex.attrs(s.num)}>
                {op().old === undefined ? "" : op().old! + 1}
              </span>
              <span {...stylex.attrs(s.num)}>
                {op().new === undefined ? "" : op().new! + 1}
              </span>
              <span
                {...stylex.attrs(
                  s.sign,
                  op().kind === "add" && s.signAdd,
                  op().kind === "del" && s.signDel,
                )}
              >
                {op().kind === "add" ? "+" : op().kind === "del" ? "−" : ""}
              </span>
              <span {...stylex.attrs(s.lineText)}>
                <Show when={pairs().get(i)} fallback={op().item || " "}>
                  {(pieces) => (
                    <For each={pieces()} keyed={false}>
                      {(p) => (
                        <span
                          {...stylex.attrs(
                            p().changed &&
                              (op().kind === "add" ? s.wordAdd : s.wordDel),
                          )}
                        >
                          {p().text}
                        </span>
                      )}
                    </For>
                  )}
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </>
  );
}

function Timeline(props: { ends: Ends; versions: Version[] }) {
  // Oldest on the left, current on the right.
  const ages = () =>
    props.versions.map((_, i) => props.versions.length - 1 - i);
  const inRange = (age: number) =>
    age <= props.ends.base() && age >= props.ends.head();
  return (
    <div {...stylex.attrs(s.timeline)}>
      <Stepper which="base" ends={props.ends} versions={props.versions} />
      <div {...stylex.attrs(s.track)}>
        <For each={ages()} keyed={false}>
          {(age) => (
            <span
              {...stylex.attrs(
                s.tick,
                inRange(age()) && s.tickIn,
                age() === props.ends.base() && s.tickBase,
                age() === props.ends.head() && s.tickHead,
              )}
              title={`${label(age())} · ${props.versions[age()]!.author} · ${ago(props.versions[age()]!.at)} ago`}
            >
              {label(age())}
            </span>
          )}
        </For>
      </div>
      <Stepper which="head" ends={props.ends} versions={props.versions} />
    </div>
  );
}

// C — rendered, unchanged runs folded, ends and change navigation stuck to the top.
type Fold =
  | { kind: "fold"; ops: Op<MdNode>[]; id: number }
  | { kind: "op"; op: Op<MdNode>; change?: number };
function VariantC(props: VariantProps & { links: Links }) {
  const ops = createMemo(() => diff(props.from.md, props.to.md, blockKey));
  const n = () => counts(ops());
  const [open, setOpen] = createSignal<Set<number>>(new Set());
  const items = createMemo((): Fold[] => {
    const list = ops();
    const out: Fold[] = [];
    let change = 0;
    let k = 0;
    while (k < list.length) {
      if (list[k]!.kind !== "same") {
        const first = k === 0 || list[k - 1]!.kind === "same";
        out.push({
          kind: "op",
          op: list[k]!,
          change: first ? change++ : undefined,
        });
        k++;
        continue;
      }
      const start = k;
      while (k < list.length && list[k]!.kind === "same") k++;
      const run = list.slice(start, k);
      const keepBefore = start === 0 ? 0 : 1;
      const keepAfter = k === list.length ? 0 : 1;
      if (run.length <= keepBefore + keepAfter + 1) {
        for (const op of run) out.push({ kind: "op", op });
        continue;
      }
      for (const op of run.slice(0, keepBefore)) out.push({ kind: "op", op });
      out.push({
        kind: "fold",
        ops: run.slice(keepBefore, run.length - keepAfter),
        id: start,
      });
      for (const op of run.slice(run.length - keepAfter))
        out.push({ kind: "op", op });
    }
    return out;
  });
  const folds = () => items().flatMap((x) => (x.kind === "fold" ? [x.id] : []));
  const allOpen = () => folds().length > 0 && folds().every((id) => open().has(id));
  const changes = () =>
    items().filter((x) => x.kind === "op" && x.change !== undefined).length;
  const [at, setAt] = createSignal(-1);
  let root!: HTMLDivElement;
  const go = (dir: 1 | -1) => {
    const total = changes();
    if (total === 0) return;
    const next = (((at() + dir) % total) + total) % total;
    setAt(next);
    root
      .querySelector(`[data-change="${next}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <div ref={root}>
      <div {...stylex.attrs(s.barC)}>
        <Timeline ends={props.ends} versions={props.versions} />
        <div {...stylex.attrs(s.barRow)}>
          <span {...stylex.attrs(s.signAdd)}>+{n().add}</span>{" "}
          <span {...stylex.attrs(s.signDel)}>−{n().del}</span> blocks ·{" "}
          <span {...stylex.attrs(s.muted)}>
            {label(props.ends.base())} by {props.from.author}, {ago(props.from.at)} ago → {label(props.ends.head())} by {props.to.author},{" "}
            {ago(props.to.at)} ago
          </span>
          <span {...stylex.attrs(s.spacer)} />
          <Show when={folds().length > 0}>
            <button type="button" {...stylex.attrs(s.link)} onClick={() => setOpen(allOpen() ? new Set<number>() : new Set(folds()))}>
              {allOpen() ? "Fold unchanged" : "Unfold all"}
            </button>
          </Show>
          <button type="button" {...stylex.attrs(s.step)} onClick={() => go(-1)} disabled={changes() === 0} title="Previous change">
            ↑
          </button>
          <span {...stylex.attrs(s.muted)}>{changes() === 0 ? "no changes" : `${at() < 0 ? "–" : at() + 1} / ${changes()}`}</span>
          <button type="button" {...stylex.attrs(s.step)} onClick={() => go(1)} disabled={changes() === 0} title="Next change">
            ↓
          </button>
        </div>
      </div>
      <For each={items()}>
        {(x) => {
          const item = x;
          if (item.kind === "op") {
            return (
              <div
                data-change={item.change}
                {...stylex.attrs(
                  item.change !== undefined &&
                    item.change === at() &&
                    s.current,
                )}
              >
                <Block op={item.op} links={props.links} />
              </div>
            );
          }
          return (
            <Show
              when={open().has(item.id)}
              fallback={
                <button
                  type="button"
                  {...stylex.attrs(s.fold)}
                  onClick={() => setOpen(new Set([...open(), item.id]))}
                >
                  ⋯ {item.ops.length} unchanged{" "}
                  {item.ops.length === 1 ? "block" : "blocks"}
                </button>
              }
            >
              <button
                type="button"
                {...stylex.attrs(s.fold, s.foldOpen)}
                onClick={() => {
                  const next = new Set(open());
                  next.delete(item.id);
                  setOpen(next);
                }}
              >
                ▴ Fold {item.ops.length} unchanged {item.ops.length === 1 ? "block" : "blocks"}
              </button>
              <For each={item.ops} keyed={false}>
                {(op) => <Block op={op()} links={props.links} />}
              </For>
            </Show>
          );
        }}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The floating variant switcher (dev builds only; no keys: the arrows scroll the detail)

export function DiffVariantSwitcher() {
  const i = () => VARIANTS.findIndex((v) => v.key === variant());
  const cycle = (d: number) =>
    setVariant(VARIANTS[(i() + d + VARIANTS.length) % VARIANTS.length]!.key);
  return (
    <Show when={import.meta.env.DEV && diffOn()}>
      <div {...stylex.attrs(s.switcher)}>
        <button
          type="button"
          {...stylex.attrs(s.switchBtn)}
          onClick={() => cycle(-1)}
        >
          ←
        </button>
        <span>
          {variant()} — {VARIANTS[i()]!.name}
        </span>
        <button
          type="button"
          {...stylex.attrs(s.switchBtn)}
          onClick={() => cycle(1)}
        >
          →
        </button>
      </div>
    </Show>
  );
}

const s = stylex.create({
  hidden: { visibility: "hidden" },
  toggle: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 1,
    paddingInline: 8,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.muted,
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  toggleOn: {
    borderColor: colors.accentBg,
    backgroundColor: { default: colors.accentBg, ":hover": colors.accentBg },
    color: colors.accentFg,
  },
  toggleFloating: {
    position: "absolute",
    zIndex: 4,
    right: 48,
    top: 6,
  },
  muted: { color: colors.muted },
  spacer: { flexGrow: 1 },
  stepper: {
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    alignItems: "center",
    display: "inline-flex",
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  stepperBase: { borderColor: colors.danger },
  stepperHead: { borderColor: colors.open },
  step: {
    font: "inherit",
    borderWidth: 0,
    paddingBlock: 0,
    paddingInline: 6,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: { default: colors.fg, ":disabled": colors.line },
    cursor: { default: "pointer", ":disabled": "default" },
    fontSize: 14,
    lineHeight: "20px",
  },
  stepLabel: { paddingInline: 4 },
  barA: {
    gap: 6,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    fontSize: 12,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    marginBottom: 10,
    paddingBottom: 8,
  },
  barRow: {
    gap: 6,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
  },
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.accent, ":hover": colors.fg },
    cursor: "pointer",
    fontSize: 12,
  },
  foldOpen: { borderStyle: "solid", marginBottom: 4 },
  barC: {
    marginInline: -12,
    paddingBlock: 6,
    paddingInline: 12,
    alignItems: "stretch",
    backgroundColor: colors.bgRaised,
    boxShadow: `0 2px 6px ${colors.popShadow}`,
    display: "flex",
    flexDirection: "column",
    fontSize: 12,
    position: "sticky",
    zIndex: 2,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    marginBottom: 10,
    top: 34,
  },
  blockRow: {
    borderRadius: 3,
    gap: 6,
    marginInline: -8,
    paddingInline: 8,
    display: "flex",
    paddingTop: 4,
  },
  addRow: { backgroundColor: colors.diffAddBg },
  delRow: { backgroundColor: colors.diffDelBg },
  delBody: {
    opacity: 0.75,
    textDecorationColor: colors.danger,
    textDecorationLine: "line-through",
  },
  blockBody: { flexGrow: 1, minWidth: 0 },
  sign: {
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontWeight: 700,
    textAlign: "center",
    width: 12,
  },
  signAdd: { color: colors.open, fontWeight: 600 },
  signDel: { color: colors.danger, fontWeight: 600 },
  current: {
    borderRadius: 3,
    outlineColor: colors.accent,
    outlineOffset: 2,
    outlineStyle: "solid",
    outlineWidth: 2,
  },
  fold: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 4,
    borderStyle: "dashed",
    borderWidth: 1,
    marginBlock: 6,
    paddingBlock: 4,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.muted,
    cursor: "pointer",
    display: "block",
    fontSize: 12,
    width: "100%",
  },
  timeline: {
    gap: 8,
    alignItems: "center",
    display: "flex",
    marginBottom: 6,
  },
  track: {
    gap: 2,
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
  },
  tick: {
    borderRadius: 3,
    paddingBlock: 2,
    color: colors.muted,
    flexBasis: 0,
    flexGrow: 1,
    fontFamily: fonts.mono,
    fontSize: 10.5,
    textAlign: "center",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 3,
  },
  tickIn: { backgroundColor: colors.hover, color: colors.fg },
  tickBase: { fontWeight: 700, borderBottomColor: colors.danger, },
  tickHead: { fontWeight: 700, borderBottomColor: colors.open, },
  summaryB: { fontSize: 12, marginBottom: 8 },
  source: {
    borderColor: colors.line,
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 1.55,
    overflowX: "auto",
  },
  line: { display: "flex" },
  num: {
    paddingInline: 4,
    color: colors.muted,
    flexShrink: 0,
    textAlign: "end",
    userSelect: "none",
    width: 28,
  },
  lineText: {
    flexGrow: 1,
    paddingInlineStart: 4,
    whiteSpace: "pre-wrap",
    minWidth: 0,
  },
  wordAdd: { borderRadius: 2, backgroundColor: colors.diffAddWord, },
  wordDel: { borderRadius: 2, backgroundColor: colors.diffDelWord, },
  switcher: {
    borderRadius: 999,
    gap: 10,
    paddingBlock: 6,
    paddingInline: 10,
    alignItems: "center",
    backgroundColor: colors.fg,
    boxShadow: `0 4px 16px ${colors.popShadow}`,
    color: colors.bg,
    display: "flex",
    fontSize: 13,
    position: "fixed",
    transform: "translateX(-50%)",
    zIndex: 100,
    bottom: 16,
    left: "50%",
  },
  switchBtn: {
    font: "inherit",
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.bg,
    cursor: "pointer",
    fontSize: 15,
  },
});
