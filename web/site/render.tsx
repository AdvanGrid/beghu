// The site's server-side entry: the web build compiles it for SSR (site/build.ts) and calls
// `render` once per page. Only HTML comes out: the pages are never hydrated.
import { renderToString } from "@solidjs/web";
import { Document, type Links } from "./Layout";
import { PAGES } from "./pages";

export { ORIGIN } from "./Layout";

/** Each page's path and file, for the build to write and list. */
export const pages = PAGES.map(({ path, file }) => ({ path, file }));

/** The page at `path` as a whole document. */
export function render(path: string, links: Links): string {
  const p = PAGES.find((x) => x.path === path);
  if (!p) throw new Error(`no site page at ${path}`);
  return "<!doctype html>" + renderToString(() => (
    <Document meta={p} links={links}>
      <p.Body />
    </Document>
  ), { noScripts: true });
}
