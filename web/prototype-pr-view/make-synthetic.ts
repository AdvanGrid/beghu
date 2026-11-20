// PROTOTYPE (PR view, #160): writes a made-up many-purpose PR, acme/shop#77, to test how the canvas
// shows a purpose that spans most of the system and parts that serve several purposes. Nothing here
// is from a real repo or the agent. Run: `node web/prototype-pr-view/make-synthetic.ts`; it writes
// data/acme-shop-77.json (the code view) and data/purposes/acme-shop-77.json (the purpose view).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis, Change, Claim, Edge, Node } from "./schema.ts";
import type { Conflict, PClaim, Purpose, Purposes, Stop } from "./purpose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nodes: Node[] = [];
const edges: Edge[] = [];
const claims: Claim[] = [];
let eid = 0;

function claim(id: string, text: string, path: string): string {
  claims.push({ id, text, status: "supported", evidence: [{ side: "head", path, start: 1, end: 3, note: text, snippet: `// ${text}\n// (made up)\n` }] });
  return id;
}

function node(id: string, name: string, kind: Node["kind"], parent: string | undefined, change: Change, summary: string, changeSummary?: string): Node {
  const path = id.replace(/\./g, "/");
  const n: Node = {
    id,
    name,
    kind,
    parent,
    paths: kind === "actor" || kind === "external" ? [] : [path],
    summary,
    change,
    changeSummary: change === "unchanged" ? undefined : (changeSummary ?? `Changed for tenant isolation.`),
    responsibilities: [{ id: `r-${id}`, text: summary, change, claims: [] }],
    facets: [],
    questions: [],
    files: change === "unchanged" || kind === "actor" || kind === "external" ? [] : [{ path: `${path}/main.go`, status: change === "added" ? "added" : "modified", additions: 40, deletions: change === "added" ? 0 : 12 }],
  };
  nodes.push(n);
  return n;
}

function edge(from: string, to: string, kind: Edge["kind"], label: string, change: Change = "unchanged"): string {
  const id = `e${++eid}`;
  edges.push({ id, from, to, kind, label, mode: kind === "event" ? "async" : "sync", change, crosses: [], facets: [], questions: [], claims: [] });
  return id;
}

// ---------------------------------------------------------------------------------------------
// The system: 24 services of up to 6 modules, a main database of 60 tables, an analytics one of 20,
// a new tenancy library, a new audit service, people and outside systems.

node("system", "acme shop", "system", undefined, "modified", "The shop's services, stores and outside systems.");
for (const [id, name] of [["customer", "Customer"], ["admin", "Admin"], ["support", "Support agent"]] as const) node(id, name, "actor", "system", "unchanged", `A ${name.toLowerCase()} using the shop.`);
for (const [id, name] of [["stripe", "Stripe"], ["auth0", "Auth0"], ["kafka", "Kafka"], ["s3", "S3"]] as const) node(id, name, "external", "system", "unchanged", `${name}, outside the repo.`);

node("lib-tenancy", "tenancy", "library", "system", "added", "Carries the tenant through requests, queries and jobs.", "New library: tenant context, query scoping, job scoping.");
node("lib-tenancy.context", "context", "module", "lib-tenancy", "added", "Reads the tenant from the token and puts it on the context.");
node("lib-tenancy.sqlscope", "sqlscope", "module", "lib-tenancy", "added", "Adds `tenant_id = ?` to every query a store builds.");
node("lib-tenancy.jobs", "jobs", "module", "lib-tenancy", "added", "Stamps the tenant on queued jobs and restores it when they run.");

const SERVICES = [
  "gateway", "auth", "users", "catalog", "search", "cart", "orders", "payments", "billing", "shipping", "inventory", "notifications",
  "reviews", "recommendations", "reports", "admin-api", "webhooks", "pricing", "promotions", "wishlist", "returns", "loyalty", "media", "feeds",
];
const WITH_JOBS = new Set(["orders", "payments", "billing", "shipping", "inventory", "notifications", "reports", "webhooks", "feeds", "search", "loyalty", "returns"]);
/** Services the tenant work leaves alone: reports and recommendations read across tenants on purpose (or so the PR thinks). */
const UNSCOPED = new Set(["reports", "recommendations", "media"]);
const ADMIN = ["users", "catalog", "orders", "payments", "pricing", "promotions", "returns", "loyalty"];

