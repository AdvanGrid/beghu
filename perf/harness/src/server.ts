// The server single-user suite: one signed-in user asks each endpoint in turn, as the web app
// asks it, and each answer is timed, weighed (gzip, as sent) and counted for full-scan steps
// (`x-beghu-scan-steps`, with the statements named in beghu's log). Then a write: its round
// trip, which ends once GitHub and the mirror have it, and the push it sends.
import { readFileSync } from "node:fs";
import { Session, settle } from "./http.ts";
import { scanEvidence, type Stack } from "./stack.ts";
import type { Probe, Sample } from "./suite.ts";

/** The list views and endpoints the gates time, by gate name: the app's own URLs. */
export const ENDPOINTS: [string, string][] = [
  ["list", "/api/issues"],
  ["list-label", "/api/issues?q=is%3Aopen+label%3Abug"],
  ["list-assignee", "/api/issues?q=is%3Aopen+assignee%3Ailze-k"],
  ["list-closed", "/api/issues?q=is%3Aclosed"],
  ["list-sort", "/api/issues?q=is%3Aopen+sort%3Acomments"],
  ["search", "/api/issues?q=is%3Aopen+dark+m"],
  ["facets", "/api/facets"],
  ["facet-counts", "/api/facets/label/counts?q=is%3Aopen"],
];

/** Tree mode's reads the gates time, by gate name (see the tree probes below). */
export const TREE: [string, string][] = [
  ["tree", "/api/tree?mode=tree"],
  ["tree-label", "/api/tree?q=is%3Aopen+label%3Abug&mode=tree"],
];

interface Row {
  id: number;
  comments: number;
  labels: { name: string }[];
}

/** The label the write adds and removes again. */
const LABEL = "performance";

export async function serverProbes(stack: Stack, opts: { quick?: boolean } = {}): Promise<Probe[]> {
  const s = new Session(stack.url);
  await s.signIn("tomsj");
  // Quick mode makes no writes: a shorter hold only has the events poller's first pass to wait out.
  await settle(s, opts.quick ? 1000 : 3000);
  const first = JSON.parse((await s.get("/api/issues")).body.toString()) as { rows: Row[]; next: string };
  // The fixture's first detail target (30 comments): the same issue however the list moved.
  const summary = JSON.parse(readFileSync(stack.fixture.replace(/mirror-([^/]+)\.db$/, "fixture-$1.json"), "utf8")) as { detail_targets: number[] };
  const detail = { id: summary.detail_targets[0]! };
  // The write's issue: one below the top that lacks the label, with a short thread.
  const target = first.rows.slice(40).find((r) => r.comments < 10 && !r.labels.some((l) => l.name === LABEL));
  if (!target) throw new Error("no issue on the first page to write to");

  const endpoints: [string, string][] = [
    ...ENDPOINTS,
    ["detail", `/api/issues/${detail.id}`],
    ["next-page", `/api/issues?after=${encodeURIComponent(first.next)}`],
  ];
  const probes: Probe[] = endpoints.map(([name, path]) => ({
    name: `server.${name}`,
    gates: [`server.${name}.ms`, `server.${name}.kb`, `server.${name}.scan`],
    async sample(): Promise<Sample> {
      const a = await s.get(path);
      if (a.status !== 200) throw new Error(`${path}: ${a.status} ${a.body.toString().slice(0, 200)}`);
      // Every row the answer's own statements stepped through unseeked: on the fixed fixture an
      // exact count, so a scan added anywhere in the answer, a small table's too, moves it.
      const scan = Number(a.headers["x-beghu-scan-steps"] ?? NaN);
      const out: Sample = { values: { [`server.${name}.ms`]: a.ms, [`server.${name}.kb`]: a.wire.length / 1024, [`server.${name}.scan`]: scan } };
      if (scan > 0) out.evidence = { [`server.${name}.scan`]: scanEvidence(stack, path) };
      return out;
    },
  }));

  // Tree mode (#108): the default view's first roots, and a filtered tree (matches inside their
  // dimmed ancestors). The server builds a view's tree once per mirror `seq` and caches it; the
  // write below bumps `seq` every round, so each sample reads twice: the first read builds the tree
  // (`.build.ms`, as the first tab's read after a push does), the second reads it cached, which
  // the `.ms`, `.kb` and `.scan` gates hold.
  for (const [name, path] of TREE) {
    probes.push({
      name: `server.${name}`,
      gates: [`server.${name}.ms`, `server.${name}.kb`, `server.${name}.scan`, `server.${name}.build.ms`],
      async sample(): Promise<Sample> {
        const cold = await s.get(path);
        const a = await s.get(path);
        for (const r of [cold, a]) if (r.status !== 200) throw new Error(`${path}: ${r.status} ${r.body.toString().slice(0, 200)}`);
        const scan = Number(a.headers["x-beghu-scan-steps"] ?? NaN);
        const out: Sample = {
          values: { [`server.${name}.ms`]: a.ms, [`server.${name}.kb`]: a.wire.length / 1024, [`server.${name}.scan`]: scan, [`server.${name}.build.ms`]: cold.ms },
        };
        if (scan > 0) out.evidence = { [`server.${name}.scan`]: scanEvidence(stack, path) };
        return out;
      },
    });
  }

  // The write, and its push: the stream stays open across samples.
  const abort = new AbortController();
  const pushes: { ids: number[]; bytes: number }[] = [];
  await s.stream(abort.signal, (event, data) => {
    if (event === "ids") pushes.push({ ids: (JSON.parse(data) as { ids: number[] }).ids, bytes: Buffer.byteLength(`event: ids\ndata: ${data}\n\n`) });
  });
  let added = false;
  probes.push({
    name: "server.write",
    gates: ["server.write.ms", "server.push.kb"],
    async sample(): Promise<Sample> {
      const kind = added ? "label_remove" : "label_add";
      const before = pushes.length;
      const a = await s.post("/api/ops", { op_id: crypto.randomUUID(), op: { kind, issue: target.id, label: LABEL } });
      if (a.status !== 200) throw new Error(`/api/ops ${kind}: ${a.status} ${a.body.toString().slice(0, 200)}`);
      added = !added;
      // The push naming the issue (the mirror write's own), within 5 s.
      const until = Date.now() + 5000;
      let push;
      while (!(push = pushes.slice(before).find((p) => p.ids.includes(target.id))) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      if (!push) throw new Error(`no push named issue ${target.id} within 5 s of its write`);
      return { values: { "server.write.ms": a.ms, "server.push.kb": push.bytes / 1024 } };
    },
    async done() {
      if (added) await s.post("/api/ops", { op_id: crypto.randomUUID(), op: { kind: "label_remove", issue: target.id, label: LABEL } });
      abort.abort();
    },
  });
  return probes;
}
