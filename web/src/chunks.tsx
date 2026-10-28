// A lazily loaded piece of the issue panel (a picker, an editor) that didn't load: shared by the
// panel and its relationship sections, in the panel's chunk.
import * as stylex from "@stylexjs/stylex";
import { Show, untrack } from "solid-js";
import { useLocation } from "@solidjs/router";
import { link } from "./bits";
import { reloadOnce } from "./Root";
import { ChunkFailed } from "./router";
import { colors } from "./tokens.stylex";

/**
 * A picker's or an editor's code didn't load: the URL reloads once (a deploy that replaced the
 * build is the usual cause, and a fresh page names the new chunks), then it says so with Retry.
 */
export function ChunkFailure(props: { error: unknown; reset: () => void; what?: string }) {
  const location = useLocation();
  // Decided once, as the failure shows: a reload leaves the page, and Retry must not flash first.
  const chunk = untrack(() => props.error instanceof ChunkFailed);
  const reloading = chunk && reloadOnce(location.pathname + location.search + location.hash);
  return (
    <Show when={!reloading}>
      <span {...stylex.attrs(s.muted)} role="alert">
        Couldn't load the {props.what ?? "picker"}
        {chunk ? "; beghu may have been updated" : ""} ·{" "}
        <button type="button" {...stylex.attrs(link.button)} onClick={() => props.reset()}>
          Retry
        </button>
      </span>
    </Show>
  );
}

const s = stylex.create({
  muted: {
    color: colors.muted,
    fontWeight: 400,
  },
});
