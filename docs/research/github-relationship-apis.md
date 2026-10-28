# GitHub relationship APIs: sub-issues, issue dependencies and "relates to"

Research date: 2026-10-13. Sources: docs.github.com (fetched as Markdown through
`https://docs.github.com/api/article/body?pathname=…`), GitHub's published OpenAPI description
(`github/rest-api-description`, `descriptions/api.github.com/api.github.com.json`, info.version
1.1.4, fetched today), live introspection of the GraphQL schema with `gh api graphql`, the GitHub
changelog, and an empirical probe against `tomsjansons/beghu` and `tomsjansons/pi-advissue-smoke-test`
with the `gh` CLI (a user OAuth token, not a GitHub App token). Doc URLs below drop the
`https://docs.github.com/en` prefix and are written as `/path`.

Labels used below: **verified** means it was observed in the probe; **documented** means it
comes from a GitHub doc, changelog or the OpenAPI/GraphQL schema; **inferred** means neither,
reasoning only.

Scratch issues created for the probe, all now closed as "not planned" with their relationships
removed: `tomsjansons/beghu#29` (A), `#30` (B), `#31` (C), and `tomsjansons/pi-advissue-smoke-test#2`
(D, a private repo) for sub-issues and dependencies; `tomsjansons/beghu#32` (E), `#33` (F),
`#34` (G) and `tomsjansons/pi-advissue-smoke-test#3` (H) for "relates to". Creating a
temporary repo webhook to capture real deliveries was refused by the session's permission
policy, so nothing about webhook *deliveries* is verified.

## Answers

1. **Endpoints.** REST, all under `/repos/{owner}/{repo}/issues/{issue_number}/`:
   `GET parent`, `GET sub_issues`, `POST sub_issues`, `DELETE sub_issue` (singular),
   `PATCH sub_issues/priority`, `GET dependencies/blocked_by`, `POST dependencies/blocked_by`,
   `DELETE dependencies/blocked_by/{issue_id}`, `GET dependencies/blocking`. There is no write
   endpoint for "blocking"; you write the other side's `blocked_by`. Every REST issue object
   carries `parent_issue_url`, `sub_issues_summary` and `issue_dependencies_summary`. GraphQL
   `Issue` has `parent`, `subIssues`, `subIssuesSummary`, `blockedBy`, `blocking`,
   `issueDependenciesSummary`; mutations are `addSubIssue`, `removeSubIssue`,
   `reprioritizeSubIssue`, `addBlockedBy`, `removeBlockedBy`. A GitHub App needs repository
   permission **Issues: read** to read and **Issues: write** to change any of these, and the
   same Issues: read to subscribe to the `sub_issues` and `issue_dependencies` webhooks
   (documented). No preview header or `GraphQL-Features` flag is needed today (verified: every
   query here ran without one).
2. **Ordering.** Sub-issues have an explicit, user-controlled order on the parent. A newly
   added sub-issue goes to the end (verified). `PATCH …/sub_issues/priority` with `sub_issue_id`
   plus exactly one of `after_id` / `before_id` moves it (verified; both together is a 422).
   REST `GET sub_issues` and GraphQL `subIssues` return that order (verified). Reordering
   creates no timeline event (verified) and, as far as the docs show, no webhook (documented by
   absence). Dependencies have no manual order: REST lists them oldest-added first (verified);
   GraphQL `blockedBy`/`blocking` default to `DEPENDENCY_ADDED_AT DESC` and also take
   `CREATED_AT` (documented in the schema, verified).
3. **Cross-repo and limits.** Both relationship types work across repos (verified, public ↔
   private repo, same owner). Cross-owner sub-issues are contradictory in the sources: the REST
   reference says "the sub-issue must belong to the same repository owner as the parent issue",
   but the 2025-09-11 changelog says sub-issues "now support cross-organization issues". Not
   verified. A caller who can't see the other issue gets it silently filtered out of lists and
   timelines (verified); `issue_dependencies_summary` counts match what the caller sees, but
   `sub_issues_summary.total` still counts the hidden sub-issue (verified, an inconsistency).
   Limits: 100 sub-issues per parent, 8 levels of nesting (documented); 50 issues per dependency
   type (documented, changelog 2025-08-21). An issue has **at most one parent** (verified: 422
   "Sub issue may only have one parent"); `replace_parent: true` moves it. Cycles are rejected
   for both types, as are self-dependencies and duplicates (verified, 422).
