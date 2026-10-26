# SAML SSO and read-only access: what beghu's tokens see

Research date: 2026-10-25. Ticket #72. Sources: docs.github.com (fetched as Markdown through
`https://docs.github.com/api/article/body?pathname=…`, and as HTML for the "Who can use this
feature?" boxes, which the Markdown body drops), GitHub's OpenAPI description
(`github/rest-api-description`, `descriptions/api.github.com/api.github.com.json`, info.version
1.1.4, fetched today), live GraphQL introspection with `gh api graphql`, and read-only probes.
Doc URLs below drop the `https://docs.github.com/en` prefix and are written as `/path`.

Labels: **verified** means observed in a probe today; **documented** means a GitHub doc, the
OpenAPI description or the GraphQL schema says so; **reported** means it comes from user reports in
GitHub's own `cli/cli` issue tracker, not from docs; **inferred** means reasoning only.

Probes (all read-only, or writes that GitHub refused):

- `gh` (the owner's OAuth token, not a GitHub App token) read GraphQL `viewer*` fields and REST
  `permissions` on `kaofelix/pi-fzf` and `cli/cli`, two public third-party repos where the owner
  has only read access.
- A `beghu-dev` installation token read the same fields on `tomsjansons/beghu` and
  `kaofelix/pi-fzf`.
- A `beghu-dev` installation token narrowed to `issues: read` tried a comment, an add-labels call,
  a title PATCH, a state PATCH and a GraphQL `addComment` on the owner's own closed scratch issue
  `tomsjansons/beghu#29`. All of them were refused, the issue is unchanged, and the token was
  revoked afterwards.
- No GitHub App user-to-server token was used. No third-party repo was written to, and no SAML org
  was available.

## Answers

**(a) SAML SSO** (documented and reported only; not observed, since we have no Enterprise Cloud
org). Scope was narrowed to one question: is supporting it trivial?

1. **A SAML-locked org mostly drops out without an error.** If the user had no active SAML
   session when they signed in to beghu, the user token "will not have access to that
   organization". GitHub's advice is to check `GET /user/installations` regularly to see which
   orgs the token can reach (`/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app`).
   A repo list may simply leave the org's repos out
   (`/enterprise-cloud@latest/apps/using-github-apps/saml-and-github-apps`). Direct calls to that
   org fail loudly:
   - REST is documented for classic PATs only: a 404 or a 403, and the 403 carries
     `X-GitHub-SSO` with an authorization URL valid for one hour. Multi-org lists return
     `X-GitHub-SSO: partial-results; organizations=…` (`/rest/authentication/authenticating-to-the-rest-api`).
   - For OAuth tokens, users report a 403 "Resource protected by organization SAML enforcement.
     You must grant your OAuth token access to this organization", sometimes without the header
     (https://github.com/cli/cli/issues/5587, https://github.com/cli/cli/issues/10698).
   - GraphQL (reported) returns HTTP 200 with partial `data`, `null` where the protected nodes
     would be, plus one `errors[]` entry per node: `type: "FORBIDDEN"`,
     `extensions.saml_failure: true` (https://github.com/cli/cli/issues/5587). The probe confirmed
     the `extensions.saml_failure` key exists: it came back `false` on an ordinary permission
     error (verified).
2. **Installation tokens are not affected.** They are "not required" to have SSO authorization
   (`/enterprise-cloud@latest/organizations/managing-programmatic-access-to-your-organization/github-credential-types#sso-authorization`),
   and "access tokens created by apps are automatically authorized for SAML SSO"
   (`/rest/authentication/authenticating-to-the-rest-api`). The import and background sweeps
   would keep working. Only the per-user view needs the user token's answer.
3. **Supporting it is close to trivial.** beghu already scopes each mirror to the repos the
   user's token lists, so a locked org's repos just fall out of scope. The rest is optional:
   - Treat a 403 on a write as a failed write.
   - Add a hint: start a session at `https://github.com/orgs/ORG/sso` (or
     `https://github.com/enterprises/ENT/sso`), then sign in to beghu again. A new sign-in
     creates a credential authorization "for each organization that you have an SSO session
     for", and that authorization is "tied to the specific sign-in session with the app"
     (`/enterprise-cloud@latest/apps/using-github-apps/saml-and-github-apps`). GitHub's
     user-facing steps also say to revoke the app first, which beghu can't do for the user.
   - How long it lasts: the docs say the browser SAML session is "24 hours unless specified
     otherwise by your IdP"
     (`/enterprise-cloud@latest/authentication/authenticating-with-single-sign-on/about-authentication-with-single-sign-on`).
     They don't say whether the app's credential authorization outlives that session, or
     whether it survives a token refresh. Inferred: it is attached to the authorization, so
     refreshes keep it. Not verified.

**(b) Read and triage access.**

1. **Read and triage roles only exist on org-owned repos.** Collaborators on a personal-account
   repo always have write ("Collaborators can't have read-only access to repositories owned by a
   personal account",
   `/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-personal-account-settings/permission-levels-for-a-personal-account-repository`).
   Public repos the user has no explicit role on are not listed by
   `/user/installations/{id}/repositories`. That endpoint lists only repos with "explicit
   permission", meaning owned, collaborator, or through org membership
   (`/rest/apps/installations#list-repositories-accessible-to-the-user-access-token`). So in
   beghu, read and triage users come from org base permissions and from teams or outside
   collaborators given Read or Triage.
2. **Read** can comment, open issues, and close, reopen and edit issues **they authored**.
   On issues authored by others, read can't do any v1 write except comment
   (`/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization`).
   Reopening is limited to issues they closed themselves (same table). That matches the probe:
   on the owner's own PR, closed by the maintainer, `viewerCanReopen` was `false` (verified).
3. **Triage** can also apply labels and milestones, assign, close and reopen any issue, mark
   duplicates, and add sub-issues and dependencies (roles table;
   `/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues`;
   `/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies`). The
   sources disagree on whether triage can edit the title and body of others' issues. The REST
   reference says "Issue owners and users with push access or Triage role can edit an issue"
   (`/rest/issues/issues#update-an-issue`). The UI doc says authors and "people with write
   access or higher"
   (`/issues/tracking-your-work-with-issues/using-issues/editing-an-issue`). **Verified: the UI
   doc is right.** Triage's title/body edit on others' issues is a 200 that changes nothing (section 1).
4. **Many denials are silent 2xx responses.** REST says labels, assignees, milestone and type
   sent without push access are "silently dropped" (`PATCH`/`POST …/issues`) or "silently
   ignored" (`POST`/`DELETE …/assignees`). That conflicts with the roles table, which gives
   triage labels, assignees and milestones. **Verified: the roles table wins.** Triage sets all
   three through every endpoint, and the silent drops happen to Read on their own issues
   (section 1). The response body carries the issue as GitHub stored it, so beghu can detect a drop by
   comparing the response with the request (inferred).
5. **Loud failures** are documented only as status codes. Writes list 403 and/or 404, and
   relationship writes list 403, 404 and 422 (OpenAPI). Role denials are the same 403 `"Resource not
   accessible by integration"` as app-side ones (verified, section 1). App-side denials are verified: 403 `"Resource not accessible by integration"` with
   `X-Accepted-GitHub-Permissions: issues=write; pull_requests=write`, and on GraphQL an HTTP 200
   with `type: "FORBIDDEN"` and the same message.
6. **App ∩ user.** A user token "only has permissions that both the user and the app have"
   (`/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app`).
   The app's Issues: write is a ceiling, and the user's role decides what happens under it. When
   the app lacks a permission, the error is "Resource not accessible by integration" (verified,
   installation token). When the user's role lacks it, the role's own error or silent drop
   applies (documented above).
7. **beghu can know ahead of time**, per repo and per issue, from GraphQL with the user token.
   `Repository.viewerPermission` gives `READ | TRIAGE | TRIAGE_PLUS | WRITE | MAINTAIN | ADMIN`.
   `Issue.viewerCanUpdate`, `viewerCanClose`, `viewerCanReopen`, `viewerCanLabel`,
   `viewerCanAssign`, `viewerCanSetMilestone`, `viewerCanUpdateMetadata` and
   `viewerCannotUpdateReasons` cover the issue (documented schema; verified with the OAuth
   token). REST `permissions` on `/user/installations/{id}/repositories` and `/user/repos` gives
   `pull/triage/push/maintain/admin` (documented). **Installation tokens are useless for this**:
   `viewerPermission` is `null`, REST `permissions` is all `false`, and `viewerCan*` describes the
   bot (verified). There is no per-issue flag for sub-issues, dependencies or "relates to".

## 1. v1 writes by role

Roles: Read, Triage, Write (Maintain and Admin are supersets). "Own" means the user authored the
issue. Every row assumes the app has Issues: write; without it, every write is a 403 "Resource not
accessible by integration" (verified).

**Verified 2026-10-26** for Read and Triage ([Test v1 writes as a read and triage
collaborator](https://github.com/AdvanGrid/beghu/issues/78)). A teammate (`JurisBaltacs`, org
member) signed in to the AdvanGrid dev App `beghu-dev-toms` through the device flow, so every
call used a GitHub App **user-to-server** token. He ran each write on `AdvanGrid/beghu-sandbox`,
first as Read (org base permission), then with Triage granted on that repo, on issues he
authored and on issues the owner authored. Each write was followed by a re-read. The Write column
is still from the docs. Raw results: `.dev/probe-roles/results-{read,triage}.json` (local,
gitignored); the script is `.dev/probe-roles/probe.mjs`.

| Write (REST) | Read, own | Read, others' | Triage (own and others') | Write |
|---|---|---|---|---|
| Comment `POST …/issues/{n}/comments` | 201 | 201 | 201 | yes |
| Labels `POST …/labels` / `DELETE …/labels/{name}` | 403 | 403 | 200 | yes |
| Labels via `PATCH …/issues/{n}` | **200, silently dropped** | 403 | 200, applied | yes |
| Assignees `POST`/`DELETE …/assignees` | 403 | 403 | 201 / 200 | yes |
| Assignees via `PATCH` | **200, silently dropped** | 403 | 200, applied | yes |
| Milestone via `PATCH` | **200, silently dropped** | 403 | 200, applied | yes |
| Close / reopen via `PATCH state` | 200 | 403 | 200 | yes |
| Edit title/body via `PATCH` | 200 | 403 | own: 200; others': **200, silently dropped** | yes |
| Create `POST …/issues` | 201 | — | 201 | yes |
| Create with labels, assignees, milestone | **201, all three silently dropped** | — | 201, all applied | yes |
| Sub-issue add / remove / reorder | 403 (own parent and own child too) | 403 | 201 / 200 / 200 | yes |
| Blocked-by add / remove | 403 (own issues too) | 403 | 201 / 200 | yes |
| "Relates to" add / remove | 403 (own issues too) | 403 | 201 / 200 | yes |

Every 403 above is `"Resource not accessible by integration"` with
`X-Accepted-GitHub-Permissions: issues=write; pull_requests=write` (relationship endpoints:
`issues=write`). That's the same body and header as an app-side denial, although the app *has*
Issues: write. The message can't tell a missing user role from a missing app permission. A
`DELETE` of a sub-issue that was never added is 404.

Notes:

- **The triage conflicts are settled.** Labels, assignees and milestone work for Triage through
  every endpoint, so the roles table is right and REST's "push access, silently dropped" is wrong
  for Triage (it holds for Read on their own issues). Editing others' title/body follows the UI
  doc (write and up), not REST, and fails silently rather than with a 403.
- **A `PATCH` applies partially.** As Triage on an issue by someone else, one `PATCH` with
  `title` and `labels` returned 200 with the labels applied and the title unchanged. The response
  body is the stored issue, so comparing it field by field with the request catches every silent
  drop seen here.
- **Authorship gives no relationship rights.** A Read user gets 403 on sub-issues, dependencies
  and "relates to" even when every issue involved is their own.
- GraphQL mutations (`updateIssue`, `addLabelsToLabelable`, `addAssigneesToAssignable`,
  `closeIssue`, `addSubIssue`, `addBlockedBy`, `addRelatesTo` and the rest) carry no permission
  notes in their schema descriptions (introspected) and weren't probed by role. Failure shape
  (verified for an app-side denial): HTTP 200, `data.<mutation>: null`, and an `errors[]` entry
  with `type: "FORBIDDEN"` and `extensions: { saml_failure: false, ip_allow_list_failure: false }`.
- `TRIAGE_PLUS` is a `RepositoryPermission` value, described as "Can also manage issues and pull
  requests, plus additional triage abilities" (introspected). The docs say no more.
  `viewerCanUpdateMetadata` "reflects the viewer's base repository role and does not account for
  individual fine-grained permissions granted via custom repository roles" (schema). Custom roles
  are Enterprise Cloud only (roles page).

## 2. What beghu can know in advance

Observed values (`viewer*` from GraphQL, `perms` from REST `GET /repos/{o}/{r}`). For the
user-to-server rows, every outcome in section 1 matched what these fields predicted, silent
drops included (verified):

| Token | Repo / issue | `viewerPermission` | `perms` | Issue `viewerCan*` |
|---|---|---|---|---|
| gh OAuth (owner, read role) | `kaofelix/pi-fzf`, issue #6 by someone else | `READ` | `pull` only | `Update/Close/Reopen/Label/Assign/SetMilestone/UpdateMetadata/Type` all `false`; `viewerCannotUpdateReasons: [INSUFFICIENT_ACCESS]` |
| gh OAuth (owner, read role) | `kaofelix/pi-fzf`, own PR #5, closed by the maintainer | `READ` | | `viewerCanUpdate: true`, `viewerCanClose: true`, `viewerCanReopen: false`, `Label`/`Assign: false` |
| gh OAuth (owner, read role) | `cli/cli` #10000 | `READ` | | same as `pi-fzf` #6 |
| beghu-dev installation | `tomsjansons/beghu` #29 | `null` | all `false` (also on `/installation/repositories`) | `Update/Close/Reopen/Label/Assign/SetMilestone: true`, `viewerCanUpdateMetadata: false` |
| beghu-dev installation | `kaofelix/pi-fzf` (not installed) | `null` | all `false` | all `false`, `INSUFFICIENT_ACCESS`; `viewerCanCreateIssues: true` (meaningless for a bot) |
| App user-to-server (`beghu-dev-toms`), Read | `beghu-sandbox`, owner's issue | `READ` | `pull` only | all `false`, `INSUFFICIENT_ACCESS` |
| App user-to-server, Read | `beghu-sandbox`, own issue | `READ` | `pull` only | `Update`/`Close: true`; `Reopen`, `Label`, `Assign`, `SetMilestone`, `UpdateMetadata: false` |
| App user-to-server, Triage | `beghu-sandbox`, owner's issue | `TRIAGE` | `pull`, `triage` | `Update: false` (`INSUFFICIENT_ACCESS`); `Close`, `Reopen`, `Label`, `Assign`, `SetMilestone`, `UpdateMetadata: true` |
| App user-to-server, Triage | `beghu-sandbox`, own issue | `TRIAGE` | `pull`, `triage` | all `true` |

What to use:

- **Per repo, at import and on each re-list:** the `permissions` object from
  `/user/installations/{id}/repositories`, which is documented as "The access the user has to each
  repository". It has a `triage` flag. Store it on the synced repo for the account. It changes
  without a webhook unless the app has org Members: read (see `github-app-mechanics.md`), so
  re-read it on the same schedule as the accessible-repo set.
- **Per issue, when it matters:** GraphQL `viewerCanUpdate` (title/body), `viewerCanClose` /
  `viewerCanReopen`, `viewerCanLabel`, `viewerCanAssign`, `viewerCanSetMilestone` and
  `viewerCanUpdateMetadata` with the **user** token. These capture "own issue" for free. They
  must be read with the user token: the installation token's answers describe the bot (verified).
  `viewerCanUpdateMetadata` is `false` for the bot even with Issues: write, so it isn't a stand-in
  either (verified).
- **No flag for relationships.** Gate sub-issues, dependencies and "relates to" on
  `viewerPermission >= TRIAGE` (verified on one repo: Read gets 403 on all three, Triage
  succeeds). Include both repos for cross-repo links: `parent` on create says triage is needed
  "to both" repos (documented). Whether the add and remove endpoints need it on both is
  unverified.
- **After every write:** compare the returned issue with the request (labels, assignees,
  milestone, title, body), since a silent drop comes back as 2xx and a `PATCH` can apply only
  some of its fields (verified). Treat a mismatch as a failed write with a "you don't have
  permission" reason.
- **Don't read a 403's message.** "Resource not accessible by integration" comes back for both a
  missing app permission and a missing user role (verified), so the reason shown to the user comes
  from `viewerPermission` / `viewerCan*`, not from the error.

## Open items / unverified

- Cross-repo relationships where the user's role differs between the two repos (Triage on one,
  Read on the other). Only same-repo links were probed.
- GraphQL mutations by role (beghu's v1 writes are REST).
- The Write column of section 1 (docs only; nobody doubts it).
- SAML (lower priority, docs and reports only): the exact REST status, body and `X-GitHub-SSO`
  for a user-to-server token; whether `GET /user/installations` omits the locked org or lists it
  and only its repos fail; and whether the credential authorization survives refreshes and the
  IdP's session length.
