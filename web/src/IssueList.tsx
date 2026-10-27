import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Loading, Show } from "solid-js";
import { SessionEnded, getIssues, signIn, type IssuePage, type IssueRow } from "./api";
import { Avatar, issueState, StateIcon } from "./bits";
import { createVirtualizer } from "./virtual";
import { ago, fullDate } from "./time";
import { colors, fonts } from "./tokens.stylex";

/** Every row is exactly this tall, border included: the virtualizer's pitch. */
export const ROW_HEIGHT = 34;
/** Rows past either edge of the window kept in the DOM. */
const OVERSCAN = 6;
/** Load the next page when the window gets this close to the last loaded row. */
const NEAR_END = 40;

/**
 * The issue list: strict columns (state, title, labels, blockers, progress, `repo#number`,
 * assignees, updated) on 34 px rows, with only the rows on screen in the DOM. Pages load as the
 * window nears the end. Rows are plain links; the router's one listener opens them.
 */
export function IssueList(props: { search: string; openId?: number }) {
  // The first page follows the view (the URL's query string); later pages are appended.
  const [page, setPage] = createSignal<IssuePage>(() => getIssues(props.search));
  let loadingMore = false;
  const loadMore = async () => {
    const have = page();
    if (loadingMore || !have.next) return;
    loadingMore = true;
    const view = props.search;
    try {
      const more = await getIssues(view, have.next);
      if (view === props.search) setPage({ rows: [...have.rows, ...more.rows], next: more.next });
    } catch (e) {
      // A failed page never replaces what's on screen; the next scroll asks again.
      if (e instanceof SessionEnded) signIn();
    } finally {
      loadingMore = false;
    }
  };

  return (
    <div {...stylex.attrs(s.column)}>
      <div {...stylex.attrs(s.row, s.head)} aria-hidden="true">
        <span />
        <span>Title</span>
        <span {...stylex.attrs(s.wide)}>Labels</span>
        <span {...stylex.attrs(s.wide)}>Blocked by</span>
        <span {...stylex.attrs(s.wide)}>Subs</span>
        <span {...stylex.attrs(s.end)}>Issue</span>
        <span>Who</span>
        <span {...stylex.attrs(s.end)}>Upd.</span>
      </div>
      <Loading fallback={<div {...stylex.attrs(s.scroller)} data-perf="list" aria-busy="true" />}>
        <Rows rows={page().rows} search={props.search} openId={props.openId} onNearEnd={loadMore} />
      </Loading>
    </div>
  );
}

