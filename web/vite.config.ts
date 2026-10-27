// The dev server and the production build. `./dev-ctl start` runs Vite with BEGHU_SERVER pointing
// at the beghu server, which answers everything that isn't the web app.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "@solidjs/vite-plugin";
import stylex from "@stylexjs/unplugin";

const server = process.env.BEGHU_SERVER ?? "http://localhost:3000";
const proxy = Object.fromEntries(
  ["/api", "/auth", "/healthz", "/readyz", "/webhook"].map((path) => [path, { target: server }]),
);

const PRELOAD = "<!--beghu:preload-->";
const THEME = "<!--beghu:theme-->";

/**
 * The same preloads the server's shell writes for a URL (crates/server/src/shell.rs): the data,
 * and on an issue's URL the panel's code, which Vite serves from its source path in dev.
 */
function preloads(url: string): string {
  const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  const path = url.includes("?") ? url.slice(0, url.indexOf("?")) : url;
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  // In the canonical form the app fetches (leading zeros dropped), and only for an id in range.
  const digits = /^\/issues\/(\d+)$/.exec(path)?.[1];
  const id = digits === undefined ? undefined : BigInt(digits);
  const issue = id !== undefined && id <= 2n ** 63n - 1n ? [`/api/issues/${id}`] : [];
  const data = ["/api/me", "/api/facets", `/api/issues${q.length > 1 ? q : ""}`, ...issue]
    .map((href) => `<link rel="preload" href="${attr(href)}" as="fetch" crossorigin>`)
    .join("");
  const panel = /^\/issues\/[^/]+$/.test(path) ? '<link rel="modulepreload" crossorigin href="/src/IssuePanel.tsx">' : "";
  return data + panel;
}

/**
 * The shell: theme.js inlined in both dev and the build. In dev, Vite serves the shell, so it
 * also fills in the per-URL preloads (and the StyleX dev stylesheet); the build keeps the
 * preload marker for the server.
 */
function shell(): Plugin {
  const theme = () => `<script>${readFileSync(new URL("./theme.js", import.meta.url), "utf8")}</script>`;
  return {
    name: "beghu-shell",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        let out = html.replace(THEME, theme());
        if (ctx.server) {
          out = out
            .replace(PRELOAD, preloads(ctx.originalUrl ?? "/"))
            .replace("</head>", '<link rel="stylesheet" href="/virtual:stylex.css" /></head>')
            .replace("</body>", '<script type="module" src="/@id/virtual:stylex:runtime"></script></body>');
        }
        return out;
      },
    },
  };
}

/**
 * In dev, a file rewritten with the content it already had updates nothing. `cargo test`
 * rewrites every file in `src/bindings/` (ts-rs exports them whole, changed or not), and Vite
 * took each rewrite for an edit: every open page reloaded or swapped modules mid-use, which broke
 * e2e tests whenever cargo test ran beside them. Each module's source is noted as it's first
 * served; an update whose source is the same is dropped.
 */
function unchangedUpdatesNothing(): Plugin {
  const seen = new Map<string, string>();
  return {
    name: "beghu-unchanged-updates-nothing",
    apply: "serve",
    enforce: "pre",
    transform(_code, id) {
      const file = id.split("?")[0]!;
      if (file.startsWith("/") && !file.includes("/node_modules/") && !seen.has(file)) {
        try {
          seen.set(file, readFileSync(file, "utf8"));
        } catch {
          // Not a file on disk (a virtual module).
        }
      }
    },
    hotUpdate: {
      order: "pre",
      async handler({ type, file, read }) {
        if (type !== "update" || !seen.has(file)) return;
        const now = await read();
        if (now === seen.get(file)) return [];
        seen.set(file, now);
      },
    },
  };
}

/**
 * `.br` and `.gz` next to each built asset, at maximum compression, for the server to send as
 * they are (crates/server/src/lib.rs). The edge passes encodings through, so these are the bytes
 * on the wire. A sibling that wouldn't be smaller isn't written.
 */
function precompress(): Plugin {
  return {
    name: "beghu-precompress",
    apply: "build",
    writeBundle(options, bundle) {
      const dir = options.dir ?? "dist";
      for (const name of Object.keys(bundle)) {
        if (!name.startsWith("assets/") || !/\.(js|css|svg|json|txt)$/.test(name)) continue;
        const raw = readFileSync(join(dir, name));
        const br = brotliCompressSync(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        });
        const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
        if (br.length < raw.length) writeFileSync(join(dir, `${name}.br`), br);
        if (gz.length < raw.length) writeFileSync(join(dir, `${name}.gz`), gz);
      }
    },
  };
}

