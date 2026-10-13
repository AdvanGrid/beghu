# begihup

A fast frontend for GitHub issues, for one person and a few teammates. GitHub is the source of truth; begihup keeps disposable copies of its data so the app can be fast.

## Language

**Connected account**:
A GitHub account that has signed in to begihup and whose repos it syncs.
_Avoid_: User, tenant

**Synced repo**:
A repo whose issues and PRs begihup copies into a mirror.
_Avoid_: Tracked repo, watched repo

**Mirror**:
The server-side copy of a connected account's GitHub data. It is disposable and can always be rebuilt from GitHub.
_Avoid_: Database, replica, backend store

**Cache**:
The browser-side copy of data from the mirror. It exists only to make the app faster, not to work offline.
_Avoid_: Local store, offline store

**Relationship**:
A link between two issues: either a sub-issue (parent/child) or a dependency (blocked by / blocking).
_Avoid_: Link, edge

**Stub**:
A placeholder for an issue in a repo that isn't synced, reached through a relationship. It has a title and a link out to GitHub.
_Avoid_: Ghost, external issue