function Rows(props: { rows: IssueRow[]; search: string; openId?: number; onNearEnd: () => void }) {
  let scroller!: HTMLDivElement;
  const v = createVirtualizer({
    count: () => props.rows.length,
    getScrollElement: () => scroller,
    size: ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const visible = createMemo(() => {
    const items = v.items();
    const first = items[0]?.index ?? 0;
    return { first, rows: props.rows.slice(first, first + items.length) };
  });
  // Near the end of what's loaded, ask for the next page. Driven by the window, which the
  // virtualizer moves after its own scroll handling.
  createEffect(
    () => (v.items().at(-1)?.index ?? 0) > props.rows.length - NEAR_END,
    (near) => {
      if (near) props.onNearEnd();
    },
  );

  return (
    <div
      ref={scroller}
      {...stylex.attrs(s.scroller)}
      data-perf="list"
      data-perf-rows={props.rows.length}
    >
      <Show when={props.rows.length > 0} fallback={<p {...stylex.attrs(s.empty)}>No open issues.</p>}>
        <div {...stylex.attrs(s.sizer(v.totalSize()))}>
          {/* One translated wrapper around rows in normal flow: a row that stays in the window
              keeps its DOM node. */}
          <div {...stylex.attrs(s.window(visible().first * ROW_HEIGHT))}>
            <For each={visible().rows}>
              {(r) => <Row r={r} search={props.search} current={props.openId === r.id} />}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function Row(props: { r: IssueRow; search: string; current: boolean }) {
  const r = () => props.r;
  return (
    <a
      href={`/issues/${r().id}${props.search}`}
      noscroll
      data-perf="row"
      data-id={r().id}
      aria-current={props.current ? "page" : undefined}
      {...stylex.attrs(s.row, s.link, props.current && s.current)}
    >
      <StateIcon state={issueState(r())} />
      <span {...stylex.attrs(s.title)}>{r().title}</span>
      <span {...stylex.attrs(s.wide, s.labels)}>
        <For each={r().labels}>
          {(l) => (
            <span {...stylex.attrs(s.pill)} title={l.name}>
              <span {...stylex.attrs(s.dot(`#${l.color}`))} />
              {l.name}
            </span>
          )}
        </For>
      </span>
      {/* Blockers and sub-issue progress fill in with relationships (#94). */}
      <span {...stylex.attrs(s.wide)} />
      <span {...stylex.attrs(s.wide)} />
      <span {...stylex.attrs(s.ref, s.end)}>
        {r().repo}#{r().number}
      </span>
      <span {...stylex.attrs(s.avatars)}>
        <For each={r().assignees.slice(0, 3)}>{(u) => <Avatar login={u.login} />}</For>
      </span>
      <span {...stylex.attrs(s.when, s.end)} title={fullDate(r().updated_at)}>
        {ago(r().updated_at)}
      </span>
    </a>
  );
}

/**
 * A wide list shows every column; a narrow one keeps state, title, number, assignees and age. The
 * list's own width decides, as the issue panel beside it takes part of the screen.
 */
const NARROW = "@container (max-width: 700px)";

const s = stylex.create({
  column: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
  },
  scroller: {
    scrollbarGutter: "stable",
    contain: "strict",
    flexGrow: 1,
    overflowY: "auto",
  },
  sizer: (height: number) => ({
    position: "relative",
    height,
  }),
  window: (y: number) => ({
    transform: `translateY(${y}px)`,
    willChange: "transform",
  }),
  row: {
    paddingInline: 14,
    alignItems: "center",
    boxSizing: "border-box",
    columnGap: 12,
    display: "grid",
    gridTemplateColumns: {
      [NARROW]: "16px minmax(0, 1fr) 96px 40px 30px",
      default: "16px minmax(0, 1fr) 192px 100px 52px 104px 46px 32px",
    },
    whiteSpace: "nowrap",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    height: ROW_HEIGHT,
  },
  head: {
    scrollbarGutter: "stable",
    overflow: "hidden",
    color: colors.muted,
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    height: 26,
  },
  link: {
    textDecoration: "none",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    color: "inherit",
    contain: "strict",
  },
  current: {
    backgroundColor: {
      default: colors.selected,
      ":hover": colors.selected,
    },
  },
  wide: {
    display: {
      [NARROW]: "none",
      default: "flex",
    },
  },
  end: {
    textAlign: "end",
  },
  title: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  labels: {
    gap: 4,
    overflow: "hidden",
  },
  pill: {
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 5,
    paddingInline: 7,
    alignItems: "center",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 11.5,
    height: 18,
  },
  // A dynamic style sets only `color`, painted through currentColor. StyleX 0.19.1's attrs()
  // kebab-cases every key of the inline style, the generated custom properties included, so a
  // multi-word dynamic property sets `--x-background-color` while the compiled rule reads
  // `var(--x-backgroundColor)` (custom properties are case-sensitive) and the colour never
  // applies. Upstream: https://github.com/facebook/stylex/issues/1709, fixed by
  // https://github.com/facebook/stylex/pull/1711 (merged after 0.19.1; drop this once released).
  dot: (color: string) => ({
    borderRadius: "50%",
    backgroundColor: "currentColor",
    color,
    flexShrink: 0,
    height: 8,
    width: 8,
  }),
  ref: {
    overflow: "hidden",
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 12,
    textOverflow: "ellipsis",
  },
  avatars: {
    gap: 2,
    display: "flex",
  },
  when: {
    color: colors.muted,
    fontVariantNumeric: "tabular-nums",
  },
  empty: {
    margin: 0,
    padding: 24,
    color: colors.muted,
  },
});
