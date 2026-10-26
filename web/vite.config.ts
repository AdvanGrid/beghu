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

/** The same preloads the server's shell writes for a URL (crates/server/src/shell.rs). */
function preloads(url: string): string {
  const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return ["/api/me", `/api/issues${q.length > 1 ? q : ""}`]
    .map((href) => `<link rel="preload" href="${attr(href)}" as="fetch" crossorigin>`)
    .join("");
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

export default defineConfig({
  plugins: [stylex.vite({ devMode: "full" }), solid(), shell(), precompress(), onlyAssets()],
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
  server: { proxy, strictPort: true },
  build: { target: ["chrome123", "firefox120", "safari17.5"] },
});
