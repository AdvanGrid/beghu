# PROTOTYPE: writes one copy of src/App.tsx per deliberate mistake, so tsc and the lint can be
# asked what each one catches. Run: python3 mistakes/make.py && npx tsc -p mistakes && npx eslint mistakes
import os, re
src = open('src/App.tsx').read().replace("from './virtual'", "from '../../src/virtual'").replace("from './api'", "from '../../src/api'")
LIST_LOADING = """          {yield* Loading({
            fallback: function* () {
              return <div class="list" data-bench="list" />;
            },
            children: function* () {
              return <>{yield* IssueList({ rows, onOpen: open, onNearEnd: loadMore })}</>;
            },
          })}"""
ERRORED_OPEN = """            {yield* Errored({
              catch: [DetailFailed],
              fallback: (err) => <p>Couldn't load the issue: {err().message}</p>,
              children: function* () {
                return (
                  <>
                    {yield* Loading({"""
ERRORED_CLOSE = """                    })}
                  </>
                );
              },
            })}
          </aside>"""
M = {
  # 1. No <Loading> around the list.
  'no-loading': [(LIST_LOADING, "          {yield* IssueList({ rows, onOpen: open, onNearEnd: loadMore })}")],
  # 2. No <Errored> around the detail pane: DetailFailed has no handler.
  'no-errored': [(ERRORED_OPEN, "            {yield* Loading({"), (ERRORED_CLOSE, "                    })}\n          </aside>")],
  # 3. Errored catches the wrong class.
  'wrong-catch': [("catch: [DetailFailed],", "catch: [ListFailed],")],
  # 4. A fetch without attempt: a plain promise returned from the memo.
  'no-attempt': [("""    return yield* attempt(
      () => getIssue(id),
      (c) => new DetailFailed(message(c)),
    );""", "    return getIssue(id);")],
  # 5. A plain throw in an event.
  'plain-throw': [("    yield* setAdding((a) => [...a, name]);", "    if (!name) throw new Error('no label');\n    yield* setAdding((a) => [...a, name]);")],
  # 6. The write's failure isn't absorbed: it escapes the event.
  'write-fails': [("      () => false,\n    );\n    if (ok)", "      (c) => new DetailFailed(message(c)),\n    );\n    if (ok)")],
  # 7. A write shown with a plain $signal instead of $optimistic: never shows until settled.
  'signal-not-optimistic': [("yield* $optimistic<string[]>([])", "yield* $signal<string[]>([])")],
  # 8. Binding an event that reads a pending source with no shown wait.
  'unshown-wait': [("              onInput={yield* search}", "              onInput={yield* loadMore}")],
  # 9. Plain-Solid habit: a tag instead of a call.
  'tag': [("return <>{yield* IssueList({ rows, onOpen: open, onNearEnd: loadMore })}</>;", "return <IssueList rows={rows} onOpen={open} onNearEnd={loadMore} />;")],
  # 10. Plain-Solid habit: reading a signal in the view body.
  'read-in-view': [("  return view(function* () {\n    return (\n      <div class=\"app\">", "  return view(function* () {\n    const v = yield* view_;\n    return (\n      <div class=\"app\" data-state={v.state}>")],
  # 11. Plain-Solid habit: un-yielded setter call.
  'unyielded-write': [("    yield* setOpenId(id);", "    setOpenId(id);")],
}
for name, edits in M.items():
  s = src
  for a, b in edits:
    assert a in s, (name, a[:60])
    s = s.replace(a, b, 1)
  os.makedirs(f'mistakes/{name}', exist_ok=True)
  open(f'mistakes/{name}/App.tsx', 'w').write(s)
  open(f'mistakes/{name}/index.tsx', 'w').write("import { render } from 'solid-yield';\nimport { App } from './App';\n\nrender(App, document.getElementById('root')!);\n")