const TABLES = [
  "users", "sessions", "api_keys", "roles", "role_grants", "products", "product_variants", "categories", "product_categories", "prices",
  "price_rules", "promotions", "coupons", "carts", "cart_items", "orders", "order_items", "order_events", "payments", "refunds",
  "invoices", "invoice_lines", "billing_accounts", "billing_events", "subscriptions", "shipments", "shipment_items", "carriers",
  "addresses", "stock_levels", "warehouses", "stock_moves", "notifications", "notification_prefs", "templates", "reviews",
  "review_votes", "wishlists", "wishlist_items", "returns", "return_items", "loyalty_accounts", "loyalty_moves", "media_assets",
  "feeds", "feed_items", "webhook_endpoints", "webhook_deliveries", "search_synonyms", "tenants", "tenant_settings", "jobs",
  "job_runs", "outbox", "idempotency_keys", "rate_limits", "feature_flags", "exports", "imports", "audit_log",
];
/** Tables that stay global: shared reference data, and the tenants table itself. */
const GLOBAL_TABLES = new Set(["tenants", "carriers", "feature_flags", "templates", "search_synonyms"]);

node("db-main", "main database", "store", "system", "modified", "Postgres: the shop's operational data.", "Every tenant-owned table gains tenant_id and a row-level policy.");
for (const t of TABLES) {
  const change: Change = t === "audit_log" ? "added" : GLOBAL_TABLES.has(t) ? "unchanged" : "modified";
  node(`db-main.${t}`, t, "store", "db-main", change, `The ${t.replace(/_/g, " ")} table.`, t === "audit_log" ? "New table: one row per admin action." : "Gains tenant_id, indexed, with a row-level policy.");
}
node("db-analytics", "analytics database", "store", "system", "unchanged", "ClickHouse: event history for reports.");
for (let i = 0; i < 20; i++) node(`db-analytics.t${i}`, `events_${["orders", "views", "carts", "search", "clicks"][i % 5]}_${Math.floor(i / 5)}`, "store", "db-analytics", "unchanged", "An analytics event table.");

const tableOf = (svc: string): string[] => TABLES.filter((t) => t.startsWith(svc.replace(/s$/, "").replace(/-api$/, "")) || t.startsWith(svc));
for (const s of SERVICES) {
  const scoped = !UNSCOPED.has(s);
  const sid = `svc-${s}`;
  node(sid, s, "service", "system", scoped ? "modified" : "unchanged", `The ${s} service.`);
  node(`${sid}.http`, "http", "module", sid, ADMIN.includes(s) || scoped ? "modified" : "unchanged", `${s}'s HTTP handlers.`, ADMIN.includes(s) ? "Admin handlers emit audit events." : "Handlers take the tenant from the context.");
  node(`${sid}.domain`, "domain", "module", sid, s === "payments" || s === "billing" || s === "orders" ? "modified" : "unchanged", `${s}'s rules.`, s === "payments" ? "Refunds check the payment's refunded total first." : "Order placement publishes a billing event.");
  node(`${sid}.store`, "store", "module", sid, scoped ? "modified" : "unchanged", `${s}'s queries.`, "Queries go through sqlscope.");
  if (s !== "gateway") node(`${sid}.middleware`, "middleware", "module", sid, scoped ? "added" : "unchanged", `${s}'s request middleware.`, "New: puts the request's tenant on the context.");
  else node(`${sid}.middleware`, "middleware", "module", sid, "modified", "The gateway's middleware: auth, tenant, rate limits.", "Resolves the tenant from the host and rate-limits sign-in.");
  node(`${sid}.config`, "config", "module", sid, "unchanged", `${s}'s configuration.`);
  if (WITH_JOBS.has(s)) node(`${sid}.jobs`, "jobs", "module", sid, scoped || s === "billing" ? "modified" : "unchanged", `${s}'s background jobs.`, "Jobs restore the tenant they were queued with.");
}
// The audit service is new.
node("svc-audit", "audit", "service", "system", "added", "Stores admin actions and serves them to support.", "New service.");
node("svc-audit.consumer", "consumer", "module", "svc-audit", "added", "Reads audit events from Kafka.");
node("svc-audit.store", "store", "module", "svc-audit", "added", "Writes and reads the audit_log table.");
node("svc-audit.http", "http", "module", "svc-audit", "added", "Serves the audit trail to the support console.");
node("svc-billing.events", "events", "module", "svc-billing", "added", "Consumes order events and bills them.", "New: billing by events instead of calls.");
node("svc-search.indexer", "indexer", "module", "svc-search", "unchanged", "Rebuilds the search index from products every night.");

