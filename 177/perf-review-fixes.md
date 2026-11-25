### Perf vs local main (quick)

perf: 24 gates, 22 pass, 2 over spec (browser.open-issue.round-trips, server.facets.scan), 0 failed

this tree: `bfe6706fab56`; main: `5e975b2c428b`; 50k  
timings fail more than 10% (and 1 ms) slower than main; bytes and counts against perf-budgets.toml  

| Gate | This tree | Limit | Main | vs main | Result |
|---|---:|---:|---:|---:|---|
| `browser.filter.ms` | 84.1 ms (first 78.1 ms) | – | 107.3 ms | -21.6% | ✅ pass |
| `browser.filter.round-trips` | 1 | 1 | – | – | ✅ pass |
| `browser.open-issue.ms` | 239.6 ms | – | 258.9 ms | -7.5% | ✅ pass |
| `browser.open-issue.round-trips` | 2 | 2 (spec 1) | – | – | ⚠️ within limit, over spec |
| `browser.warm.depth` | 1 | 1 | – | – | ✅ pass |
| `browser.warm.ms` | 296.8 ms (first 346.7 ms) | – | 397.3 ms | -25.3% | ✅ pass |
| `server.detail.kb` | 4.1 KB | 4.3 KB | – | – | ✅ pass |
| `server.detail.ms` | 4.7 ms | – | 4.9 ms | -4.1% | ✅ pass |
| `server.detail.scan` | 0 | 0 | – | – | ✅ pass |
| `server.facets.kb` | 0.5 KB | 0.6 KB | – | – | ✅ pass |
| `server.facets.ms` | 131.5 ms | – | 139.5 ms | -5.7% | ✅ pass |
| `server.facets.scan` | 37693 | 37693 (spec 0) | – | – | ⚠️ within limit, over spec |
| `server.list-label.kb` | 5.0 KB | 5.3 KB | – | – | ✅ pass |
| `server.list-label.ms` | 83.2 ms | – | 92.0 ms | -9.6% | ✅ pass |
| `server.list-label.scan` | 0 | 0 | – | – | ✅ pass |
| `server.list.kb` | 5.0 KB | 5.2 KB | – | – | ✅ pass |
| `server.list.ms` | 8.2 ms | – | 9.9 ms | -16.8% | ✅ pass |
| `server.list.scan` | 0 | 0 | – | – | ✅ pass |
| `server.next-page.kb` | 4.9 KB | 5.1 KB | – | – | ✅ pass |
| `server.next-page.ms` | 8.3 ms | – | 9.1 ms | -8.3% | ✅ pass |
| `server.next-page.scan` | 0 | 0 | – | – | ✅ pass |
| `server.search.kb` | 4.7 KB | 4.9 KB | – | – | ✅ pass |
| `server.search.ms` | 24.2 ms | – | 24.3 ms | -0.4% | ✅ pass |
| `server.search.scan` | 0 | 0 | – | – | ✅ pass |

<details><summary>Evidence</summary>

**`browser.open-issue.round-trips`**: Requests for the issue when its row is clicked: its detail and anything of its own. Calibrated as measured, one over the spec's 1 (over spec warns; another request fails): after the detail the panel fetches a second comments page (comments?order=newest&after=…). For the owner: whether that page belongs in the detail answer.

- `/api/issues/3000043749`
- `/api/issues/3000043749/comments?order=newest&after=1790811436.2000198306`
- `/api/issues/3000043748`
- `/api/issues/3000029990`
- `/api/me`

**`server.facets.scan`**: The filter bar's suggestions: rows their statements stepped through with no index to seek on, all told. Calibrated as measured, so any scan added to the answer still fails; the spec asks for none (over spec warns). Most of it is the issue-type facet (facet_types: SELECT MIN(i.issue_type) … GROUP BY i.issue_type COLLATE NOCASE), which walks the items_issue_type index from end to end to group it: the index exists, but a GROUP BY over it is a full index scan, every typed item at 50k. count_types (a facet's counts for types) does the same under the view. For the owner, a follow-up: a table of distinct issue types kept by the writes, or a skip-scan (a recursive CTE stepping from one type to the next through the index).

- `scan steps: 37467: SELECT MIN(i.issue_type) AS "name!: String" FROM items i WHERE i.is_stub = 0 AND i.issue_type IS NOT NULL AND EXISTS (SELECT 1 FROM repos r WHERE r.id = i.repo_id AND r.synced = 1) GROUP BY i.issue_type COLLATE NOCASE ORDER BY 1 COLLATE NOCASE`
- `scan steps: 119: SELECT l.name, MIN(l.color) AS "color!: String" FROM labels l JOIN repos r ON r.id = l.repo_id WHERE r.synced = 1 GROUP BY l.name COLLATE NOCASE ORDER BY l.name COLLATE NOCASE`
- `scan steps: 39: SELECT m.title, MAX(m.state = 'open') AS "open!: bool" FROM milestones m JOIN repos r ON r.id = m.repo_id WHERE r.synced = 1 GROUP BY m.title COLLATE NOCASE ORDER BY 2 DESC, m.title COLLATE NOCASE`
- `scan steps: 29: SELECT u.login FROM users u WHERE EXISTS (SELECT 1 FROM items i JOIN repos r ON r.id = i.repo_id WHERE i.author_id = u.id AND i.is_stub = 0 AND r.synced = 1) ORDER BY u.login COLLATE NOCASE`
- `scan steps: 29: SELECT u.login FROM users u WHERE EXISTS (SELECT 1 FROM item_assignees ia JOIN items i ON i.id = ia.item_id JOIN repos r ON r.id = i.repo_id WHERE ia.user_id = u.id AND i.is_stub = 0 AND r.synced = 1) ORDER BY u.login COLLATE NOCASE`
- `scan steps: 10: SELECT r.id, r.owner, r.name, r.private AS "private: bool", r.role, r.archived AS "archived: bool" FROM repos r WHERE r.synced = 1 ORDER BY r.owner, r.name`

</details>
