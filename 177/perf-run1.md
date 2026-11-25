### Perf vs local main (quick)

perf: 24 gates, 20 pass, 2 over spec (browser.open-issue.round-trips, server.facets.scan), 2 FAILED (browser.filter.ms 108.6 ms +23% vs main, server.list-label.ms 94.0 ms +13% vs main)

this tree: `02e4e3273929`; main: `5e975b2c428b`; 50k  
timings fail more than 10% (and 1 ms) slower than main; bytes and counts against perf-budgets.toml  

| Gate | This tree | Limit | Main | vs main | Result |
|---|---:|---:|---:|---:|---|
| `browser.filter.ms` | 108.6 ms (first 92.4 ms) | – | 88.4 ms | +22.9% | ❌ fail |
| `browser.filter.round-trips` | 1 | 1 | – | – | ✅ pass |
| `browser.open-issue.ms` | 218.9 ms | – | 289.5 ms | -24.4% | ✅ pass |
| `browser.open-issue.round-trips` | 2 | 2 (spec 1) | – | – | ⚠️ within limit, over spec |
| `browser.warm.depth` | 1 | 1 | – | – | ✅ pass |
| `browser.warm.ms` | 322.7 ms | – | 412.8 ms | -21.8% | ✅ pass |
| `server.detail.kb` | 4.1 KB | 4.3 KB | – | – | ✅ pass |
| `server.detail.ms` | 3.9 ms | – | 5.0 ms | -22.5% | ✅ pass |
| `server.detail.scan` | 0 | 0 | – | – | ✅ pass |
| `server.facets.kb` | 0.5 KB | 0.6 KB | – | – | ✅ pass |
| `server.facets.ms` | 132.5 ms | – | 128.5 ms | +3.1% | ✅ pass |
| `server.facets.scan` | 37693 | 37693 (spec 0) | – | – | ⚠️ within limit, over spec |
| `server.list-label.kb` | 5.0 KB | 5.3 KB | – | – | ✅ pass |
| `server.list-label.ms` | 94.0 ms (first 92.2 ms) | – | 82.9 ms | +13.4% | ❌ fail |
| `server.list-label.scan` | 0 | 0 | – | – | ✅ pass |
| `server.list.kb` | 5.0 KB | 5.2 KB | – | – | ✅ pass |
| `server.list.ms` | 7.8 ms | – | 7.8 ms | +0.4% | ✅ pass |
| `server.list.scan` | 0 | 0 | – | – | ✅ pass |
| `server.next-page.kb` | 4.9 KB | 5.1 KB | – | – | ✅ pass |
| `server.next-page.ms` | 6.3 ms | – | 6.9 ms | -9.0% | ✅ pass |
| `server.next-page.scan` | 0 | 0 | – | – | ✅ pass |
| `server.search.kb` | 4.7 KB | 4.9 KB | – | – | ✅ pass |
| `server.search.ms` | 24.7 ms | – | 22.7 ms | +8.7% | ✅ pass |
| `server.search.scan` | 0 | 0 | – | – | ✅ pass |

<details><summary>Evidence</summary>

**`browser.filter.ms`**: A preset click (Assigned to me on, then off again) to the frame with the right rows: the slower of the two.


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

**`server.list-label.ms`**: A label filter (is:open label:bug), the commonest filter-bar click: its answer time, median of 10.


</details>
