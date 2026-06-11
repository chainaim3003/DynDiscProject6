// ================= tommyBuyerAgent — principal (REAL evaluateQuote) =================
//
// Principal BUYER agent (REFINED-MultiAgent-Design-vLEI.md §5.1). OWNS: accept |
// counter | reject, and the target/reservation price. Transport-only — no privileged
// tools; reads only the buyer-safe projection (here: the seller's current unit price).
//
// POLICY (honest label — Rule 8): the accept/counter/reject RULE is real and bounded;
// the concession heuristic ("hold firm at reservation") is a DETERMINISTIC PLACEHOLDER
// for the LLM/persona policy (TKI styles, MAX_BUYER_COUNTER_ROUNDS) — marked so in the
// rationale. No fabricated offers: the reservation price is supplied by the caller
// (from the inquiry's target), never invented.
//
// The decision is signed under the buyer's AID (§7 attribution).

import type { AgentContext, AgentDecision, PrincipalAgent } from "../../agent-contract.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Buyer negotiation strategy (configurable; sensible defaults). */
export interface BuyerStrategy {
  /** Opening counter as a fraction of the reservation price (0 < f <= 1). Default 0.85. */
  openingFraction?: number;
}

export type BuyerMove = "ACCEPT" | "COUNTER" | "REJECT";

export interface BuyerEvaluation {
  move: BuyerMove;
  /** Present on ACCEPT — the price the buyer accepts. */
  acceptedPrice?: number;
  /** Present on COUNTER — the buyer's counter price/unit. */
  counterPrice?: number;
}

export interface EvaluateQuoteInput {
  /** The seller's current ask (price/unit). */
  sellerUnitPrice: number;
  /** The buyer's reservation — the max it will pay (price/unit). From the inquiry target. */
  buyerMaxUnitPrice: number;
  /** 1-indexed round. */
  round: number;
  /** Bound on rounds (inquiry.maxNegotiationRounds ?? flags.NEGOTIATION_MAX_ROUNDS). */
  maxRounds: number;
}

export class TommyBuyerAgent implements PrincipalAgent {
  readonly agentRef = "tommyBuyerAgent";
  readonly oorRole = "Chief Procurement Officer";

  constructor(
    private readonly ctx: AgentContext,
    private readonly strategy: BuyerStrategy = {},
  ) {}

  present() {
    return this.ctx.credentials.present(this.agentRef);
  }

  /** Sign an outbound envelope under the buyer's AID. */
  sign(payload: unknown) {
    return this.ctx.credentials.sign(this.agentRef, payload);
  }

  /**
   * Evaluate the seller's current unit price and choose accept / counter / reject.
   * Bounded by maxRounds. Signed under the buyer AID.
   */
  async evaluateQuote(input: EvaluateQuoteInput): Promise<AgentDecision<BuyerEvaluation>> {
    const { sellerUnitPrice, buyerMaxUnitPrice, round, maxRounds } = input;

    let evaluation: BuyerEvaluation;
    let rationale: string;

    if (sellerUnitPrice <= buyerMaxUnitPrice) {
      evaluation = { move: "ACCEPT", acceptedPrice: sellerUnitPrice };
      rationale = `accept: seller ${sellerUnitPrice} <= reservation ${buyerMaxUnitPrice}`;
    } else if (round >= maxRounds) {
      evaluation = { move: "REJECT" };
      rationale =
        `reject: seller ${sellerUnitPrice} > reservation ${buyerMaxUnitPrice} at final round ${round}/${maxRounds}`;
    } else {
      // Buyer concedes UPWARD across rounds: open below the reservation and rise toward it.
      // (Deterministic persona placeholder for the LLM/TKI policy — but now it MOVES.)
      const openFrac = this.strategy.openingFraction ?? 0.85;
      const open = round2(buyerMaxUnitPrice * openFrac);
      const progress = maxRounds > 1 ? (round - 1) / (maxRounds - 1) : 1;
      const counterPrice = round2(open + (buyerMaxUnitPrice - open) * progress);
      evaluation = { move: "COUNTER", counterPrice };
      rationale =
        `counter ${counterPrice}: opening ${open} conceding toward reservation ` +
        `${buyerMaxUnitPrice} (round ${round}/${maxRounds}); seller ${sellerUnitPrice} still too high`;
    }

    const attestation = await this.ctx.credentials.sign(this.agentRef, evaluation);
    return {
      agentRef: this.agentRef,
      decision: evaluation,
      rationale,
      attestation,
      decidedAt: new Date().toISOString(),
    };
  }
}