4. **Webhooks and `updated_at`.** Relationship changes fire their own events, not `issues`:
   `sub_issues` with actions `sub_issue_added`, `sub_issue_removed`, `parent_issue_added`,
   `parent_issue_removed`; and `issue_dependencies` with `blocked_by_added`,
   `blocked_by_removed`, `blocking_added`, `blocking_removed` (documented). Payloads carry both
   full issue objects, both numeric ids, and the other side's repository object (documented).
   **Adding, removing, re-parenting or reordering a relationship does not change either issue's
   `updated_at`** in REST or GraphQL (verified for every case). Closing a sub-issue changes the
   parent's `sub_issues_summary.completed` without touching the parent's `updated_at` either
   (verified). Each change appears as a timeline/issue event on **both** issues
   (`sub_issue_added` on the parent, `parent_issue_added` on the child, `blocked_by_added` on
   the blocked issue, `blocking_added` on the blocker; verified), and in the repo-wide
   `GET /repos/{o}/{r}/issues/events` feed of each issue's own repo (verified).
5. **Other sync points.** REST relationship writes and the DELETE path take the issue's
   numeric database `id` (passing a number gives 404, verified); GraphQL takes node ids. Reads
   were briefly stale after writes, about 1 s (verified twice). One GraphQL query for 100 issues
   with `parent`, `subIssues(first:100)`, `blockedBy(first:50)`, `blocking(first:50)` cost 3
   points (verified).
6. **"Relates to"** (GA 2026-09-25) is a true symmetric, undirected link. See section 6.
   - Endpoints: REST `GET`/`POST …/issues/{n}/relates_to` (body `issue_id`) and
     `DELETE …/relates_to/{issue_id}`. GraphQL has `Issue.relatesTo` and the mutations
     `addRelatesTo` / `removeRelatesTo`. Permissions are the same Issues read/write
     (documented).
   - Symmetry: adding E→F makes F list E, either side can remove it, and adding the
     reverse is a duplicate (verified).
   - `updated_at` is unchanged on both issues for every add and remove (verified).
   - Order: REST lists oldest-added first; GraphQL defaults to `RELATES_TO_ADDED_AT DESC`
     (verified).
   - Cross-repo: works between a public and a private repo. A caller who can't see the
     other issue gets it silently dropped from lists and timelines (verified).
   - Errors and overlap: a duplicate in either direction is 422 "The relationship already
     exists", and a self-link is 422 (verified). A pair can also be parent/child or
     blocked/blocking at the same time (verified).
   - Limits: no limit is documented, and the maximum count was not probed.
   - Remove: removing an absent link to a real issue returns 200 (idempotent), and an id
     that doesn't exist returns 404 (verified). GraphQL `removeRelatesTo` repeated also
     succeeds (verified).
   - Events: `relates_to_added` / `relates_to_removed` appear on both issues' timelines
     and in each repo's `issues/events` feed. **They name no other issue at all**: no
     number, no id, no repository (verified). GraphQL has no timeline item type for them
     (verified by introspection).
   - Summary field: the issue object has none (verified; documented by absence).
   - Webhook `issue_relates_to`: a same-repo link sends **one** delivery with both issues.
     A cross-repo link sends one delivery per repo, containing only that repo's issue, so
     the other side is unidentifiable from the payload (documented).

## 1. Read and write surface

### REST

From the OpenAPI description (operation ids in brackets) and `/rest/issues/sub-issues`,
`/rest/issues/issue-dependencies`. Paths are relative to `/repos/{owner}/{repo}/issues/{issue_number}`.

| Operation | Method and path | Body | Notes |
|---|---|---|---|
| Get parent [`issues/get-parent`] | `GET /parent` | | Added 2025-09-11 (changelog) |
| List sub-issues [`issues/list-sub-issues`] | `GET /sub_issues` | | `per_page`, `page` |
| Add sub-issue [`issues/add-sub-issue`] | `POST /sub_issues` | `sub_issue_id` (int, required), `replace_parent` (bool) | 201; returns the **parent** |
| Remove sub-issue [`issues/remove-sub-issue`] | `DELETE /sub_issue` (singular) | `sub_issue_id` | DELETE with a JSON body; returns the parent |
| Reprioritize [`issues/reprioritize-sub-issue`] | `PATCH /sub_issues/priority` | `sub_issue_id`, `after_id` or `before_id` | 503 listed as a possible response |
| List blocked-by [`issues/list-dependencies-blocked-by`] | `GET /dependencies/blocked_by` | | `per_page`, `page` |
| Add blocked-by [`issues/add-blocked-by-dependency`] | `POST /dependencies/blocked_by` | `issue_id` (the blocker) | 201; returns the **blocked** issue |
| Remove blocked-by [`issues/remove-dependency-blocked-by`] | `DELETE /dependencies/blocked_by/{issue_id}` | | 200; returns the blocked issue |
| List blocking [`issues/list-dependencies-blocking`] | `GET /dependencies/blocking` | | read-only |

