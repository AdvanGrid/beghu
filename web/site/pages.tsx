// The public site's pages: each one's path, file, title, description and body. The build
// (site/build.ts) prerenders every page listed here and lists them in the sitemap; the server
// (crates/server/src/site.rs) serves them at their paths. A path can't be one the server answers
// itself (`/issues`, `/api`, `/auth`, …).
import type { JSX } from "@solidjs/web";
import { Landing } from "./Landing";
import { Pricing } from "./Pricing";
import { Privacy } from "./Privacy";
import { Terms } from "./Terms";

export interface Page {
  path: string;
  /** The file under `site/` in the build. */
  file: string;
  title: string;
  description: string;
  Body: () => JSX.Element;
}

export const PAGES: Page[] = [
  {
    path: "/",
    file: "index.html",
    title: "beghu: a fast frontend for GitHub issues",
    description:
      "beghu mirrors the GitHub repos you work in, so filtering, searching and opening issues is instant. Live updates, sub-issue trees, blockers and GitHub's keyboard shortcuts.",
    Body: Landing,
  },
  {
    path: "/pricing",
    file: "pricing.html",
    title: "Pricing · beghu",
    description: "beghu is free while it's in beta.",
    Body: Pricing,
  },
  {
    path: "/privacy",
    file: "privacy.html",
    title: "Privacy policy · beghu",
    description: "What beghu keeps about you and your GitHub issues, why, and when it's deleted.",
    Body: Privacy,
  },
  {
    path: "/terms",
    file: "terms.html",
    title: "Terms of use · beghu",
    description: "The terms of using beghu during its beta.",
    Body: Terms,
  },
];
