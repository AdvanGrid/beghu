# GitHub App mechanics for beghu: tokens, permissions, webhooks, delivery, dev/prod

Research date: 2026-10-13. Sources: docs.github.com (fetched as Markdown through
`https://docs.github.com/api/article/body?pathname=…`, and as HTML where the Markdown body drops
the per-endpoint permission blurbs), the GitHub changelog, the octokit/webhooks schemas, and
read-only `gh api graphql` introspection of the public schema. Nothing on GitHub was created or
changed. Doc URLs below drop the `https://docs.github.com/en` prefix and are written as `/path`.

## Answers

1. **User access tokens (`ghu_`) last 8 h, and refresh tokens (`ghr_`) last 6 months and
   rotate on every use.** Users get them through the web flow (with PKCE) or the device flow. A
   refresh returns a new access token and a new refresh token, and the old pair stops working
   at once. Expiry is on by default and is controlled by "Expire user authorization tokens".
   When a user revokes the app, GitHub sends `github_app_authorization` (`revoked`) and the
   tokens start returning 401. Installation tokens last 1 h and are minted from the app's
   private key. Use user tokens for every write, so the action is attributed to the user. Use
   installation tokens for the background import and reconciliation, which doesn't spend the
   user's personal quota. REST: a user token shares the user's own 5,000/h budget with `gh`
   and everything else the user runs. An installation gets 5,000/h, plus 50/h per repo above 20
   repos and 50/h per org user above 20 users, capped at 12,500/h. GraphQL uses the same numbers
   in points.
2. **One repository permission covers almost everything: Issues: write.** That includes
   issues, comments, labels, assignees, milestone, close/reopen, edit, create, sub-issues (REST
   and GraphQL) and dependencies (blocked-by/blocking). Add Pull requests: read for the PR
   mirror. Metadata: read is mandatory. A user token can do only what both the app and the user
   can do, and only in accounts where the app is installed. No org setting is needed beyond an
   org owner (or a repo admin, for repos they administer) installing the app. GitHub Apps are
   not subject to the OAuth app access policy.
3. **There is one webhook per app, and every delivery carries `installation.id` and
   `repository`.** Subscribe to `issues`, `issue_comment`, `label`, `milestone`,
   `pull_request`, `sub_issues` and `issue_dependencies`. `installation`,
   `installation_repositories` and `github_app_authorization` arrive without subscribing. Which
   connected accounts should see a delivery is up to beghu: look up the repository id against
   each account's accessible-repo set. No document says that changes made through `gh` or any
   other API client are excluded from webhooks; nothing was found that excludes them. Latency
   is not guaranteed: the docs say deliveries "can take a few minutes" and may be throttled
   during surges.
4. **GitHub does not retry. The timeout is 10 s, the payload cap is 25 MB, and delivery
   order is not guaranteed.** `X-GitHub-Delivery` is a GUID that stays the same on
   redelivery. `X-Hub-Signature-256` is an HMAC-SHA256 of the raw body. The app deliveries API
   (`GET /app/hook/deliveries`, `GET …/{id}`, `POST …/{id}/attempts`, JWT auth) can list
   failures, fetch the original payload and redeliver. GitHub's documented pattern is a
   scheduled job that groups deliveries by GUID and redelivers any GUID with no `OK` attempt.
   Retention is stated as 3 days in the body text, but the page summaries say 7 days. Beyond
   the window, reconcile from the API (`since` on issues and comments, then re-read
   relationships).
