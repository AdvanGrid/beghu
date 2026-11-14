// `/terms`: the terms of use during the beta.
import * as stylex from "@stylexjs/stylex";
import { CONTACT, UPDATED } from "./about";
import { page } from "./Layout";

export function Terms() {
  return (
    <article {...stylex.attrs(page.prose)}>
      <h1 {...stylex.attrs(page.h1)}>Terms of use</h1>
      <p {...stylex.attrs(page.muted)}>Last updated {UPDATED}</p>
      <p>By using beghu you agree to these terms.</p>

      <h2 {...stylex.attrs(page.h2)}>The beta</h2>
      <p>
        beghu is in beta and free to use. It may change, break, or lose its copy of your data
        (GitHub keeps the original). Features may be added or removed, and paid plans may come
        later. Nothing will start costing you money without you choosing a plan.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Your account and GitHub</h2>
      <p>
        You sign in with your GitHub account, and GitHub's terms still apply to everything you do
        on GitHub through beghu. Changes you make in beghu are made on GitHub as you, with your
        own permissions. You're responsible for what you do with them.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Fair use</h2>
      <p>
        Don't use beghu to break the law, to get at data you aren't allowed to see, or in a way
        that harms beghu, GitHub or other people using them. Don't try to overload or attack the
        service. We may suspend an account that does.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Your data</h2>
      <p>
        Your issues and comments stay yours. beghu keeps a copy only to show them to you, as the{" "}
        <a href="/privacy" {...stylex.attrs(page.link)}>
          privacy policy
        </a>{" "}
        describes. You can disconnect at any time, which deletes that copy.
      </p>

      <h2 {...stylex.attrs(page.h2)}>No warranty</h2>
      <p>
        beghu is provided as it is, without warranties of any kind. As far as the law allows, we
        aren't liable for any loss that comes from using it or from being unable to use it.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Changes</h2>
      <p>
        We may update these terms. The date at the top says when they last changed, and we'll
        give notice of significant changes in beghu.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Contact</h2>
      <p>
        <a href={`mailto:${CONTACT}`} {...stylex.attrs(page.link)}>
          {CONTACT}
        </a>
      </p>
    </article>
  );
}