// Lines.
edge("customer", "svc-gateway.http", "call", "browses, buys");
edge("admin", "svc-admin-api.http", "call", "manages the shop");
edge("support", "svc-audit.http", "call", "reads the audit trail", "added");
edge("svc-gateway.middleware", "auth0", "call", "verifies tokens");
edge("svc-gateway.middleware", "lib-tenancy.context", "call", "resolves the tenant", "added");
for (const s of SERVICES) {
  const sid = `svc-${s}`;
  const scoped = !UNSCOPED.has(s);
  if (s !== "gateway") edge("svc-gateway.http", `${sid}.http`, "call", "routes requests");
  if (s !== "gateway") edge(`${sid}.middleware`, "lib-tenancy.context", "call", "reads the tenant", scoped ? "added" : "unchanged");
  edge(`${sid}.http`, `${sid}.domain`, "call", "applies rules");
  edge(`${sid}.domain`, `${sid}.store`, "call", "reads and writes");
  if (scoped) edge(`${sid}.store`, "lib-tenancy.sqlscope", "call", "scopes queries", "added");
  for (const t of tableOf(s)) edge(`${sid}.store`, `db-main.${t}`, "data", t, scoped && !GLOBAL_TABLES.has(t) ? "modified" : "unchanged");
  if (WITH_JOBS.has(s)) {
    edge(`${sid}.jobs`, `${sid}.store`, "call", "batch work");
    if (scoped) edge(`${sid}.jobs`, "lib-tenancy.jobs", "call", "restores the tenant", "added");
  }
}
// Tables no service name matches: give each a store that reads it.
const owned = new Set(edges.filter((e) => e.to.startsWith("db-main.")).map((e) => e.to));
const owners = ["svc-users.store", "svc-orders.store", "svc-catalog.store", "svc-webhooks.store", "svc-billing.store"];
TABLES.forEach((t, i) => {
  if (!owned.has(`db-main.${t}`) && t !== "audit_log") edge(owners[i % owners.length]!, `db-main.${t}`, "data", t, GLOBAL_TABLES.has(t) ? "unchanged" : "modified");
});
for (const s of ADMIN) edge("svc-admin-api.http", `svc-${s}.http`, "call", "admin actions");
for (const s of ADMIN) edge(`svc-${s}.http`, "kafka", "event", "audit event", "added");
edge("kafka", "svc-audit.consumer", "event", "audit events", "added");
edge("svc-audit.consumer", "svc-audit.store", "call", "stores actions", "added");
edge("svc-audit.http", "svc-audit.store", "call", "reads actions", "added");
edge("svc-audit.store", "db-main.audit_log", "data", "audit rows", "added");
edge("svc-orders.domain", "kafka", "event", "order placed", "added");
edge("kafka", "svc-billing.events", "event", "order placed", "added");
edge("svc-billing.events", "svc-billing.store", "call", "records charges", "added");
edge("svc-billing.events", "stripe", "call", "charges cards", "added");
edge("svc-billing.jobs", "stripe", "call", "retries charges", "modified");
edge("svc-orders.domain", "svc-billing.http", "call", "charge now (removed)", "removed");
edge("svc-payments.domain", "stripe", "call", "refunds");
edge("svc-payments.store", "db-main.refunds", "data", "refunds", "modified");
edge("svc-reports.jobs", "db-analytics", "data", "event history");
edge("svc-reports.store", "db-main.orders", "data", "orders, all tenants");
edge("svc-search.indexer", "db-main.products", "data", "products, all tenants");
edge("svc-search.indexer", "svc-search.store", "call", "writes the index");
edge("svc-media.store", "s3", "data", "images");
edge("svc-auth.http", "svc-auth.store", "call", "sign-in attempts");
edge("svc-gateway.middleware", "db-main.rate_limits", "data", "sign-in counters", "modified");

