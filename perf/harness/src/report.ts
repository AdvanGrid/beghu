// The verdicts as a Markdown table (the PR comment, `last.md`) and as one summary line.
import type { Row, Unit } from "./gates.ts";

const fmt = (v: number | null | undefined, unit: Unit) =>
  v === null || v === undefined ? "–" : unit === "ms" ? `${v.toFixed(1)} ms` : unit === "kb" ? `${v.toFixed(1)} KB` : String(v);

const MARK: Record<Row["verdict"], string> = {
  pass: "✅ pass",
  fail: "❌ fail",
  warn: "⚠️ over (report-only)",
  "over-spec": "⚠️ within limit, over spec",
  unbudgeted: "❌ no budget",
  missing: "❌ not measured",
};

export function failed(rows: readonly Row[]): Row[] {
  return rows.filter((r) => r.verdict === "fail" || r.verdict === "unbudgeted" || r.verdict === "missing");
}

/** One line: how many gates passed, warned and failed, the failures named. */
export function summaryLine(rows: readonly Row[], seconds?: number): string {
  const n = (v: Row["verdict"]) => rows.filter((r) => r.verdict === v).length;
  const bad = failed(rows);
  const parts = [`perf: ${rows.length} gates`, `${n("pass")} pass`];
  if (n("warn")) parts.push(`${n("warn")} report-only over (${rows.filter((r) => r.verdict === "warn").map((r) => r.gate).join(", ")})`);
  if (n("over-spec")) parts.push(`${n("over-spec")} over spec (${rows.filter((r) => r.verdict === "over-spec").map((r) => r.gate).join(", ")})`);
  parts.push(bad.length ? `${bad.length} FAILED (${bad.map((r) => `${r.gate} ${fmt(r.value, r.unit)}${r.limit !== null ? ` > ${fmt(r.limit, r.unit)}` : ""}${r.slower !== undefined ? ` +${(r.slower * 100).toFixed(0)}% vs main` : ""}`).join(", ")})` : "0 failed");
  if (seconds !== undefined) parts.push(`${Math.round(seconds)} s`);
  return parts.join(", ");
}

export interface Meta {
  title: string;
  lines: string[];
  /** Whether the rows carry local main's values (`./dev-ctl perf`). */
  vsMain?: boolean;
}

export function markdown(rows: readonly Row[], meta: Meta): string {
  const out = [`### ${meta.title}`, "", summaryLine(rows), "", ...meta.lines.map((l) => `${l}  `), ""];
  out.push(meta.vsMain ? "| Gate | This tree | Limit | Main | vs main | Result |" : "| Gate | Measured | Limit | Result |");
  out.push(meta.vsMain ? "|---|---:|---:|---:|---:|---|" : "|---|---:|---:|---|");
  for (const r of rows) {
    const value = r.first !== undefined ? `${fmt(r.value, r.unit)} (first ${fmt(r.first, r.unit)})` : fmt(r.value, r.unit);
    const limit = r.spec === undefined ? fmt(r.limit, r.unit) : `${fmt(r.limit, r.unit)} (spec ${fmt(r.spec, r.unit)})`;
    const cells = [`\`${r.gate}\``, value, limit];
    if (meta.vsMain) cells.push(fmt(r.main, r.unit), r.slower === undefined ? "–" : `${r.slower >= 0 ? "+" : ""}${(r.slower * 100).toFixed(1)}%`);
    cells.push(MARK[r.verdict]);
    out.push(`| ${cells.join(" | ")} |`);
  }
  const explained = rows.filter((r) => r.verdict !== "pass" && (r.evidence?.length || r.reason));
  if (explained.length) {
    out.push("", "<details><summary>Evidence</summary>", "");
    for (const r of explained) {
      out.push(`**\`${r.gate}\`**${r.reason ? `: ${r.reason}` : ""}`, "");
      for (const e of r.evidence ?? []) out.push(`- \`${e.replace(/`/g, "'")}\``);
      out.push("");
    }
    out.push("</details>");
  }
  return out.join("\n") + "\n";
}
