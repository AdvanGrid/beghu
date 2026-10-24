# beghu

A fast frontend for GitHub issues, for one person and a few teammates. GitHub is the source of truth; beghu keeps disposable copies of its data so the app can be fast.

## Language

**Connected account**:
A GitHub account that has signed in to beghu and whose repos it syncs.
_Avoid_: User, tenant

**Synced repo**:
A repo whose issues and PRs beghu copies into a mirror.
_Avoid_: Tracked repo, watched repo

**Mirror**:
The server-side copy of a connected account's GitHub data. It is disposable and can always be rebuilt from GitHub.
_Avoid_: Database, replica, backend store

**Relationship**:
A link between two issues: a sub-issue (parent/child), a dependency (blocked by / blocking), or "relates to" (symmetric, no direction).
_Avoid_: Link, edge

**Stub**:
A placeholder for an issue in a repo that isn't synced, reached through a relationship. It has a title and a link out to GitHub.
_Avoid_: Ghost, external issue

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
A change to a list's order from a live update (an issue moving, arriving or leaving) that waits until the user isn't about to click, so nothing moves under the pointer. Changes to a row's contents are never held.
_Avoid_: Frozen order, pending reorder
