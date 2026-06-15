// ================= IMPL-V6 — NEGOTIATION RUNNER (orchestrator entry) =================
//
// The library entry point for the negotiation saga. Resolves flags once, creates the
// single ErpNextClient, builds + compiles the graph, seeds the initial state from an
// inbound inquiry, and invokes the graph with thread_id = negotiationId (so every
// super-step checkpoints to the shared SqliteSaver, T2/T5).
//
// The graph now spans intake → DD (GLEIF + credit) → quoting/ATP → negotiate (binding
// treasury veto) → persist+sign. DD and negotiation activate per the inquiry's dimensions
// ("DD"/"N"); otherwise they pass through. To EXERCISE them, forward the relevant knobs:
//   - creditFixturesDir   → enables the fixture-backed demo CreditProvider for DD
//   - negotiateDemoFloor  → the configured treasury floor the negotiate veto enforces
//   - buyerMaxUnitPrice   → optional buyer reservation override (else inquiry target)
//
// AI vs MANUAL: this module is AI-written and unit-runnable; an actual LIVE run hits
// ERPNext at localhost:8080 (your machine only) and GLEIF at api.gleif.org, so a real
// end-to-end run is MANUAL — drive it from a small harness once masters/Item Prices are
// seeded and (for DD) the credit fixtures are real.
//
// GROUNDING:
//   - Graph:        orchestrator/graph.ts
//   - Inquiry norm: orchestrator/nodes/intake.ts (normalizeInquiry — shared)
//   - Flags:        config/flags.ts (loadFlags — resolved once here)
//   - Seller LEI:   01 §1 locked invariant (Jupiter Knitting Co).

import { loadFlags, type OrchestratorFlags } from "../config/flags.js";
import { createErpNextClient } from "../erpnext/client.js";
import { buildNegotiationGraph } from "./graph.js";
import { normalizeInquiry, type InquiryInput } from "./nodes/intake.js";
import type { NegStateType } from "./state/neg-state.js";

/** Jupiter Knitting Co — seller LEI (01 §1 invariant). Overridable via options. */
export const DEFAULT_SELLER_LEI = "3358004DXAMRWRUIYJ05";

export interface RunNegotiationOptions {
  /** Saga thread id. Defaults to the inquiry's, else a generated NEG-<ts>. */
  negotiationId?: string;
  /** Seller LEI. Defaults to the Jupiter invariant. */
  sellerLEI?: string;
  /** Pre-resolved flags (else loadFlags()). */
  flags?: Readonly<OrchestratorFlags>;
  /** Selling Price List the quoting nodes read (default "Standard Selling"). */
  priceList?: string;
  /** ERPNext Warehouse doc NAME for Bin lookups (else flags default). */
  warehouse?: string;
  /** Directory of <lei>.json credit fixtures → enables the demo CreditProvider for DD. */
  creditFixturesDir?: string;
  /** Configured treasury floor (price/unit) the negotiate veto enforces (demo mode). */
  negotiateDemoFloor?: number;
  /** Buyer reservation (max price/unit) override; else the inquiry's stated target. */
  buyerMaxUnitPrice?: number;
  /** Emit ERPNext custom identity fields on persist (only once the quotation fixture exists). */
  persistCustomFields?: boolean;
}

/** Deterministic NEG id when none supplied. */
function newNegotiationId(): string {
  return `NEG-${Date.now()}`;
}

/**
 * Run one negotiation saga end-to-end and return the final saga state.
 *
 *   const final = await runNegotiation(inquiry);
 *   const final = await runNegotiation(inquiry, {
 *     priceList: "Jupiter Standard - INR",
 *     creditFixturesDir: "DEMO-DATA/credit",   // exercise DD
 *     negotiateDemoFloor: 250,                 // exercise negotiation veto
 *   });
 *
 * Throws if intake can't write the Opportunity or quoting can't price a line — fail
 * loud, never a fabricated result. The SqliteSaver checkpoint allows resuming the same
 * thread_id after a fix.
 */
export async function runNegotiation(
  inquiry: InquiryInput,
  opts: RunNegotiationOptions = {},
): Promise<NegStateType> {
  const flags = opts.flags ?? loadFlags();
  const erp = createErpNextClient(flags);
  const graph = buildNegotiationGraph({
    flags,
    erp,
    priceList: opts.priceList,
    warehouse: opts.warehouse,
    creditFixturesDir: opts.creditFixturesDir,
    negotiateDemoFloor: opts.negotiateDemoFloor,
    buyerMaxUnitPrice: opts.buyerMaxUnitPrice,
    persistCustomFields: opts.persistCustomFields,
  });

  const negotiationId = opts.negotiationId ?? inquiry.negotiationId ?? newNegotiationId();
  const sellerLEI = opts.sellerLEI ?? DEFAULT_SELLER_LEI;

  // Build a complete, valid Inquiry for the seed (the channel requires a full
  // Inquiry). intake.parse re-normalizes idempotently as the canonical step.
  const normalized = normalizeInquiry(inquiry, { negotiationId });

  const seed = {
    negotiationId,
    buyerLEI: normalized.buyerLei,
    sellerLEI,
    inquiry: normalized,
  };

  const final = await graph.invoke(seed, { configurable: { thread_id: negotiationId } });
  return final as NegStateType;
}
