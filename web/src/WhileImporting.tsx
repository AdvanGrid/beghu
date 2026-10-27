// What the app says while the account imports, wherever it says it: the status slot's progress
// and the note that ends every view. The words themselves are their own chunk (Importing.tsx),
// loaded once an import is under way.
import { Errored, lazy, Loading, Show, type Accessor, type Element } from "solid-js";
import type { ImportStatus } from "./bindings/ImportStatus";
import { importing } from "./live";

const load = () => import("./Importing");
const ImportProgress = lazy(load, { export: "ImportProgress" });
const StillImportingNote = lazy(load, { export: "StillImportingNote" });

/** Shows what `children` makes of the import's status while the account imports. */
function WhileImporting(props: { children: (status: Accessor<ImportStatus>) => Element }) {
  return (
    <Show when={importing()}>
      {(status) => (
        // A chunk that fails to load leaves nothing, on purpose: the import's words are a
        // courtesy, the app works without them, and a notice in the status slot or at the end of
        // every view would say more about a failed download than the import ever did. The next
        // import (or a reload) tries the chunk again.
        <Errored fallback={null}>
          <Loading fallback={null}>{props.children(status)}</Loading>
        </Errored>
      )}
    </Show>
  );
}

/** The status slot's "Importing open issues… n of m repos". */
export function Importing() {
  return <WhileImporting>{(status) => <ImportProgress status={status()} />}</WhileImporting>;
}

/** The end of every view while the account imports: what may not be there yet. */
export function StillImporting() {
  return <WhileImporting>{() => <StillImportingNote />}</WhileImporting>;
}