// ---------------------------------------------------------------------------------------------
// The purposes.

const pclaims: PClaim[] = [];
function pc(id: string, text: string, status: PClaim["status"], src: "description" | "code" | "issue", quote = text): string {
  const c = src === "code" ? claim(`k-${id}`, text, "made/up.go") : "";
  pclaims.push({
    id,
    text,
    status,
    sources: src === "description" ? [{ kind: "description", quote }] : src === "issue" ? [{ kind: "issue", number: 412, title: "Tenant data leaks between shops", quote }] : [{ kind: "code", claim: c }],
  });
  return id;
}
const walk = (intro: string, journey: string, destination: string, cs: string[]) => ({ intro, journey, destination, claims: cs });
const serves = (ids: string[], role: string, cs: string[]) => ids.filter((id) => nodes.some((n) => n.id === id)).map((node) => ({ node, role, claims: cs }));
const edgesBetween = (pred: (e: Edge) => boolean, why: string) => edges.filter(pred).map((e) => ({ edge: e.id, why, claims: [] }));
const stop = (kind: Stop["kind"], id: string, line: string): Stop => ({ kind, id, line } as Stop);
const firstEdge = (from: string, to: string) => edges.find((e) => e.from === from && e.to === to)!.id;

const cLeak = pc("q-leak", "One shop could read another's orders through the reports export.", "stated", "issue", "Shop A's export contained shop B's orders.");
const cScope = pc("q-scope", "Every query a store builds goes through sqlscope, which adds tenant_id.", "backed", "code");
const cRls = pc("q-rls", "Every tenant-owned table gets tenant_id and a row-level policy.", "backed", "code");
const cAudit = pc("q-audit", "Admin actions are recorded so support can answer 'who changed this?'.", "backed", "description", "Support needs to see who changed a price or refunded an order.");
const cBill = pc("q-bill", "Orders are billed from an event, so a billing outage no longer fails checkout.", "backed", "description", "Checkout no longer calls billing synchronously.");
const cRefund = pc("q-refund", "A refund now checks the payment's refunded total first, so a retry can't refund twice.", "backed", "code");
const cRate = pc("q-rate", "Sign-in is limited to 10 attempts a minute per account.", "backed", "code");

const scopedSvcs = SERVICES.filter((s) => !UNSCOPED.has(s));
const tenantTables = TABLES.filter((t) => !GLOBAL_TABLES.has(t) && t !== "audit_log").map((t) => `db-main.${t}`);
const middlewares = scopedSvcs.map((s) => `svc-${s}.middleware`);
const stores = [...scopedSvcs.map((s) => `svc-${s}.store`), "svc-audit.store"];
const jobs = scopedSvcs.filter((s) => WITH_JOBS.has(s)).map((s) => `svc-${s}.jobs`);


