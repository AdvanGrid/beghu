// The dev server. `./dev-ctl start` runs it with BEGHU_SERVER pointing at the beghu server,
// which answers everything that isn't the web app.
import { defineConfig } from "vite";

const server = process.env.BEGHU_SERVER ?? "http://localhost:3000";
const proxy = Object.fromEntries(
  ["/api", "/auth", "/healthz", "/readyz", "/webhook"].map((path) => [path, { target: server }]),
);

export default defineConfig({
  server: { proxy, strictPort: true },
});
