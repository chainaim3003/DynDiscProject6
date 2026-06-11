// ================= IMPL-V6 — NEGOTIATION ROUND OUTCOME TYPES =================
//
// NET-NEW (no literal TS exists). Derived from:
//   04-Orchestration-Design.md §3.1 (rounds: RoundOutcome[] channel, concat
//      reducer), §4.3 (bounded loop, NEGOTIATION_MAX_ROUNDS=3), §4.7
//      (evaluator-optimizer per round: optimizer → constraints → treasury veto → emit)
//   Reuses the EXISTING decision-trail + treasury-summary shapes from
//   negotiation-types.ts (vendored into shared/ in the vendor step) rather than
//   redefining them — keeps the audit trail consistent with the legacy engine.
// Appended once per negotiation round; written to NegState.rounds (04 §3.1).

import type {
  DecisionTrailEntry,
  TreasuryConsultationSummary,
} from "./negotiation-types.js";

// Exit states for a round (04 §4.3 exit conditions).
export type RoundResult = "COUNTERED" | "ACCEPTED" | "REJECTED" | "ESCALATED";

export interface RoundOutcome {
  round:          number;                       // 1-indexed; capped by NEGOTIATION_MAX_ROUNDS
  timestamp:      string;                       // ISO

  buyerOffer?:    number;                        // incoming buyer price this round
  sellerCounter?: number;                        // seller's emitted price (post-evaluator)

  // Evaluator-optimizer trail (04 §4.7): optimizer (LLM) → constraints.validate
  // (det) → treasury.veto (ACTUS). Reuses the existing DecisionTrailEntry so the
  // audit JSON is byte-compatible with the legacy engine's decision trail.
  decision:       DecisionTrailEntry;
  treasury?:      TreasuryConsultationSummary;   // veto result; minViablePrice on reject

  result:         RoundResult;

  // Each committed round MAY become a Quotation revision (P09). Persisted only
  // when QUOTE_PERSIST_MODE=every-round; for the default (final) these live in
  // T2 only and just the final Quotation is written (01 Part 7 item 7).
  quoteRevision?: number;
  envelopeHash?:  string;                        // sha256 envelope of the emitted offer (SIGNING_MODE=plain)
}
