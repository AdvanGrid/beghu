# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting:
[open a draft advisory](https://github.com/AdvanGrid/beghu/security/advisories/new) (the
repository's Security tab, "Report a vulnerability"). Please don't open a public issue, pull
request or discussion about it.

Say what's affected, how to reproduce it, and what an attacker gains. We'll acknowledge the
report, keep you posted in the advisory while we fix it, and credit you when it's published,
unless you'd rather not be named.

## Scope

- beghu as deployed at `https://beghu.dev`, and the code in this repository: the server, the web
  app, and the image published to `ghcr.io/advangrid/beghu` (`docs/deploy.md`, "The image").
- The publish workflow and anything else that decides what goes into that image: the workflows,
  the `Dockerfile`, the dependency gates (`deny.toml`, `supply-chain/`).

Testing against `beghu.dev` must stay within your own GitHub account and repositories: don't read
or change other people's data, and don't degrade the service for others (no load or denial-of-service
testing). Run your own instance (`./dev-ctl start`, with Fake GitHub, needs no GitHub account) for
anything heavier.

Out of scope: GitHub itself (report those to [GitHub's bug bounty](https://bounty.github.com/)),
and the dev and test keys committed on purpose (`crates/fake-github/src/dev-app-key.pem` and the
others `.gitleaks.toml` allows). They're public by design, and beghu accepts the dev App key only
against a loopback GitHub API, which is to say Fake GitHub.
