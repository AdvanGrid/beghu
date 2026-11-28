// The claims and their evidence: one background read of the analysis's claims file, started as
// soon as the graph is in (the view's Body), and every place that shows claim text or evidence in
// its own small boundary. While the claims are on their way a place shows a skeleton; if they
// fail, each place says "Couldn't load the evidence" with Retry, and one Retry refetches the one
// file, which resets every place. Nothing retries by itself. The drawing, the walkthrough and the
// counts (from the graph's claim stubs) never wait on them.
import * as stylex from "@stylexjs/stylex";
import { createContext, createEffect, createMemo, createSignal, Errored, For, Loading, Show, useContext, type Accessor } from "solid-js";
import { request } from "../api";
import type { Claims } from "../analysis";
import type { Claim, Evidence } from "../bindings/analysis";
import { Failure } from "../Root";
import type { Model } from "./model";
import { Fold, githubBlob, repoPath, ui } from "./ui";
import { colors, fonts } from "../tokens.stylex";

/** The claims read, shared by every place that shows them. */
export interface ClaimsRead {
  /** The claims by ID: suspends while the file is on its way, throws its failure. */
  byId: Accessor<Map<string, Claim>>;
  /** Fetches the file again: every place's boundary resets. */
  retry: () => void;
  /** Which read is current: changes with each retry and each new claims file (Show it). */
  attempt: Accessor<string>;
}

const ClaimsContext = createContext<ClaimsRead>();

/** Starts the claims' read as soon as `url` (the graph's `claimsUrl`) is known, and again for a new one. */
export function createClaims(url: Accessor<string>): ClaimsRead {
  const [attempt, setAttempt] = createSignal(0);
  // One read per URL and attempt: a failed memo runs again for each new place that reads it,
  // which must not fetch again (no retry loop); only Retry does.
  let read: { url: string; attempt: number; claims: Promise<Map<string, Claim>> } | undefined;
  const byId = createMemo(() => {
    const at = { url: url(), attempt: attempt() };
    if (read?.url !== at.url || read.attempt !== at.attempt) {
      read = { ...at, claims: request<Claims>(at.url).then((file) => new Map(file.claims.map((c) => [c.id, c]))) };
    }
    return read.claims;
  });
  return { byId, retry: () => setAttempt((n) => n + 1), attempt: () => `${url()}#${attempt()}` };
}

export function ClaimsProvider(props: { read: ClaimsRead; children: import("solid-js").Element }) {
  return <ClaimsContext value={props.read}>{props.children}</ClaimsContext>;
}

function useClaims(): ClaimsRead {
  const c = useContext(ClaimsContext);
  if (!c) throw new Error("claims read outside the PR view");
  return c;
}

/**
 * The paths the code evidence of a list of claims shows. Suspends while the claims are on their
 * way and throws their failure, so ask only when the graph alone can't say.
 */
export function useEvidencePaths(): (ids: readonly string[]) => string[] {
  const read = useClaims();
  return (ids) => {
    const map = read.byId();
    return ids.flatMap((id) => map.get(id)?.evidence.flatMap((e) => (e.kind === "code" ? [e.path] : [])) ?? []);
  };
}

/** What a list of claims holds, from the graph's stubs: "2 claims · code ×3". Never waits. */
export function claimCount(m: Model, ids: readonly string[]): string {
  let code = 0;
  let description = 0;
  let issue = 0;
  let undetermined = 0;
  for (const id of ids) {
    const s = m.stubs.get(id);
    if (!s) continue;
    code += s.code;
    description += s.description;
    issue += s.issue;
    if (s.status === "undetermined") undetermined++;
  }
  const parts = [`${ids.length} ${ids.length === 1 ? "claim" : "claims"}`];
  if (code) parts.push(`code ×${code}`);
  if (description) parts.push(`description ×${description}`);
  if (issue) parts.push(`issue ×${issue}`);
  if (undetermined) parts.push(`${undetermined} undetermined`);
  return parts.join(" · ");
}

/**
 * A place's claims: each claim's text, its evidence one fold down. In its own boundary: a
 * skeleton while the claims are on their way, "Couldn't load the evidence" with Retry if they
 * failed.
 */
export function ClaimList(props: { m: Model; ids: readonly string[] }) {
  return (
    <Show when={props.ids.length > 0}>
      <div {...stylex.attrs(s.place)} data-perf="claims">
        <Errored fallback={(err, reset) => <EvidenceFailure error={err()} reset={reset} />}>
          <Loading fallback={<Skeleton n={Math.min(props.ids.length, 3)} />}>
            <Claimed m={props.m} ids={props.ids} />
          </Loading>
        </Errored>
      </div>
    </Show>
  );
}

