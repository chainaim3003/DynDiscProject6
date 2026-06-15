// ================= treasury sub-agent (REAL decide) =================
//
// S2 — Treasury (REFINED-MultiAgent-Design-vLEI.md §6). ECR: Treasurer.
// OWNS the VETO: the price floor / minViablePrice / term approval — a binding
// financial control. The negotiator must never emit a price below floor.
//
// MODE (honest, no fabrication — Rule 2/4):
//   - real (TREASURY_MODE=real): the floor comes from the ACTUS PAM risk engine.
//     The ACTUS endpoint is an OPEN ITEM in the design (unspecified) and no client
//     exists yet, so real mode THROWS rather than invent a risk number.
//   - demo (TREASURY_MODE=demo): the floor is an EXPLICIT configured input
//     (demoFloor), supplied by the caller. The agent compares the candidate price
//     to that floor and signs the approve/veto decision. No NPV/risk is fabricated.
//
// The decision is signed under the treasuryAgent identity (§7 attribution).

import type { AgentContext, AgentDecision, SubAgent } from "../../agent-contract.js";
import type { ProviderMode } from "../../../config/flags.js";

export interface TreasuryInput {
  /** The candidate price-per-unit the negotiator wants to offer. */
  candidatePrice: number;
  quantity?: number;
  paymentTermDays?: number;
  round?: number;
  /**
   * REQUIRED in demo mode: the configured floor (price/unit) below which no offer
   * may go. In real mode the floor is computed by ACTUS (not wired). Never invented.
   */
  demoFloor?: number;
}

export interface TreasuryDecision {
  /** true = price approved; false = VETO (binding on the negotiator). */
  approved: boolean;
  /** Hard floor price/unit. */
  floor: number;
  /** Minimum viable price (== floor in demo mode). */
  minViablePrice: number;
  /** Which mode produced this decision (provenance). */
  mode: ProviderMode;
}

export interface TreasuryDeps {
  /** TREASURY_MODE — "real" (ACTUS) or "demo" (configured floor). Default "demo". */
  mode?: ProviderMode;
}

export class TreasuryAgent implements SubAgent<TreasuryInput, TreasuryDecision> {
  readonly agentRef = "treasuryAgent";
  readonly ecrRole = "Treasurer";

  constructor(private readonly deps: TreasuryDeps = {}) {}

  async decide(
    input: TreasuryInput,
    ctx: AgentContext,
  ): Promise<AgentDecision<TreasuryDecision>> {
    const mode: ProviderMode = this.deps.mode ?? "demo";

    if (mode === "real") {
      throw new Error(
        "[treasury] TREASURY_MODE=real requires the ACTUS PAM risk client, which is not " +
        "wired — the ACTUS endpoint is an OPEN ITEM in the design (unspecified). Use " +
        "TREASURY_MODE=demo with a configured demoFloor, or implement tools/actus/actus-client.ts " +
        "against the real ACTUS contract first (no invented risk numbers).",
      );
    }

    if (input.demoFloor === undefined || input.demoFloor === null) {
      throw new Error(
        "[treasury] demo mode requires an explicit demoFloor (the configured floor " +
        "price/unit). The floor is never fabricated.",
      );
    }

    const floor = input.demoFloor;
    const approved = input.candidatePrice >= floor;
    const decision: TreasuryDecision = {
      approved,
      floor,
      minViablePrice: floor,
      mode,
    };

    const attestation = await ctx.credentials.sign(ctx.agentRef, decision);
    const rationale = approved
      ? `approved: candidate ${input.candidatePrice} >= floor ${floor} (demo configured floor)`
      : `VETO: candidate ${input.candidatePrice} < floor ${floor} (demo configured floor) — binding`;

    return {
      agentRef: ctx.agentRef,
      decision,
      rationale,
      attestation,
      decidedAt: new Date().toISOString(),
    };
  }
}
