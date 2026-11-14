// The landing page (`/`): what beghu is, how it works, and what it's good at.
import * as stylex from "@stylexjs/stylex";
import { For } from "solid-js";
import { colors } from "../src/tokens.stylex";
import { page } from "./Layout";

const STEPS = [
  {
    title: "Sign in with GitHub",
    text: "beghu uses your own GitHub account. There is no new password and nothing to invite your team to.",
  },
  {
    title: "Install the App and pick repos",
    text: "Install the beghu GitHub App on the repos you work in, then choose which of them beghu syncs. It copies their issues, pull requests and comments once, then keeps the copy current.",
  },
  {
    title: "Work in a fast list",
    text: "Filter, search, sort and open issues without waiting on GitHub. Changes made on GitHub, by you, a teammate or an agent using the gh CLI, show up within a second or two.",
  },
];

const FEATURES = [
  {
    title: "Fast on an old laptop",
    text: "Every filter, search and sort runs on the server and comes back as a small page of rows. The browser only holds what's on screen, so 20,000 issues feel the same as 200.",
  },
  {
    title: "Live, without the jumps",
    text: "When something changes on GitHub, the list and the open issue update by themselves. Rows never move under your pointer while you're about to click one.",
  },
  {
    title: "Sub-issues, blockers and related issues",
    text: "See a Tree of sub-issues across repos, what blocks what, and what relates to what. Reorder and re-parent by dragging, and edit relationships in place.",
  },
  {
    title: "The keyboard you already know",
    text: "Keys follow GitHub's shortcuts, and you can rebind any of them.",
  },
  {
    title: "Writes that show at once",
    text: "Edits go to GitHub with your own token and appear straight away. If GitHub refuses one, beghu says so and offers to retry. Nothing gets lost silently.",
  },
  {
    title: "GitHub stays the source of truth",
    text: "beghu's copy of your issues is disposable. Disconnect, and it's deleted. Come back, and it's rebuilt from GitHub.",
  },
];

export function Landing() {
  return (
    <>
      <section {...stylex.attrs(page.section, s.hero)}>
        <h1 {...stylex.attrs(page.h1, s.title)}>GitHub issues, without the wait.</h1>
        <p {...stylex.attrs(page.lead)}>
          beghu is a fast frontend for GitHub issues, built for people who live in issues all day.
          It mirrors the repos you work in, so filtering, searching and opening issues happen
          instantly. GitHub stays the source of truth.
        </p>
        <p {...stylex.attrs(s.actions)}>
          <a href="/auth/login" {...stylex.attrs(page.button)}>
            Sign in with GitHub
          </a>
          <span {...stylex.attrs(page.muted)}>Free while in beta.</span>
        </p>
      </section>
      <section {...stylex.attrs(page.section, s.band)}>
        <h2 {...stylex.attrs(page.h2, s.bandTitle)}>How it works</h2>
        <ol {...stylex.attrs(s.steps)}>
          <For each={STEPS}>
            {(step) => (
              <li {...stylex.attrs(s.card)}>
                <h3 {...stylex.attrs(page.h3)}>{step.title}</h3>
                <p {...stylex.attrs(s.cardText)}>{step.text}</p>
              </li>
            )}
          </For>
        </ol>
      </section>
      <section {...stylex.attrs(page.section, s.band)}>
        <h2 {...stylex.attrs(page.h2, s.bandTitle)}>What you get</h2>
        <ul {...stylex.attrs(s.grid)}>
          <For each={FEATURES}>
            {(f) => (
              <li {...stylex.attrs(s.card)}>
                <h3 {...stylex.attrs(page.h3)}>{f.title}</h3>
                <p {...stylex.attrs(s.cardText)}>{f.text}</p>
              </li>
            )}
          </For>
        </ul>
      </section>
    </>
  );
}

const s = stylex.create({
  band: {
    paddingBlock: 24,
  },
  bandTitle: {
    marginTop: 0,
  },
  hero: {
    paddingTop: 80,
  },
  title: {
    fontSize: 48,
  },
  actions: {
    gap: 16,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    marginTop: 32,
  },
  steps: {
    margin: 0,
    padding: 0,
    gap: 16,
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  },
  grid: {
    margin: 0,
    padding: 0,
    gap: 16,
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  },
  card: {
    padding: 20,
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.bgRaised,
  },
  cardText: {
    margin: 0,
    color: colors.muted,
  },
});
