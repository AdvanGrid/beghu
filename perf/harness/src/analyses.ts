// The PR view's perf-size analyses on a stack (#178): the recorded analysis tiled to #2627's shape
// and to 3× (the fixture crate's `pr-fixtures`, cached in perf/data), each uploaded once,
// untimed, before any gate runs, through an analysis run as an agent's upload goes: the tile's PR
// pushed to its head and files on Fake GitHub, a run started and pinned, the analysis posted. So
// its brotli 9 and gzip 9 are paid here, at upload, as in production.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchRaw, type Session } from "./http.ts";
import { control, FIXTURES, type Stack } from "./stack.ts";
import { sleep } from "./stats.ts";

/** A tile as `pr-fixtures versions` lists it. */
interface Listed {
  name: string;
  repo: string;
  number: number;
  version?: number;
  headSha: string;
  analysis: string;
  pr: string;
}

/** An uploaded tile: its PR and the analysis the server accepted. */
export interface Tile {
  name: string;
  repo: string;
  number: number;
  analysis: string;
}

interface PinnedFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
}

/** Uploads both tiles as `s`'s account; their PRs and analyses. */
export async function uploadTiles(stack: Stack, s: Session): Promise<Tile[]> {
  const run = spawnSync(join(stack.build.bin, "pr-fixtures"), ["versions", "--out", FIXTURES], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (run.status !== 0) throw new Error("pr-fixtures versions failed (does this build have it?)");
  const tiles = (JSON.parse(run.stdout) as Listed[]).filter((v) => v.name.startsWith("tiled-"));
  const out: Tile[] = [];
  for (const t of tiles) {
    const pr = JSON.parse(readFileSync(t.pr, "utf8")) as { files: PinnedFile[]; base: { sha: string } };
    await control(stack, "POST", "/push", {
      repo: t.repo,
      number: t.number,
      sha: t.headSha,
      base_sha: pr.base.sha,
      files: pr.files.map((f) => ({ filename: f.path, previous_filename: f.previousPath ?? null, status: f.status, additions: f.additions, deletions: f.deletions })),
    });
    // The push's webhook moves the mirror's head a moment later; a run pins GitHub's head and
    // files, which have moved already, but its start reads the PR from the mirror.
    const deadline = Date.now() + 30_000;
    let token = "";
    for (;;) {
      const started = await s.post(`/api/${t.repo}/pulls/${t.number}/runs`, {});
      if (started.status !== 201) throw new Error(`starting a run on ${t.repo}#${t.number}: ${started.status} ${started.body.toString().slice(0, 200)}`);
      token = (JSON.parse(started.body.toString()) as { token: string }).token;
      const pinned = await fetchRaw(`${stack.url}/api/runs/${token}/pr.json`);
      if (pinned.status !== 200) throw new Error(`pr.json: ${pinned.status}`);
      const head = (JSON.parse(pinned.body.toString()) as { headSha: string }).headSha;
      if (head === t.headSha) break;
      if (Date.now() > deadline) throw new Error(`${t.name}: no run pinned ${t.headSha} within 30 s`);
      await sleep(500);
    }
    const up = await fetchRaw(`${stack.url}/api/runs/${token}/analysis`, {
      method: "POST",
      headers: { "content-type": "application/json", "beghu-snippets": "not-checked" },
      body: readFileSync(t.analysis, "utf8"),
    });
    if (up.status !== 201) throw new Error(`uploading ${t.name}: ${up.status} ${up.body.toString().slice(0, 2000)}`);
    out.push({ name: t.name, repo: t.repo, number: t.number, analysis: (JSON.parse(up.body.toString()) as { analysis: string }).analysis });
  }
  return out;
}
