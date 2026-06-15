// ================= IMPL-V6 — AUDIT OBSERVABILITY GraphQL API (P4 / gap G6 fix) =================
//
// `npm run graphql` (package.json) points here; before this file the script was
// BROKEN (referenced a non-existent src/api/graphql/index.ts). This is the audit
// observability surface from REFINED-Project-Structure.md §2 (src/api/), serving
// the REAL audit data the system already produces — no mock data (Rule 8):
//
//   1. Tool-call audit  — the JSONL sink written per MCP tool call
//      (mcp/tool-audit.ts → ./data/tool-call-audit.jsonl). Shape = ToolCallAuditRow.
//   2. Idempotency ledger — the (negotiationId, doctype) -> docName table in
//      AUDIT_DB_PATH (erpnext/idempotency.ts), so you can see which ERPNext docs a
//      negotiation produced and confirm re-runs reused them (gap G3 observability).
//
// Both sources are read defensively: a missing JSONL file or a not-yet-created
// ledger table yields [] rather than an error (the endpoint never fabricates rows).
//
// Stack: graphql-yoga + graphql (already in package.json deps) over node:http.
// Port: GRAPHQL_PORT (default 5000 — the port the README reserves for this API;
// 3000=MCP-SSE, 8080=ERPNext). A named constant, overridable by env.
//
// GROUNDING (read, not assumed):
//   - audit row shape  : mcp/tool-audit.ts (ToolCallAuditRow, DEFAULT_AUDIT_PATH)
//   - ledger table     : erpnext/idempotency.ts (idempotency_ledger columns)
//   - AUDIT_DB_PATH    : config/flags.ts (loadFlags)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";

import { createYoga, createSchema } from "graphql-yoga";
import Database from "better-sqlite3";

import { loadFlags } from "../../config/flags.js";
import type { ToolCallAuditRow } from "../../mcp-servers/tool-audit.js";

// ── Constants (not flags — mirror server-sse's stance) ───────────────────────
const GRAPHQL_PORT = Number(process.env.GRAPHQL_PORT ?? 5000);
const TOOL_AUDIT_PATH = process.env.TOOL_AUDIT_PATH ?? "./data/tool-call-audit.jsonl";

// ── Data access (real sources, defensive reads) ──────────────────────────────

/** Read + parse the tool-call audit JSONL. Missing file → []. Bad lines skipped. */
function readToolCalls(): ToolCallAuditRow[] {
  const file = path.resolve(TOOL_AUDIT_PATH);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const rows: ToolCallAuditRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed) as ToolCallAuditRow);
    } catch {
      // skip a malformed line rather than fail the whole query
    }
  }
  return rows;
}

interface LedgerRow {
  negotiationId: string;
  doctype: string;
  docName: string;
  createdAt: string;
}

/** Read the idempotency ledger from AUDIT_DB_PATH. Missing db/table → []. */
function readLedger(negotiationId?: string, limit = 200): LedgerRow[] {
  const flags = loadFlags();
  const dbPath = flags.AUDIT_DB_PATH;
  if (dbPath !== ":memory:" && !fs.existsSync(path.resolve(dbPath))) return [];
  let db: Database.Database | undefined;
  try {
    db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
    const where = negotiationId ? "WHERE negotiation_id = ?" : "";
    const stmt = db.prepare(
      `SELECT negotiation_id AS negotiationId, doctype, doc_name AS docName, created_at AS createdAt
         FROM idempotency_ledger ${where}
         ORDER BY created_at DESC
         LIMIT ?`,
    );
    const args = negotiationId ? [negotiationId, limit] : [limit];
    return stmt.all(...args) as LedgerRow[];
  } catch {
    // table not created yet (no saga has persisted) or db locked → empty view
    return [];
  } finally {
    db?.close();
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────

const typeDefs = /* GraphQL */ `
  type ToolCall {
    ts: String!
    tool: String!
    ok: Boolean!
    routerLatencyMs: Float!
    subAgent: String
    dataMode: String
    dataSource: String
    ref: String
    error: String
  }

  type ToolStat {
    tool: String!
    calls: Int!
    ok: Int!
    failed: Int!
    avgLatencyMs: Float!
  }

  type LedgerEntry {
    negotiationId: String!
    doctype: String!
    docName: String!
    createdAt: String!
  }

  type Query {
    "Liveness."
    health: String!
    "Per-call MCP tool audit (newest first). Filter by tool name and/or ok."
    toolCalls(tool: String, ok: Boolean, limit: Int = 100): [ToolCall!]!
    "Aggregates per tool: call count, success/failure, mean latency."
    toolStats: [ToolStat!]!
    "ERPNext docs each negotiation produced (idempotency ledger)."
    idempotencyLedger(negotiationId: String, limit: Int = 200): [LedgerEntry!]!
  }
`;

const resolvers = {
  Query: {
    health: () => "ok",
    toolCalls: (
      _p: unknown,
      args: { tool?: string; ok?: boolean; limit?: number },
    ): ToolCallAuditRow[] => {
      let rows = readToolCalls();
      if (args.tool) rows = rows.filter((r) => r.tool === args.tool);
      if (typeof args.ok === "boolean") rows = rows.filter((r) => r.ok === args.ok);
      rows.reverse(); // newest first (JSONL is append-order)
      return rows.slice(0, Math.max(0, args.limit ?? 100));
    },
    toolStats: (): Array<{ tool: string; calls: number; ok: number; failed: number; avgLatencyMs: number }> => {
      const rows = readToolCalls();
      const byTool = new Map<string, { calls: number; ok: number; failed: number; latSum: number }>();
      for (const r of rows) {
        const s = byTool.get(r.tool) ?? { calls: 0, ok: 0, failed: 0, latSum: 0 };
        s.calls += 1;
        if (r.ok) s.ok += 1;
        else s.failed += 1;
        s.latSum += Number(r.routerLatencyMs) || 0;
        byTool.set(r.tool, s);
      }
      return [...byTool.entries()].map(([tool, s]) => ({
        tool,
        calls: s.calls,
        ok: s.ok,
        failed: s.failed,
        avgLatencyMs: s.calls > 0 ? Math.round((s.latSum / s.calls) * 100) / 100 : 0,
      }));
    },
    idempotencyLedger: (
      _p: unknown,
      args: { negotiationId?: string; limit?: number },
    ): LedgerRow[] => readLedger(args.negotiationId, args.limit ?? 200),
  },
};

// ── Server ──────────────────────────────────────────────────────────────────

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: "/graphql",
  landingPage: true,
});

const server = http.createServer(yoga);

server.listen(GRAPHQL_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[graphql] audit observability API on :${GRAPHQL_PORT}\n` +
      `  GraphiQL : http://localhost:${GRAPHQL_PORT}/graphql\n` +
      `  sources  : toolCalls/toolStats <- ${TOOL_AUDIT_PATH}; idempotencyLedger <- ${loadFlags().AUDIT_DB_PATH}`,
  );
});
