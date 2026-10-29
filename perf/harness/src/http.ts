// HTTP as a browser tab sends it, without a browser: a session's cookies kept by hand (the
// session cookie is `Secure`, which no cookie store sends over plain HTTP), gzip asked for, and
// the bytes on the wire kept as well as the body.
import { Agent, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { sleep } from "./stats.ts";

export interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body as sent: compressed, when the server compressed it. */
  wire: Buffer;
  /** The body decoded. */
  body: Buffer;
  /** From sending the request to the last byte of the body. */
  ms: number;
}

export interface Ask {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** `accept-encoding` (default gzip, which the budgets count in). */
  encoding?: string;
}

/** One request, with its body read in full. */
export function fetchRaw(url: string, ask: Ask = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const t0 = performance.now();
    const req = httpRequest(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: ask.method ?? "GET",
        headers: { "accept-encoding": ask.encoding ?? "gzip", ...ask.headers },
        agent: keepAlive,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const ms = performance.now() - t0;
          const wire = Buffer.concat(chunks);
          const enc = res.headers["content-encoding"];
          const body = enc === "gzip" ? gunzipSync(wire) : enc === "br" ? brotliDecompressSync(wire) : wire;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, wire, body, ms });
        });
      },
    );
    req.on("error", reject);
    if (ask.body !== undefined) req.write(ask.body);
    req.end();
  });
}

/** Kept-alive connections, as a browser keeps them, with no cap: the load suite's users don't queue here. */
const keepAlive = new Agent({ keepAlive: true });

/** A browser's session with beghu: its cookies, and the account its tab is on. */
export class Session {
  readonly cookies = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  get cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  /** The tab's account (`beghu_acct`), which every write names. */
  get account(): string {
    return this.cookies.get("beghu_acct") ?? "";
  }

  private take(headers: IncomingHttpHeaders): void {
    for (const c of headers["set-cookie"] ?? []) {
      const [pair, ...attrs] = c.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(at + 1).trim());
    }
  }

  /** A GET (or `ask.method`) of a path on beghu, as the tab sends it. */
  async get(path: string, ask: Ask = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...ask.headers };
    if (this.cookies.size) headers.cookie = this.cookieHeader;
    const a = await fetchRaw(this.base + path, { ...ask, headers });
    this.take(a.headers);
    return a;
  }

  /** A write to the API from beghu's own page, as the tab on its account. */
  post(path: string, body: unknown): Promise<Answer> {
    return this.get(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: this.base, "x-beghu-account": this.account },
    });
  }

  /** Signs `login` in through the whole web flow (beghu, then Fake GitHub's OAuth, then back). */
  async signIn(login: string): Promise<void> {
    let url = `${this.base}/auth/login?login=${encodeURIComponent(login)}`;
    for (let i = 0; i < 10; i++) {
      const ours = url.startsWith(this.base);
      const a = ours ? await this.get(url.slice(this.base.length)) : await fetchRaw(url);
      if (a.status < 300 || a.status >= 400) {
        if (a.status !== 200 || !this.cookies.has("beghu_acct")) throw new Error(`signing ${login} in ended at ${url}: ${a.status}`);
        return;
      }
      const to = String(a.headers.location);
      url = to.startsWith("/") ? new URL(to, url).toString() : to;
    }
    throw new Error(`signing ${login} in: too many redirects`);
  }

  /**
   * Holds `/api/stream` open, calling `on` with each event, until `signal` aborts. Resolves once
   * the stream answered.
   */
  stream(signal: AbortSignal, on: (event: string, data: string, at: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = new URL(`${this.base}/api/stream?account=${this.account}`);
      const req = httpRequest(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { cookie: this.cookieHeader, accept: "text/event-stream" }, signal },
        (res) => {
          if (res.statusCode !== 200) return reject(new Error(`/api/stream: ${res.statusCode}`));
          resolve();
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            const at = Date.now();
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const msg = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let event = "message";
              const data: string[] = [];
              for (const line of msg.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
              }
              if (data.length) on(event, data.join("\n"), at);
            }
          });
          res.on("error", () => {});
        },
      );
      req.on("error", (e) => (signal.aborted ? resolve() : reject(e)));
      req.end();
    });
  }
}

/** A list row, as far as the harness reads it. */
export interface Row {
  id: number;
  repo: string;
  owner: string;
  number: number;
  title: string;
  comments: number;
}

/** The first rows the list should show for a view (`q`, or the default view). */
export async function expected(s: Session, q?: string): Promise<{ ids: number[]; rows: Row[] }> {
  const a = await s.get(q === undefined ? "/api/issues" : `/api/issues?q=${encodeURIComponent(q)}`);
  const rows = (JSON.parse(a.body.toString()) as { rows: Row[] }).rows;
  return { ids: rows.slice(0, 20).map((r) => r.id), rows };
}

/**
 * Waits until the default view's top rows hold still for `holdMs` (60 s at most): a live session
 * starts the server's events poller, and a write's or an edit's webhook lands about a second
 * after it, each of which can move an issue to the top while a sample expects the rows it read.
 */
export async function settle(s: Session, holdMs = 3000): Promise<void> {
  const until = Date.now() + 60_000;
  let last = "";
  let since = Date.now();
  while (Date.now() < until) {
    const now = (await expected(s)).ids.join(",");
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= holdMs) return;
    await sleep(500);
  }
}