function Claimed(props: { m: Model; ids: readonly string[] }) {
  const read = useClaims();
  const list = () => {
    const map = read.byId();
    return props.ids.map((id) => map.get(id)).filter((c): c is Claim => c !== undefined);
  };
  return (
    <ul {...stylex.attrs(ui.list)}>
      <For each={list()}>{(c) => <ClaimItem m={props.m} c={c} />}</For>
    </ul>
  );
}

function ClaimItem(props: { m: Model; c: Claim }) {
  const undetermined = () => props.c.status === "undetermined";
  return (
    <li data-perf="claim" data-claim={props.c.id}>
      <Fold
        nested
        summary={
          <>
            <Show when={undetermined()}>
              <span {...stylex.attrs(s.undetermined)}>couldn't determine: </span>
            </Show>
            {props.c.text}{" "}
            <span {...stylex.attrs(ui.muted, ui.small)}>
              ({props.c.evidence.length} {props.c.evidence.length === 1 ? "source" : "sources"})
            </span>
          </>
        }
      >
        <Show when={props.c.lookedAt}>{(l) => <p {...stylex.attrs(ui.p, ui.muted, ui.small)}>Looked at: {l()}</p>}</Show>
        <For each={props.c.evidence}>{(e) => <EvidenceItem m={props.m} e={e} />}</For>
      </Fold>
    </li>
  );
}

/**
 * What a walk's source chip opens (#183), under the paragraph: for `description` or one issue
 * (`issue`, `owner/repo#N`), each quote with the claim it backs; for `code`, each claim with code
 * evidence and its lines, shown. In its own boundary, as `ClaimList`.
 */
export function SourceBox(props: { m: Model; ids: readonly string[]; kind: "description" | "issue" | "code"; issue?: string }) {
  return (
    <div {...stylex.attrs(s.place, s.box)} data-perf="source-box" data-kind={props.kind}>
      <Errored fallback={(err, reset) => <EvidenceFailure error={err()} reset={reset} />}>
        <Loading fallback={<Skeleton n={Math.min(props.ids.length, 3)} />}>
          <Sourced {...props} />
        </Loading>
      </Errored>
    </div>
  );
}

