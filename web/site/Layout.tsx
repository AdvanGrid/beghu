// The public site's document: <head> with the page's own title, description, canonical URL and
// Open Graph tags, then a header, the page and a footer. Rendered to static HTML at build time
// (site/build.ts) and never hydrated, so nothing here may rely on running in the browser.
import * as stylex from "@stylexjs/stylex";
import type { JSX } from "@solidjs/web";
import { colors, fonts } from "../src/tokens.stylex";

/** Where the server writes beghu's origin (crates/server/src/site.rs). */
export const ORIGIN = "%BEGHU_ORIGIN%";

/** The files a page links, with the names the build gave them. */
export interface Links {
  css: string;
  icon: string;
  /** web/theme.js, inlined so the theme is set before first paint, as in the app's shell. */
  theme: string;
}

export interface Meta {
  path: string;
  title: string;
  description: string;
}

export function Document(props: { meta: Meta; links: Links; children: JSX.Element }) {
  const url = () => ORIGIN + props.meta.path;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>{props.meta.title}</title>
        <meta name="description" content={props.meta.description} />
        <link rel="canonical" href={url()} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="beghu" />
        <meta property="og:title" content={props.meta.title} />
        <meta property="og:description" content={props.meta.description} />
        <meta property="og:url" content={url()} />
        <meta name="twitter:card" content="summary" />
        <link rel="icon" href={props.links.icon} type="image/svg+xml" />
        <link rel="stylesheet" href={props.links.css} />
        <script innerHTML={props.links.theme} />
      </head>
      <body {...stylex.attrs(s.body)}>
        <header {...stylex.attrs(s.header)}>
          <div {...stylex.attrs(s.bar)}>
            <a href="/" {...stylex.attrs(s.brand)}>
              <img src={props.links.icon} alt="" width="24" height="24" />
              beghu
            </a>
            <span {...stylex.attrs(s.spacer)} />
            <a href="/pricing" {...stylex.attrs(s.navLink)}>
              Pricing
            </a>
            <a href="/issues" {...stylex.attrs(s.open)}>
              Open beghu
            </a>
          </div>
        </header>
        <main {...stylex.attrs(s.main)}>{props.children}</main>
        <footer {...stylex.attrs(s.footer)}>
          <div {...stylex.attrs(s.bar)}>
            <span>beghu</span>
            <span {...stylex.attrs(s.spacer)} />
            <a href="/pricing" {...stylex.attrs(s.footLink)}>
              Pricing
            </a>
            <a href="/privacy" {...stylex.attrs(s.footLink)}>
              Privacy
            </a>
            <a href="/terms" {...stylex.attrs(s.footLink)}>
              Terms
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** A page's width and rhythm, for the pages to share. */
export const page = stylex.create({
  section: {
    marginInline: "auto",
    paddingBlock: 48,
    paddingInline: 20,
    maxWidth: 960,
  },
  prose: {
    marginInline: "auto",
    paddingBlock: 48,
    paddingInline: 20,
    maxWidth: 680,
  },
  h1: {
    marginBlock: 0,
    fontSize: 36,
    letterSpacing: "-0.02em",
    lineHeight: 1.15,
  },
  h2: {
    fontSize: 22,
    letterSpacing: "-0.01em",
    marginBottom: 8,
    marginTop: 36,
  },
  h3: {
    fontSize: 16,
    marginBottom: 6,
    marginTop: 0,
  },
  lead: {
    color: colors.muted,
    fontSize: 19,
    marginBottom: 0,
    marginTop: 16,
    maxWidth: 640,
  },
  muted: {
    color: colors.muted,
  },
  link: {
    color: colors.accent,
  },
  button: {
    borderRadius: 8,
    paddingBlock: 10,
    paddingInline: 18,
    textDecoration: "none",
    backgroundColor: colors.accentBg,
    color: colors.accentFg,
    display: "inline-block",
    fontWeight: 600,
  },
});

const s = stylex.create({
  body: {
    margin: 0,
    backgroundColor: colors.bg,
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    fontFamily: fonts.ui,
    fontSize: 16,
    lineHeight: 1.6,
    minHeight: "100dvh",
  },
  header: {
    backgroundColor: colors.bgRaised,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  bar: {
    gap: 20,
    marginInline: "auto",
    paddingBlock: 12,
    paddingInline: 20,
    alignItems: "center",
    display: "flex",
    maxWidth: 960,
  },
  brand: {
    gap: 8,
    textDecoration: "none",
    alignItems: "center",
    color: colors.fg,
    display: "flex",
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: "-0.01em",
  },
  spacer: {
    flexGrow: 1,
  },
  navLink: {
    textDecoration: "none",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
  },
  open: {
    borderRadius: 6,
    paddingBlock: 6,
    paddingInline: 12,
    textDecoration: "none",
    backgroundColor: colors.accentBg,
    color: colors.accentFg,
    fontWeight: 600,
  },
  main: {
    flexGrow: 1,
  },
  footer: {
    color: colors.muted,
    fontSize: 14,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  footLink: {
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
  },
});