5. **Register two apps, `beghu-dev` and `beghu`.** Each app has one webhook URL, so a
   separate dev app is the only way to point webhooks at a laptop. The docs recommend smee.io
   (or ngrok and similar) for dev and warn against smee in production. A webhook URL can't be
   `localhost`. A callback URL can (the docs' tutorial uses `http://localhost:4567/...`). Up to
   10 callback URLs are allowed. The manifest flow can create both apps from one JSON config.
   **A private app can only be installed on the account that owns it.** If teammates' repos
   live in other accounts or orgs, beghu has to be public.

## 1. Tokens: user access tokens, installation tokens, rate limits

### User access tokens (user-to-server)

- **What it is.** "A GitHub App user access token only has permissions that both the user and
  the app have", and it "can only access resources that both the user and app can access"
  (`/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app`).
  The app also "can only access resources in an account where it is installed"
  (`/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user`).
- **Attribution.** Requests are "attributed to that user", and the UI shows "the user's avatar
  photo along with the app's identicon badge". Audit logs list the user as actor with
  `programmatic_access_type` "GitHub App user-to-server token" (same page).
- **Web flow.** Redirect to `https://github.com/login/oauth/authorize` with `client_id`,
  `redirect_uri`, `state`, and PKCE `code_challenge` + `code_challenge_method=S256` (marked
  "Strongly recommended"). Exchange `code` (+ `client_secret`, `code_verifier`) at
  `POST https://github.com/login/oauth/access_token`. `scope` only accepts `offline_access`,
  which forces an expiring token even if the app opted out of expiry (`/apps/…/generating-a-user-access-token-for-a-github-app`).
- **Device flow.** Must be enabled in app settings ("Enable Device Flow"). Device/user codes
  expire after 900 s by default. The refresh step needs no `client_secret` for device-flow
  tokens (same page; `/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens`).
  Not needed for a web server like beghu.
- **Expiry and refresh.** `expires_in` is "always `28800` (8 hours)", and
  `refresh_token_expires_in` is "always `15897600` (6 months)". "Once you use a refresh token,
  that refresh token and the old user access token will no longer work." Refresh with
  `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`,
  `grant_type=refresh_token` and `refresh_token`. An expired or invalid refresh token returns
  `bad_refresh_token`, and the user has to go through the web flow again
  (`/apps/…/refreshing-user-access-tokens`; `/apps/…/generating-a-user-access-token-for-a-github-app#bad-refresh-token`).
- **The setting.** "Expire user authorization tokens" is on by default at registration, and
  GitHub "strongly recommends" leaving it on
  (`/apps/creating-github-apps/registering-a-github-app/registering-a-github-app`). It can be
  toggled later under Optional features, where it is called "User-to-server token expiration".
  Tokens issued while it was off do not start expiring when it is turned back on
  (`/apps/…/refreshing-user-access-tokens`).
- **Revocation.** The user can revoke from settings. This revokes every token for that
  authorization, and the app receives `github_app_authorization`, which it "cannot unsubscribe
  from". After that, calls return `401 Bad Credentials`
  (`/apps/…/generating-a-user-access-token-for-a-github-app`;
  `/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation`).
  The action name is `revoked` (octokit schema
  `payload-schemas/api.github.com/github_app_authorization/revoked.schema.json` in
  https://github.com/octokit/webhooks). Revoking does **not** uninstall the app
  (`/webhooks/webhook-events-and-payloads#github_app_authorization`). Tokens are also revoked
  automatically if pushed to a public repo or gist (token-expiration page). An app can revoke a
  user token itself with `DELETE /applications/{client_id}/token`
  (`/rest/apps/oauth-applications#delete-an-app-token`).
- **Org membership changes.** "You should use the `GET /user/installations` REST API endpoint
  regularly to verify which organizations a user access token has access to." Under SAML SSO,
  the token has no org access until the user has an active SAML session
  (`/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app`).
- **Storage.** "Encrypt the tokens on your back end… Consider storing refresh tokens in a
  separate place from active access tokens." Cache tokens and reuse them until expiry
  (best-practices page).
- **Server refresh strategy (inferred).** The docs say nothing about refresh races, so the
  following is inferred. Refresh tokens are single-use, so two concurrent refreshes for one
  user means one of them loses, possibly together with the session. Serialize refreshes per
  user (a mutex or a DB row lock), persist the new pair atomically before using it, and
  refresh proactively a few minutes before `expires_in` and also on a 401. On
  `bad_refresh_token`, mark the account "needs sign-in". Secondary limit: at most 2,000 OAuth
  token requests per hour per app (`/rest/using-the-rest-api/rate-limits-for-the-rest-api`),
  which is no concern at this scale.

### Installation access tokens

- Created with `POST /app/installations/{installation_id}/access_tokens` using a JWT signed with
  the app's private key. They expire after 1 hour and can be narrowed with
  `repositories`/`repository_ids` and `permissions`
  (`/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app`).
  They work for REST and GraphQL
  (`/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation`).
- Activity is attributed to the app (the `[bot]` account)
  (`/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps`).
- GitHub's guidance: "if your GitHub App takes an action on behalf of a user, it should always
  use a user access token instead of an installation access token. Otherwise, your app might
  allow a user to see or do things that they shouldn't be able to see or do" (best-practices
  page, "Use the appropriate token type").

### Rate limits

| Token | REST primary | GraphQL primary | Source |
|---|---|---|---|
| User access token | 5,000/h, **shared** with the user's PATs, `gh`, and every other app acting for that user. 15,000/h if the app is owned by a GHEC org | 5,000 points/h per user (10,000 if the app is owned by a GHEC org) | `/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-authenticated-users`, `/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api` |
| Installation token, non-GHEC | 5,000/h, +50/h per repo over 20, +50/h per org user over 20, capped at 12,500/h | same formula in points, capped at 12,500 | `…/rate-limits-for-the-rest-api#primary-rate-limit-for-github-app-installations`, GraphQL page |
| Installation token, GHEC org | 15,000/h | 10,000 points/h | same |

Secondary limits apply to both token types: at most 100 concurrent requests (REST and GraphQL
combined); 900 points/min per REST endpoint and 2,000 points/min for GraphQL (a GET or a
GraphQL query costs 1, a mutating REST call or a GraphQL mutation costs 5); 80
content-creating requests per minute and 500 per hour; 90 s of CPU per 60 s
(`/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits`). GraphQL
primary cost: add up the requests per connection, assuming `first`/`last` is maxed, then divide
by 100. `first`/`last` must be 1–100, and a call can request at most 500,000 nodes (GraphQL
page, "Node limit"). For beghu's size (about 10 repos, under 20 per installation), a personal
account installation stays at the 5,000 base.

## 2. Permissions

From `/rest/authentication/permissions-required-for-github-apps` (the "Issues", "Pull requests"
and "Metadata" tables). Every endpoint below accepts both UAT and IAT. The per-endpoint "Fine-grained access tokens"
blurbs on `/rest/issues/sub-issues` and `/rest/issues/issue-dependencies` say the same thing.

| Need | Endpoint(s) | Permission |
|---|---|---|
| Read issues, comments, labels, milestones, timeline/events | `GET /repos/{o}/{r}/issues…`, `…/issues/comments`, `…/labels`, `…/milestones`, `…/issues/{n}/timeline` | Issues: read (the ✓ "additional permissions" rows also accept Pull requests: read) |
| Create issue | `POST /repos/{o}/{r}/issues` | Issues: write |
| Edit title/body, close/reopen, set milestone | `PATCH /repos/{o}/{r}/issues/{n}` | Issues: write (or Pull requests: write for PRs) |
| Comment | `POST …/issues/{n}/comments` | Issues: write |
| Labels on an issue | `POST/PUT/DELETE …/issues/{n}/labels` | Issues: write |
| Assignees | `POST/DELETE …/issues/{n}/assignees` | Issues: write |
| Sub-issues: read parent / list | `GET …/issues/{n}/parent`, `GET …/issues/{n}/sub_issues` | Issues: read |
| Sub-issues: add / remove / reorder | `POST …/issues/{n}/sub_issues`, `DELETE …/issues/{n}/sub_issue` (singular), `PATCH …/sub_issues/priority` | Issues: write |
| Dependencies: list | `GET …/issues/{n}/dependencies/blocked_by`, `…/blocking` | Issues: read |
| Dependencies: add / remove | `POST …/dependencies/blocked_by`, `DELETE …/dependencies/blocked_by/{issue_id}` | Issues: write |
| PRs read-only | `GET /repos/{o}/{r}/pulls…` | Pull requests: read |
| Repo info, collaborators, list accessible repos | `GET /repos/{o}/{r}`, `GET /user/installations/{id}/repositories` (UAT only) | Metadata: read |

Notes:

- **Blocking is write-only from the blocked side.** There is no `POST …/dependencies/blocking`.
  To mark A as blocking B, add A to B's `blocked_by` (`/rest/issues/issue-dependencies`).
- **Request bodies take issue *ids*, not numbers.** `sub_issue_id` is "the id of the sub-issue
  to add. The sub-issue must belong to the same repository owner as the parent issue", with an
  optional `replace_parent`. `issue_id` is "the id of the issue that blocks the current issue"
  (`/rest/issues/sub-issues#add-sub-issue`, `/rest/issues/issue-dependencies#add-a-dependency-an-issue-is-blocked-by`).
  Cross-repo sub-issues therefore work within one owner, and the REST docs rule out cross-owner
  ones. The dependency endpoint states no owner restriction. The `issue_dependencies` payload
  carries a `blocking_issue_repo`, which points to cross-repo support (inferred).
- **Limits.** Up to 100 sub-issues per parent and 8 levels of nesting
  (`/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues`). Up to 50 issues per
  dependency relationship type (https://github.blog/changelog/2025-08-21-dependencies-on-issues/).
- **GraphQL.** Introspection of the live schema shows the mutations `addSubIssue`
  (`issueId`, `subIssueId` or `subIssueUrl`, `replaceParent`), `removeSubIssue`,
  `reprioritizeSubIssue`, `addBlockedBy`/`removeBlockedBy` (`issueId`, `blockingIssueId`) and
  `addRelatesTo`/`removeRelatesTo`. On `Issue` it shows the fields `parent`, `subIssues`,
  `subIssuesSummary`, `blockedBy`, `blocking`, `issueDependenciesSummary` and `relatesTo`
  (reference: `/graphql/reference/mutations#addsubissue`,
  `/graphql/reference/mutations#addblockedby`, `/graphql/reference/objects#issue`). **The
  GraphQL docs publish no per-mutation permission table.** That GraphQL needs the same Issues
  read/write as REST is inferred.
- **Status.** Sub-issues went GA on 2025-04-09
  (https://github.blog/changelog/2025-04-09-evolving-github-issues-and-projects/), and the REST
  API followed on 2024-12-12, during the preview
  (https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/).
  Issue dependencies went GA on 2025-08-21 and are "fully supported in the API and webhooks"
  (changelog above). `gh` v2.94.0 added `--parent`, `--blocked-by` and `--blocking` flags
  (https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/).
- **A newer relationship: "relates to".** REST `…/issues/{n}/relates_to` (Issues read/write),
  GraphQL `addRelatesTo`, and an `issue_relates_to` webhook exist (permissions page;
  `/webhooks/webhook-events-and-payloads#issue_relates_to`). It is outside beghu v1, but it is
  cheap to mirror later.
- **Effective permission = app ∩ user ∩ installed accounts.** If the app has Issues: write but
  the user only has read on a repo, the user token can only read
  (`/apps/…/generating-a-user-access-token-for-a-github-app`). A triage-role teammate can label
  but cannot edit someone else's issue body, so expect 403/404 on writes and show the error in
  the UI. That GitHub's role checks apply is inferred from the intersection rule.
- **Org-level requirements.** Organization owners can install apps. Repository admins can also
  install, limited to repos they administer, if the app requests no org permissions and not
  "Repository administration" (beghu requests neither). Owners can switch off installs by
  repository admins. Members who can't install get an "install request" flow instead
  (`/apps/using-github-apps/installing-a-github-app-from-a-third-party#requirements-to-install-a-github-app`;
  `/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests-and-installations`).
  "GitHub Apps aren't subject to organization application policies"
  (`/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps`).
  Private repos need no separate setting: the installer picks "All repositories" or selected
  repos (third-party install page). On personal accounts only the owner can install, so a
  teammate's personal repos need that teammate to install the app. Each org member must still
  authorize the app before beghu can act for them
  (`/apps/…/authenticating-with-a-github-app-on-behalf-of-a-user`). Adding permissions later
  makes every installation re-approve them, and until they do the old permissions stay in
  force. Watch `installation.new_permissions_accepted` (best-practices page).

## 3. Webhooks

- **One webhook per app.** "Each GitHub App has a single webhook that is automatically created
  by GitHub… A GitHub App webhook cannot be deleted, but you can deactivate it"
  (`/webhooks/types-of-webhooks#github-app-webhooks`). It "can receive webhook events for all
  repositories and organizations the app can access", unlike OAuth apps, which need a webhook
  per repo or org (`/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps`).
  The events an app can subscribe to depend on its permissions
  (`/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps`).
- **Routing data.** App deliveries include `installation` ("when the event is configured for
  and sent to a GitHub App"), plus `repository`, `organization` (for org-owned repos) and
  `sender` (`/webhooks/webhook-events-and-payloads#common-payload-parameters`). In app payloads,
  `installation` is just `{id, node_id}` (octokit `common/installation-lite.schema.json`).
  Headers: `X-GitHub-Event`, `X-GitHub-Delivery`, `X-GitHub-Hook-ID`,
  `X-GitHub-Hook-Installation-Target-Type/-ID`, `X-Hub-Signature-256` (same page, "Delivery
  headers"). `sender` may be the `ghost` user (same page).
- **Installations and accounts.** Each installation belongs to one account, user or org, and
  covers either all repos or a selected set (`/apps/using-github-apps/installing-a-github-app-from-a-third-party`).
  A user token can list the installations it can reach with `GET /user/installations`, and the
  repos inside one with `GET /user/installations/{installation_id}/repositories`
  (`/rest/apps/installations`). The app can list its installations with
  `GET /app/installations`, and can find the installation for a repo, org or user with
  `GET /repos/{o}/{r}/installation`, `/orgs/{org}/installation` and `/users/{u}/installation`
  (`/rest/apps/apps`).
- **Mapping a delivery to connected accounts (beghu's job; the docs are silent).** Keep a
  table `(connected_account, installation_id, repository_id)`, built from the two
  `/user/installations…` calls with each user's token at sign-in. Rebuild it on
  `installation_repositories` and `installation` events, and periodically, because collaborator
  and team access changes have no webhook unless the app requests org "Members" permission
  (for the `member`/`organization` events; `/webhooks/webhook-events-and-payloads#member`).
  On each delivery, fan out to every connected account that has `repository.id` in its set.
  Several teammates under the same org installation all match. This design is inferred.
- **Events and actions** (all from `/webhooks/webhook-events-and-payloads`):

| Event | Actions | App permission to subscribe |
|---|---|---|
| `issues` | `assigned, closed, deleted, demilestoned, edited, field_added, field_removed, labeled, locked, milestoned, opened, pinned, reopened, transferred, typed, unassigned, unlabeled, unlocked, unpinned, untyped` | Issues: read |
| `issue_comment` | `created, deleted, edited, pinned, unpinned` (issues and PRs) | Issues: read |
| `label` | `archived, created, deleted, edited, unarchived` (repo label set; issue labelling is `issues.labeled`) | Metadata: read |
| `milestone` | `closed, created, deleted, edited, opened` | Issues or Pull requests: read |
| `pull_request` | `assigned, …, closed, edited, labeled, opened, reopened, synchronize, …` (22 actions) | Pull requests: read |
| `sub_issues` | `parent_issue_added, parent_issue_removed, sub_issue_added, sub_issue_removed`; payload has `parent_issue(_id)`, `parent_issue_repo`, `sub_issue(_id)` | Issues: read |
| `issue_dependencies` | `blocked_by_added, blocked_by_removed, blocking_added, blocking_removed`; payload has `blocked_issue(_id)`, `blocking_issue(_id)`, `blocking_issue_repo` | Issues: read |
| `issue_relates_to` | `relates_to_added, relates_to_removed` | Issues: read |
| `installation` | `created, deleted, new_permissions_accepted, suspend, unsuspend` | always sent, cannot subscribe |
| `installation_repositories` | `added, removed` (`repositories_added/removed`, `repository_selection`) | always sent |
| `installation_target` | account renamed | app only |
| `github_app_authorization` | `revoked` | always sent |
| `repository` | `archived, deleted, renamed, transferred, privatized, …` | Metadata: read |

  Optional extras for the read-only PR mirror: `pull_request_review`,
  `pull_request_review_comment`, `pull_request_review_thread` (Pull requests: read).
- **Paired actions (ambiguous).** For `sub_issues` and `issue_dependencies`, the docs don't say
  whether one change produces one delivery or two (for example `sub_issue_added` on the
  parent's repo and `parent_issue_added` on the child's), or how cross-repo pairs are split. The
  docs spell this out only for `issue_relates_to`: one delivery for same-repo pairs, one per
  repo for cross-repo pairs, and cross-repo deliveries omit the other issue. Treat these events
  as idempotent "re-read this relationship" signals rather than deltas. That is inferred and
  needs a live test.
- **Changes made through `gh`.** No document says that changes made through the API (and so
  `gh`, which calls the API) skip webhooks. Event descriptions say only that an event "occurs
  when there is activity relating to" the resource. That `gh` edits fire webhooks the same way
  is inferred and should be checked once. `sender` will be the token owner.
- **Latency.** GitHub promises "near real-time updates"
  (`/webhooks/about-webhooks`), but also says "Webhook deliveries can take a few minutes to be
  delivered" and "GitHub may temporarily throttle the rate of deliveries to your account",
  reported in `throttled_at` (`/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#webhook-deliveries-are-not-immediate`).
  No typical latency figure is published. The 1–2 s target is beghu's own goal; GitHub does not
  guarantee it.

## 4. Delivery guarantees and catch-up

- **No automatic retry.** "GitHub does not automatically redeliver failed deliveries." A
  delivery fails if the server is down or "takes longer than 10 seconds to respond"
  (`/webhooks/using-webhooks/handling-failed-webhook-deliveries`). Reply with a 2xx within 10 s
  and queue the processing (`/webhooks/using-webhooks/best-practices-for-using-webhooks#respond-within-10-seconds`).
- **Payload cap: 25 MB.** Above that, "GitHub will not deliver a payload for that webhook
  event" (`/webhooks/webhook-events-and-payloads#payload-cap`). Issue events are not near that
  size (inferred).
- **`X-GitHub-Delivery`** is a GUID, and on redelivery it "will be the same as in the original
  delivery". Use it for dedupe and replay protection (best-practices page).
- **Signature.** `X-Hub-Signature-256` is `sha256=` + HMAC-SHA256 hex of the raw body, keyed
  by the webhook secret. Compare in constant time
  (`/webhooks/using-webhooks/validating-webhook-deliveries`). GitHub's IP ranges are available
  from `GET /meta` if an allow-list is wanted (best-practices page).
- **Ordering.** "GitHub may deliver webhooks in a different order than the order in which the
  events took place… use the timestamps that are included in the delivery payload"
  (troubleshooting page, "out of order").
- **App deliveries API** (`/rest/apps/webhooks`, JWT auth only):
  - `GET /app/hook/deliveries`, with `per_page`, `cursor` (Link header) and `status`
    (`success` = 200–399, `failure` = 400–599). Items include `id`, `guid`, `delivered_at`,
    `redelivery`, `status`, `status_code`, `event`, `action`, `installation_id`,
    `repository_id` and `throttled_at`.
  - `GET /app/hook/deliveries/{delivery_id}` adds `request.headers`, `request.payload` and
    `response`. The original payload can therefore be fetched and processed directly without
    asking for a redelivery. This is an inference from the response schema; the docs' own
    pattern is to redeliver.
  - `POST /app/hook/deliveries/{delivery_id}/attempts` redelivers.
- **Retention window (conflicting text).** The body of the redelivery and viewing pages says
  "deliveries that occurred in the past 3 days", repeated in every UI step, while the page
  summaries say "past 7 days"
  (`/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks`,
  `/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries`). Plan for 3 days.
- **Documented redelivery pattern**
  (`/webhooks/using-webhooks/automatically-redelivering-failed-deliveries-for-a-github-app-webhook`):
  run on a schedule (the sample cron is `40 */6 * * *`). Fetch deliveries since the last run
  (the first run defaults to 24 h back), paging until `delivered_at` predates the cutoff. Group
  them by `guid`, skip any GUID that has an attempt with `status === "OK"`, redeliver the rest
  (a 404 on redeliver means "not found"), then save the run time. The page says it can also run
  as a cron job on the webhook server.
- **After downtime longer than the window (inferred; no doc covers it).** Re-sync from the API.
  - Per repo: `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=desc&since=<last_seen>`.
    This returns PRs too, marked by a `pull_request` key (`/rest/issues/issues#list-repository-issues`).
  - Comments: `GET /repos/{o}/{r}/issues/comments?since=` (`/rest/issues/comments`).
  - Relationships: the docs do not say whether adding or removing a sub-issue or dependency
    changes `updated_at` on either issue. Until that is tested, re-read `parent`, `subIssues`,
    `blockedBy` and `blocking` through GraphQL for every issue in the window, or run a full
    relationship sweep.
  - Deletions, transfers and label/milestone renames won't show up in `since` lists. Compare
    full id sets (cheap at 20k issues) during a periodic full reconcile.

## 5. Dev and prod apps

- **Two registrations.** The docs list "Ensure you deploy GitHub Apps to development and
  production environments using the same configuration" as a manifest use case
  (`/apps/sharing-github-apps/registering-a-github-app-from-a-manifest`). That two apps are
  standard is inferred from this, together with the one-webhook-URL-per-app rule. The dev app
  gets its own client id/secret, private key, webhook secret and installations.
- **Local webhooks.** "You can use a webhook payload delivery service like Smee… Never use Smee
  for an application in production." ngrok, localtunnel and Hookdeck Console are listed as
  alternatives (`/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps#choosing-a-webhook-url-for-development-and-testing`).
  "You cannot use `localhost` or `127.0.0.1` as a webhook URL" (troubleshooting page). Redelivery
  from the app settings or the API is useful when a dev server was down.
- **Callback URLs.** Up to 10. Pass `redirect_uri` to choose one, otherwise the first is used.
  Exact match unless per-URL wildcard matching is enabled; that setting is on for apps that had
  a single callback before 2026-08-03, and GitHub recommends disabling it
  (`/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url`).
  `http://localhost:…` callbacks are used in GitHub's own tutorial
  (`/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app`).
- **Manifest flow.** POST a JSON `manifest` to `https://github.com/settings/apps/new` (or
  `/organizations/ORG/settings/apps/new`). The user names the app, and GitHub redirects back
  with a `code`. Exchange it within 1 hour at `POST /app-manifests/{code}/conversions` for the
  app id, PEM, webhook secret and client secret. The manifest sets `hook_attributes.url`,
  `callback_urls` (up to 10), `public`, `default_permissions`, `default_events` and
  `request_oauth_on_install` (manifest page; `/rest/apps/apps#create-a-github-app-from-a-manifest`).
  Not settable in the manifest: device flow or token-expiry toggles (absent from the parameter
  table). Expiry defaults to on anyway.
- **Public vs private.** "If you set your GitHub App registration to private, it can only be
  installed on the account that owns the app. Only members of the organization that owns it can
  authorize it." The Install button on a private app is available only to owners and app
  managers of the owning org, or to the owning user
  (`/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private`).
  A public app can't be made private again while it is installed on other accounts
  (`/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-visibility-of-a-github-app`).
  Implications:
  - If all the repos sit in one org and beghu is registered by that org as a private app,
    teammates who are org members can sign in, and one org installation covers them.
  - If any repo lives in a teammate's personal account, another org, or the user's own personal
    account while the app is owned elsewhere, that account needs an installation. A private app
    cannot be installed there, so the app must be public.
  - The docs don't say whether outside collaborators of the owning org, or anyone besides the
    owner of a personal-account-owned private app, can authorize a private app.
  - Public only means installable and authorizable by anyone with the link. It is not listed
    in Marketplace unless published there (`/apps/sharing-github-apps/sharing-your-github-app`).

## Implications for beghu

- **Tokens.**
  - **Writes use the acting user's token**, so they are attributed to that user and limited to
    what that user may do.
  - **Import, reconciliation and the redelivery job use installation tokens and the app JWT**,
    so they don't spend the user's 5,000/h. That budget is shared with their `gh` and agent
    usage.
  - Keep expiry on. Refresh under a per-user lock and store the rotated pair atomically before
    use. Handle `bad_refresh_token` and `github_app_authorization.revoked` by marking the
    account as needing sign-in.
- **App permissions.** Repository: Issues **write**, Pull requests **read**, Metadata **read**.
  Account permissions: none. Organization "Members: read" is optional; it is only needed to
  receive `member`/`organization` events for access changes, which a periodic
  `/user/installations` refresh can cover instead.
- **Webhook events to subscribe.** `issues`, `issue_comment`, `label`, `milestone`,
  `pull_request`, `sub_issues`, `issue_dependencies`, `issue_relates_to` (relates-to was added
  to v1 after this research), `repository`. Optionally `pull_request_review*`. `installation`, `installation_repositories`
  and `github_app_authorization` arrive automatically.
- **Handler.**
  1. Verify `X-Hub-Signature-256` on the raw body.
  2. Insert into a deliveries table keyed by `X-GitHub-Delivery`, ignoring duplicates.
  3. Return 2xx right away.
  4. Process async: route by `repository.id` to every connected account with access.
  5. Upsert only if the payload's `updated_at` is newer than what is stored. Treat
     relationship events as "re-read relationships for these issues".
- **Missed-delivery recipe.**
  - Every few minutes, and on startup, list `GET /app/hook/deliveries` since the last
    checkpoint. Group by `guid`, and redeliver (or fetch and process) GUIDs with no OK attempt.
  - On startup after downtime over about 2.5 days, or after losing the checkpoint, run the API
    reconcile instead: issues and comments `since`, relationship re-read, id-set diff.
  - Schedule a full reconcile periodically anyway, because ordering and delivery are not
    guaranteed and the mirror is disposable.
- **Dev/prod.** Register `beghu-dev` and `beghu` from one manifest. The dev app's webhook points
  at a smee.io channel or a tunnel, and its callbacks include `http://localhost:<port>/…`. The
  prod app gets the real HTTPS URLs.
- **Visibility.** If teammates' repos are spread across more than one account, make the app
  **public** (installable via `https://github.com/apps/<name>/installations/new`). If everything
  lives in one org, a private app owned by that org is enough.
- **Expectations.** GitHub doesn't guarantee webhook latency; its docs mention minutes and
  throttling. Nothing in the docs supports a 1–2 s figure, so measure it. For beghu's own
  writes, update the mirror from the API response rather than waiting for the echo webhook
  (inferred).

## Open questions / unverified

- Does one sub-issue or dependency change produce one or two webhook deliveries? How are
  cross-repo pairs split, and which repo's installation receives each? Needs a live test.
- Does adding or removing a sub-issue or dependency bump `updated_at` on either issue? This
  decides whether `since` catches relationship changes.
- Delivery retention: 3 days (body text) or 7 days (page summaries)?
- No GraphQL permission table exists for `addSubIssue`/`addBlockedBy`. Issues: write is
  assumed.
- Whether anyone other than the owner (or org members, for an org-owned app) can authorize a
  private app. The docs say only org members, but are silent for personal-account-owned apps
  and for outside collaborators.
- Whether dependencies can cross owners. REST forbids cross-owner sub-issues, and nothing is
  stated for dependencies.
- No published latency figures for webhook delivery.
