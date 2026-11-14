// `/privacy`: what beghu keeps, why, and for how long. Each statement here describes what the
// server does: change it with the code it describes.
import * as stylex from "@stylexjs/stylex";
import { CONTACT, UPDATED } from "./about";
import { page } from "./Layout";

export function Privacy() {
  return (
    <article {...stylex.attrs(page.prose)}>
      <h1 {...stylex.attrs(page.h1)}>Privacy policy</h1>
      <p {...stylex.attrs(page.muted)}>Last updated {UPDATED}</p>
      <p>
        beghu is a frontend for GitHub issues. To be fast it keeps a copy of the GitHub data you
        ask it to sync. This page says what it keeps, why, and when it's deleted.
      </p>

      <h2 {...stylex.attrs(page.h2)}>What beghu keeps</h2>
      <ul>
        <li>
          <strong>Your GitHub account</strong>: its id and login, the repos you chose to sync, and
          your preferences in beghu (such as key bindings).
        </li>
        <li>
          <strong>GitHub tokens</strong>: the access and refresh tokens GitHub issues when you
          sign in, encrypted. beghu uses them to make the changes you make in beghu, and to see
          which repos you can reach.
        </li>
        <li>
          <strong>A copy of your synced repos' issues</strong>: issues, pull requests, comments,
          labels, milestones, assignees and the relationships between issues, as GitHub has them,
          along with the names and avatars of the people involved. This copy is disposable and
          can always be rebuilt from GitHub.
        </li>
        <li>
          <strong>Your browser session</strong>: which GitHub accounts are signed in on a browser.
          beghu stores only a hash of the session's id.
        </li>
      </ul>

      <h2 {...stylex.attrs(page.h2)}>What beghu doesn't do</h2>
      <ul>
        <li>No analytics, no tracking, no ads, and no third-party scripts.</li>
        <li>Your data is never sold or shared for marketing.</li>
        <li>
          Images in issues and comments load through beghu, so the sites hosting them don't see
          your browser.
        </li>
      </ul>

      <h2 {...stylex.attrs(page.h2)}>Cookies</h2>
      <p>
        beghu sets only the cookies it needs to keep you signed in. Your theme choice stays in
        your browser's local storage and is never sent to beghu.
      </p>

      <h2 {...stylex.attrs(page.h2)}>How long it's kept</h2>
      <ul>
        <li>
          The copy of an account's issues is deleted after 30 days without use, when the account
          loses access on GitHub, or when you disconnect it. Using beghu again rebuilds it from
          GitHub.
        </li>
        <li>
          Disconnecting an account (from the account menu) also revokes beghu's access on GitHub
          and deletes its tokens and preferences.
        </li>
        <li>
          beghu backs up its account records, never the copy of your issues, and keeps the
          backups for up to a week.
        </li>
      </ul>

      <h2 {...stylex.attrs(page.h2)}>Who sees it</h2>
      <p>
        Your data goes only to GitHub, which beghu reads from and writes to on your behalf, and
        to the provider that hosts beghu's server. GitHub's own{" "}
        <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement" {...stylex.attrs(page.link)}>
          privacy statement
        </a>{" "}
        covers what GitHub does with it.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Contact</h2>
      <p>
        Questions, or a request to see or delete your data:{" "}
        <a href={`mailto:${CONTACT}`} {...stylex.attrs(page.link)}>
          {CONTACT}
        </a>
        .
      </p>
    </article>
  );
}