/**
 * Fails the build if the shell links a same-origin file production doesn't serve: the server
 * mounts only `/assets/` (crates/server/src/lib.rs), so a file in `public/` would be a 404 there
 * even though Vite serves it in dev.
 */
function onlyAssets(): Plugin {
  return {
    name: "beghu-only-assets",
    apply: "build",
    writeBundle(options) {
      const html = readFileSync(join(options.dir ?? "dist", "index.html"), "utf8");
      const urls = [...html.matchAll(/\s(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]!);
      const outside = urls.filter((u) => !u.startsWith("/assets/") && !u.startsWith("/api/"));
      if (outside.length) this.error(`index.html links ${outside.join(", ")}, which production doesn't serve`);
    },
  };
}

/**
 * Keeps first-load JS in one file. Everything the entry reaches through static imports goes in
 * the entry chunk, so only code reached solely through a dynamic import (the issue panel, the
 * router's forms support) is split off. Without this, Rolldown hoists the code those lazy chunks
 * share with the entry into a common chunk: a second first-load request that also compresses
 * worse than one file. `test` is the code-splitting group's test; the plugin fills its set, and
 * fails the build if the set came out empty or the entry chunk still imports another chunk
 * statically (either means the grouping silently stopped working).
 */
function firstLoadInEntry(): { plugin: Plugin; test: (id: string) => boolean } {
  const entryGraph = new Set<string>();
  return {
    test: (id) => entryGraph.has(id),
    plugin: {
      name: "beghu-first-load-in-entry",
      apply: "build",
      buildEnd() {
        entryGraph.clear();
        const todo = [...this.getModuleIds()].filter((id) => this.getModuleInfo(id)?.isEntry);
        for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
          if (entryGraph.has(id)) continue;
          entryGraph.add(id);
          todo.push(...(this.getModuleInfo(id)?.importedIds ?? []));
        }
        if (entryGraph.size === 0) this.error("first-load-in-entry: found no modules reachable from the entry");
      },
      generateBundle(_options, bundle) {
        const entries = Object.values(bundle).filter((c) => c.type === "chunk" && c.isEntry);
        if (entries.length === 0) this.error("first-load-in-entry: the build has no entry chunk");
        for (const c of entries) {
          if (c.type === "chunk" && c.imports.length > 0) {
            this.error(`first-load-in-entry: entry ${c.fileName} statically imports ${c.imports.join(", ")}: first-load JS is split`);
          }
        }
      },
    },
  };
}

const firstLoad = firstLoadInEntry();

export default defineConfig({
  plugins: [unchangedUpdatesNothing(), stylex.vite({ devMode: "full" }), solid(), shell(), precompress(), onlyAssets(), firstLoad.plugin],
  // The router's Solid server functions support, which beghu (a Rust server) never uses: kept
  // out of first-load JS (see src/no-server-functions.ts). Exact match only, so the router's
  // lazy `…/server-functions/server` import is untouched.
  resolve: {
    alias: [
      {
        find: /^@solidjs\/web\/server-functions$/,
        replacement: fileURLToPath(new URL("./src/no-server-functions.ts", import.meta.url)),
      },
    ],
  },
  // Every bare import the app's code reaches, pre-bundled at startup. Vite's scan of index.html
  // misses the ones that only show up once a plugin has transformed a module (StyleX's runtime,
  // Solid's refresh, the list's virtualizer): it found those on the first page loads instead,
  // bundled them again and reloaded every open tab, mid-test on a fresh `./dev-ctl start`.
  // @solidjs/router ships JSX, which the Solid plugin compiles as source.
  optimizeDeps: { include: ["solid-js", "solid-js/refresh", "@solidjs/web", "@stylexjs/stylex", "@tanstack/virtual-core"] },
  server: { proxy, strictPort: true },
  build: {
    target: ["chrome123", "firefox120", "safari17.5"],
    // Every target supports <link rel="modulepreload">: no polyfill in first-load JS.
    modulePreload: { polyfill: false },
    manifest: true,
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: "index", test: firstLoad.test }] } } },
  },
});
