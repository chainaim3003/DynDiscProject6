// ================= IMPL-V6 — ERPNext IDEMPOTENT WRITES (gap G3) =================
//
// Stops a re-run of the same saga (same negotiationId) from creating DUPLICATE
// ERPNext docs. The run_negotiation tool self-labels as "MUTATING + NON-IDEMPOTENT";
// this module is the guard that makes repeated local runs safe.
//
// TWO STRATEGIES, chosen by WHETHER A QUERYABLE DEDUPE KEY EXISTS ON THE DOCTYPE
// (Rule 8 — grounded in the actual mappers, not assumed):
//
//   1. ERPNext-side dedupe (idempotentInsertByField)
//      Used when the dedupe value is written to a QUERYABLE field. Verified:
//        - Opportunity.custom_inquiry_id = inquiry.negotiationId
//          (erpnext/mappers.ts mapInquiryToOpportunityPayload — always written)
//        - Quotation.custom_negotiation_id = quote.negotiationId
//          (erpnext/quotation-mapper.ts — ONLY when includeCustomFields=true)
//      Before inserting, findOne(doctype, custom_*=value); if found, return that
//      doc's name and DO NOT insert.
//
//   2. Local ledger dedupe (idempotentInsertViaLedger + IdempotencyLedger)
//      Used when the dedupe field is NOT written/queryable. TODAY this is the
//      Quotation in the default path: quotation-mapper.ts GATES custom_negotiation_id
//      behind includeCustomFields (default false) because no erpnextEnh1 Quotation
//      custom-field fixture exists yet (conformance gap G8). So we cannot ask ERPNext
//      "is there already a Quotation for this negotiationId?". Instead we keep a tiny
//      (negotiationId, doctype) -> docName table in the SAME SQLite file the saga
//      checkpointer uses (flags.AUDIT_DB_PATH). When the quotation fixture lands and
//      includeCustomFields flips to true, persist.ts switches to strategy 1 and this
//      ledger is no longer consulted for Quotation.
//
// FLAG: every path is gated by `enabled` (= flags.IDEMPOTENT_WRITES, default true).
// enabled=false reproduces the original blind-insert behavior exactly.

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

import type { ErpNextClient } from "./client.js";

/** Outcome of an idempotent write. */
export interface IdempotentWriteResult {
  /** The ERPNext doc name (existing one on reuse, or the freshly-created one). */
  name: string;
  /** true = an existing doc was found and returned; no INSERT was issued. */
  reused: boolean;
  /** How the name was resolved (provenance for logs/audit). */
  via: "insert" | "erpnext-key" | "ledger";
}

// ─── Strategy 1: ERPNext-side dedupe by a queryable field ────────────────────

/**
 * Idempotent insert keyed on a QUERYABLE ERPNext field.
 *
 * When `enabled` and `keyValue` is non-empty, first findOne(doctype, keyField=keyValue):
 * if a doc exists, return its name without inserting. Otherwise insert `body`.
 *
 * ONLY valid when `keyField` is actually written to the doctype (e.g.
 * Opportunity.custom_inquiry_id). For a field that is gated off (Quotation today),
 * use idempotentInsertViaLedger instead.
 */
export async function idempotentInsertByField(
  erp: ErpNextClient,
  opts: {
    doctype: string;
    keyField: string;
    keyValue: string;
    body: Record<string, unknown>;
    enabled: boolean;
  },
): Promise<IdempotentWriteResult> {
  const { doctype, keyField, keyValue, body, enabled } = opts;

  if (enabled && keyValue) {
    const existing = await erp.findOne<{ name?: string }>(doctype, {
      filters: [[keyField, "=", keyValue]],
      fields: ["name"],
    });
    if (existing?.name) {
      return { name: existing.name, reused: true, via: "erpnext-key" };
    }
  }

  const created = await erp.insert<{ name?: string }>(doctype, body);
  if (!created.name) {
    throw new Error(`[idempotency] ${doctype} insert returned no name`);
  }
  return { name: created.name, reused: false, via: "insert" };
}

// ─── Strategy 2: local SQLite ledger (for non-queryable dedupe keys) ─────────

/**
 * (negotiationId, doctype) -> docName ledger, persisted in the SAME SQLite file
 * the saga checkpointer uses (flags.AUDIT_DB_PATH). The table name
 * `idempotency_ledger` does not collide with LangGraph's checkpoint tables.
 */
export class IdempotencyLedger {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new Database(dbPath);
    // WAL so this connection coexists with the checkpointer's writes.
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS idempotency_ledger (
         negotiation_id TEXT NOT NULL,
         doctype        TEXT NOT NULL,
         doc_name       TEXT NOT NULL,
         created_at     TEXT NOT NULL,
         PRIMARY KEY (negotiation_id, doctype)
       )`,
    );
  }

  /** The doc name already recorded for (negotiationId, doctype), or null. */
  lookup(negotiationId: string, doctype: string): string | null {
    const row = this.db
      .prepare(
        `SELECT doc_name FROM idempotency_ledger WHERE negotiation_id = ? AND doctype = ?`,
      )
      .get(negotiationId, doctype) as { doc_name?: string } | undefined;
    return row?.doc_name ?? null;
  }

  /** Record (or overwrite) the doc name for (negotiationId, doctype). */
  record(negotiationId: string, doctype: string, docName: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO idempotency_ledger
           (negotiation_id, doctype, doc_name, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(negotiationId, doctype, docName, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Process-wide ledger cache keyed by db path, so repeated graph builds in one
 * server process (every run_negotiation call rebuilds the graph) reuse ONE
 * SQLite connection instead of leaking a handle per call.
 */
const ledgerCache = new Map<string, IdempotencyLedger>();

/** Get (or lazily open) the shared ledger for a given AUDIT_DB_PATH. */
export function getIdempotencyLedger(dbPath: string): IdempotencyLedger {
  let ledger = ledgerCache.get(dbPath);
  if (!ledger) {
    ledger = new IdempotencyLedger(dbPath);
    ledgerCache.set(dbPath, ledger);
  }
  return ledger;
}

/**
 * Idempotent insert via the local ledger (for doctypes without a queryable
 * dedupe field — Quotation today). When `enabled` and a prior doc is recorded
 * for `negotiationId`, return it without inserting; otherwise insert + record.
 */
export async function idempotentInsertViaLedger(
  erp: ErpNextClient,
  ledger: IdempotencyLedger,
  opts: {
    doctype: string;
    negotiationId: string;
    body: Record<string, unknown>;
    enabled: boolean;
  },
): Promise<IdempotentWriteResult> {
  const { doctype, negotiationId, body, enabled } = opts;

  if (enabled && negotiationId) {
    const prior = ledger.lookup(negotiationId, doctype);
    if (prior) return { name: prior, reused: true, via: "ledger" };
  }

  const created = await erp.insert<{ name?: string }>(doctype, body);
  if (!created.name) {
    throw new Error(`[idempotency] ${doctype} insert returned no name`);
  }
  if (enabled && negotiationId) {
    ledger.record(negotiationId, doctype, created.name);
  }
  return { name: created.name, reused: false, via: "insert" };
}
