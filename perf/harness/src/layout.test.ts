// The layout suite's counts and probes (layout.ts).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crossings, DRAWINGS, layoutProbes, type P } from "./layout.ts";
import { ROOT } from "./stack.ts";

const pts = (...xy: number[]): P[] => xy.flatMap((v, i) => (i % 2 ? [] : [{ x: v, y: xy[i + 1]! }]));

test("a horizontal stretch crossing another line's vertical counts once per point", () => {
  const routes = new Map([
    ["a", pts(0, 50, 100, 50)],
    ["b", pts(50, 0, 50, 100)],
    // On the same vertical as b (a trunk's lines overlap): the same point, not a second crossing.
    ["c", pts(50, 10, 50, 90)],
    // Touching at an end isn't crossing.
    ["d", pts(100, 0, 100, 100)],
  ]);
  assert.equal(crossings({ routes, trunks: [] }), 1);
});

test("lines that share a trunk don't cross each other", () => {
  const routes = new Map([
    ["a", pts(0, 50, 100, 50)],
    ["b", pts(50, 0, 50, 100)],
  ]);
  assert.equal(crossings({ routes, trunks: [{ id: "t", lines: ["a", "b"] }] }), 0);
  assert.equal(crossings({ routes, trunks: [{ id: "t", lines: ["a", "c"] }] }), 1);
});

test("a tree's probes measure each drawing's time, crossings and area; a tree with no engine has none", async () => {
  const probes = (await layoutProbes(ROOT))!;
  assert.deepEqual(probes.map((p) => p.name), DRAWINGS.map((d) => d.name));
  const top = probes[0]!;
  const s = await top.sample();
  assert.deepEqual(Object.keys(s.values).sort(), [...top.gates].sort());
  assert.ok(s.values["layout.top.ms"]! > 0 && s.values["layout.top.crossings"]! > 0 && s.values["layout.top.area"]! > 0);
  assert.deepEqual((await top.sample()).values["layout.top.area"], s.values["layout.top.area"]);
  assert.equal(await layoutProbes(mkdtempSync(join(tmpdir(), "no-engine-"))), null);
});
