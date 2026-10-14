import type { APIEvent } from "@solidjs/start/server";
import { webhook } from "~/lib/db";

export async function POST({ request }: APIEvent) {
  webhook(request.headers.get("x-github-event"), await request.json());
  return Response.json({ ok: true }, { status: 202 });
}
