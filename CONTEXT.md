# beghu

A fast frontend for GitHub issues, for one person and a few teammates. GitHub is the source of truth; beghu keeps disposable copies of its data so the app can be fast.

## Language

**Connected account**:
A GitHub account that has signed in to beghu and whose repos it syncs.
_Avoid_: User, tenant

**Browser session**:
One browser's sign-in to beghu, held in its session cookie. It carries every connected account signed in on that browser, one of them active. URLs carry no account: each tab works as the account that was active when it loaded, and a tab left on another account goes stale and freezes its writes.
_Avoid_: Login, user session

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
A pending write that didn't go through: GitHub refused it, it never reached GitHub, or beghu can't tell whether it did (a lost write, a maybe-posted comment). Its change is reverted, but it stays visible until the user retries or dismisses it, or reloads the tab. It offers Retry, except where sending it again can't work, or a comment may already be in the thread and hasn't yet looked for itself there.
_Avoid_: Error, rejected op

**Lost write**:
A failed write beghu lost track of: the server restarted while it was on its way, or had forgotten it (past 10 minutes, or past the 500 writes per account it remembers) when the tab sent it again, or the tab's resends went unanswered for 9 minutes. It may or may not have reached GitHub, so it's never sent again on its own; it says to check, and a lost comment looks for itself in the thread first.
_Avoid_: Dropped write, orphaned op

**Maybe-posted comment**:
A comment GitHub may have posted though beghu can't confirm it: GitHub answered with a 5xx or an answer beghu couldn't read, or didn't answer at all. It's never sent again on its own. It looks for itself in the thread, among the comments newer than any it could be confused with: exactly one by the same account with its text, and it shows as posted; none, or more than one, and it offers Retry.
_Avoid_: Unconfirmed comment, ghost comment

**Unsaved text**:
Text the user typed that the tab would lose by leaving: a comment draft, a comment GitHub never got, or an open title or body editor's text that differs from what it opened with or whose edit failed. Leaving, reloading or signing out asks first while there is some; a pending write alone doesn't, since the server finishes it without the tab.
_Avoid_: Dirty state, unsaved changes

**Post**:
An issue's or PR's body, or one of its comments: Markdown written on GitHub, which beghu renders on the server and sends as a compact tree, never as HTML.
_Avoid_: Message, entry, content

**Place**:
The issue or PR a post belongs to, which is all its rendering depends on besides its text: a bare `#n` in it means an issue in that repo, and its relative links resolve against that issue's page on GitHub.
_Avoid_: Context, location

**Ref**:
An issue, PR, comment, user or team a post refers to (`#12`, `acme/web#12`, a link to an issue, `@ilze-k`, `@acme/core`), which links when shown. Beside a post goes its refs map: what the viewer's mirror holds of the issues and PRs it refers to, which open in-app with their state; every other ref links to GitHub.
_Avoid_: Mention (for issues), link, cross-reference

**Digest**:
The SHA-256 of a post's Markdown. A comment's digest is how a maybe-posted or lost comment finds itself in the thread without the thread carrying every comment's text.
_Avoid_: Hash, checksum, fingerprint

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

**Touchpoint**:
Something a view lets the keyboard do, by name (next issue, comment, close/reopen), while the view can do it. Keys reach a touchpoint only through the keymap in effect, and only where the focus is in an area it works in: an issue's write keys need the focus in the issue.
_Avoid_: Shortcut handler, hotkey, command

**Selection**:
The issue the list's keys are on: the open issue, or the one the keys just stepped to while it opens. Its row is the one in the tab order when it's on screen, and it follows the issue, not the row's position.
_Avoid_: Cursor, highlighted row, current row

**Match mode**:
How a search's text affects the list order: Blend (match field weighted against age on the sort key), Best match (title matches, then body, then comment), or Off (the text only filters).
_Avoid_: Relevance, search ranking

**Preference**:
A choice a user makes about how beghu looks or behaves for them. A device preference (theme, divider and column widths, tree expand state) stays in the browser where it was set. An account preference (comment order, key bindings) is stored per connected account on the server and follows that account to every browser.
_Avoid_: Setting, user config
