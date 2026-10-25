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
   (`/issues/tracking-your-work-with-issues/using-issues/editing-an-issue`).
4. **Many denials are silent 2xx responses.** REST says labels, assignees, milestone and type
   sent without push access are "silently dropped" (`PATCH`/`POST …/issues`) or "silently
   ignored" (`POST`/`DELETE …/assignees`). That conflicts with the roles table, which gives
   triage labels, assignees and milestones. Which side wins for triage is the main unverified
   point. The response body carries the issue as GitHub stored it, so beghu can detect a drop by
   comparing the response with the request (inferred).
5. **Loud failures** are documented only as status codes. Writes list 403 and/or 404, and
   relationship writes list 403, 404 and 422 (OpenAPI). The exact role-denial messages were not
   observed. App-side denials are verified: 403 `"Resource not accessible by integration"` with
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
accessible by integration" (verified). "Docs" codes are the ones the OpenAPI description lists.
None of the role outcomes were observed with a write; they come from the docs cited.

| Write (REST) | Read | Triage | Write | Failure shape (documented) | Source |
|---|---|---|---|---|---|
| Comment `POST …/issues/{n}/comments` | yes | yes | yes | 403, 404, 410, 422. A locked issue takes comments only from write and above (`LOCKED`); 410 when issues are disabled | roles table ("Lock conversations": write); `RepositoryPermission.READ` "can also open and comment"; OpenAPI |
| Add labels `POST …/labels` / remove `DELETE …/labels/{name}` | no | yes (roles table) | yes | Docs codes 200, 301, 404, 410, 422; no 403 listed. What a read user gets is **unverified** (error or no-op) | roles table "Apply/dismiss labels"; `/issues/using-labels-and-milestones-to-track-work/managing-labels` |
| Labels via `PATCH …/issues/{n}` (`labels`) | no, silent | **conflict**: REST says push only, so silently dropped | yes | 200 with labels unchanged | `/rest/issues/issues#update-an-issue` |
| Assignees `POST`/`DELETE …/assignees` (or `PATCH assignees`) | no, silent | **conflict**: roles table yes, REST "Only users with push access… silently ignored" | yes | 201/200 with assignees unchanged | `/rest/issues/assignees#add-assignees-to-an-issue`; roles table "Close, reopen, and assign all issues" |
| Milestone via `PATCH` (`milestone`) | no, silent | **conflict**: roles table "Apply milestones" yes, REST push only | yes | 200 with milestone unchanged | `/rest/issues/issues#update-an-issue` |
| Close / reopen via `PATCH state` | own only; reopen only if they closed it | yes, any | yes | 403 or 404 (message unverified) | roles table; `/issues/tracking-your-work-with-issues/administering-issues/closing-an-issue` |
| Edit title/body via `PATCH` | own only | own yes; others **conflict** (REST yes, UI doc write+) | yes | 403 or 404 (message unverified) | `/rest/issues/issues#update-an-issue`; `/issues/…/editing-an-issue` |
| Create issue `POST …/issues` | yes | yes | yes | Labels, assignees, milestone and type are silently dropped without push; `parent` needs triage on both repos. 403 when blocked, 410 when issues are disabled | `/rest/issues/issues#create-an-issue` |
| Sub-issue add / remove / reorder (`POST sub_issues`, `DELETE sub_issue`, `PATCH sub_issues/priority`) | no (own parent: undocumented) | yes | yes | 403, 404, 422 | `/issues/…/adding-sub-issues` ("at least triage"); `/rest/issues/sub-issues` |
| Blocked-by add / remove (`POST`/`DELETE …/dependencies/blocked_by`) | no (own: undocumented) | yes | yes | 403, 404, 422 (DELETE also 400, 401) | `/issues/…/creating-issue-dependencies` ("at least triage"); `/rest/issues/issue-dependencies` |
| "Relates to" add / remove (`POST`/`DELETE …/relates_to`) | undocumented | undocumented (inferred: triage, like the other relationships) | yes | 403, 404, 422 (DELETE also 400) | `/rest/issues/issues#add-a-related-issue` |

Notes:

- The roles table is the UI permission matrix. The "silently dropped" notes are REST-specific.
  GitHub has not reconciled the two in the docs. The triage rows marked "conflict" are where a
  live test matters most.
