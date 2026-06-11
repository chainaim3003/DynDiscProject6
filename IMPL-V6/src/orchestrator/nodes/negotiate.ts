// ================= IMPL-V6 — Φ4 NEGOTIATE NODE (bounded loop + BINDING treasury veto) =================
//
// The seller's negotiation phase (REFINED-MultiAgent-Design-vLEI.md §5.2 phase 4;
// 04 §4.3 bounded loop, §4.7 evaluator-optimizer). Runs a bounded round loop over a
// single representative unit price (RoundOutcome is single-price by design):
//
//   each round r (1..maxRounds):
//     1. seller proposes a desired price (deterministic concession — PLACEHOLDER for LLM)
//     2. BINDING TREASURY VETO: treasury.decide(candidate, floor). The node NEVER emits
//        a price below the floor — on veto it clamps to the treasury floor.
//     3. sign the emitted seller offer under the seller AID (envelopeHash)
//     4. buyer.evaluateQuote(emitted) → ACCEPT | COUNTER | REJECT (bounded)
//     5. journal a RoundOutcome (+ treasury & buyer attestations)
//
// Outcomes: ACCEPTED (apply price to the quote → persist), REJECTED → NO_DEAL,
// exhausted → ESCALATED. NO_DEAL/ESCALATED do not persist (graph conditional edge).
//
// PASS-THROUGH: if the inquiry doesn't request negotiation (no "N" dimension AND no
// buyer target price), this node is a no-op — the deterministic happy path (P01-P02)
// flows straight to persist unchanged.
//
// HONEST BOUNDARIES (Rule 2/8):
//   - The concession curve + buyer hold policy are DETERMINISTIC PLACEHOLDERS for the
//     LLM optimizer (marked usedFallback:true). The loop bound + veto are real.
//   - demoFloor is a CONFIGURED input (treasury). Real mode derives it from ACTUS (not
//     wired) — see TreasuryAgent. Negotiation throws if neither a floor nor a buyer
//     target is available, rather than fabricate one.
//   - RoundOutcome.treasury (the full ACTUS summary) is OMITTED in demo mode (its
//     NPV/risk fields require ACTUS); the veto is recorded in decision.treasuryOverride.

import type { NegStateType, AgentAttestation } from "../state/neg-state.js";
import type { Quote } from "../../shared/quote-types.js";
import type { OrchestratorFlags } from "../../config/flags.js";
import type { AgentContext } from "../../agents/agent-contract.js";
import type { TreasuryAgent } from "../../agents/subagents/treasury/index.js";
import type { BuyerTransport } from "../../agents/transport/buyer-transport.js";
import type { RoundOutcome, RoundResult } from "../../shared/round-types.js";
import type { DecisionTrailEntry } from "../../shared/negotiation-types.js";
import { createOptimizer, type NegotiationOptimizer } from "./negotiate-optimizer.js";

export const NEGOTIATE_NODE = {
  run: "negotiate.run",
} as const;

export interface NegotiateDeps {
  flags: OrchestratorFlags;
  treasury: TreasuryAgent;
  /** Identity context to run/sign the treasury decision under the Treasurer ECR. */
  treasuryContext: AgentContext;
  buyer: BuyerTransport;
  /** Identity context to sign the emitted seller offers under the seller OOR. */
  sellerContext: AgentContext;
  /** Configured treasury floor (price/unit). Demo mode. Real mode → ACTUS (not wired). */
  demoFloor?: number;
  /** Buyer reservation (max price/unit) override; else inquiry target. */
  buyerMaxUnitPrice?: number;
  /** Seller concession behaviour (configurable; sensible defaults). */
  concession?: {
    /** On the final round, meet the buyer's last counter (clamped to floor) to close. Default true. */
    closeOnFinalRound?: boolean;
  };
  /** Counter-price proposer. Defaults to createOptimizer(flags) when omitted. */
  optimizer?: NegotiationOptimizer;
}

