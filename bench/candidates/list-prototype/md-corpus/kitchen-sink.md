# Heading 1: the sync engine drops deltas after reconnect

Plain paragraph with **bold**, *italic*, ~~struck~~, `inline code`, a [web link](https://example.com), an autolink https://github.com/tomsjansons/beghu and a reference link to [the spec][spec]. Mentions: @tomsjansons and @beghu-org/core. References: #1203 (open, synced), #1188 (closed), #999999 (invalid), tomsjansons/beghu#12 (cross-repo, synced) and partner/sdk#44 (not synced).

## Heading 2: what happens

A second paragraph that is long enough to wrap in a narrow side panel, so you can see how the measure, line height and inline decorations behave when the text runs over several lines at the panel's width.

### Heading 3: steps

1. Open the app on a slow link
2. Disconnect for 10 s
   1. Wait for the "reconnecting…" marker
   2. Reconnect
3. Watch the list

#### Heading 4: nested lists

- List item 1: with a [link](https://example.com)
- List item 2: with `inline` code
  - Nested list 1 item 1
  - Nested list 1 item 2
    - Nested list 2 item 1
      - Nested list 3 item 1
        - Nested list 4 item 1
- List item 3: with a [reference link][spec]

##### Heading 5: task list

- [x] Reproduce on the 50k fixture
- [x] Capture the SSE frames
- [ ] Write the failing test
- [ ] Fix the cursor

###### Heading 6: the smallest heading

Text under the smallest heading.

## Alerts

> [!NOTE]
> A regular note.
>
> With a second paragraph.

> [!TIP]
> Standard tip, with code inside:
>
> ```lua
> print('Standard tip')
> ```

> [!IMPORTANT]
> Exceptional info.

> [!WARNING] Custom title
> Dastardly surprise.

> [!CAUTION]
> Cautionary tale.

## Code

```rust
pub fn apply(&mut self, delta: Delta) -> Result<(), SyncError> {
    if delta.seq <= self.seq {
        return Ok(()); // already applied
    }
    self.rows.insert(delta.id, delta.row);
    self.seq = delta.seq;
    Ok(())
}
```

```ts
const rows = await mirror.query({ state: 'open', limit: 20 });
render(rows);
```

```
unlabelled block: no language, rendered plain
    with indentation kept
```

```zig
const std = @import("std"); // unknown language: plain, with its label
```

```diff
- const page = 50;
+ const page = 100;
```

## Tables

| Left | Center | Right | None |
| :--- | :----: | ----: | ---- |
| `Code` | **Bold** | Plain | Item |
| Item | [link](https://example.com) | 1,204 ms | Item |
| A cell with a lot more text that has to wrap | x | 3 | y |

## Quotes, rules and details

> A plain blockquote from someone else's comment.
>
> > A nested quote inside it.

---

<details>
<summary>Logs (click to expand)</summary>

```
[12:00:01] sse: connected
[12:00:11] sse: error, retrying in 1s
[12:00:12] sse: connected, refetching
```

</details>

## Images

![A screenshot of the list](https://picsum.photos/id/1/800/450)

An image link: [![badge](https://img.shields.io/badge/build-passing-brightgreen)](https://example.com)

## Footnotes

The reconnect delay is about one second[^1], and the marker shows after three[^marker].

[^1]: Live updates: change push and refetch.
[^marker]: Status, write feedback and error surfaces.

[spec]: https://github.com/tomsjansons/beghu/issues/1
