# Issue edge cases for the beghu mirror: delete, transfer, convert to discussion, renames

Measured 2026-10-15 on two throwaway private repos, `tomsjansons/beghu-scratch-a` and
`tomsjansons/beghu-scratch-b`, each with a repo webhook (all events) pointing at a smee.io
channel. The probe script is [`github-app/probe/edges.mjs`](../../github-app/probe/edges.mjs).
Raw deliveries and results are in `.dev/probe-edges/` (gitignored). Conversion to a discussion
has no API, so that step was done by hand in the web UI. Payloads were checked against
`@octokit/webhooks-schemas` 7.6.1. This fills in what
[the import and reconciliation doc](mirror-import-and-reconciliation.md#3-deleted-transferred-and-converted-issues-repo-level-changes)
couldn't test read-only.

## Answers

1. **Delete sends one `issues.deleted` and the old number answers 410.** The payload is
   `{action, issue, repository, sender}`, with the full issue as it was. Afterwards REST
   `GET …/issues/{n}` returns **410** `{"message":"This issue was deleted"}` to the repo owner.
   GraphQL by number and `node(id:)` both return `NOT_FOUND`. The issue had no links, so whether
   a delete also sends relationship `*_removed` events is untested.
2. **Transfer keeps every link, but only some of them are announced again.** The issue had a
   parent, a sub-issue, a blocked-by, a blocking and a relates-to, all in the source repo.
   After the transfer the new issue (new number, `id` and `node_id`) has all five, and each
   linked issue now points at the new issue. No linked issue's `updated_at` moved. The
   deliveries, in arrival order, measured from the mutation returning:
   - 2.9 s, destination repo: **`issues.opened`** for the new issue, with
     `changes.old_issue` and `changes.old_repository`. This arrives **before**
     `issues.transferred`.
   - 3.2–3.9 s: **`issue_dependencies` `blocked_by_added` and `blocking_added`**, one per side
     per link, with the usual cross-repo split (each repo's delivery carries only its own
     issue). No `*_removed` was sent for the old issue.
   - 4.5 s: **`issue_relates_to` `relates_to_added`**, one per repo, again each carrying only
     its own issue.
   - 6.0 s, source repo: **`issues.transferred`**, with the old `issue` plus
     `changes.new_issue` and `changes.new_repository`.
   - **No `sub_issues` delivery at all**, for either the parent link or the child link.

   Afterwards REST `GET` on the old number returns **301** with `Location` set to the new issue
   (`gh api` follows it silently). GraphQL by the old number and by the old `node_id` return
   `NOT_FOUND`.
3. **The payloads match the octokit schema in structure.** Every captured payload
   (`issues.opened/deleted/transferred/closed/locked`, `label.edited`, `milestone.edited`,
   `discussion.created/labeled`) fails strict validation, but only because GitHub has since
   added fields (`sub_issues_summary`, `issue_dependencies_summary`, `pinned_comment`,
   `user_view_type`, `has_pull_requests`, label `archived_at`). Plain `issues.opened` fails the
   same way. With additional properties allowed, the only error left is `repository` missing
   `custom_properties`, which personal-account repos don't have. `issue_dependencies` and
   `issue_relates_to` have no schema in 7.6.1. So beghu should parse with lenient,
   hand-written types rather than strict octokit validation.
4. **Converting to a discussion doesn't remove the issue.** It creates a **new discussion with
   a new number** (#12 from issue #8), copying the title, body and labels. The issue stays as a
   **closed, locked issue**: REST returns **200**, it's still listed by
   `issues?state=all`, keeps its label and milestone, and **stays a sub-issue of its parent**.
   Its timeline gains `locked` and `converted_to_discussion`. The deliveries were
   `discussion.created`, `discussion.labeled`, then **`issues.locked`** and **`issues.closed`**
   (`state_reason: "completed"`, `active_lock_reason: null`). There was no `issues.deleted` and
   no relationship event. The parent's `updated_at` didn't move. A `closed` payload doesn't say
   the issue was converted. Only the timeline event does. The discussion doesn't take over the
   issue's number, so conversion leaves no gap in issue numbers.
5. **Label and milestone renames bump nothing on the issues that carry them.** A rename sends
   exactly one `label.edited` (with `changes.name.from`, plus `changes.color.from` when the
   colour changes) or `milestone.edited` (with `changes.title.from`), and no `issues.*`
   delivery. `updated_at` on both carrying issues was unchanged, and REST shows the new name
   on them immediately. So a `since` sweep never sees a rename. The mirror has to apply it
   from the webhook (or a label/milestone list sweep) to one label or milestone row, which
   works only if issues reference labels and milestones by id rather than copying the name.

## What this means for the mirror

- **Transfer has to be handled from either end, in either order.** `issues.opened` with
  `changes.old_issue` arrives first and carries everything needed (old id, new issue), so
  treat it and `issues.transferred` as the same event and make the handler idempotent.
  Because sub-issue links get no webhook, the handler should re-point every edge from the old
  id to the new id (the links all survive), or re-read the new issue's five relationship
  lists in one GraphQL query. The re-sent `*_added` deliveries for dependencies and
  relates-to are then duplicates and must be no-ops.
- **When the destination repo isn't synced**, only `issues.transferred` arrives. The old item
  becomes a stub for the new one, and its edges now point at that stub.
- **Delete** tombstones the item. 404 and 410 both mean gone.
- **A converted issue is just a closed issue** to the mirror. It keeps its edges, and the
  count check doesn't change. Showing "converted to discussion" would take a timeline read,
  which v1 has no need for.

## Not tested

- Relationship events when an issue with links is deleted.
- Transfer to a repo the app isn't installed on, and transfer of an issue with cross-repo
  links.
- Behaviour in an org repo, where deletion needs an owner setting first.
