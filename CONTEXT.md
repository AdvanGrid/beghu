# beghu

A fast frontend for GitHub issues, for one person and a few teammates. GitHub is the source of truth; beghu keeps disposable copies of its data so the app can be fast.

## Language

**Connected account**:
A GitHub account that has signed in to beghu and whose repos it syncs.
_Avoid_: User, tenant

**Dormant account**:
A connected account nobody has used beghu as for 30 days. Its mirror is deleted and it receives no webhooks or sweeps; using it again re-imports its synced repos.
_Avoid_: Inactive account, idle account

**Synced repo**:
A repo whose issues and PRs beghu copies into a mirror.
_Avoid_: Tracked repo, watched repo

**Role**:
A connected account's permission on a synced repo: Read, Triage, or Write and up. With authorship, the repo's archived flag and the issue's locked flag, it decides which writes beghu offers on an issue.
_Avoid_: Access level, permission set

**Mirror**:
The server-side copy of a connected account's GitHub data. It is disposable and can always be rebuilt from GitHub.
_Avoid_: Database, replica, backend store

**Relationship**:
A link between two issues: a sub-issue (parent/child), a dependency (blocked by / blocking), or "relates to" (symmetric, no direction).
_Avoid_: Link, edge

**Stub**:
A placeholder for an issue in a repo that isn't synced, reached through a relationship. It has a title and a link out to GitHub.
_Avoid_: Ghost, external issue

**Linked PR**:
A PR that will close an issue when it merges, through a closing keyword in its body ("closes #12") or a manual link in GitHub's Development sidebar. Read-only in beghu, and not a relationship.
_Avoid_: Closing reference, development link, PR relationship

**Pending write**:
A change the user made in beghu that GitHub hasn't confirmed yet. It shows at once, lives only in the tab that made it, and reverts visibly if GitHub refuses it.
_Avoid_: Outbox entry, queued write

**Failed write**:
A pending write that GitHub refused, or that never reached GitHub. Its change is reverted, but it stays visible with Retry until the user retries or dismisses it, or reloads the tab.
_Avoid_: Error, rejected op

**Fake GitHub**:
A stand-in for GitHub used in local dev and CI. It keeps its own copy of the fixture, answers the API calls beghu makes, signs in fixture users and sends webhooks back, with latency and failures set at runtime. Never used in production.
_Avoid_: Mock GitHub, GitHub stub, stand-in

**Held change**:
A layout change from a live update that waits while the user is in intent mode, so nothing moves under the pointer: a list's order changing (an issue moving, arriving or leaving), or the detail growing or shrinking (new comments, a body edit). It applies in reading mode, behind a shift cue and then animated. Changes to contents that don't move layout are never held, and neither is a change wholly off-screen: it applies at once and the reading position is kept.
_Avoid_: Frozen order, pending reorder

**Intent mode**:
The user may be about to act: the pointer is moving or has rested under 5 s, a press or selection is in progress, or a key was pressed in the last 5 s. Held changes wait.
_Avoid_: Busy, active

**Reading mode**:
The pointer has been still for 5 s or more, with no keys or presses. Held changes apply, each behind a shift cue.
_Avoid_: Idle

**Shift cue**:
A still mark at the exact spot of a held change, shown for a moment before it applies: a line where something will open (a comment, a paragraph, a row, a first blocker) and an outline on what will go. It marks only the part that changes, such as one property line, never a whole section around it.
_Avoid_: Warning, toast, transition indicator

**Match mode**:
How a search's text affects the list order: Blend (match field weighted against age on the sort key), Best match (title matches, then body, then comment), or Off (the text only filters).
_Avoid_: Relevance, search ranking

**Preference**:
A choice a user makes about how beghu looks or behaves for them. A device preference (theme, divider and column widths, tree expand state) stays in the browser where it was set. An account preference (comment order, key bindings) is stored per connected account on the server and follows that account to every browser.
_Avoid_: Setting, user config