const purposes: Purpose[] = [
  {
    id: "T",
    name: "Keep each shop's data to itself",
    kind: "security",
    walk: walk(
      "One shop could read another's orders, so every request, query and job now carries its shop (the tenant).",
      "The gateway resolves the tenant, each service's middleware puts it on the context, stores scope every query by it, and jobs keep it.",
      "Every tenant-owned table has tenant_id and a row-level policy, so a missed filter fails closed.",
      [cLeak, cScope, cRls],
    ),
    stops: [stop("purpose", "T1", "The tenant is resolved once and travels with the request."), stop("purpose", "T2", "Stores add tenant_id to every query."), stop("purpose", "T3", "Tables get tenant_id and a row-level policy."), stop("purpose", "T4", "Jobs restore the tenant they were queued with.")],
    serves: [...serves(["lib-tenancy", "db-main"], "Holds the tenant work", [cScope, cRls])],
    edges: [],
  },
  {
    id: "T1",
    name: "Every request carries its tenant",
    parent: "T",
    kind: "groundwork",
    walk: walk("The tenant is worked out once, at the gateway, from the shop's host.", "Each service's new middleware reads it from the token into the context.", "Handlers never take a tenant from the request body.", [cScope]),
    stops: [stop("node", "svc-gateway.middleware", "Resolves the tenant from the host."), stop("edge", firstEdge("svc-gateway.middleware", "lib-tenancy.context"), "Hands it to the context."), stop("node", "lib-tenancy.context", "Holds it for the request."), stop("node", "svc-orders.middleware", "Each service reads it the same way (21 more).")],
    serves: [...serves(["svc-gateway.middleware", "lib-tenancy.context"], "Resolves and holds the tenant", [cScope]), ...serves(middlewares.filter((x) => x !== "svc-gateway.middleware"), "Reads the tenant into the context", [cScope])],
    edges: edgesBetween((e) => e.to === "lib-tenancy.context", "carries the tenant"),
  },
  {
    id: "T2",
    name: "Stores filter by tenant",
    parent: "T",
    kind: "security",
    walk: walk("Every store builds its queries through sqlscope.", "sqlscope adds tenant_id = ? from the context, and refuses a query without one.", "No store query runs without a tenant.", [cScope]),
    stops: [stop("node", "lib-tenancy.sqlscope", "Adds the filter."), stop("node", "svc-orders.store", "Orders' queries go through it (and 20 other stores).")],
    serves: [...serves(["lib-tenancy.sqlscope"], "Adds the tenant filter", [cScope]), ...serves(stores, "Builds its queries through sqlscope", [cScope])],
    edges: edgesBetween((e) => e.to === "lib-tenancy.sqlscope", "scopes queries"),
  },
  {
    id: "T3",
    name: "Tables get a tenant column",
    parent: "T",
    kind: "groundwork",
    walk: walk("55 tables gain tenant_id.", "A migration backfills it from each row's owner and adds a row-level policy.", "A query that forgets the filter returns nothing.", [cRls]),
    stops: [stop("node", "db-main", "One migration per table."), stop("node", "db-main.orders", "Orders: backfilled from the cart's shop.")],
    serves: serves(tenantTables, "Holds tenant_id with a row-level policy", [cRls]),
    edges: edgesBetween((e) => e.to.startsWith("db-main.") && tenantTables.includes(e.to) && e.change === "modified", "now scoped"),
  },
  {
    id: "T4",
    name: "Jobs keep their tenant",
    parent: "T",
    kind: "groundwork",
    walk: walk("Background jobs ran with no tenant at all.", "The queue stamps the tenant on each job and the runner restores it.", "A job's queries are scoped like a request's.", [cScope]),
    stops: [stop("node", "lib-tenancy.jobs", "Stamps and restores."), stop("node", "svc-orders.jobs", "Every job runner uses it.")],
    serves: [...serves(["lib-tenancy.jobs"], "Stamps and restores the tenant", [cScope]), ...serves(jobs, "Restores the tenant before running", [cScope])],
    edges: edgesBetween((e) => e.to === "lib-tenancy.jobs", "restores the tenant"),
  },
  {
    id: "A",
    name: "Record what admins do",
    kind: "feature",
    walk: walk("Support couldn't tell who changed a price or refunded an order.", "Admin handlers in eight services publish an audit event, and a new audit service stores them.", "Support reads the trail in the console.", [cAudit]),
    stops: [stop("purpose", "A1", "Admin actions publish events."), stop("purpose", "A2", "The audit service keeps and serves them.")],
    serves: [],
    edges: [],
  },
  {
    id: "A1",
    name: "Admin actions publish events",
    parent: "A",
    kind: "feature",
    walk: walk("Eight services' admin handlers publish one event per change.", "The admin API calls them, and each sends who, what and when to Kafka.", "Nothing an admin changes goes unrecorded.", [cAudit]),
    stops: [stop("node", "svc-admin-api.http", "Admins act here."), stop("node", "svc-orders.http", "Each handler publishes (8 services)."), stop("node", "kafka", "Carries the events.")],
    serves: [...serves(["svc-admin-api.http", "kafka", "svc-gateway.middleware"], "Carries admin actions", [cAudit]), ...serves(ADMIN.map((s) => `svc-${s}.http`), "Publishes an audit event per admin change", [cAudit])],
    edges: edgesBetween((e) => e.label === "audit event" || e.label === "admin actions", "carries admin actions"),
  },
  {
    id: "A2",
    name: "The audit service keeps them",
    parent: "A",
    kind: "feature",
    walk: walk("A new audit service reads the events.", "It writes one row per action to audit_log and serves them to support.", "Support sees who did what.", [cAudit]),
    stops: [stop("node", "svc-audit.consumer", "Reads events."), stop("node", "svc-audit.store", "Writes audit_log."), stop("node", "svc-audit.http", "Serves the trail.")],
    serves: serves(["svc-audit", "svc-audit.consumer", "svc-audit.store", "svc-audit.http", "db-main.audit_log", "kafka"], "Stores and serves the trail", [cAudit]),
    edges: edgesBetween((e) => e.from.startsWith("svc-audit") || e.to.startsWith("svc-audit"), "the trail"),
  },
  {
    id: "B",
    name: "Bill orders from an event",
    kind: "process",
    walk: walk("Checkout called billing directly, so a billing outage failed checkout.", "Orders now publish 'order placed', and billing's new consumer charges from it.", "Checkout succeeds even when billing or Stripe is down.", [cBill]),
    stops: [stop("node", "svc-orders.domain", "Publishes the event."), stop("node", "kafka", "Carries it."), stop("node", "svc-billing.events", "Charges from it."), stop("node", "stripe", "Takes the money.")],
    serves: serves(["svc-orders.domain", "kafka", "svc-billing.events", "svc-billing.store", "svc-billing.jobs", "stripe", "svc-payments.store", "db-main.invoices", "db-main.billing_events", "db-main.payments"], "Bills from the event", [cBill]),
    edges: edgesBetween((e) => ["order placed", "charges cards", "records charges", "retries charges", "charge now (removed)"].includes(e.label), "bills from the event"),
  },
  {
    id: "F1",
    name: "Stop double refunds",
    kind: "fix",
    walk: walk("A retried refund could refund twice.", "The refund checks the payment's refunded total in the same transaction.", "A retry is a no-op.", [cRefund]),
    stops: [stop("node", "svc-payments.domain", "Checks the total."), stop("node", "svc-payments.store", "Locks the row."), stop("node", "db-main.refunds", "Holds the refunds.")],
    serves: serves(["svc-payments.domain", "svc-payments.store", "db-main.refunds", "db-main.payments"], "Refuses a second refund", [cRefund]),
    edges: edgesBetween((e) => e.label === "refunds", "refunds"),
  },
  {
    id: "F2",
    name: "Rate-limit sign-in",
    kind: "fix",
    walk: walk("Sign-in had no limit.", "The gateway counts attempts per account in rate_limits.", "The eleventh attempt in a minute is refused.", [cRate]),
    stops: [stop("node", "svc-gateway.middleware", "Counts attempts."), stop("node", "db-main.rate_limits", "Holds the counters.")],
    serves: serves(["svc-gateway.middleware", "db-main.rate_limits", "svc-auth.http"], "Limits sign-in", [cRate]),
    edges: edgesBetween((e) => e.label === "sign-in counters", "counts attempts"),
  },
];