The issue schema (`components.schemas.issue`) now includes:

- `parent_issue_url`: URI or null. Gives the child → parent edge on every issue fetched in bulk,
  so a mirror can build the tree from the plain issue list without per-issue calls.
- `sub_issues_summary`: `{total, completed, percent_completed}`.
- `issue_dependencies_summary`: `{blocked_by, blocking, total_blocked_by, total_blocking}`.
  `blocked_by`/`blocking` count open issues, the `total_*` fields count open and closed
  (GraphQL descriptions of the same fields).

Error behaviour (verified):

| Case | Result |
|---|---|
| Add a sub-issue that already has a parent | 422 "Sub issue may only have one parent" |
| Add a sub-issue that would form a cycle | 422 "Sub issue may not create a circular dependency" |
| Reprioritize with both `after_id` and `before_id` | 422 "Only the before_id or the after_id argument may be provided, but not both" |
| Blocked-by that would form a cycle | 422 "…would create a cycle where the target is already blocked by the source" |
| Issue blocked by itself | 422 "Target issue cannot be the same as the source issue" |
| Duplicate blocked-by | 422 "Target issue has already been taken" |
| Issue number passed instead of id | 404 |
| Remove a blocked-by that doesn't exist | 200 with the issue (idempotent) |
| Remove a sub-issue that isn't attached | 404 |

The asymmetry in the last two rows matters for retry logic: removing a dependency is safe to
replay, removing a sub-issue is not.

Both write endpoints say "Creating content too quickly using this endpoint may result in
secondary rate limiting" (OpenAPI descriptions). The general content-creation limit is 80
requests per minute and 500 per hour (`/rest/using-the-rest-api/rate-limits-for-the-rest-api`).
All write endpoints except "add sub-issue" are marked `triggersNotification: true` in the
OpenAPI `x-github` block.

### GraphQL

Introspected live:

- `Issue.parent: Issue`
- `Issue.subIssues(first, last, after, before): IssueConnection`. No `orderBy`.
- `Issue.subIssuesSummary: SubIssuesSummary { total, completed, percentCompleted }`
- `Issue.blockedBy(first, last, after, before, orderBy: IssueDependencyOrder)` and
  `Issue.blocking(...)`, both `IssueConnection`. `IssueDependencyOrderField` is
  `DEPENDENCY_ADDED_AT` or `CREATED_AT` (creation time of the other issue). Default
  `{field: DEPENDENCY_ADDED_AT, direction: DESC}`.
- `Issue.issueDependenciesSummary { blockedBy, blocking, totalBlockedBy, totalBlocking }`
- `Issue.trackedIssues` / `trackedInIssues` still exist. These are the older task-list tracking,
  not sub-issues.
- Mutations:
  - `addSubIssue(issueId: ID!, subIssueId: ID, subIssueUrl: String, replaceParent: Boolean)`.
    The child can be given by URL instead of id. Returns `issue`, `subIssue`.
  - `removeSubIssue(issueId: ID!, subIssueId: ID!)`
  - `reprioritizeSubIssue(issueId: ID!, subIssueId: ID!, afterId: ID, beforeId: ID)`
  - `addBlockedBy(issueId: ID!, blockingIssueId: ID!)`, which returns `issue`, `blockingIssue`
  - `removeBlockedBy(issueId: ID!, blockingIssueId: ID!)`
- Timeline item types: `SUB_ISSUE_ADDED_EVENT`, `SUB_ISSUE_REMOVED_EVENT`,
  `PARENT_ISSUE_ADDED_EVENT`, `PARENT_ISSUE_REMOVED_EVENT`, `BLOCKED_BY_ADDED_EVENT`,
  `BLOCKED_BY_REMOVED_EVENT`, `BLOCKING_ADDED_EVENT`, `BLOCKING_REMOVED_EVENT`.

GraphQL schema changelog (`/graphql/overview/changelog/2024`, `/2025`): `parent`, `subIssues`,
`subIssuesSummary`, `addSubIssue`, `reprioritizeSubIssue` were added 2024-12-02; `blockedBy`,
`blocking`, `issueDependenciesSummary`, `addBlockedBy` were added 2025-07-30. `relatesTo`,
`addRelatesTo` and `removeRelatesTo` were added 2026-09-28 (`/graphql/overview/changelog`).

**Preview headers.** During the sub-issues preview, clients sent `GraphQL-Features: sub_issues`
(and `issue_types` for issue types). Not found in current docs. Every query in this probe ran
without the header and returned the fields, so it is no longer needed (verified for reads; no
GraphQL mutations were run).

