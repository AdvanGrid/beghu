# Contract check: which shapes need real GitHub, and which are writes

Research date: 2026-10-26. Ticket #85. The question: under the revised dev setup (one dev App per
dev, no seed repos, real-GitHub writes only on `AdvanGrid/beghu-sandbox`;
[#77 addendum](https://github.com/AdvanGrid/beghu/issues/77#issuecomment-6410944290)), which of the
shapes the Fake GitHub serves can be checked by reading real data, which need a write on the
sandbox, and which need no real GitHub at all? And what App, credentials, cadence and triggers
does the CI check use?

Sources: the resolution comments of the tickets linked below, docs.github.com (fetched as Markdown
through `https://docs.github.com/api/article/body?pathname=…`, and as HTML where the Markdown drops
the fine-grained permission boxes), and read-only `gh` queries against AdvanGrid repos today. Doc
URLs drop the `https://docs.github.com/en` prefix and are written as `/path`.

Labels: **documented** means a GitHub doc says so; **project** means a measured result in a
beghu ticket; **verified** means a read-only query today; **inferred** means reasoning only.

What exists today: no Fake GitHub crate, no `./dev-ctl`, no `contract` command and no `.github/`
workflows in the repo or on any branch. The only GitHub-side code is `github-app/` (manifest,
`create-app.mjs`, probe scripts). So this file sorts the shapes the Fake GitHub is specified to serve
([#51](https://github.com/AdvanGrid/beghu/issues/51#issuecomment-6332343351)), not code.

## Answers

1. **Most of the contract is reads.** Every import, sweep, detail and feed call is a read with the
   installation token, and AdvanGrid's real repos hold enough data to produce each shape:
   sub-issues, dependencies, cross-repo parents, closing references, reviews and attachments all
   exist (verified, section 1). Webhook payloads are reads too: `GET /app/hook/deliveries/{id}`
   returns the stored `request.payload` of every delivery from the past 3 days, with an App JWT
   (`/rest/apps/webhooks#get-a-delivery-for-an-app-webhook`,
   `/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries`;
   [#41](https://github.com/AdvanGrid/beghu/issues/41#issuecomment-6309546856)). An App installed
   on busy repos collects real `issues`, `issue_comment`, `pull_request`, `sub_issues` and
   `issue_dependencies` deliveries every day without anyone writing anything.
2. **The sandbox is needed for write responses and for rare webhooks.** That covers the v1 write
   ops' status codes and bodies, their error shapes (422 duplicate, 404 on removing a missing
   sub-issue, 403 refusals), and the deliveries that real traffic seldom produces: `issue_relates_to`
   (no relates-to links in the recent 100 issues of `advangrid` or `hermes`), `label`/`milestone`
   edits, `issue_comment.deleted`, `issues.locked`. These writes don't need a user token. A
   response or payload has the same fields whichever App token made the write; only values such as
   `sender` change (inferred). So the write side can run unattended with an installation token
   scoped to `beghu-sandbox`.
3. **No real GitHub needed:** 409 (beghu's own conflict, not GitHub's), rate-limit refusals with
   `retry-after`, 5xx and GitHub being down, webhook drops, duplicates and reordering. Also
   everything that needs a browser or an admin: the web sign-in, install and setup-URL redirects,
   grant revocation, issue deletion, transfer, discussion conversion and repo archiving. These stay
   on recorded fixtures and a by-hand check before releases.
4. **Some writes only need to happen once.** A deleted issue keeps returning 410 and a
   transferred issue's old number keeps returning 301
   ([#35](https://github.com/AdvanGrid/beghu/issues/35#issuecomment-6183709148)), and an uploaded
   attachment stays put. Done once by hand on the sandbox, each of these becomes a read-side check.
5. **CI gets its own App,** `beghu-ci`, registered under AdvanGrid from `github-app/manifest.json`
   and installed on a few busy real repos plus `beghu-sandbox`. Per token, GitHub enforces
   read-only on real repos and writes on the sandbox only (section 2). The read side runs nightly.
   The write side runs weekly, on `workflow_dispatch`, and on pushes to `main` that change the
   Fake GitHub's templates or beghu's GitHub client. The user-token half is a small read set run
   with a machine user's token, and its OAuth success paths stay manual.

## 1. Every shape, sorted

Buckets: **read** = read existing data on an AdvanGrid repo; **sandbox** = needs a write on
`beghu-sandbox`; **none** = no real GitHub (fixture, or by hand before release). "↺" marks a
write shape that can also be read back from deliveries or the feed when real traffic happens to
produce it.

Tokens: **inst** = installation token; **user** = user-to-server token (`ghu_`); **JWT** = App
JWT; **client** = client id/secret; **–** = no token.

Real data seen today (verified, read-only GraphQL over the latest 100 issues and 50 PRs):
`advangrid` (1,120 issues, 1,075 PRs) has 7 parents, 91 children, 24 issues with dependencies and
34 PRs with closing references. `hermes` has 54 children (one under a parent in another repo) and an
`APPROVED` review decision. `adv-website` has 10 PRs with closing references. Neither repo has
relates-to links. `advangrid`'s issue events feed held 100 events from the last 3.5 hours,
including `sub_issue_added`, `blocked_by_added`, `labeled`, `assigned` and `closed`.

### App, install and auth

| Shape | beghu uses it for | Token | Bucket | Why |
|---|---|---|---|---|
| `POST /app/installations/{id}/access_tokens` | installation tokens for import and sweeps | JWT | read | Minting changes no repo data. The body takes `repositories` and `permissions` to narrow a token (`/rest/apps/apps#create-an-installation-access-token-for-an-app`). |
| `GET /app/installations`, `GET /installation/repositories` | installation lookup, installed repo set | JWT / inst | read | Plain reads. |
| `GET /app/hook/deliveries`, `…/{id}` | redelivery job; the contract's payload source | JWT | read | List plus full `request.payload` for the past 3 days (`/rest/apps/webhooks`). Only that App's own deliveries are listed, so CI needs its own App. |
| `POST /app/hook/deliveries/{id}/attempts` | redelivery job | JWT | read | It resends a stored delivery to the App's own URL and changes no repo. Harmless on `beghu-ci`. |
| Install page, setup URL redirect | first run ([#7](https://github.com/AdvanGrid/beghu/issues/7#issuecomment-6183525608)) | – | none | Browser-only. By hand before release. |
| Web flow: authorize and code exchange (success) | sign-in | client → user | none | Needs a person signing in. By hand. |
| Code exchange with a bad code (`bad_verification_code`) | error path | client | read | A garbage code gives the error unattended (`/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app`). |
| Device flow: `POST /login/device/code`, one poll (`authorization_pending`) | dev and probe sign-in ([#78](https://github.com/AdvanGrid/beghu/issues/78#issuecomment-6414672728)) | client | read | Unattended up to the point where a person enters the code. Needs device flow enabled on the App (same page). |
| Refresh `grant_type=refresh_token` (success) | lazy refresh under the per-account lock | client | none* | Single-use: "Once you use a refresh token, that refresh token and the old user access token will no longer work" (`/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens`). CI would have to write the new pair back after every run; see section 2. Devs' own Apps exercise it every 8 h in `--github` mode. |
| Refresh with a bad token (`bad_refresh_token`) | failed refresh → `needs_sign_in` | client | read | A garbage refresh token gives the error unattended (token page above). |
| `DELETE /applications/{client_id}/grant` | Disconnect | client | none | It destroys the grant, and a new browser sign-in follows. By hand. |
| `GET /user` | account identity | user | read | Needs a user token in CI. |
| `GET /user/installations`, `…/{id}/repositories` with `permissions` | visible repo set every 15 min; role source ([#73](https://github.com/AdvanGrid/beghu/issues/73#issuecomment-6418135021)) | user | read | Needs a user token. A machine user with Read on one repo gives a non-admin `permissions` object. |
| GraphQL `viewerPermission`, `viewerCan*` | relationship gating (`>= TRIAGE`) | user | read | Installation tokens describe the bot ([#72](https://github.com/AdvanGrid/beghu/issues/72#issuecomment-6397502856)), so this needs a user token. |

### Import, sweeps and detail reads

All of these run on the installation token ([#36](https://github.com/AdvanGrid/beghu/issues/36#issuecomment-6184026681)),
and all are reads on real data.

| Shape | beghu uses it for | Token | Bucket | Why |
|---|---|---|---|---|
| GraphQL `repository.issues` / `pullRequests` pages (`first:100`, `UPDATED_AT ASC`, labels, assignees, milestone, `parent`, `subIssuesSummary`, `issueDependenciesSummary`, `body`, `headRefName`, `baseRefName`, `reviewDecision`, `closingIssuesReferences`) | import, full sweep ([#6](https://github.com/AdvanGrid/beghu/issues/6#issuecomment-6141381005), [#65](https://github.com/AdvanGrid/beghu/issues/65#issuecomment-6385762132)) | inst | read | `advangrid`/`hermes` hold every field non-null somewhere. Query validity can also be checked against the published `schema.docs.graphql` with no token (`/graphql/overview/public-schema`). |
| GraphQL `nodes(ids:)` edge lists `subIssues`, `blockedBy`, `blocking`, `relatesTo` | edge import, cross-repo relates-to refetch ([#5](https://github.com/AdvanGrid/beghu/issues/5#issuecomment-6140964569)) | inst | read | Relates-to needs one standing link on the sandbox, made once, since real repos have none. |
| GraphQL `nodes(ids:) { comments(first:100) }` | comments phase | inst | read | |
| GraphQL `rateLimit { cost remaining }`, `GET /rate_limit`, `x-ratelimit-*` headers | budget, sweep pause, down probe ([#10](https://github.com/AdvanGrid/beghu/issues/10#issuecomment-6307581734)) | inst | read | On every response. `/rate_limit` doesn't count against the primary limit (`/rest/using-the-rest-api/rate-limits-for-the-rest-api`). |
| REST `issues?state=all&since=&per_page=1` with ETag → 304, then the list | 5-min `since` sweep | inst | read | 304 on an unchanged probe ([#69](https://github.com/AdvanGrid/beghu/issues/69#issuecomment-6396099081)). |
| REST `/issues/comments?since=` | comment sweep, closed-items comments | inst | read | |
| GraphQL `issues { totalCount }`, id sweep over `nodes` | 15-min count check | inst | read | |
| REST `…/issues/{n}/sub_issues` | sub-issue order sweep | inst | read | |
| REST `…/issues/{n}`, `…/comments`, `…/parent`, `…/dependencies/blocked_by\|blocking`, `…/relates_to` | single fetch after a webhook, pre-check GET (ETag) before a title/body patch | inst / user | read | |
| REST `GET /repos/{o}/{r}` (`archived`, `permissions`) | archived flag ([#73](https://github.com/AdvanGrid/beghu/issues/73#issuecomment-6418135021)) | inst / user | read | |
| REST `GET /repos/{o}/{r}/assignees?per_page=100&page=n` with `If-None-Match` → 304 | the assignee picker ([#102](https://github.com/AdvanGrid/beghu/issues/102)): every page, kept per repo with its `ETag` and asked for again on each open | user | read | **Not yet verified on real GitHub.** beghu relies on each page carrying an `ETag`, on a 304 to `If-None-Match` with a user token, and on that 304 not counting against the rate limit (documented for REST in general, measured only on `issues`, see `mirror-import-and-reconciliation.md`). Also unverified: whether another user's token gets a 304 for the same `ETag` (`Vary: Authorization`); a 200 there is correct, only not free. |
| REST `GET …/issues/{n}` after a label write | the issue's `updated_at`, which the labels answer lacks, so the write's echo is a no-op ([#102](https://github.com/AdvanGrid/beghu/issues/102)) | user | read | One extra call per label pick. The same GET with an installation token reads an issue again after a delivery the mirror can't order (same `updated_at`, different content), or after a read that overwrote a row of its own second. |
| REST `GET …/issues/{n}` for a **PR** with an installation token narrowed to `issues: read` | the read-back of a PR whose deliveries can't be ordered (two `issue_comment`s in one second) | inst | read | **To verify on the dev App ([#118](https://github.com/AdvanGrid/beghu/issues/118)).** The permissions page lists the issue endpoints under Issues and, as "additional permissions", Pull requests, but doesn't say whether an issues-only token may read a PR through them. beghu's read-back token asks for `pull_requests: read` too (the App holds it), so either answer works; Fake GitHub doesn't model a refusal. The check records which it is. |
| GraphQL `closingIssuesReferences` on one PR | refetch after a `connected`/`disconnected` feed event | inst | read | |

### Attachments and minted URLs

| Shape | beghu uses it for | Token | Bucket | Why |
|---|---|---|---|---|
| `bodyHTML` (GraphQL, batched `nodes`) / `body_html` (REST, `application/vnd.github.html+json`) holding `private-user-images…?jwt=` | minting image and video URLs ([#62](https://github.com/AdvanGrid/beghu/issues/62#issuecomment-6384974869), [#67](https://github.com/AdvanGrid/beghu/issues/67#issuecomment-6395752320)) | inst / user | read | AdvanGrid repos hold uploader `<img>` and plain `![](…)` attachments, e.g. `advangrid#250`. |
| Minted URL: 200 with no auth, `Range` → 206, 404 after `exp` | attachment route | – | read | Needs a video for the 206 check. The sandbox gets one image, one video and one zip uploaded once by hand, because uploads have no API. |
| Raw `user-attachments/assets/<uuid>` and `files/…` → 404 for App tokens | fact behind the mint path | inst / user | read | |

### Issue events feed

| Shape | beghu uses it for | Token | Bucket | Why |
|---|---|---|---|---|
| `GET /repos/{o}/{r}/issues/events` with ETag → 304; events `connected`, `disconnected`, `sub_issue_*`, `parent_issue_*`, `blocked_by_*`, `blocking_*`, `relates_to_*` | ~2 s poller while a session is live ([#69](https://github.com/AdvanGrid/beghu/issues/69#issuecomment-6396099081), [#70](https://github.com/AdvanGrid/beghu/issues/70#issuecomment-6396519248)) | inst | read | `advangrid` and `hermes` feeds are busy. `relates_to_*` is on the sandbox from #78. `connected`/`disconnected` need a PR, and the CI App has only Pull requests: read, so those are read when they turn up in real feeds, or recorded once by hand. The feed also carries types beghu ignores (`project_v2_item_status_changed`, `issue_type_added`); the check must accept unknown types. |

### Writes (the v1 ops, [#10](https://github.com/AdvanGrid/beghu/issues/10#issuecomment-6307581734))

In prod every write uses the user token. The shapes are the same under an installation token
(inferred: same endpoints, same resource objects, a bot `user`/`sender`), so the sandbox run uses
an installation token scoped to `beghu-sandbox`. Role behaviour (silent drops, partial `PATCH`) is
a separate, user-token concern, verified in
[#78](https://github.com/AdvanGrid/beghu/issues/78#issuecomment-6414672728).

| Shape | Token | Bucket | Why |
|---|---|---|---|
| `POST …/issues` (create with labels, assignee, milestone) → 201 | inst (user in prod) | sandbox | Only a create produces it. The issue object itself is also read-side. |
| `POST …/issues/{n}/comments` → 201; `DELETE` of that comment for cleanup | inst | sandbox ↺ | The comment object is read-side through `issue_comment.created` deliveries. Only the status and `Location` need the write. |
| `POST …/labels`, `DELETE …/labels/{name}` | inst | sandbox ↺ | The body is an array of labels. |
| `DELETE …/labels/{name}` of a label the issue doesn't have: 404 with the message "Label does not exist" | inst | sandbox | **To verify on the dev App ([#118](https://github.com/AdvanGrid/beghu/issues/118)).** Observed, not documented: the docs list a 404 for the endpoint but not its message. beghu takes only that message as done (the label is off, as asked) and any other 404 as gone, so the check pins the message. |
| `POST …/labels` with a name the repo has no label for | user | sandbox | **To verify on the dev App ([#118](https://github.com/AdvanGrid/beghu/issues/118)).** GitHub most likely creates the label, so a stale name (renamed since the picker read it) would make a duplicate. beghu refuses a `label_add` whose name the mirror's repo doesn't have ([#102](https://github.com/AdvanGrid/beghu/issues/102)); Fake GitHub answers a loud 422 rather than guess. |
| `POST`/`DELETE …/assignees` | inst | sandbox ↺ | |
| `PATCH …/issues/{n}`: `state` + `state_reason`, `milestone`, `title`, `body` | inst | sandbox ↺ | |
| `POST …/sub_issues` (incl. `replace_parent`), `DELETE …/sub_issue`, `PATCH …/sub_issues/priority` | inst | sandbox ↺ | Write calls take database ids ([#5](https://github.com/AdvanGrid/beghu/issues/5#issuecomment-6140964569)). A reorder leaves no trace to read back ([#70](https://github.com/AdvanGrid/beghu/issues/70#issuecomment-6396519248)), so it's sandbox-only. |
| `POST`/`DELETE …/dependencies/blocked_by` | inst | sandbox ↺ | |
| `POST …/relates_to`, `DELETE …/relates_to/{issue_id}` | inst | sandbox | No real relates-to traffic. |
| 422 "already exists" (duplicate link, cycle), 404 removing a missing sub-issue, 200 removing a missing dependency or relates-to | inst | sandbox | The retry rules depend on these ([#10](https://github.com/AdvanGrid/beghu/issues/10#issuecomment-6307581734), [#5](https://github.com/AdvanGrid/beghu/issues/5#issuecomment-6140964569)). Refused writes change nothing. |
| 403 `Resource not accessible by integration` + `X-Accepted-GitHub-Permissions` | inst narrowed to `issues: read` | sandbox | A narrowed token's write is refused and leaves the issue unchanged ([#72](https://github.com/AdvanGrid/beghu/issues/72#issuecomment-6397502856)). That would be safe on a real repo too, but the sandbox costs nothing. |
| Role silent drops (200, field unchanged) and partial `PATCH` | user, Read/Triage | none | Behaviour, not shape. Verified in #78 and re-run by hand before releases with the machine user. |

### Webhook payloads

All come from `GET /app/hook/deliveries/{id}` (JWT, past 3 days). "read" means real traffic on
the installed repos produces them often enough. The manifest today lacks `pull_request_review`
([#65](https://github.com/AdvanGrid/beghu/issues/65#issuecomment-6385762132)) and `repository`
([#4](https://github.com/AdvanGrid/beghu/issues/4#issuecomment-6140834766),
[#73](https://github.com/AdvanGrid/beghu/issues/73#issuecomment-6418135021)). Both need adding
before `beghu-ci` is registered, or those payloads never arrive.

| Event and actions | Bucket | Why |
|---|---|---|
| `issues`: opened, edited, closed, reopened, labeled, unlabeled, assigned, unassigned, milestoned, demilestoned | read | Daily on `advangrid`. If an action goes unseen, it falls back to the sandbox run. |
| `issues`: locked, unlocked | sandbox | Rare in real traffic. `PUT …/lock` works with Issues: write. |
| `issues`: deleted | none | Deleting needs an admin, and the org has to allow issue deletion (`/issues/tracking-your-work-with-issues/administering-issues/deleting-an-issue`). Fixture, plus a by-hand re-record before releases. |
| `issues`: transferred, plus `opened` with `changes.old_issue` | none | Needs a second repo; the owner chose one sandbox (section 3). Fixture. |
| `issue_comment`: created, edited | read | |
| `issue_comment`: deleted | sandbox | Cleanup deletes the run's comment, which produces it for free. |
| `label`, `milestone`: created, edited (rename with `changes.*.from`), deleted | sandbox | Rename a sandbox label and milestone and rename them back ([#35](https://github.com/AdvanGrid/beghu/issues/35#issuecomment-6183709148)). |
| `pull_request`: opened, edited, closed, reopened | read | Daily PR traffic on `advangrid`/`adv-website`. The CI App can't open PRs. |
| `pull_request_review`: submitted, dismissed | read | Reviews exist on `advangrid` and `hermes`. Needs the subscription. |
| `sub_issues`: four actions, same-repo | read ↺ sandbox | Seen in today's `advangrid` feed. |
| `sub_issues`, cross-repo (each side carries only its own issue) | read | Only when it happens. `hermes` has a cross-repo parent, so it does happen. A second sandbox would make it deterministic. |
| `issue_dependencies`: four actions | read ↺ sandbox | |
| `issue_relates_to`: `relates_to_added`, `relates_to_removed` (`/webhooks/webhook-events-and-payloads#issue_relates_to`) | sandbox | No real traffic. |
| `repository`: archived, unarchived, renamed | none | Archiving the sandbox would block the write run. Fixture, by hand. |
| `installation`, `installation_repositories` | read | Produced whenever an org owner adds a repo to `beghu-ci` (kept 3 days), otherwise fixture. |
| `github_app_authorization`: revoked | none | Follows a grant revoke. By hand, together with the Disconnect check. |
| Signature header, `X-GitHub-Delivery`, `installation.id`, `repository` on every payload | read | The stored delivery `request.headers` carries them. |

### Errors, limits and faults

| Shape | Bucket | Why |
|---|---|---|
| 401 expired or garbage token | read | Send a bad token. |
| 404 no access (repo not installed, or the user can't see it) | read | Ask for a repo outside the installation. |
| 410 deleted issue; GraphQL `NOT_FOUND` | read, after a one-time setup | One issue deleted by hand on the sandbox stays 410 for good. `NOT_FOUND` also comes back for any unused issue number. |
| 301 transferred issue | read, after a one-time setup | Needs one transfer by hand, so a second repo. |
| 304 on ETag | read | |
| 409 title/body conflict | none | It's beghu's own response after its ETag pre-check; `PATCH /issues` has no `If-Match` ([#10](https://github.com/AdvanGrid/beghu/issues/10#issuecomment-6307581734)). The Fake GitHub produces it from state. |
| 403/429 primary and secondary rate limit, `retry-after`, `x-ratelimit-remaining: 0` | none | Documented shape (`/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit`). Provoking it on purpose risks "the banning of your integration" (same page). Fixture from the docs. |
| 5xx, timeouts, connection refused | none | Fake GitHub fault control ([#51](https://github.com/AdvanGrid/beghu/issues/51#issuecomment-6332343351)). |
| Webhook drop, delay, duplicate, reorder | none | Fake GitHub fault control. |

**Behaviours, not shapes.** Several measured facts aren't field shapes: relationship changes don't
bump `updated_at`, reorders send nothing, cross-repo deliveries leave out the other issue, feed ids
aren't in time order, transfers send `opened` before `transferred`. A shape diff won't notice if
GitHub changes one of them. The write run can assert the cheap ones on the sandbox (no
`updated_at` bump after a link, no delivery after a reorder) for a few extra calls. The rest stay
in the probe scripts under `github-app/probe/`.

## 2. Recommendation

**App.** Register a dedicated private `beghu-ci` App under AdvanGrid with
`create-app.mjs --org AdvanGrid`, from the same manifest (with `pull_request_review` and
`repository` added). Don't use a dev's App: deliveries are per App
(`/rest/apps/webhooks#list-deliveries-for-an-app-webhook`), so CI would read that dev's test
traffic, and CI would hold one person's key. Its webhook must be active, because GitHub keeps no
delivery log for an inactive one (`/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries`).
Point it at a smee channel nobody listens to; payloads are read back from the log, never received
live (inferred). Install it, with an org owner's approval, on a few busy real repos (`advangrid`,
`hermes`, `adv-website`) and on `beghu-sandbox`, but not on `beghu`. It has the same permissions
as the prod App, which is already installed on every AdvanGrid repo
([#77](https://github.com/AdvanGrid/beghu/issues/77#issuecomment-6402394555)).

**Credentials, installation half (unattended).**
- A `contract` environment on `AdvanGrid/beghu`, limited to `main`, holds the App id, client id,
  client secret and PEM. A workflow mints the JWT itself. `GITHUB_TOKEN` can't stand in: it's the
  Actions App's token, limited to the workflow's own repo
  (`/actions/concepts/security/github_token`).
- The read side mints tokens with
  `permissions: {issues: read, pull_requests: read, metadata: read}`. The write side mints one
  with `repositories: ["beghu-sandbox"]`. GitHub enforces both narrowings per token
  (`/rest/apps/apps#create-an-installation-access-token-for-an-app`), so a bug in the check can't
  write to `advangrid`.

**Credentials, user half.** It's a small read set: `/user`, `/user/installations…` with
`permissions`, `viewerPermission`/`viewerCan*`, and the two OAuth error shapes. Run it nightly with
a **machine user** (e.g. `advangrid-beghu-ci`, an org member with Read on one installed repo and
Triage on the sandbox), signed in once by device flow. Its token reaches only what that user can
see. For storage:
- **Recommended: opt `beghu-ci` out of user-token expiration.** The token then doesn't expire and
  sits in the environment as a static secret. Expiry is an optional, per-App setting
  (`/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens`).
  The cost is that CI never sees a refresh; the token exchange and refresh shapes stay on the
  fixture and the by-hand list, and devs' own Apps refresh every 8 h anyway. The docs call
  expiring tokens "an optional feature and subject to change", so this may have to change later.
- **Fallback, if expiry becomes mandatory:** refresh at the start of each run, under a
  `concurrency` group so no two runs use one refresh token, and write the new pair back before
  doing anything else. `GITHUB_TOKEN` has no secrets permission
  (`/actions/reference/workflows-and-actions/workflow-syntax#permissions`). Writing an environment
  secret needs "Environments" repository permission (write), which a GitHub App token can hold
  (`/rest/actions/secrets#create-or-update-an-environment-secret`). That means a second small App
  on `beghu` with that one permission. A failed write-back breaks the chain, and someone has to
  sign the machine user in again.

**Cadence.**
- **Read side: nightly** (cron + `workflow_dispatch`, never on PRs, as in
  [#77](https://github.com/AdvanGrid/beghu/issues/77#issuecomment-6402394555)). A night is well
  inside the 3-day delivery window, so every delivery is seen. Each run fetches one payload per
  (event, action) pair seen since the last run, plus the read calls in section 1. That's about 100
  requests, a few GraphQL points and no content creation. It also reports coverage: pairs the
  check knows but hasn't seen in 14 days.
- **Write side: weekly**, on `workflow_dispatch`, and on pushes to `main` that touch the Fake
  GitHub's recorded templates or request set or beghu's GitHub client module. Also before each
  release, alongside the by-hand list. One run is about 40 writes, under the 80/min and 500/h
  content-creation limits (`/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits`).
  When the read side reports an unseen pair that the write side can produce, the next write run
  covers it. Making it weekly and not nightly keeps the sandbox's history readable for #78-style
  tests.
- `AdvanGrid/beghu` is public, and GitHub disables scheduled workflows in a public repo after 60
  days without repository activity (`/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows`).
  Commits keep it alive. If the project goes quiet, `gh workflow enable` restarts it.

**Cleanup on `beghu-sandbox`.**
- Use a fixed set of long-lived fixture issues labelled `contract` (a parent, two children, a
  blocker, a relates-to pair). Each write is undone in the same run: add then remove, close then
  reopen, rename then rename back.
- Each run starts by putting the fixture back in its starting state, idempotently, so a crashed
  run leaves nothing behind.
- The one create per run gets closed as `not_planned`. The run's comment gets deleted, which also
  produces `issue_comment.deleted`.
- The contract never touches issues without the label, so #78-style role tests share the repo
  safely.
- One-time setup by hand: an uploaded image, video and zip; one deleted issue (once the org allows
  deletion); one standing relates-to link; one transferred issue if a second repo exists.

**Reporting drift.** The single "Contract drift" issue lives on private `AdvanGrid/beghu-sandbox`
(owner's decision, section 3), opened or commented on by the write-side installation token (which
already reaches the sandbox) or a `beghu-sandbox`-scoped token, plus a failed run. `GITHUB_TOKEN`
on `beghu` can't reach another repo.
- Since the repo is private, the diff may carry values, but it still leads with field paths and
  types, endpoints as templates (`/repos/{o}/{r}/issues/{n}`), matching the "fields and types, not
  values" diff in [#51](https://github.com/AdvanGrid/beghu/issues/51#issuecomment-6332343351).
- Coverage gaps go in the same comment under their own heading. They aren't drift.

## 3. Owner decisions (2026-10-26)

1. **A machine user** holds the user-token half: an AdvanGrid bot account with Read on one repo,
   signed in once by device flow.
2. **`beghu-ci` opts out of expiring user tokens**, so the token is a static secret in the
   `contract` environment. The write-back fallback applies only if GitHub makes expiry mandatory.
3. **One sandbox.** No `beghu-sandbox-b`: cross-repo deliveries are read only when real traffic
   produces them, and transfer (301, `issues.transferred`) stays fixture-only.
4. **The drift issue lives on private `beghu-sandbox`.**

Left to setup time, not spec-blocking: which busy repos `beghu-ci` is installed on (default
`advangrid`, `hermes`, `adv-website`), and whether an org admin allows issue deletion for the
one-time 410 setup (until then 410 stays fixture-only).
