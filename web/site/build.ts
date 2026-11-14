// The public site's build: compiles site/render.tsx for SSR (Solid's `generate: "ssr"`, not
// hydratable, with StyleX), renders every page to a whole HTML document, and gives StyleX's
// stylesheet and the icon hashed names under assets/. `vite build` runs it after the app's own
// build and writes the result next to it (`site/`, `assets/`); in dev, Vite serves it from
// memory, rebuilt after a change (`sitePlugin`). The server serves the result
// (crates/server/src/site.rs).
//
// It runs as its own Node process (`node site/build.ts <dir>`): StyleX's Vite plugin keeps the
// rules it collects on `globalThis`, so in the app's process the site's stylesheet would take
// in every rule of the app's.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";
import solid from "@solidjs/vite-plugin";
import stylex from "@stylexjs/unplugin";
import { writeCompressedSiblings } from "../compress.ts";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(WEB, "site");
/** Where the server writes beghu's origin (crates/server/src/site.rs, site/Layout.tsx). */
const ORIGIN = "%BEGHU_ORIGIN%";
/** The first path segments the server answers itself (crates/server/src/site.rs). */
const RESERVED = new Set(["issues", "new", "repos", "prefs", "api", "auth", "assets", "webhook", "healthz", "readyz"]);

interface Rendered {
  pages: { path: string; file: string }[];
  render: (path: string, links: { css: string; icon: string; theme: string }) => string;
}

const hashed = (name: string, ext: string, body: string | Buffer) =>
  `assets/${name}-${createHash("sha256").update(body).digest("base64url").slice(0, 8)}.${ext}`;

/** Builds and renders the whole site, by each file's path under the build's output directory. */
async function renderSite(): Promise<Map<string, string | Buffer>> {
  // Inside web/, so the SSR bundle's bare imports (solid-js, @solidjs/web) resolve.
  const scratch = join(WEB, "node_modules", ".beghu-site");
  mkdirSync(scratch, { recursive: true });
  const out = mkdtempSync(join(scratch, "build-"));
  try {
    await build({
      configFile: false,
      root: WEB,
      logLevel: "warn",
      plugins: [stylex.vite({}), solid({ solid: { generate: "ssr", hydratable: false } })],
      build: { ssr: join(SITE, "render.tsx"), outDir: out, emptyOutDir: true, copyPublicDir: false },
    });
    const mod = (await import(pathToFileURL(join(out, "render.js")).href)) as Rendered;
    const cssFile = join(out, "assets", "stylex.css");
    if (!existsSync(cssFile)) throw new Error("the site build wrote no StyleX stylesheet");
    const css = readFileSync(cssFile);
    const icon = readFileSync(join(WEB, "favicon.svg"));
    const links = {
      css: "/" + hashed("site", "css", css),
      icon: "/" + hashed("site-icon", "svg", icon),
      theme: readFileSync(join(WEB, "theme.js"), "utf8"),
    };
    const files = new Map<string, string | Buffer>([
      [links.css.slice(1), css],
      [links.icon.slice(1), icon],
    ]);
    for (const p of mod.pages) {
      const segment = p.path.slice(1);
      if (!p.path.startsWith("/") || !/^[a-z0-9-]*$/.test(segment) || RESERVED.has(segment)) {
        throw new Error(`site page ${p.path}: the server can't serve a page there (crates/server/src/site.rs)`);
      }
      files.set(`site/${p.file}`, mod.render(p.path, links));
    }
    files.set("site/pages.json", JSON.stringify(mod.pages));
    files.set("site/robots.txt", robots());
    files.set("site/sitemap.xml", sitemap(mod.pages.map((p) => p.path)));
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The app is behind sign-in: crawlers get the public site only. */
function robots(): string {
  const app = ["/api/", "/auth/", "/issues", "/new", "/repos", "/prefs"];
  return ["User-agent: *", "Allow: /", ...app.map((p) => `Disallow: ${p}`), "", `Sitemap: ${ORIGIN}/sitemap.xml`, ""].join("\n");
}

function sitemap(paths: string[]): string {
  const urls = paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Writes the site into `dir`, with `.br` and `.gz` siblings for its assets. */
async function writeSite(dir: string): Promise<void> {
  for (const [name, body] of await renderSite()) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    if (name.startsWith("assets/")) writeCompressedSiblings(path);
  }
}

/** Runs this file as its own process, writing the site into `dir`. */
function runSite(dir: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir], { cwd: WEB, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`the site build failed (exit ${code})`))));
  });
}

/** The site as the dev server serves it, by URL path, built afresh into a scratch directory. */
async function devSite(): Promise<Map<string, string | Buffer>> {
  const scratch = join(WEB, "node_modules", ".beghu-site");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "dev-"));
  try {
    await runSite(dir);
    const byUrl = new Map<string, string | Buffer>();
    const pages = JSON.parse(readFileSync(join(dir, "site", "pages.json"), "utf8")) as { path: string; file: string }[];
    for (const p of pages) byUrl.set(p.path, readFileSync(join(dir, "site", p.file), "utf8"));
    for (const name of ["robots.txt", "sitemap.xml"]) byUrl.set(`/${name}`, readFileSync(join(dir, "site", name), "utf8"));
    for (const name of readdirSync(join(dir, "assets"))) {
      if (!/\.(br|gz)$/.test(name)) byUrl.set(`/assets/${name}`, readFileSync(join(dir, "assets", name)));
    }
    return byUrl;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
};

/**
 * The site in the build (written after the app's own build, into the same directory) and in dev
 * (served by Vite's dev server before its own middleware, so `/` is the landing page, not the
 * app's shell).
 */
export function sitePlugin(): Plugin {
  return {
    name: "beghu-site",
    async writeBundle(options) {
      if (this.environment.config.consumer !== "client") return;
      await runSite(resolve(WEB, options.dir ?? "dist"));
    },
    configureServer(server) {
      let built: Promise<Map<string, string | Buffer>> | undefined;
      const stale = (file: string) => {
        if (file.startsWith(SITE) || file.endsWith(".stylex.ts") || file === join(WEB, "theme.js")) built = undefined;
      };
      server.watcher.on("change", stale);
      server.watcher.on("add", stale);
      server.watcher.on("unlink", stale);
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        const path = (req.url ?? "/").split("?")[0]!;
        const page = /^\/([a-z0-9-]*)$/.exec(path);
        const ours =
          (page && !RESERVED.has(page[1]!)) || path === "/robots.txt" || path === "/sitemap.xml" || path.startsWith("/assets/site-");
        if (!ours) return next();
        built ??= devSite();
        built.then(
          (files) => {
            const body = files.get(path);
            if (body === undefined) return next();
            const ext = /\.(\w+)$/.exec(path)?.[1] ?? "html";
            res.setHeader("content-type", TYPES[ext] ?? "application/octet-stream");
            res.setHeader("cache-control", "no-cache");
            const origin = `http://${req.headers.host ?? "localhost"}`;
            res.end(typeof body === "string" ? body.replaceAll(ORIGIN, origin) : body);
          },
          (e: unknown) => {
            built = undefined;
            next(e);
          },
        );
      });
    },
  };
}

// `node site/build.ts <dir>`: what `runSite` starts.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (dir === undefined) throw new Error("usage: node site/build.ts <output directory>");
  await writeSite(resolve(dir));
}