const conflicts: Conflict[] = [
  {
    id: "x1",
    kind: "purpose-purpose",
    title: "Does the audit store filter by tenant?",
    a: { says: "every store does", text: "Every store builds its queries through sqlscope.", source: { kind: "code", claim: "k-q-scope" }, purpose: "T2" },
    b: { says: "reads all shops", text: "The audit store reads every shop's rows so support can search across them.", source: { kind: "code", claim: claim("k-audit-all", "The audit store queries audit_log without tenant_id.", "svc/audit/store/query.go") }, purpose: "A2" },
    touches: { purposes: ["T", "T2", "A", "A2"], nodes: ["svc-audit.store", "db-main.audit_log"], edges: [] },
  },
  {
    id: "x2",
    kind: "purpose-outside",
    title: "Does every query filter by tenant?",
    a: { says: "every store does", text: "Every store builds its queries through sqlscope.", source: { kind: "code", claim: "k-q-scope" }, purpose: "T2" },
    b: { says: "reports and search don't", text: "reports' store and search's nightly indexer, which the PR doesn't touch, read orders and products for every shop.", source: { kind: "code", claim: claim("k-outside", "svc/reports/store and svc/search/indexer query without tenant_id.", "svc/reports/store/orders.go") } },
    touches: { purposes: ["T", "T2"], nodes: ["svc-reports.store", "svc-search.indexer", "db-main.orders", "db-main.products"], edges: [firstEdge("svc-reports.store", "db-main.orders"), firstEdge("svc-search.indexer", "db-main.products")] },
  },
  {
    id: "x3",
    kind: "stated-code",
    title: "Does billing still retry Stripe?",
    a: { says: "no retries", text: "Billing no longer retries Stripe; the event is redelivered instead.", source: { kind: "description", quote: "Billing doesn't retry Stripe any more: Kafka redelivers." } },
    b: { says: "retries 3 times", text: "billing's charge job still retries a failed charge three times.", source: { kind: "code", claim: claim("k-retry", "billing/jobs retries a charge up to 3 times.", "svc/billing/jobs/charge.go") } },
    touches: { purposes: ["B"], nodes: ["svc-billing.jobs"], edges: [firstEdge("svc-billing.jobs", "stripe")] },
  },
];

