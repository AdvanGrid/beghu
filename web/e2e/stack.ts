// The ./dev-ctl stack the suite runs against. Its URLs come from `./dev-ctl status`, which
// reports the ports the running stack was started with: several checkouts run stacks side by
// side, each on its own ports, so a default port would be another checkout's stack.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The app's URL, as playwright.config.ts has it. */
export const APP = process.env.BEGHU_APP_URL ?? `http://localhost:${process.env.DEV_APP_PORT ?? 5173}`;

export function devCtl(args: string[]): string {
  const env = { ...process.env, DEV_APP_PORT: new URL(APP).port };
  return execFileSync(`${ROOT}/dev-ctl`, args, { env, encoding: "utf8" });
}

export type Status = {
  phase?: string;
  urls: { app: string; server: string; fake: string; control: string };
  up: { app: boolean; server: boolean; fake: boolean };
  /** The secret the server checks webhook deliveries with. */
  webhook_secret: string;
};

/** The running stack's status; throws if it isn't running. */
export function status(): Status {
  return JSON.parse(devCtl(["status", "--json"])) as Status;
}
