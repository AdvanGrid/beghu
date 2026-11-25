### Perf vs local main (quick)

perf: 2 gates, 2 pass, 0 failed

this tree: `02e4e3273929` + uncommitted changes; main: `5e975b2c428b`; 50k  
timings fail more than 10% (and 1 ms) slower than main; bytes and counts against perf-budgets.toml  

| Gate | This tree | Limit | Main | vs main | Result |
|---|---:|---:|---:|---:|---|
| `browser.filter.ms` | 77.1 ms | – | 117.8 ms | -34.6% | ✅ pass |
| `browser.filter.round-trips` | 1 | 1 | – | – | ✅ pass |
