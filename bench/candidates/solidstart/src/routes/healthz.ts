import { facets } from "~/lib/db";

export function GET() {
  facets(); // opens the mirror, so a healthy answer means the app can serve
  return Response.json({ ok: true });
}