function Sourced(props: { m: Model; ids: readonly string[]; kind: "description" | "issue" | "code"; issue?: string }) {
  const read = useClaims();
  const claims = () => {
    const map = read.byId();
    return props.ids.map((id) => map.get(id)).filter((c): c is Claim => c !== undefined);
  };
  const matches = (e: Evidence) => e.kind === props.kind && (e.kind !== "issue" || props.issue === undefined || `${e.repo}#${e.number}`.toLowerCase() === props.issue.toLowerCase());
  const items = () => claims().flatMap((c) => c.evidence.filter(matches).map((e) => ({ c, e })));
  return (
    <Show
      when={props.kind === "code"}
      fallback={
        <ul {...stylex.attrs(ui.list)}>
          <For each={items()}>
            {(x) => (
              <li data-perf="source-quote" data-claim={x.c.id}>
                <EvidenceItem m={props.m} e={x.e} />
                <p {...stylex.attrs(ui.p, ui.small)}>
                  <span {...stylex.attrs(ui.muted)}>It backs: </span>
                  {x.c.text}
                </p>
              </li>
            )}
          </For>
        </ul>
      }
    >
      <ul {...stylex.attrs(ui.list)}>
        <For each={claims().filter((c) => c.evidence.some(matches))}>
          {(c) => (
            <li {...stylex.attrs(ui.stack)} data-perf="source-claim" data-claim={c.id}>
              <p {...stylex.attrs(ui.p)}>
                <Show when={c.status === "undetermined"}>
                  <span {...stylex.attrs(s.undetermined)}>couldn't determine: </span>
                </Show>
                {c.text}
              </p>
              <For each={c.evidence.filter(matches)}>{(e) => <EvidenceItem m={props.m} e={e} />}</For>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** One piece of evidence: code at its exact SHA, or a quote with its source. */
function EvidenceItem(props: { m: Model; e: Evidence }) {
  const g = props.m.g;
  return (
    <div {...stylex.attrs(s.evidence)} data-perf="evidence" data-kind={props.e.kind}>
      <Show when={props.e.kind === "code" && props.e} fallback={<Quote m={props.m} e={props.e} />}>
        {(code) => {
          const sha = () => (code().side === "base" ? g.mergeBase : g.headSha);
          const lines = () => code().snippet.split("\n");
          return (
            <>
              <div {...stylex.attrs(ui.row, ui.small)}>
                <span {...stylex.attrs(s.side)}>{code().side === "base" ? "before" : "after"}</span>
                <a
                  href={`${githubBlob(g.repo, sha(), code().path)}#L${code().start}-L${code().end}`}
                  target="_blank"
                  rel="noreferrer external"
                  {...stylex.attrs(ui.link, ui.mono)}
                  data-perf="evidence-link"
                >
                  {code().path}:{code().start}
                  {code().end !== code().start ? `–${code().end}` : ""} ↗
                </a>
                <span {...stylex.attrs(ui.muted)} data-perf="checked">
                  {g.snippets === "checked" ? "checked by the uploader's tool" : "not checked"}
                </span>
              </div>
              <Show when={code().note}>
                <p {...stylex.attrs(ui.p, ui.muted, ui.small)}>{code().note}</p>
              </Show>
              <pre {...stylex.attrs(s.pre)}>
                <For each={lines()}>
                  {(line, i) => (
                    <div {...stylex.attrs(s.line)}>
                      <span {...stylex.attrs(s.lineNo)} aria-hidden="true">
                        {code().start + i()}
                      </span>
                      {line}
                    </div>
                  )}
                </For>
              </pre>
            </>
          );
        }}
      </Show>
    </div>
  );
}

function Quote(props: { m: Model; e: Evidence }) {
  const source = () => {
    const e = props.e;
    if (e.kind === "issue") return { text: `${e.repo}#${e.number}`, href: `https://github.com/${repoPath(e.repo)}/issues/${e.number}` };
    return { text: "the PR's description", href: undefined };
  };
  const quote = () => (props.e.kind === "code" ? "" : props.e.quote);
  return (
    <>
      <div {...stylex.attrs(ui.row, ui.small)}>
        <span {...stylex.attrs(ui.muted)}>Quoted from</span>
        <Show when={source().href} fallback={<span>{source().text}</span>}>
          {(href) => (
            <a href={href()} target="_blank" rel="noreferrer external" {...stylex.attrs(ui.link)}>
              {source().text} ↗
            </a>
          )}
        </Show>
      </div>
      <blockquote {...stylex.attrs(s.quote)}>{quote()}</blockquote>
      <Show when={props.e.note}>
        <p {...stylex.attrs(ui.p, ui.muted, ui.small)}>{props.e.note}</p>
      </Show>
    </>
  );
}

/** While the claims are on their way: a line per claim, at most three. */
function Skeleton(props: { n: number }) {
  return (
    <div {...stylex.attrs(ui.stack)} aria-busy="true" data-perf="claims-loading">
      <For each={Array.from({ length: props.n }, (_, i) => i)}>{() => <div {...stylex.attrs(s.bone)} />}</For>
    </div>
  );
}

/**
 * The claims didn't load: Retry refetches the one file, which resets every place; so does a new
 * file (Show it's newer analysis).
 */
function EvidenceFailure(props: { error: unknown; reset: () => void }) {
  const read = useClaims();
  createEffect(read.attempt, (now, prev) => {
    if (prev !== undefined && now !== prev) props.reset();
  });
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(ui.p, ui.small, ui.muted)} role="alert" data-perf="claims-failed">
        Couldn't load the evidence ·{" "}
        <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={() => read.retry()}>
          Retry
        </button>
      </p>
    </Failure>
  );
}

const s = stylex.create({
  place: { marginTop: 2 },
  box: {
    padding: 8,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.bgRaised,
    marginTop: 6,
  },
  undetermined: { color: colors.warn, fontWeight: 600 },
  evidence: { gap: 4, display: "flex", flexDirection: "column", marginBottom: 6 },
  side: {
    borderRadius: 4,
    paddingInline: 5,
    backgroundColor: colors.bgRaised,
    color: colors.muted,
    fontSize: 11,
  },
  pre: {
    margin: 0,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 6,
    backgroundColor: colors.bgRaised,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 1.5,
    overflowX: "auto",
  },
  line: { paddingInlineEnd: 8, whiteSpace: "pre" },
  lineNo: {
    paddingInline: 8,
    color: colors.muted,
    display: "inline-block",
    textAlign: "end",
    userSelect: "none",
    minWidth: 32,
  },
  quote: {
    margin: 0,
    paddingBlock: 2,
    borderInlineStartColor: colors.line,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 3,
    lineHeight: 1.45,
    paddingInlineStart: 8,
    whiteSpace: "pre-wrap",
  },
  bone: { borderRadius: 4, backgroundColor: colors.hover, height: 14, width: "80%" },
});
