// The detail's relationships (part of the issue panel's chunk): the parent breadcrumb with its
// progress above the title; the Blocks section above the body, blocked by on the left and
// blocking mirrored on the right; Relates to under it; and the Sub-issues section after the body.
// An end in a repo that isn't synced is a stub: "not synced", opening on GitHub (↗).
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import { Avatar, issueState, ProgressRing, StateIcon } from "./bits";
import type { Related } from "./bindings/Related";
import type { Relationships } from "./bindings/Relationships";
import { colors, fonts } from "./tokens.stylex";

/** Where a related issue opens: in the panel, or on GitHub for a stub. */
function hrefOf(r: Related, search: string): string {
  return r.stub ? `https://github.com/${r.owner}/${r.repo}/${r.kind === "pr" ? "pull" : "issues"}/${r.number}` : `/issues/${r.id}${search}`;
}

/** A related issue's title as a link: in the panel, or out to GitHub with ↗. */
function TitleLink(props: { r: Related; search: string }) {
  const stub = () => props.r.stub;
  const closed = () => props.r.state === "closed";
  return (
    <a
      href={hrefOf(props.r, props.search)}
      noscroll
      target={props.r.stub ? "_blank" : undefined}
      rel={props.r.stub ? "noreferrer external" : undefined}
      title={props.r.stub ? `${props.r.title} (not synced: opens on GitHub)` : props.r.title}
      {...stylex.attrs(s.title, stub() && s.stubTitle, closed() && s.struck)}
    >
      {props.r.title}
      {props.r.stub ? " ↗" : ""}
    </a>
  );
}

function NotSynced() {
  return (
    <span {...stylex.attrs(s.stubTag)} title="In a repo beghu doesn't sync: only its title is known">
      not synced
    </span>
  );
}

/** Closed ones sink to the bottom. */
function openFirst(xs: Related[]): Related[] {
  return [...xs].sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed"));
}

