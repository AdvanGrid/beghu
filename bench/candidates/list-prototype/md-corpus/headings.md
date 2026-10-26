Spec-style body with headings that go down and back up, the way agent reviews and design docs do.

## Summary

The reconnect path drops deltas when the stream reopens during a refetch.

### Root cause

The refetch and the stream race for the same cursor.

#### When the refetch wins

The list shows the new rows, then the stream replays older ones over them.

#### When the stream wins

Nothing visible goes wrong, but the refetch is wasted.

##### Timing detail

The window is about 40 ms on the low device.

###### Raw numbers

p50 38 ms, p95 61 ms over 200 runs.

### Fix

Drop the cursor and refetch on every open.

#### Server side

- Send `reset` when the mirror is rebuilt.
- Stop sending `seq` on the push.

#### Client side

- Treat the first open like a reconnect.

## Findings

### Suggestion (recommended, doesn't block)

1. **Spec status is `draft`**: promote it before task-01.

### Nit

#### Naming

`seq` and `cursor` mean the same thing in two files.

## Next steps

- [ ] Land the server change
- [ ] Update the client
