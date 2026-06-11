// ================= IMPL-V6 — TOOL-CALL AUDIT SINK (V6.2 bridge) =================
//
// WHY THIS EXISTS (read, not assumed):
//   The design's durable audit row is a LangGraph super-step artifact written by
//   the SqliteSaver checkpointer (04 §7.1/§8). In V6.2 there is NO graph yet —
//   the MCP server invokes a single tool directly. To honor INV-3
//   (audit-always-available) and the V6.2 exit criterion ("audit row written"),
//   this module appends one JSONL row per tool call.
//
//   This is an explicit BRIDGE, not a replacement: when the orchestrator graph
//   wraps tools (V6.3+), per-call audit becomes a checkpoint in audit.db and this
//   sink can be retired or kept as a lightweight access log. It deliberately does
//   NOT write into audit.db (reserved for T2 saga + T5 audit) — so it cannot
//   corrupt the checkpoint schema.
//
// DESIGN PROPERTIES:
//   - Configurable (userPreferences Rule 8): `enabled` + `path` via opts, with
//     sensible defaults. No new env flags introduced (keeps flags.ts/.env.example
//     the single flag contract); server-sse passes options explicitly.
//   - NEVER throws: an audit failure must not break the tool call. Errors are
//     logged to stderr and swallowed.
//   - Records routerLatencyMs (wall-clock measured by the server boundary) and
//     the ConsultationRecord provenance (subAgent/dataMode/dataSource) — never
//     secrets (no API keys; the LEI is public reference data).

import fs from "node:fs";
import path from "node:path";

/** One durable audit row per MCP tool invocation. */
export interface ToolCallAuditRow {
  /** ISO timestamp when the row was written. */
  ts: string;
  /** MCP tool name (e.g. "verify_lei_gleif"). */
  tool: string;
  /** Did the consultation succeed (data returned)? false = defensive branch / error. */
  ok: boolean;
  /** Wall-clock of the handler at the server boundary (the design's routerLatencyMs). */
  routerLatencyMs: number;
  /** Provenance echoed from ConsultationRecord.metadata (non-sensitive). */
  subAgent?: string;
  dataMode?: string;
  dataSource?: string;
  /** Tool-specific reference (e.g. the LEI — public data). Optional. */
  ref?: string;
  /** Populated when ok === false. */
  error?: string;
}

export interface ToolAuditOptions {
  /** Default true. */
  enabled?: boolean;
  /** Default "./data/tool-call-audit.jsonl". */
  path?: string;
}

const DEFAULT_AUDIT_PATH = "./data/tool-call-audit.jsonl";

/**
 * Append one audit row as a JSON line. Creates the parent directory if needed.
 * Never throws — a failed audit write logs and returns.
 */
export function appendToolCallAudit(row: ToolCallAuditRow, opts: ToolAuditOptions = {}): void {
  const enabled = opts.enabled ?? true;
  if (!enabled) return;

  const file = path.resolve(opts.path ?? DEFAULT_AUDIT_PATH);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  } catch (err) {
    // INV-3: audit-always-available must not break the tool path.
    console.error(`[tool-audit] failed to append audit row: ${(err as Error).message}`);
  }
}