export interface NegotiateNodes {
  negotiate: (state: NegStateType) => Promise<Partial<NegStateType>>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Apply a negotiated unit price to the primary line and recompute totals/schedule. */
function applyNegotiatedPrice(quote: Quote, unitPrice: number, gstRate: number): Quote {
  const lines = quote.lines.map((l, i) =>
    i === 0 ? { ...l, rate: unitPrice, amount: round2(l.qty * unitPrice) } : l,
  );
  const netTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const totalTaxesAndCharges = round2((netTotal * gstRate) / 100);
  const grandTotal = round2(netTotal + totalTaxesAndCharges);
  const totals = {
    ...quote.totals,
    netTotal,
    totalTaxesAndCharges,
    grandTotal,
    roundedTotal: Math.round(grandTotal),
  };
  const schedule = quote.payment.schedule.map((r, i) =>
    i === 0 ? { ...r, paymentAmount: grandTotal } : r,
  );
  return {
    ...quote,
    lines,
    totals,
    payment: { ...quote.payment, schedule },
    revision: quote.revision + 1,
  };
}

export function buildNegotiateNode(deps: NegotiateDeps): NegotiateNodes {
  async function negotiate(state: NegStateType): Promise<Partial<NegStateType>> {
    const inquiry = state.inquiry;
    if (inquiry === undefined || inquiry === null) {
      throw new Error("[negotiate] no inquiry in state — run intake first");
    }
    const quote = state.quoteDraft;
    if (quote === undefined || quote === null) {
      throw new Error("[negotiate] no quoteDraft in state — run quoting first");
    }

    // Buyer reservation (max) — from override or the inquiry's stated target. Honest:
    // never invented. If absent and negotiation not requested → pass through.
    const buyerMax =
      deps.buyerMaxUnitPrice ?? inquiry.targetUnitPrice ?? inquiry.lines[0]?.targetRate;
    const negotiationRequested = inquiry.dimensions.includes("N") || buyerMax !== undefined;
    if (!negotiationRequested) {
      return {}; // pass-through: deterministic happy path, no negotiation
    }
    if (buyerMax === undefined) {
      throw new Error(
        "[negotiate] negotiation requested (dimension N) but no buyer target price " +
        "(inquiry.targetUnitPrice / line.targetRate / deps.buyerMaxUnitPrice). No offer fabricated.",
      );
    }
    if (deps.demoFloor === undefined) {
      throw new Error(
        "[negotiate] no treasury floor configured (deps.demoFloor). Demo mode requires it; " +
        "real mode derives it from ACTUS (not wired). No floor fabricated.",
      );
    }

    const startPrice = quote.lines[0]!.rate;
    const floor = deps.demoFloor;
    const maxRounds = inquiry.maxNegotiationRounds ?? deps.flags.NEGOTIATION_MAX_ROUNDS;

    const rounds: RoundOutcome[] = [];
    const attestations: AgentAttestation[] = [];
    let dealPrice: number | undefined;
    let finalResult: RoundResult = "ESCALATED";

    // State threaded across rounds so the seller REACTS to the buyer (was missing before).
    let buyerCounter: number | undefined; // the buyer's last counter offer
    let prevSellerAsk = startPrice;       // the seller's previous ask (convergence anchor)
    const closeOnFinal = deps.concession?.closeOnFinalRound ?? true;
    const optimizer = deps.optimizer ?? createOptimizer(deps.flags);
    const buyerTrajectory: number[] = [];

    for (let round = 1; round <= maxRounds; round++) {
      // 1. Seller desired price — REACTS to the buyer's last counter, converging.
      //    R1 (no buyer counter yet): open at the list/anchor price.
      //    Mid rounds: split the difference toward the buyer; never below the buyer's own
      //    counter, never below floor, never above the previous ask (monotonic concession).
      //    Final round: meet the buyer (clamped to floor) to CLOSE instead of walking away.
      const proposal = await optimizer.propose({
        round,
        maxRounds,
        anchor: startPrice,
        floor,
        buyerCounter,
        prevSellerAsk,
        buyerTrajectory: [...buyerTrajectory],
        closeOnFinal,
      });
      const sellerDesired = proposal.price;
      const incomingOffer = buyerCounter ?? buyerMax; // the offer the seller is responding to

      // 2. BINDING TREASURY VETO — never emit below floor.
      const treasuryDecision = await deps.treasury.decide(
        { candidatePrice: sellerDesired, demoFloor: floor, round },
        deps.treasuryContext,
      );
      attestations.push({
        agentRef: deps.treasury.agentRef,
        role: deps.treasury.ecrRole,
        aid: treasuryDecision.attestation.aid,
        subject: "treasury-veto",
        signature: treasuryDecision.attestation.signature,
        signingMode: treasuryDecision.attestation.signingMode,
        signedAt: treasuryDecision.attestation.signedAt,
      });
      // On veto, clamp to the treasury floor — the emitted price is NEVER below floor.
      const emittedSeller = treasuryDecision.decision.approved
        ? sellerDesired
        : treasuryDecision.decision.floor;

      // 3. Sign the emitted seller offer under the seller AID (round envelope).
      const envelope = await deps.sellerContext.credentials.sign(deps.sellerContext.agentRef, {
        round,
        unitPrice: emittedSeller,
      });

      // 4. Buyer evaluates.
      const buyerDecision = await deps.buyer.evaluateQuote({
        sellerUnitPrice: emittedSeller,
        buyerMaxUnitPrice: buyerMax,
        round,
        maxRounds,
      });
      attestations.push({
        agentRef: deps.buyer.agentRef,
        role: deps.buyer.oorRole,
        aid: buyerDecision.attestation.aid,
        subject: "buyer-evaluation",
        signature: buyerDecision.attestation.signature,
        signingMode: buyerDecision.attestation.signingMode,
        signedAt: buyerDecision.attestation.signedAt,
      });
      const move = buyerDecision.decision.move;
      const buyerOfferThisRound =
        buyerDecision.decision.counterPrice ?? buyerDecision.decision.acceptedPrice ?? buyerMax;
      if (buyerDecision.decision.counterPrice !== undefined) {
        buyerCounter = buyerDecision.decision.counterPrice;
        buyerTrajectory.push(buyerDecision.decision.counterPrice);
      }
      prevSellerAsk = emittedSeller;

      // 5. Journal the round.
      const timestamp = new Date().toISOString();
      const result: RoundResult =
        move === "ACCEPT" ? "ACCEPTED" : move === "REJECT" ? "REJECTED" : "COUNTERED";
      const decision: DecisionTrailEntry = {
        round,
        timestamp,
        perspective: "SELLER",
        incomingOffer,
        llmProposal: {
          action: "COUNTER",
          price: sellerDesired,
          reasoning: proposal.reasoning,
          usedFallback: proposal.usedFallback,
        },
        treasuryOverride: {
          approved: treasuryDecision.decision.approved,
          minViablePrice: treasuryDecision.decision.minViablePrice,
          failReasons: treasuryDecision.decision.approved
            ? undefined
            : ["candidate below treasury floor (binding veto)"],
        },
        finalDecision: {
          action: move === "ACCEPT" ? "ACCEPT" : "COUNTER",
          price: emittedSeller,
        },
      };
      rounds.push({
        round,
        timestamp,
        buyerOffer: buyerOfferThisRound,
        sellerCounter: emittedSeller,
        decision,
        result,
        envelopeHash: envelope.signature,
      });

      if (move === "ACCEPT") {
        dealPrice = emittedSeller;
        finalResult = "ACCEPTED";
        break;
      }
      if (move === "REJECT") {
        finalResult = "REJECTED";
        break;
      }
      // COUNTER → keep negotiating; if this was the last round, it escalates.
      finalResult = "ESCALATED";
    }

    if (dealPrice !== undefined) {
      const updatedQuote = applyNegotiatedPrice(quote, dealPrice, deps.flags.GST_RATE);
      return {
        quoteDraft: updatedQuote,
        rounds,
        attestations,
        negotiationRounds: rounds.length,
        status: "ACCEPTED",
      };
    }

    // No deal: REJECTED → NO_DEAL; exhausted COUNTERs → ESCALATED. Neither persists.
    return {
      rounds,
      attestations,
      negotiationRounds: rounds.length,
      status: finalResult === "REJECTED" ? "NO_DEAL" : "ESCALATED",
    };
  }

  return { negotiate };
}
