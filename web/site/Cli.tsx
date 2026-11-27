// `/cli`: the beghu CLI, for an engineer about to install it. Each deployment serves its own build
// of it, from the same commit as the server, so the install line names this deployment's origin
// (filled in from BEGHU_PUBLIC_URL as every page's canonical URL is: crates/server/src/site.rs),
// and so does `beghu login`, unless this is the hosted beghu, the CLI's default.
// Each statement here describes what the CLI and the server do: change it with the code.
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex";
import { HOST_FLAG, ORIGIN, page } from "./Layout";

/** A command, on a line of its own. */
function Cmd(props: { children: string }) {
  return <pre {...stylex.attrs(s.pre)}>{props.children}</pre>;
}

/** A command or name inline. */
function C(props: { children: string }) {
  return <code {...stylex.attrs(s.code)}>{props.children}</code>;
}

export function Cli() {
  return (
    <article {...stylex.attrs(page.prose)}>
      <h1 {...stylex.attrs(page.h1)}>The beghu CLI</h1>
      <p {...stylex.attrs(page.lead)}>
        Analyse a pull request from your agent's shell: <C>beghu analyse owner/repo#123</C> hands the agent its
        instructions and tools, and uploads what it builds to beghu's PR view.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Install</h2>
      <Cmd>{`curl -fsSL ${ORIGIN}/cli/install.sh | sh`}</Cmd>
      <p>
        It installs <C>beghu</C> to <C>~/.local/bin</C>, or to <C>$BEGHU_INSTALL_DIR</C>, with no sudo, and checks the download against this
        beghu's SHA-256 for it. There are builds for Linux (x86_64 and aarch64, static) and macOS (Apple silicon and Intel). On Windows, run the same
        line inside WSL: there is no native Windows build.
      </p>
      <p>
        Every beghu deployment serves its own CLI, built from the same commit as the server, so the CLI you install always matches the beghu you use.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Sign in</h2>
      <Cmd>{`beghu login${HOST_FLAG}`}</Cmd>
      <p>
        It opens beghu in your browser, which shows the machine's name and a short code: check the code matches the one in your terminal, then
        Approve. Over SSH, or with <C>--no-browser</C>, it prints the link and the code to open on any device where you're signed in to beghu. With
        several GitHub accounts signed in to beghu, choose which one the CLI acts as there. beghu never hands the CLI a GitHub token.
      </p>
      <p>
        <C>--name</C> names the machine (its hostname by default); the setup page lists each one under "CLI sign-ins", with when it was last used and
        Revoke. Another beghu deployment: <C>beghu login --host https://beghu.example.com</C>. The CLI keeps one sign-in per host, and uses the last
        one you signed in to unless <C>--host</C> says otherwise.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Analyse a pull request</h2>
      <Cmd>{"beghu analyse owner/repo#123"}</Cmd>
      <p>
        Run it from your agent, or tell your agent to run it: it starts an analysis run (replacing any run of yours on that PR), writes the run's files
        to <C>.beghu/run-&lt;id&gt;/</C> in the current folder, and prints the PR's size and then the instructions, which the agent follows to the
        end. The agent uses these, from the same folder:
      </p>
      <ul>
        <li>
          <C>beghu analyse check analysis.json</C>: the full validator, every quoted snippet checked against the checkouts in <C>base</C> and{" "}
          <C>head</C>.
        </li>
        <li>
          <C>beghu analyse check-split split.json</C> and <C>beghu analyse merge</C>: the tools for a PR split across several agents.
        </li>
        <li>
          <C>beghu analyse upload analysis.json</C>: checks again, refuses on any error, then uploads.
        </li>
        <li>
          <C>beghu analyse end</C>: ends the run.
        </li>
      </ul>
      <p>
        <C>--yes</C> lets the agent go on past its checkpoint without asking you; <C>--max-areas N</C> stops a large PR early when it would need more
        than N agents. A large PR can take an hour.
      </p>

      <h2 {...stylex.attrs(page.h2)}>The other commands</h2>
      <ul>
        <li>
          <C>beghu status</C>: the host, your GitHub account and when the sign-in expires, this CLI's version and build, and the host's build and
          the oldest CLI it answers.
        </li>
        <li>
          <C>beghu logout</C> signs this machine out on the server, then forgets it; <C>--all</C> does so for every host.
        </li>
        <li>
          <C>beghu --version</C>: the version and the commit it was built from.
        </li>
      </ul>

      <h2 {...stylex.attrs(page.h2)}>In CI and containers</h2>
      <p>
        Set <C>BEGHU_TOKEN</C> to a token <C>beghu login</C> stored, and <C>BEGHU_HOST</C> to the beghu it's for: they go before the credentials file.
        The CLI sends <C>BEGHU_TOKEN</C> only to that host, and refuses it without <C>BEGHU_HOST</C>. It's the same kind of credential, listed and
        revoked on the setup page like any other.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Where the sign-ins live</h2>
      <p>
        In <C>~/.local/state/beghu/credentials.toml</C> on Linux (<C>$XDG_STATE_HOME/beghu/</C> when that's set) and{" "}
        <C>~/Library/Application Support/beghu/credentials.toml</C> on macOS, readable only by you. Not in <C>~/.config</C>, which is often kept in
        git, and not in a keychain, which is missing over SSH, in containers and in CI. A sign-in can only start analysis runs and act within them. It
        expires after 90 days without use, and goes with your account if it's unused for 30 days or disconnected. Signing out in the browser leaves
        it, so CI keeps working. Revoking it on the setup page takes effect on its next call.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Updating</h2>
      <Cmd>{"beghu update"}</Cmd>
      <p>
        It installs exactly the host's build, newer or older. You rarely need to: when beghu needs a newer CLI than yours, the CLI updates itself from
        the host (if it can write its own file), says so in one line, and carries on with the same command, in the same run. A CLI newer than the host
        only says so, because going older should be your choice. It never checks for updates in the background.
      </p>

      <h2 {...stylex.attrs(page.h2)}>Verifying a binary</h2>
      <p>
        The binaries are part of the beghu image, built from the same commit, and covered by its signed build provenance and SBOM. To check one, find
        the deployment's image (<C>beghu status</C> shows its build: <C>ghcr.io/advangrid/beghu:&lt;build&gt;</C>), verify the image, and compare
        the binary with the copy inside it:
      </p>
      <Cmd>
        {`gh attestation verify oci://ghcr.io/advangrid/beghu:<build> \\
  --signer-workflow AdvanGrid/beghu/.github/workflows/publish.yml --source-ref refs/heads/main
docker create --name beghu-cli ghcr.io/advangrid/beghu:<build>
docker cp beghu-cli:/app/cli/linux-x86_64/beghu ./beghu-from-image && docker rm beghu-cli
sha256sum ./beghu-from-image ~/.local/bin/beghu`}
      </Cmd>
      <p>
        <C>{`${ORIGIN}/cli/manifest.json`}</C> lists the SHA-256 of every build this beghu serves.
      </p>
    </article>
  );
}

const s = stylex.create({
  pre: {
    padding: 12,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.bgRaised,
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 14,
    overflowX: "auto",
  },
  code: {
    fontFamily: fonts.mono,
    fontSize: "0.92em",
  },
});
