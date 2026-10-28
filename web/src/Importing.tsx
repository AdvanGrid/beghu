// What the app says while the account imports: the status slot's progress and the note that
// ends every view. Its own chunk, loaded only once an import is under way (WhileImporting.tsx),
// so a tab that never sees one doesn't carry it. WhileImporting.tsx shows these only while an
// import runs and hands them its status.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import type { ImportPhase } from "./bindings/ImportPhase";
import type { ImportStatus } from "./bindings/ImportStatus";
import { clockTime } from "./time";
import { colors } from "./tokens.stylex";

/** What each phase brings in, as the status slot names it. */
const PHASE: Record<ImportPhase, string> = {
  open_issues: "open issues",
  open_prs: "open PRs",
  open_comments: "comments",
  closed: "closed issues and PRs",
};

/**
 * "Importing open PRs… n of m repos": the phase running and how many of the round's repos are
 * through it, then any repo whose import failed and what GitHub holds the import up with.
 * Between rounds, only the failed repos and when they're tried again, as a time of day: the
 * status only changes when the import does, so a countdown would go stale. An account back from
 * dormancy (unused for 30 days, its data deleted) says why it's importing everything again
 * first: "Re-importing — you've been away a while · open issues… n of m repos".
 */
export function ImportProgress(props: { status: ImportStatus }) {
  const failed = () => props.status.failed.join(", ");
  const waiting = () => props.status.waiting;
  const retry = () => (props.status.retry_at == null ? "" : ` · trying again at ${clockTime(props.status.retry_at)}`);
  return (
    <Show when={props.status.phase} fallback={<>Couldn't import {failed()}{retry()}</>}>
      {(phase) => (
        <>
          {props.status.away ? `Re-importing — you've been away a while · ${PHASE[phase()]}…` : `Importing ${PHASE[phase()]}…`}{" "}
          {props.status.done} of {props.status.of} {props.status.of === 1 ? "repo" : "repos"}
          {props.status.failed.length > 0 ? ` · couldn't import ${failed()}` : ""}
          {waiting() ? ` · ${waiting()}` : ""}
        </>
      )}
    </Show>
  );
}

/** The end of every view while the account imports: what may not be there yet. */
export function StillImportingNote() {
  return (
    <p {...stylex.attrs(s.still)} role="note" data-perf="still-importing">
      Still importing · closed issues, PRs and comments may still be missing.
    </p>
  );
}

const s = stylex.create({
  still: {
    margin: 0,
    paddingBlock: 12,
    paddingInline: 16,
    color: colors.muted,
    fontSize: 12,
  },
});