- GraphQL mutations (`updateIssue`, `addLabelsToLabelable`, `addAssigneesToAssignable`,
  `closeIssue`, `addSubIssue`, `addBlockedBy`, `addRelatesTo` and the rest) carry no permission
  notes in their schema descriptions (introspected). Failure shape (verified for an app-side
  denial): HTTP 200, `data.<mutation>: null`, and an `errors[]` entry with `type: "FORBIDDEN"`
  and `extensions: { saml_failure: false, ip_allow_list_failure: false }`.
- `TRIAGE_PLUS` is a `RepositoryPermission` value, described as "Can also manage issues and pull
  requests, plus additional triage abilities" (introspected). The docs say no more.
  `viewerCanUpdateMetadata` "reflects the viewer's base repository role and does not account for
  individual fine-grained permissions granted via custom repository roles" (schema). Custom roles
  are Enterprise Cloud only (roles page).

## 2. What beghu can know in advance

Observed values (`viewer*` from GraphQL, `perms` from REST `GET /repos/{o}/{r}`):

| Token | Repo / issue | `viewerPermission` | `perms` | Issue `viewerCan*` |
|---|---|---|---|---|
| gh OAuth (owner, read role) | `kaofelix/pi-fzf`, issue #6 by someone else | `READ` | `pull` only | `Update/Close/Reopen/Label/Assign/SetMilestone/UpdateMetadata/Type` all `false`; `viewerCannotUpdateReasons: [INSUFFICIENT_ACCESS]` |
| gh OAuth (owner, read role) | `kaofelix/pi-fzf`, own PR #5, closed by the maintainer | `READ` | | `viewerCanUpdate: true`, `viewerCanClose: true`, `viewerCanReopen: false`, `Label`/`Assign: false` |
| gh OAuth (owner, read role) | `cli/cli` #10000 | `READ` | | same as `pi-fzf` #6 |
| beghu-dev installation | `tomsjansons/beghu` #29 | `null` | all `false` (also on `/installation/repositories`) | `Update/Close/Reopen/Label/Assign/SetMilestone: true`, `viewerCanUpdateMetadata: false` |
| beghu-dev installation | `kaofelix/pi-fzf` (not installed) | `null` | all `false` | all `false`, `INSUFFICIENT_ACCESS`; `viewerCanCreateIssues: true` (meaningless for a bot) |

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
  `viewerPermission >= TRIAGE` (inferred from the "at least triage" docs). Include both repos for
  cross-repo links: `parent` on create says triage is needed "to both" repos (documented). Whether
  the add and remove endpoints need it on both is unverified.
- **After every write:** compare the returned issue with the request (labels, assignees,
  milestone), since a silent drop comes back as 2xx. Treat a mismatch as a failed write with a
  "you don't have permission" reason (inferred).

## Open items / unverified

- **No role-level write was observed.** Every read/triage outcome above is from the docs. A
  follow-up needs:
  1. An org owned by the owner (a free org has Read and Triage roles) with one test repo.
  2. A second GitHub account added to that repo as an outside collaborator, first with Read,
     then with Triage.
  3. That account running each write in the table on (a) an issue it authored and (b) an issue
     the owner authored. Record status, body and `X-Accepted-GitHub-Permissions`, and re-read the
     issue to catch silent drops.

  Doing this with the second account's `gh` token tests the role layer alone. Testing the app ∩
  user path needs beghu-dev installed on that org. A private app installs only on its owning
  account (`github-app-mechanics.md`), so that means making beghu-dev public or registering a
  dev app owned by the org.
- The triage conflicts: labels, assignees and milestone via REST ("push access, silently
  dropped") against the roles table, and title/body edits on others' issues (REST against the UI
  doc).
- Whether a read user's `POST …/labels` errors (and with what) or quietly does nothing. The
  OpenAPI lists no 403 for it.
- Whether an issue author with read access can add sub-issues, dependencies or "relates to" on
  their own issue. The docs say "at least triage" and don't mention authors.
- What `viewerPermission` and the `viewerCan*` fields return for a GitHub App **user-to-server**
  token. The schema says `viewerPermission` is null only "if authenticated as an GitHub App".
  Only the OAuth token and the installation token were probed.
- SAML (lower priority, docs and reports only): the exact REST status, body and `X-GitHub-SSO`
  for a user-to-server token; whether `GET /user/installations` omits the locked org or lists it
  and only its repos fail; and whether the credential authorization survives refreshes and the
  IdP's session length.
