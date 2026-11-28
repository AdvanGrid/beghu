// The PR view's modules in a cold load's chunks (browser.cold.pr-view-modules), read from a build's
// module list: view code inlined into the entry chunk counts as much as a view chunk fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewModulesIn } from "./browser.ts";

/** A build's `.vite/`: its module list, and a manifest with the view in `assets/View-b.js`. */
function build(list: Record<string, string[]> | undefined): string {
  const web = mkdtempSync(join(tmpdir(), "harness-web-"));
  mkdirSync(join(web, ".vite"));
  if (list) writeFileSync(join(web, ".vite", "modules.json"), JSON.stringify(list));
  const manifest = {
    "index.html": { file: "assets/index-a.js", isEntry: true, dynamicImports: ["src/pr-view/View.tsx"] },
    "src/pr-view/View.tsx": { file: "assets/View-b.js", imports: ["index.html"] },
  };
  writeFileSync(join(web, ".vite", "manifest.json"), JSON.stringify(manifest));
  return web;
}

test("view modules inlined into the entry count, and the view's own chunk unfetched doesn't", () => {
  const web = build({
    "assets/index-a.js": ["src/main.tsx", "src/IssueList.tsx", "src/pr-view/model.ts", "src/analysis.ts"],
    "assets/View-b.js": ["src/pr-view/View.tsx", "src/pr-view/Panel.tsx"],
    "assets/Analyse-c.js": ["src/Analyse.tsx"],
  });
  try {
    assert.deepEqual(viewModulesIn(web, ["/", "/assets/index-a.js", "/assets/index-a.js", "/api/issues"]), {
      found: ["/assets/index-a.js: src/pr-view/model.ts"],
      chunks: 1,
    });
    assert.deepEqual(viewModulesIn(web, ["/assets/index-a.js", "/assets/Analyse-c.js"])?.found, ["/assets/index-a.js: src/pr-view/model.ts", "/assets/Analyse-c.js: src/Analyse.tsx"]);
  } finally {
    rmSync(web, { recursive: true });
  }
});

test("a clean cold load finds none; a build without the list leaves the gate unmeasured", () => {
  const web = build({ "assets/index-a.js": ["src/main.tsx", "src/analysis.ts"], "assets/View-b.js": ["src/pr-view/View.tsx"] });
  const old = build(undefined);
  try {
    assert.deepEqual(viewModulesIn(web, ["/assets/index-a.js"]), { found: [], chunks: 1 });
    assert.equal(viewModulesIn(old, ["/assets/index-a.js"]), undefined);
  } finally {
    rmSync(web, { recursive: true });
    rmSync(old, { recursive: true });
  }
});

test("a module list that names no view module in the view's own chunks fails the gate", () => {
  // Module ids in another form than the harness reads (absolute paths, say): the view's chunk
  // lists none of its src/pr-view/ modules, and every cold load would count none.
  const web = build({ "assets/index-a.js": ["/abs/web/src/main.tsx"], "assets/View-b.js": ["/abs/web/src/pr-view/View.tsx"] });
  try {
    assert.throws(() => viewModulesIn(web, ["/assets/index-a.js"]), /lists no src\/pr-view\/ module in the PR view's own chunks \(\/assets\/View-b\.js\)/);
  } finally {
    rmSync(web, { recursive: true });
  }
});