const analysis: Analysis = {
  version: 1,
  pr: {
    repo: "acme/shop",
    number: 77,
    title: "Tenant isolation, an audit log, billing by events, and two fixes",
    url: "https://example.com/acme/shop/pull/77",
    author: "sam",
    description: "MADE UP for the PR view prototype (#160). Scopes every query to its shop, records admin actions, bills orders from an event, stops double refunds and rate-limits sign-in.",
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    stats: { files: 412, additions: 9120, deletions: 2210 },
  },
  coverage: { summary: "Made up: no code behind it.", skipped: [], notes: ["Made up for #160."] },
  facets: [],
  nodes,
  edges,
  boundaries: [],
  scenarios: [],
  claims,
};

const p: Purposes = {
  walk: walk(
    "This PR does five things: it keeps each shop's data to itself, records what admins do, bills orders from an event, and fixes double refunds and unlimited sign-in.",
    "Tenant isolation is most of it: it touches 21 services' middleware, stores and jobs and 55 tables.",
    "Once merged, no query runs without a shop, and checkout no longer waits on billing.",
    [cLeak, cAudit, cBill],
  ),
  purposes,
  nodes: [],
  edges: [],
  conflicts,
  claims: pclaims,
};

mkdirSync(join(here, "data/purposes"), { recursive: true });
writeFileSync(join(here, "data/acme-shop-77.json"), JSON.stringify(analysis, null, 1));
writeFileSync(join(here, "data/purposes/acme-shop-77.json"), JSON.stringify(p, null, 1));
const lit = new Set(purposes.flatMap((x) => x.serves.map((s) => s.node)));
console.log(`${nodes.length} parts, ${edges.length} lines, ${purposes.length} purposes, ${lit.size} parts serve a purpose, ${claims.length} code claims`);