### Permissions

`/rest/authentication/permissions-required-for-github-apps`, section "Repository permissions
for 'Issues'": every GET above needs Issues **read**, every POST/PATCH/DELETE needs Issues
**write**, and all work with user access tokens and installation access tokens. None needs an
additional permission. The OpenAPI marks all of them `enabledForGitHubApps: true`. The webhook
docs say subscribing to `sub_issues` and `issue_dependencies` requires "at least read-level
access for the 'Issues' repository permissions" (`/webhooks/webhook-events-and-payloads#sub_issues`,
`#issue_dependencies`). Nothing is organization-level, unlike issue types and issue fields.

Inferred: for a cross-repo write, the token needs Issues: write on the repo in the path, and
must at least be able to see the other issue (the add calls return 404 for an id you can't
see). Whether write access to the other repo is also required was not tested; in the probe the
token had write access to both repos.

## 2. Ordering

- **Storage.** The order belongs to the parent and is positional. The API exposes no rank or
  position value, only relative moves (`after_id` / `before_id`). Documented: "reprioritize a
  sub-issue to a different position in the parent list" (OpenAPI).
- **New sub-issues are appended.** A added C, then B: the list was `[C, B]` in REST and
  GraphQL (verified).
- **Reprioritize.** `PATCH …/sub_issues/priority` with `sub_issue_id=B, before_id=C` gave
  `[B, C]` (verified). Exactly one of `after_id`/`before_id` (verified 422 for both; behaviour
  with neither not tested). All three ids are REST database ids; GraphQL takes node ids.
- **Lists return the stored order.** REST `GET sub_issues` and GraphQL `subIssues` matched the
  UI order after each change (verified). `subIssues` has no `orderBy` argument.
- **No event for a reorder.** No timeline event appeared after the reprioritize call
  (verified), and the `sub_issues` webhook has no reorder action (documented). Inferred: a
  mirror only learns of a reorder from someone else by re-listing the parent's sub-issues.
  Nothing pushes it.
- **Dependencies have no user order.** REST listed `blocked_by` as `[30, 2]` (oldest added
  first) and GraphQL as `[2, 30]` (default `DEPENDENCY_ADDED_AT DESC`). Verified. The REST
  order is not documented.

## 3. Cross-repo, visibility, limits

**Cross-repo, same owner: works for both types (verified).** D in private
`pi-advissue-smoke-test` was added as a sub-issue of A in public `beghu`, and A was marked
blocked by D. REST lists returned D with its `repository_url`; GraphQL returned it with
`repository { nameWithOwner }`. The help page for sub-issues describes picking a different
repository in the UI (`/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues`).

**Cross-owner: unclear.**

- REST body description of `sub_issue_id`: "The sub-issue must belong to the same repository
  owner as the parent issue" (OpenAPI and `/rest/issues/sub-issues#add-sub-issue`).
- Changelog 2025-09-11: "Sub-issues now support cross-organization issues, allowing a
  sub-issue to belong to a different organization than its parent."
  (https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/)
- Dependencies: no owner restriction is stated anywhere. The webhook payload has a
  `blocking_issue_repo` field, which implies at least cross-repo.

Inferred: the REST text is older than the changelog and likely stale. A mirror should handle
a related issue in any owner. Not tested, because the account has no org repo to use.

**Visibility (verified, with an anonymous caller standing in for "can't see the private repo").**
After linking D:

