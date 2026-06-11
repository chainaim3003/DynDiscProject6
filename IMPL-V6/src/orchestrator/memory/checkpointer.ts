// ================= IMPL-V6 — SAGA CHECKPOINTER (T2 + T5) =================
//
// SqliteSaver checkpointer for the negotiation saga. Per 04 §7.1 + §8 and
// 01 §3 (memory tiers): T2 (saga / episodic) and T5 (human-readable audit)
// SHARE one SQLite file = flags.AUDIT_DB_PATH (default ./data/audit.db).
//
// thread_id = negotiationId is NOT set here — it's supplied per-invocation in
// the graph run config: graph.invoke(input, { configurable: { thread_id: negId } }).
// This factory only owns "which DB file + which backend".
//
// Backend is gated by flags.CHECKPOINTER_KIND (only "sqlite" in V6 scope).
//
// API NOTE (Rule 3): the exact SqliteSaver entrypoint is verified by
// `npm run typecheck` against @langchain/langgraph-checkpoint-sqlite@1.0.1.
// `fromConnString` is the documented factory (opens better-sqlite3 internally);
// if the installed version differs, the typecheck error will pinpoint it.

import path from "node:path";
import fs   from "node:fs";

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import { loadFlags, type OrchestratorFlags } from "../../config/flags.js";

export interface CheckpointerOptions {
  /** Override the resolved AUDIT_DB_PATH. Use ":memory:" for ephemeral tests. */
  dbPath?: string;
  /** Inject pre-resolved flags (else loadFlags() is called). */
  flags?: Readonly<OrchestratorFlags>;
}

/**
 * Build the saga checkpointer. Ensures the parent directory of a file-backed
 * DB exists (recursive mkdir); ":memory:" is left untouched.
 */
export function createCheckpointer(opts: CheckpointerOptions = {}): SqliteSaver {
  const flags = opts.flags ?? loadFlags();

  if (flags.CHECKPOINTER_KIND !== "sqlite") {
    throw new Error(
      `[checkpointer] CHECKPOINTER_KIND="${flags.CHECKPOINTER_KIND}" is not supported; ` +
      `only "sqlite" is wired in V6.`,
    );
  }

  const dbPath = opts.dbPath ?? flags.AUDIT_DB_PATH;

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  return SqliteSaver.fromConnString(dbPath);
}
