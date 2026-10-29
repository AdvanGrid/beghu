// The server concurrency suite: 20 users at once for 30 s, each on their own session (tomsj
// and ilze-k, two mirrors), holding the stream open and doing what the app does: a cold load
// (me, facets and the list together), then views, search typed a key at a time, issues opened
// and next pages, with think time between. The gate is the p95 of every request.
import { Session } from "./http.ts";
import { ENDPOINTS } from "./server.ts";
import type { Stack } from "./stack.ts";
import type { Probe, Sample } from "./suite.ts";
import { percentile, seeded, sleep } from "./stats.ts";

export const USERS = 20;
export const SECONDS = 30;

export async function loadProbe(stack: Stack, users = USERS, seconds = SECONDS): Promise<Probe> {
  const sessions = await Promise.all(
    Array.from({ length: users }, async (_, u) => {
      const s = new Session(stack.url);
      await s.signIn(u % 2 ? "ilze-k" : "tomsj");
      return s;
    }),
  );
  let round = 0;
  return {
    name: "load",
    gates: ["load.p95.ms", "load.errors"],
    async sample(): Promise<Sample> {
      const times: number[] = [];
      const errors: string[] = [];
      const abort = new AbortController();
      const end = Date.now() + seconds * 1000;
      const ask = async (s: Session, path: string) => {
        try {
          const a = await s.get(path);
          if (a.status === 200) times.push(a.ms);
          else errors.push(`${a.status} ${path}`);
          return a;
        } catch (e) {
          errors.push(`${(e as Error).message} ${path}`);
          return null;
        }
      };
      round++;
      await Promise.all(
        sessions.map(async (s, u) => {
          const rand = seeded(1000 * round + u);
          await sleep(rand() * 1000);
          await s.stream(abort.signal, () => {}).catch((e: Error) => errors.push(`stream: ${e.message}`));
          const [, , list] = await Promise.all([ask(s, "/api/me"), ask(s, "/api/facets"), ask(s, "/api/issues")]);
          const page = list ? (JSON.parse(list.body.toString()) as { rows: { id: number }[]; next: string | null }) : null;
          while (Date.now() < end) {
            const r = rand();
            if (r < 0.35) {
              await ask(s, ENDPOINTS[Math.floor(rand() * 6)]![1]);
            } else if (r < 0.5) {
              // Typing: one request per key, 150 ms apart, none waiting for the last.
              const keys: Promise<unknown>[] = [];
              const text = "dark m";
              for (let n = 1; n <= text.length; n++) {
                keys.push(ask(s, `/api/issues?q=${encodeURIComponent(`is:open ${text.slice(0, n)}`)}`));
                await sleep(150);
              }
              await Promise.all(keys);
            } else if (r < 0.8 && page?.rows.length) {
              await ask(s, `/api/issues/${page.rows[Math.floor(rand() * Math.min(40, page.rows.length))]!.id}`);
            } else if (r < 0.9 && page?.next) {
              await ask(s, `/api/issues?after=${encodeURIComponent(page.next)}`);
            } else {
              await ask(s, "/api/facets/label/counts?q=is%3Aopen");
            }
            await sleep(500 + rand() * 1000);
          }
        }),
      );
      abort.abort();
      const out: Sample = { values: { "load.p95.ms": percentile(times, 95), "load.errors": errors.length } };
      if (errors.length) out.evidence = { "load.errors": [...new Set(errors)].slice(0, 8) };
      console.log(`load: ${times.length} requests from ${users} users in ${seconds} s, ${errors.length} errors`);
      return out;
    },
  };
}
