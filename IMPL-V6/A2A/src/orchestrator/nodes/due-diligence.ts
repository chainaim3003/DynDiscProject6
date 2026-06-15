// ================= IMPL-V6 — Φ2 DUE-DILIGENCE NODE (GLEIF + credit → payment term) =================
//
// The seller's DD phase (REFINED-MultiAgent-Design-vLEI.md §5.2 phase 2 + §6 S1; 04 §1 Φ2).
// Runs ONLY when the inquiry exercises the "DD" dimension — otherwise a no-op pass-through
// (the deterministic happy path is unchanged).
//
// What it does:
//   1. GLEIF active-status check on BOTH LEIs (reuses verify_lei_gleif → real GLEIF v1).
//   2. DdCreditAgent.decide() → signed payment term (Net-0/30/60) + pd1y/lgd, via the
//      injected CreditProvider (fixture-backed demo, or real GLEIF/EDGAR).
//   3. Assembles DDResult (gleif + gleifVerified + recommendedTerm + rationale), records the
//      GLEIF consultations and the credit attestation, and sets ddResult so quoting can
//      prefer recommendedTerm over the buyer's requested term.
//
// NO fabrication (Rule 2): GLEIF is a live call; credit numbers come from the provider; a
// failed GLEIF lookup maps to a conservative non-ACTIVE status (noted in the rationale as a
// lookup outcome, not a fabricated lapse).
//
// GLEIF STATUS MAPPING (the lossy map the gleif-types.ts note defers to the credit layer):
//   GLEIF raw (ISSUED + entity ACTIVE) → "ACTIVE"; LAPSED/RETIRED/MERGED/DUPLICATE map
//   across; PENDING_* → "PENDING"; anything else (incl. lookup failure) → "LAPSED"
//   (conservative not-good-to-trade).

import type { NegStateType, AgentAttestation } from "../state/neg-state.js";
import type { OrchestratorFlags } from "../../config/flags.js";
import type { AgentContext } from "../../agents/agent-contract.js";
import type { DdCreditAgent } from "../../agents/subagents/dd-credit/index.js";
import type { DDResult } from "../../shared/due-diligence-types.js";
import type { GleifStatus as ProviderGleifStatus, ConsultationRecord } from "../../shared/provider-types.js";
import { verifyLeiGleif, type GleifVerification } from "../../mcp-servers/mcp-vlei/verify_lei_gleif.js";

export const DUE_DILIGENCE_NODE = {
  run: "dueDiligence.run",
} as const;

export interface DueDiligenceDeps {
  flags: OrchestratorFlags;
  creditAgent: DdCreditAgent;
  /** Identity context to sign the credit decision under the Credit-Officer ECR. */
  creditContext: AgentContext;
}

export interface DueDiligenceNodes {
  dueDiligence: (state: NegStateType) => Promise<Partial<NegStateType>>;
}

/** Lossy map: GLEIF verification → the narrower provider GleifStatus vocabulary. */
function gleifToProviderStatus(rec: ConsultationRecord<GleifVerification>): ProviderGleifStatus {
  if (!rec.success || !rec.result) return "LAPSED"; // lookup failed → conservative not-active
  const v = rec.result;
  if (v.isActive) return "ACTIVE";
  switch (v.registrationStatus) {
    case "LAPSED": return "LAPSED";
    case "RETIRED": return "RETIRED";
    case "MERGED": return "MERGED";
    case "DUPLICATE": return "DUPLICATE";
    case "PENDING_TRANSFER":
    case "PENDING_ARCHIVAL": return "PENDING";
    default: return "LAPSED"; // ISSUED-but-entity-inactive, ANNULLED, etc.
  }
}

export function buildDueDiligenceNode(deps: DueDiligenceDeps): DueDiligenceNodes {
  async function dueDiligence(state: NegStateType): Promise<Partial<NegStateType>> {
    const inquiry = state.inquiry;
    if (inquiry === undefined || inquiry === null) {
      throw new Error("[dueDiligence] no inquiry in state — run intake first");
    }

    // Gate: only run DD when the inquiry requests it.
    if (!inquiry.dimensions.includes("DD")) {
      return {}; // pass-through — no DD requested
    }

    // 1. GLEIF on both LEIs (live).
    const buyerGleif = await verifyLeiGleif({ lei: state.buyerLEI, forceFresh: false }, deps.flags);
    const sellerGleif = await verifyLeiGleif({ lei: state.sellerLEI, forceFresh: false }, deps.flags);
    const buyerStatus = gleifToProviderStatus(buyerGleif);
    const sellerStatus = gleifToProviderStatus(sellerGleif);
    const gleifVerified = buyerStatus === "ACTIVE" && sellerStatus === "ACTIVE";

    // 2. Credit decision (signed). Order value (pre-quote, best-effort from line targets).
    const orderValue = inquiry.lines.reduce((s, l) => s + l.qty * (l.targetRate ?? 0), 0);
    const buyerName = buyerGleif.success ? buyerGleif.result?.legalEntityName : undefined;
    const creditDecision = await deps.creditAgent.decide(
      { buyerLei: state.buyerLEI, legalEntityName: buyerName, orderValue },
      deps.creditContext,
    );

    // 3. Assemble DDResult. creditSummary is omitted this iteration (its recommendedTerms
    //    field wants the credit NET_x vocabulary; the agent already mapped to PaymentTerm,
    //    which is the field quoting needs — recommendedTerm). Credit detail lives in the rationale.
    const gleifNote = [
      `GLEIF buyer=${buyerStatus}${buyerGleif.success ? "" : ` (lookup failed: ${buyerGleif.error ?? "?"})`}`,
      `seller=${sellerStatus}${sellerGleif.success ? "" : ` (lookup failed: ${sellerGleif.error ?? "?"})`}`,
    ].join(", ");
    const dd: DDResult = {
      gleif: { buyer: buyerStatus, seller: sellerStatus },
      gleifVerified,
      recommendedTerm: creditDecision.decision.recommendedTerms,
      rationale: `${gleifNote}. Credit: ${creditDecision.rationale}`,
      performedAt: new Date().toISOString(),
    };

    const creditAttestation: AgentAttestation = {
      agentRef: deps.creditAgent.agentRef,
      role: deps.creditAgent.ecrRole,
      aid: creditDecision.attestation.aid,
      subject: "credit-decision",
      signature: creditDecision.attestation.signature,
      signingMode: creditDecision.attestation.signingMode,
      signedAt: creditDecision.attestation.signedAt,
    };

    return {
      ddResult: dd,
      gleif: { buyer: buyerStatus, seller: sellerStatus },
      consultations: [buyerGleif, sellerGleif],
      attestations: [creditAttestation],
      status: "DD_DONE",
    };
  }

  return { dueDiligence };
}