/** The parent as a breadcrumb above the title, with its progress. Nothing without a parent. */
export function ParentCrumb(props: { rels: Relationships; search: string }) {
  return (
    <Show when={props.rels.parent}>
      {(p) => (
        <div {...stylex.attrs(s.crumb)} data-perf="parent">
          <span {...stylex.attrs(s.muted)}>↑</span>
          <TitleLink r={p()} search={props.search} />
          <span {...stylex.attrs(s.ref)}>
            {p().repo}#{p().number}
          </span>
          <Show when={p().stub}>
            <NotSynced />
          </Show>
          <Show when={p().progress}>
            {(g) => (
              <span {...stylex.attrs(s.progress)} title={`${g().done} of ${g().total} sub-issues closed, at every level`}>
                <ProgressRing done={g().done} total={g().total} />
                {g().done}/{g().total}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

/**
 * One end of a dependency, on two lines: the title, then the number and who has it ("unassigned"
 * while open). A blocker that is itself blocked says so; so does an issue this one blocks that
 * waits on others too.
 */
function BlockItem(props: { r: Related; side: "blocked_by" | "blocking"; open: boolean; search: string }) {
  const r = () => props.r;
  // On the blocking side this issue is one of its blockers: count the others.
  const others = () => r().blocked_by - (props.side === "blocking" && props.open ? 1 : 0);
  const chain = () => r().state === "open" && others() > 0;
  const right = () => props.side === "blocking";
  const closed = () => r().state === "closed";
  return (
    <div {...stylex.attrs(s.blockItem, right() && s.mirrored, closed() && s.closed)} data-perf="block-item" data-id={r().id}>
      <span {...stylex.attrs(s.icon, right() && s.iconRight)}>
        <StateIcon state={issueState(r())} />
      </span>
      <span {...stylex.attrs(s.line, right() && s.lineRight)}>
        <TitleLink r={r()} search={props.search} />
      </span>
      <span {...stylex.attrs(s.meta, right() && s.metaRight)}>
        <span {...stylex.attrs(s.ref)}>
          {r().repo}#{r().number}
        </span>
        <Show when={r().stub}>
          <NotSynced />
        </Show>
        <Show when={chain()}>
          <span {...stylex.attrs(s.chain)}>{right() ? `also waits on ${others()} more` : `itself blocked by ${others()}`}</span>
        </Show>
        <Show when={!r().stub}>
          <Show
            when={r().assignee}
            fallback={
              <Show when={r().state === "open"}>
                <span {...stylex.attrs(s.nobody)}>unassigned</span>
              </Show>
            }
          >
            {(who) => (
              <span {...stylex.attrs(s.who, right() && s.whoRight)}>
                <Avatar login={who()} size={14} />
                {who()}
              </span>
            )}
          </Show>
        </Show>
      </span>
    </div>
  );
}

function BlockSide(props: { items: Related[]; side: "blocked_by" | "blocking"; open: boolean; search: string }) {
  const items = () => openFirst(props.items);
  const openCount = () => props.items.filter((x) => x.state === "open").length;
  const right = () => props.side === "blocking";
  // A count of open blockers is red.
  const hot = () => props.side === "blocked_by" && openCount() > 0;
  return (
    <div {...stylex.attrs(s.side)} data-perf={props.side}>
      <header {...stylex.attrs(s.sideHead, right() && s.sideHeadRight)}>
        <span {...stylex.attrs(s.heading)}>{right() ? "Blocking" : "Blocked by"}</span>
        <Show when={props.items.length > 0}>
          <span {...stylex.attrs(s.count, hot() && s.hot)}>
            {openCount() === props.items.length ? openCount() : `${openCount()} of ${props.items.length} open`}
          </span>
        </Show>
      </header>
      <For each={items()} keyed={(r) => r.id} fallback={<p {...stylex.attrs(s.empty, right() && s.emptyRight)}>{right() ? "Nothing waits on this" : "Nothing; ready to start"}</p>}>
        {(r) => <BlockItem r={r()} side={props.side} open={props.open} search={props.search} />}
      </For>
    </div>
  );
}

/** Blocked by on the left, blocking mirrored on the right; hidden when there are neither. */
export function Blocks(props: { rels: Relationships; open: boolean; search: string }) {
  return (
    <Show when={props.rels.blocked_by.length > 0 || props.rels.blocking.length > 0}>
      <section aria-label="Blocks" data-perf="blocks" {...stylex.attrs(s.blocks)}>
        <BlockSide items={props.rels.blocked_by} side="blocked_by" open={props.open} search={props.search} />
        <div aria-hidden="true" {...stylex.attrs(s.mid)}>
          <span {...stylex.attrs(s.arrow)}>→</span>
        </div>
        <BlockSide items={props.rels.blocking} side="blocking" open={props.open} search={props.search} />
      </section>
    </Show>
  );
}

/** One related issue on one line: state, title, number, "not synced", progress, who has it. */
function RelRow(props: { r: Related; search: string; progress?: boolean }) {
  const r = () => props.r;
  const closed = () => r().state === "closed";
  return (
    <div {...stylex.attrs(s.relRow, closed() && s.closed)} data-perf="rel-item" data-id={r().id}>
      <StateIcon state={issueState(r())} />
      <TitleLink r={r()} search={props.search} />
      <span {...stylex.attrs(s.ref)}>
        {r().repo}#{r().number}
      </span>
      <Show when={r().stub}>
        <NotSynced />
      </Show>
      <Show when={props.progress && r().progress}>
        {(g) => (
          <span {...stylex.attrs(s.progress)} title={`${g().done} of ${g().total} sub-issues closed, at every level`}>
            <ProgressRing done={g().done} total={g().total} />
            {g().done}/{g().total}
          </span>
        )}
      </Show>
      <Show when={r().assignee}>{(who) => <Avatar login={who()} size={14} />}</Show>
    </div>
  );
}

/** Relates to, under Blocks; hidden when empty. */
export function RelatesTo(props: { rels: Relationships; search: string }) {
  return (
    <Show when={props.rels.relates_to.length > 0}>
      <section aria-label="Relates to" data-perf="relates" {...stylex.attrs(s.relates)}>
        <header {...stylex.attrs(s.sideHead)}>
          <span {...stylex.attrs(s.heading)}>Relates to</span>
        </header>
        <For each={props.rels.relates_to} keyed={(r) => r.id}>
          {(r) => <RelRow r={r()} search={props.search} />}
        </For>
      </section>
    </Show>
  );
}

/** The sub-issues in GitHub's order, with "x of y done" over them and each one's own progress. */
export function SubIssues(props: { rels: Relationships; search: string }) {
  const done = () => props.rels.sub_issues.filter((x) => x.state === "closed").length;
  return (
    <section aria-label="Sub-issues" data-perf="sub-issues">
      <h3 {...stylex.attrs(s.section)}>
        Sub-issues
        <Show when={props.rels.sub_issues.length > 0}>
          <span {...stylex.attrs(s.progress, s.done)} data-perf="sub-progress">
            <ProgressRing done={done()} total={props.rels.sub_issues.length} />
            {done()} of {props.rels.sub_issues.length} done
          </span>
        </Show>
      </h3>
      <div {...stylex.attrs(s.subs)}>
        <For each={props.rels.sub_issues} keyed={(r) => r.id} fallback={<p {...stylex.attrs(s.empty)}>No sub-issues</p>}>
          {(r) => <RelRow r={r()} search={props.search} progress />}
        </For>
      </div>
    </section>
  );
}

const s = stylex.create({
  crumb: {
    gap: 6,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    fontSize: 12.5,
    whiteSpace: "nowrap",
    minHeight: 22,
    paddingBottom: 4,
  },
  muted: {
    color: colors.muted,
  },
  title: {
    overflow: "hidden",
    textDecoration: {
      default: "none",
      ":hover": "underline",
    },
    color: "inherit",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  stubTitle: {
    color: colors.muted,
    fontStyle: "italic",
  },
  struck: {
    textDecoration: "line-through",
  },
  stubTag: {
    borderColor: colors.muted,
    borderRadius: 999,
    borderStyle: "dashed",
    borderWidth: 1,
    paddingInline: 6,
    color: colors.muted,
    flexShrink: 0,
    fontSize: 10.5,
  },
  ref: {
    color: colors.muted,
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontSize: 11.5,
  },
  progress: {
    gap: 3,
    alignItems: "center",
    color: colors.muted,
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
  done: {
    fontWeight: 400,
    paddingInlineStart: 8,
  },
  blocks: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    marginInline: 16,
    paddingBlock: 8,
    paddingInline: 6,
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 18px minmax(0, 1fr)",
    marginBottom: 8,
  },
  mid: {
    alignItems: "center",
    display: "grid",
    justifyItems: "center",
    position: "relative",
  },
  arrow: {
    paddingBlock: 3,
    backgroundColor: colors.bg,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 1,
  },
  side: {
    gap: 2,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  sideHead: {
    gap: 6,
    paddingInline: 4,
    alignItems: "center",
    display: "flex",
    minHeight: 24,
  },
  sideHeadRight: {
    flexDirection: "row-reverse",
  },
  heading: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  count: {
    color: colors.muted,
    fontSize: 11.5,
  },
  hot: {
    color: colors.danger,
    fontWeight: 600,
  },
  empty: {
    margin: 0,
    paddingBlock: 2,
    paddingInline: 4,
    color: colors.muted,
    fontSize: 12,
  },
  emptyRight: {
    textAlign: "end",
  },
  blockItem: {
    padding: 4,
    borderRadius: 6,
    alignItems: "center",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    columnGap: 6,
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr)",
    rowGap: 1,
  },
  // Mirrored: the icon on the outer (right) edge, everything aligned to it.
  mirrored: {
    gridTemplateColumns: "minmax(0, 1fr) 16px",
    textAlign: "end",
  },
  closed: {
    opacity: 0.55,
  },
  icon: {
    display: "flex",
  },
  iconRight: {
    gridColumn: 2,
    gridRow: 1,
  },
  line: {
    display: "flex",
    minWidth: 0,
  },
  lineRight: {
    gridColumn: 1,
    gridRow: 1,
    justifyContent: "flex-end",
  },
  meta: {
    gap: "4px 8px",
    gridColumn: 2,
    alignItems: "center",
    color: colors.muted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 11.5,
    minWidth: 0,
  },
  metaRight: {
    gridColumn: 1,
    flexDirection: "row-reverse",
  },
  chain: {
    color: colors.danger,
  },
  nobody: {
    color: colors.unowned,
  },
  who: {
    gap: 4,
    alignItems: "center",
    display: "inline-flex",
  },
  whoRight: {
    flexDirection: "row-reverse",
  },
  relates: {
    paddingInline: 16,
    paddingBottom: 8,
  },
  relRow: {
    borderRadius: 4,
    gap: 8,
    paddingInline: 4,
    alignItems: "center",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    display: "flex",
    whiteSpace: "nowrap",
    minHeight: 28,
  },
  section: {
    margin: 0,
    paddingBlock: 10,
    paddingInline: 16,
    alignItems: "center",
    backgroundColor: colors.bgRaised,
    display: "flex",
    fontSize: 13,
    fontWeight: 600,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  subs: {
    paddingBlock: 6,
    paddingInline: 12,
  },
});
