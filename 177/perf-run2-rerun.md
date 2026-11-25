### Perf vs local main (quick)

perf: 5 gates, 4 pass, 1 FAILED (browser.filter.ms 85.7 ms +11% vs main)

this tree: `02e4e3273929` + uncommitted changes; main: `5e975b2c428b`; 50k  
timings fail more than 10% (and 1 ms) slower than main; bytes and counts against perf-budgets.toml  

| Gate | This tree | Limit | Main | vs main | Result |
|---|---:|---:|---:|---:|---|
| `browser.filter.ms` | 85.7 ms (first 164.6 ms) | – | 77.4 ms | +10.7% | ❌ fail |
| `browser.filter.round-trips` | 1 | 1 | – | – | ✅ pass |
| `server.list-label.kb` | 5.0 KB | 5.3 KB | – | – | ✅ pass |
| `server.list-label.ms` | 69.9 ms | – | 88.8 ms | -21.3% | ✅ pass |
| `server.list-label.scan` | 0 | 0 | – | – | ✅ pass |

<details><summary>Evidence</summary>

**`browser.filter.ms`**: A preset click (Assigned to me on, then off again) to the frame with the right rows: the slower of the two.


</details>