| What | Authenticated (sees both) | Anonymous (can't see D) |
|---|---|---|
| `GET /issues/29/sub_issues` | `[30, 2]` | `[30]`, D silently dropped |
| `GET /issues/29/dependencies/blocked_by` | `[30, 2]` | `[30]` |
| `GET /issues/29` `sub_issues_summary.total` | 2 | **2** (counts D) |
| `GET /issues/29` `issue_dependencies_summary.total_blocked_by` | 2 | 1 |
| `GET /issues/29/timeline` | events for both | events naming D omitted |
| `GET …/pi-advissue-smoke-test/issues/2/parent` | | 404 |

No error and no placeholder: hidden issues just vanish from lists. The sub-issue summary
disagrees with the list a caller sees. Re-checked about 12 s later with the same result, so not
a cache artifact (anonymous responses carry `cache-control: public, max-age=60`, but the first
anonymous read came after both links existed). Inferred for beghu: a GitHub App installation
that doesn't cover the other repo will behave like the anonymous caller for private repos,
since installation tokens see only installed repos. A Stub can only be created for related
issues the token can see. A mirror should not treat "summary total > listed rows" as a sync
error.

**Limits (documented, not tested).**

- 100 sub-issues per parent, "up to eight levels of nested sub-issues"
  (`/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues`). Raised from 50 to
  100 on 2024-12-12
  (https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/).
- "You can link up to 50 issues for each relationship type", meaning blocked by and blocking
  (https://github.blog/changelog/2025-08-21-dependencies-on-issues/, the GA announcement).
- One parent per issue (verified, see the error table). The REST and GraphQL flag
  `replace_parent` / `replaceParent` moves a child in one call. That emits
  `parent_issue_removed` then `parent_issue_added` on the child (verified via GraphQL timeline,
  1 s apart). Inferred: it also emits `sub_issue_removed` on the old parent, which the
  repo-level events feed showed on #29 at the same second.

## 4. Webhooks, `updated_at`, events

### Webhook events (documented)

From `/webhooks/webhook-events-and-payloads` and the OpenAPI `x-webhooks` section. Both
events are available to repository, organization and App webhooks.

**`sub_issues`**, actions `sub_issue_added`, `sub_issue_removed`, `parent_issue_added`,
`parent_issue_removed`. Payload: `parent_issue_id`, `parent_issue` (full issue),
`sub_issue_id`, `sub_issue` (full issue), plus `sub_issue_repo` on the `sub_issue_*` actions
or `parent_issue_repo` on the `parent_issue_*` actions, and the usual `repository`,
`installation`, `organization`, `sender`.

**`issue_dependencies`**, actions `blocked_by_added`, `blocked_by_removed`, `blocking_added`,
`blocking_removed`. Payload: `blocked_issue_id`, `blocked_issue`, `blocking_issue_id`,
`blocking_issue`, plus `blocking_issue_repo` on `blocked_by_*` actions or `blocked_issue_repo`
on `blocking_*` actions. The OpenAPI schema lists `organization` as **required** for these
payloads. That would be odd for user-owned repos, and is probably a schema error (unknown).

**`issues`** has no relationship actions (`assigned, closed, deleted, demilestoned, edited,
field_added, field_removed, labeled, locked, milestoned, opened, pinned, reopened, transferred,
typed, unassigned, unlabeled, unlocked, unpinned, untyped`). An App subscribed only to `issues`
sees no relationship changes.

**Which repo receives what (inferred).** Each relationship change produces a pair of actions,
one per side. That matches the timeline, where each side gets its own event (verified), and
the `*_repo` field always describes the *other* side. The inference is that `sub_issue_added`
is delivered for the parent's repository and `parent_issue_added` for the child's, and
likewise `blocked_by_added` for the blocked issue's repo and `blocking_added` for the
blocker's. For a same-repo link, an App would then get both deliveries. GitHub documents this
explicitly only for the newer `issue_relates_to` event: "For relationships between issues in
different repositories, GitHub sends one delivery for each repository." If the inference
holds, an App installed on only one of the two repos still gets one event, from its own side.
Not verified, because the probe webhook was refused.

### `updated_at` (verified)

Timestamps from the probe (REST `updated_at`, confirmed with GraphQL `updatedAt` for A and C):

| Action | A (#29) | B (#30) | C (#31) |
|---|---|---|---|
| Created | 07:48:16 | 07:48:17 | 07:48:18 |
| C added as sub-issue of A (07:48:23) | unchanged | | unchanged |
| A blocked by B (07:48:31) | unchanged | unchanged | |
| B added under A, B reprioritized before C | unchanged | unchanged | unchanged |
| C moved to B with `replace_parent` (07:49:20) | unchanged | unchanged | unchanged |
| Cross-repo links to D, then all removals (07:50:12) | unchanged | unchanged | unchanged |
| C re-added under A, then C closed (07:50:30) | unchanged (summary now `completed: 1`) | | 07:50:31 |

So `GET /repos/{o}/{r}/issues?since=…` and any "sort by updated" reconciliation never sees
relationship changes, or a parent's progress changing when a child closes. The issue's
`sub_issues_summary` and `issue_dependencies_summary` do change, so they can be compared, but
only by refetching.

### Timeline and repo issue events (verified)

- Per issue: `GET /repos/{o}/{r}/issues/{n}/timeline` and `…/{n}/events` include
  `sub_issue_added`, `sub_issue_removed`, `parent_issue_added`, `parent_issue_removed`,
  `blocked_by_added`, `blocked_by_removed`, `blocking_added`, `blocking_removed`
  (OpenAPI schemas `sub-issue-added-issue-event` and so on).
- Repo-wide: `GET /repos/{o}/{r}/issues/events` included all of them, newest first, each with
  `issue.number`. This is one paginated call per repo, which makes it a usable reconciliation
  feed: poll it, and refetch the relationship lists of any issue it names. Each event lands in
  the feed of the repo whose issue it is attached to. The cross-repo `parent_issue_added` and
  `blocking_added` for D appeared only in `pi-advissue-smoke-test`'s timeline, not in
  `beghu`'s feed.
- **The other issue in an event has no id.** The embedded `sub_issue` / `parent_issue` /
  `blocked_by` / `blocking` object has only `number`, `title`, `state`, `state_reason`,
  `issue_type` and a full `repository`. There is no `id` and no `node_id`, so mapping it to a
  mirror row has to go through `(repository.id or full_name, number)`.
- Lag: events were stamped about 1–2 s after the call. The repo feed had not yet shown the
  `replace_parent` events about 15 s after the call, but had them on a later read. So the feed
  can trail by tens of seconds and should not be the 1–2 s path.

## 5. Other things that matter for a mirror

- **Ids.** REST bodies and the DELETE path segment take the numeric database `id` (e.g.
  `5826589572`), not `number`, and not the node id. Webhook payloads give numeric
  `*_issue_id`. GraphQL needs node ids (`I_kwDO…`). REST issue objects have both `id` and
  `node_id`, so the mirror should store both.
- **Write responses.** "Add sub-issue" and "remove sub-issue" return the parent. "Add/remove
  blocked-by" return the blocked issue. Their summary fields were sometimes stale: the
  sub-issue DELETE response showed `total: 2` after a removal. A plain `GET` 1 s after the
  blocked-by POST still showed `blocked_by: 0`, and the same GET 7 s later showed 1. Treat
  post-write reads as eventually consistent for about a second (verified twice; exact window
  unknown).
- **Pagination.** All list endpoints take `per_page`/`page`. Sub-issues fit in one
  `per_page=100` page because of the 100 cap, and dependencies in one page because of the 50
  cap. GraphQL connections use cursors, and `first: 100` covers every case.
- **Cost of a full pull.** REST needs one call per issue per list, three per issue (sub-issues,
  blocked by, blocking) for a full read. Two shortcuts: `parent_issue_url` in the bulk issue
  list gives every child → parent edge for free (but not order), and the summary fields let you
  skip issues with zero counts. GraphQL is far cheaper: a query for 100 issues with `parent`,
  `subIssues(first:100)`, `blockedBy(first:50)` and `blocking(first:50)` cost 3 points (verified
  via `rateLimit { cost }`).
- **Inherited fields.** Sub-issues "inherit the Project and Milestone of their parent issue by
  default" (changelog 2025-09-11). Not tested; the probe parents had no milestone or project.
  If inheritance also applies when an existing issue is attached, it would change the child's
  milestone, and that should arrive as a normal `issues` `milestoned` event.
- **`gh` CLI writes go through the same API.** `gh issue edit --add-sub-issue / --remove-parent /
  --add-blocked-by` and `gh issue create --parent / --blocked-by` exist
  (`/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues`,
  `…/creating-issue-dependencies`; changelog 2026-06-10). Inferred: they produce the same
  webhooks and events as the raw API calls used here.

## 6. "Relates to"

An undirected link that implies no blocking, containment or duplication. Public preview
2026-08-07, GA 2026-09-25. The GA note says it "now works across the REST API, GraphQL API,
webhooks, timeline events, issues search, and projects search"
(https://github.blog/changelog/2026-08-07-connecting-issues-and-multi-select-field-support/,
https://github.blog/changelog/2026-09-25-personal-saved-views-for-repository-issues-and-more/).
No docs.github.com help page for it was found. Probe issues: E = `beghu#32`, F = `#33`,
G = `#34`, H = `pi-advissue-smoke-test#3` (private).

### Endpoints (documented, all exercised)

| Operation | REST | GraphQL |
|---|---|---|
| List | `GET …/issues/{n}/relates_to` (`per_page`, `page`) | `Issue.relatesTo(first, after, last, before, orderBy)` |
| Add | `POST …/issues/{n}/relates_to`, body `issue_id` (database id). 201, returns issue `n` | `addRelatesTo(issueId: ID!, relatedIssueId: ID!)` returns `issue`, `relatedIssue` |
| Remove | `DELETE …/issues/{n}/relates_to/{issue_id}`. 200, returns issue `n` | `removeRelatesTo(issueId: ID!, relatedIssueId: ID!)` |

The OpenAPI files these under the `issues` subcategory, not a subcategory of their own, so
the docs page is `/rest/issues/issues#add-a-related-issue` and so on. Permissions:
Issues **read** for the GET and Issues **write** for POST/DELETE, with user and installation
tokens (`/rest/authentication/permissions-required-for-github-apps`). GraphQL
`relatesTo`/`addRelatesTo`/`removeRelatesTo` entered the schema on 2026-09-28
(`/graphql/overview/changelog`). No preview header was needed (verified).

### Symmetry (verified)

- After `POST /issues/32/relates_to {issue_id: F}`, REST and GraphQL both listed `[33]` on E
  and `[32]` on F.
- Adding the reverse (F→E) gave 422 "The relationship already exists", the same error as
  repeating E→F. There is one undirected edge, not two directed ones.
- Either side can remove it: `DELETE /issues/33/relates_to/{E.id}` removed it from both
  lists. The cross-repo link E–H was removed through H's repo path
  (`pi-advissue-smoke-test/issues/3/relates_to/{E.id}`).
- In GraphQL, `addRelatesTo(issueId: E, relatedIssueId: F)` followed by
  `removeRelatesTo(issueId: F, relatedIssueId: E)`, with the argument order swapped, removed
  it.

### Errors and overlap (verified)

| Case | Result |
|---|---|
| Duplicate, same direction or reversed | 422 "An error occurred while adding the related issue to the issue. The relationship already exists." |
| Self-link | 422 "…Validation failed: Target issue cannot be the same as the source issue" |
| Issue number instead of id | 404 |
| Pair already parent/child (E→G with G a sub-issue of E) | 201, both links coexist |
| Pair already a dependency (F→G with F blocked by G) | 201, both links coexist |
| Remove a link that exists | 200 |
| Remove the same link again, or an existing issue that was never related | 200 (idempotent) |
| Remove an `issue_id` that isn't an issue (`1`) | 404 |
| GraphQL `removeRelatesTo` for a link already gone | succeeds, no error |

Max count: neither the docs nor the changelogs give one. It was not probed, because that would
mean creating dozens of issues in a public repo against the 80/min content limit. The issue
schema's other caps (50 per dependency type) suggest there is one (inferred).

### `updated_at` (verified)

E, F, G and H kept their creation `updated_at` (07:55:08 to 07:55:11) through every add and
remove from 07:55:17 to 07:56:35, via REST and GraphQL, same-repo and cross-repo. This is the
same behaviour as the other two types.

### Ordering (verified)

There is no manual order. REST `GET …/32/relates_to` returned `[33, 34, 3]`, the order they
were added. GraphQL `relatesTo` defaults to `{field: RELATES_TO_ADDED_AT, direction: DESC}`
and returned `[3, 34, 33]`. `orderBy` also accepts `CREATED_AT`, the creation time of the
related issue (schema).

### Cross-repo and visibility (verified)

E (public `beghu`) ↔ H (private repo, same owner) worked. Authenticated, E listed
`[33, 34, 3]` and H listed `[32]`. Anonymously, E listed `[33, 34]`: H was silently dropped.
The anonymous timeline also omitted the `relates_to_added` event for H, while showing the
other two. There is no summary field, so there is no count to disagree with the list.
Cross-owner was not tested, and nothing documents a restriction.

### Summary field (verified)

None. The REST issue object has `sub_issues_summary` and `issue_dependencies_summary` but
nothing for "relates to" (the OpenAPI issue schema has no such field). GraphQL `Issue` likewise
has no `relatesToSummary`. Reading the count means fetching `relatesTo { totalCount }`.

### Timeline and repo events (verified)

- `relates_to_added` and `relates_to_removed` appear in `GET …/issues/{n}/timeline` and
  `…/{n}/events` on **both** issues, and in each repo's `GET /repos/{o}/{r}/issues/events`
  feed. For E–H, the event landed in the private repo's feed too.
- **The event names nothing but itself.** Its keys are `actor, commit_id, commit_url,
  created_at, event, id, node_id, performed_via_github_app, url`. There is no related-issue
  object, number, id or repository, unlike the sub-issue and dependency events. An event tells
  you that issue N's related set changed, and nothing more. Reconciliation has to refetch
  N's `relates_to` list.
- Repeated idempotent removes produced no extra events.
- The OpenAPI issue-event and timeline schemas have no entry for these events, and GraphQL's
  `IssueTimelineItemsItemType` has no `RELATES_TO_*` value, so they can't be read via GraphQL
  `timelineItems` (introspection).

### Webhook `issue_relates_to` (documented, not verified)

From `/webhooks/webhook-events-and-payloads#issue_relates_to` and the OpenAPI `x-webhooks`
section:

- Actions are `relates_to_added` and `relates_to_removed`. Subscribing needs Issues: read.
  Available to repository, organization and App webhooks.
- The payload has `issue_id`, `issue` ("the issue the relationship was added to"),
  `related_issue_id` ("Only present when both issues belong to the same repository"),
  `related_issue`, `repository`, `installation`, `organization`, `sender`. `organization` is
  marked required, as with `issue_dependencies`.
- **Same repo:** "GitHub sends one delivery containing both issues." This differs from the
  other two types, where each change is a pair of actions.
- **Different repos:** "GitHub sends one delivery for each repository. Each cross-repository
  delivery contains only the issue in the repository receiving the delivery and omits the
  related issue, its ID, and its repository details."
- Inferred: for a same-repo link, `issue` is the side the user acted on. Which side that is
  can't be relied on, so treat the pair as unordered.

## Implications for beghu

- **Subscribe the App to `sub_issues`, `issue_dependencies` and `issue_relates_to`** in
  addition to `issues`.
  These are the only push signals for relationship changes. `updated_at`-based catch-up never
  sees them.
- **Apply relationship webhooks directly.** The payload has both full issues and both ids.
  Expect each change to arrive as two deliveries (one per side) when both repos are synced,
  and make applying them idempotent (upsert or delete the edge keyed by
  `(parent_id, child_id)` or `(blocked_id, blocking_id)`).
- **"Relates to" needs a refetch for cross-repo links.** A same-repo delivery has both ids,
  so the edge can be applied directly, keyed as the unordered pair `(min_id, max_id)`. A
  cross-repo delivery has only the local issue. On it, refetch that issue's `relates_to` list
  (or `relatesTo` in GraphQL) and replace its edge set. The timeline and repo events say just
  as little, so reconciliation for this type is "refetch the lists of the issues named in
  `relates_to_*` events".
- **Reorders are invisible to push.** Re-list a parent's sub-issues whenever the mirror touches
  it (a `sub_issues` event on it, or opening it), and in periodic reconciliation.
- **Reconciliation:** poll `GET /repos/{o}/{r}/issues/events` per synced repo for the ten
  relationship event types (eight for sub-issues and dependencies, plus `relates_to_added` and
  `relates_to_removed`) and refetch the named issues' lists. Alternatively, refetch
  relationships via GraphQL periodically (cheap). Resolve sub-issue and dependency targets by
  `(repo, number)`, since those events carry no id; relates-to events carry no target at all.
- **Stubs:** cross-repo targets the installation can't see are dropped by GitHub without any
  signal. The mirror can only make Stubs for issues it can read. Don't derive "has N children"
  from `sub_issues_summary` if it must agree with the listed rows.
- **Writes:** convert numbers to database ids before calling REST. Treat removing a sub-issue
  that isn't attached (404) as success, since a dependency removal already returns 200. After a
  write, update the mirror optimistically from the request rather than re-reading at once.

## Open questions / unverified

- Webhook deliveries themselves: which repo/installation gets which action for cross-repo
  links, whether same-repo links produce two deliveries, the delivery latency, and whether
  `issue_dependencies` fires for user-owned (non-org) repos given the `organization`-required
  schema. Needs a real App or repo webhook (the probe's temporary webhook was refused).
- Cross-owner sub-issues and dependencies (REST text vs. 2025-09-11 changelog). Needs two
  owners.
- What an installation token returns for a related issue in a repo the App isn't installed on
  but that is public. Inferred visible, not tested.
- Whether a cross-repo add needs write access to the other repo, or only read.
- Whether reprioritize with neither `after_id` nor `before_id` errors or is a no-op.
- What happens at the limits (101st sub-issue, 9th level, 51st dependency): presumably a 422,
  not tested.
- What "eight levels of nested sub-issues" counts. beghu assumes it counts the top issue: a chain
  of 8 issues (the top one and 7 levels under it) is the deepest it lets a write make, and it
  refuses a 9th issue before calling. If GitHub allows the top one plus 8 levels (9 issues),
  beghu refuses one level GitHub would take.
- Whether GitHub refuses a dependency loop through other issues (A blocks B, B blocks C, then C
  blocks A) or only a direct one (the verified 422 above). beghu refuses only the direct loop
  before calling, the conservative choice: a longer loop is sent, and GitHub's 422, if it gives
  one, is shown as its refusal. (Fake GitHub refuses both.)
- Whether deleting or transferring an issue emits `*_removed` events or webhooks for its
  relationships, and what happens to the edges.
- GraphQL sub-issue and dependency mutations were not exercised; only their schema was read.
  The relates-to mutations were exercised.
- "Relates to": the maximum number of links per issue (undocumented, not probed), whether
  cross-owner links work, and the actual `issue_relates_to` deliveries (one vs. two per link,
  and which issue is `issue` vs. `related_issue`).
- Exact read-after-write staleness window (observed about 1 s; seen twice, on one account).
