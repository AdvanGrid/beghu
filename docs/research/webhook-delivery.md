# Webhook delivery for beghu: latency, relationships, retention

Measured 2026-10-13 against the `beghu-dev` GitHub App (id 5297723, private, owned by
`tomsjansons`), installed on `tomsjansons/beghu` and `tomsjansons/lang-exp`. The app was registered
from [`github-app/manifest.json`](../../github-app/manifest.json) by
[`github-app/create-app.mjs`](../../github-app/create-app.mjs), with its webhook pointing at a
smee.io channel. The probe scripts are in [`github-app/probe/`](../../github-app/probe/). Raw
results are in `.dev/probe/` (gitignored).

## Answers

1. **Latency: GitHub to smee took 0.5–2.0 s, median 1.3 s.** That is over 24 edits that each
   make one API call, timed from the moment the call returned. p90 was 1.8 s. smee to this
   machine adds about 60 ms. All 40 edits got their webhook, and none came twice. Edits made
   with `gh` and with plain REST behave the same. GitHub's delivery log shows 73 deliveries, all
   `200`, none redelivered. **So webhooks alone use up most of the 1–2 s budget.** A change made
   outside beghu reaches the server in about 1.3 s typically and 2 s at worst, before any
   processing or push to the browser.
2. **Sub-issues and dependencies send two deliveries per change, one for each side.** Adding a
   sub-issue sends `sub_issue_added` (the parent's side) and `parent_issue_added` (the
   child's). Dependencies send `blocked_by_added` and `blocking_added`, and removals send the
   matching `*_removed` pair. Both arrive within about 0.3–1.2 s.
3. **A cross-repo delivery doesn't name the other issue.** In a same-repo change, both
   deliveries carry both issues as full objects. In a cross-repo change, each repo's delivery
   carries only its own issue, and the other issue is absent: there is no object and no id. The
   parent's repo gets `sub_issue_added` with only `parent_issue`, and the child's repo gets
   `parent_issue_added` with only `sub_issue`. Dependencies work the same way. To find the
   other end, beghu has to pair the two deliveries (which arrive within about 0.5 s of each
   other, but only if both repos are installed) or read the relationship again from the API,
   for example `GET …/issues/{n}/sub_issues` or `…/dependencies/blocked_by`. When only one
   repo is synced, the API read is the only way to get the stub.
4. **Relationship changes never bump `updated_at`**, on either issue, for any of the three
   kinds, whether same-repo or cross-repo. A `since=`-based reconciliation won't see them.
5. **Relates-to has its own event, `issue_relates_to`, and the app must subscribe to it.** The
   first run was missing it from the manifest and got nothing. After subscribing, a same-repo
   link sends **one** delivery carrying both issues (`issue` and `related_issue`). A cross-repo
   link sends one delivery to each repo, and each carries only its own `issue`, the same split
   as in Answer 3. Deliveries arrived 0.4–0.8 s after the change. `relates_to_added` and
   `relates_to_removed` also appear on the timeline. The event is now in `manifest.json`.
6. **Retention of `GET /app/hook/deliveries` is still open.** The app is new and has no
   deliveries older than today. To settle 3 days vs 7, run
   `node github-app/probe/app.mjs "/app/hook/deliveries?per_page=100" --all` on or after
   2026-10-17 and check whether the oldest delivery, the ping at 2026-10-13T08:22:19Z, is still
   listed.

## Setup notes

- **The manifest flow works as documented.** GitHub accepted every requested permission and
  event, including `sub_issues` and `issue_dependencies`. `issue_relates_to` was added later in
  the app settings, and it's in the manifest now. The redirect and callback can use a
  plain-HTTP internal hostname (`http://devinator.i.advangrid.com:4567/created`,
  `…:3000/auth/callback`). Credentials land in `.dev/github-app/<slug>.{json,pem}`.
- **smee.io worked for dev with no setup.** A channel is just a URL (`curl -sI
  https://smee.io/new`), and the listener reads it as server-sent events. The smee hop added
  about 60 ms.
- **App-JWT calls work with the client id as `iss`** (`github-app/probe/app.mjs`).

## Latency detail

Time from the API call returning to smee receiving the webhook, in ms.

| Edit | Via | Samples (ms) |
| --- | --- | --- |
| Comment | `gh issue comment` | 1155, 1008, 914, 1307 |
| Comment | REST `POST …/comments` | 1814, 1473, 1802, 1761 |
| Title edit | `gh issue edit -t` | 1019, 1964, 1767, 1838 |
| Body edit | REST `PATCH …/issues/{n}` | 1416, 1567, 1328, 1764 |
| Close | `gh issue close` | 660, 750, 626, 640 |
| Reopen | `gh issue reopen` | 825, 652, 496, 559 |
| Label add/remove | `gh issue edit --add/--remove-label` | 281–584 (8 samples) |
| Assign/unassign | `gh issue edit --add/--remove-assignee` | −761 to 80 (8 samples) |

`gh issue edit` for labels and assignees makes several API calls, so the webhook can arrive
before `gh` exits. That is why those times are small or negative. They are left out of the
summary in Answer 1.

## Relationship detail

Source issues: `beghu#37` (A), `beghu#38` (A2), `lang-exp#29` (B). Each change was followed by
a 20 s window, and `updated_at` was read before and after.

| Change | Deliveries (repo: action) | `updated_at` bumped |
| --- | --- | --- |
| Sub-issue add, same repo | beghu: `sub_issue_added`, `parent_issue_added` | no |
| Sub-issue remove, same repo | beghu: `sub_issue_removed`, `parent_issue_removed` | no |
| Sub-issue add, cross repo | lang-exp: `parent_issue_added`; beghu: `sub_issue_added` | no |
| Sub-issue remove, cross repo | lang-exp: `parent_issue_removed`; beghu: `sub_issue_removed` | no |
| Blocked-by add, same repo | beghu: `blocked_by_added`, `blocking_added` | no |
| Blocked-by remove, same repo | beghu: `blocked_by_removed`, `blocking_removed` | no |
| Blocked-by add, cross repo | lang-exp: `blocking_added`; beghu: `blocked_by_added` | no |
| Blocked-by remove, cross repo | beghu: `blocked_by_removed`; lang-exp: `blocking_removed` | no |
| Relates-to add, same repo | beghu: `relates_to_added` (one delivery) | no |
| Relates-to remove, same repo | beghu: `relates_to_removed` (one delivery) | no |
| Relates-to add, cross repo | beghu: `relates_to_added`; lang-exp: `relates_to_added` | no |
| Relates-to remove, cross repo | beghu: `relates_to_removed`; lang-exp: `relates_to_removed` | no |

The relates-to rows come from a second run after subscribing the app to `issue_relates_to`. In
the first run, without the subscription, relates-to changes produced no deliveries.

Payload keys besides `repository`, `sender` and `installation`:

- Same repo, sub-issues: `parent_issue_id`, `parent_issue`, `sub_issue_id`, `sub_issue`.
- Cross repo, sub-issues: the parent's repo gets only `parent_issue_id`, `parent_issue`, and
  the child's repo gets only `sub_issue_id`, `sub_issue`.
- Same repo, dependencies: `blocked_issue_id`, `blocked_issue`, `blocking_issue_id`,
  `blocking_issue`, plus `blocking_issue_repo` (on `blocked_by_*`) or `blocked_issue_repo` (on
  `blocking_*`).
- Cross repo, dependencies: the blocked issue's repo gets only `blocked_issue_id`,
  `blocked_issue`, and the blocking issue's repo gets only `blocking_issue_id`,
  `blocking_issue`.
- Same repo, relates-to: `issue_id`, `issue`, `related_issue_id`, `related_issue`.
- Cross repo, relates-to: each repo gets only `issue_id`, `issue`. In this run, both deliveries
  of a cross-repo pair had GUIDs with the same leading timestamp segment (`d4202120-c6e2-11f1-…`),
  but GitHub doesn't document that, so don't use it for pairing.
