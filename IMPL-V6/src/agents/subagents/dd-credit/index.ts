// ================= dd-credit sub-agent (REAL decide) =================
//
// S1 — Due-Diligence & Credit (REFINED-MultiAgent-Design-vLEI.md §6). ECR: Credit Officer.
// OWNS the single payment term to extend (Net-0/30/60) with pd1y / lgd / rationale.
//
// Data source = an injected CreditProvider (provider-types.ts), exactly like the
// Fulfillment agent's InventoryProvider. Real mode = GLEIF + EDGAR + Companies House;
// demo mode = DEMO-DATA/credit/*.json fixtures. This agent does NOT invent credit
// numbers — pd1y/lgd/score come from the provider's CreditConsultation; the term is
// translated by term-mapping.ts.
//
// FAIL-LOUD (Rule 2/8): if no provider is injected, decide() throws (no fabrication).
// DEFENSIVE: if the provider consult fails, the agent does NOT invent a healthy score —
// it returns the most conservative term (Net-0 / pre-pay) with worst-case sentinels and a
// rationale that states the values are defensive, not measured (design vocab:
// "refused-deferred-terms").
//
// The decision is signed under the ddCreditAgent identity (§7 attribution).

import type { AgentContext, AgentDecision, SubAgent } from "../../agent-contract.js";
import type { CreditProvider } from "../../../shared/provider-types.js";
import type { PaymentTerm } from "../../../shared/quote-types.js";
import { mapRecommendedToPaymentTerm } from "./term-mapping.js";

export interface CreditInput {
  /** Counterparty (buyer) LEI to assess. */
  buyerLei: string;
  /** Optional buyer legal-entity name for cross-check / logging. */
  legalEntityName?: string;
  /** Order value (ERPNEXT_CURRENCY) used to scale exposure. */
  orderValue: number;
}

export interface CreditDecision {
  /** The single payment term DD will extend (mapped to the V6 allowed set). */
  recommendedTerms: PaymentTerm;
  /** 1-yr probability of default [0,1] — from the provider (or 1 = worst-case on failure). */
  pd1y: number;
  /** Loss given default [0,1] — from the provider (or 1 = worst-case on failure). */
  lgd: number;
  /** GLEIF registration status of the buyer LEI, when the consult succeeded. */
  gleifStatus?: string;
  /** Composite financial-health score 0-100, when the consult succeeded. */
  financialHealthScore?: number;
  /** True when the term came from a failed consult's conservative fallback. */
  defensive: boolean;
}

export interface DdCreditDeps {
  /** GLEIF/EDGAR/Companies-House provider (real) or fixture-backed demo provider. */
  provider?: CreditProvider;
}

export class DdCreditAgent implements SubAgent<CreditInput, CreditDecision> {
  readonly agentRef = "ddCreditAgent";
  readonly ecrRole = "Credit Officer";

  constructor(private readonly deps: DdCreditDeps = {}) {}

  async decide(
    input: CreditInput,
    ctx: AgentContext,
  ): Promise<AgentDecision<CreditDecision>> {
    if (!this.deps.provider) {
      throw new Error(
        "[dd-credit] no CreditProvider configured. Inject a real GLEIF/EDGAR/Companies-House " +
        "provider, or a fixture-backed demo provider. No credit numbers are fabricated.",
      );
    }

    const rec = await this.deps.provider.consult({
      lei: input.buyerLei,
      legalEntityName: input.legalEntityName,
      dealSizeUsd: input.orderValue,
    });

    let decision: CreditDecision;
    let rationale: string;

    if (!rec.success || !rec.result) {
      // Defensive branch — demand pre-pay; do NOT invent a score (sentinels = worst case).
      decision = { recommendedTerms: "Net-0", pd1y: 1, lgd: 1, defensive: true };
      rationale =
        `credit consult failed (${rec.error ?? "unknown error"}) → defensive Net-0 (pre-pay). ` +
        `pd1y/lgd shown as worst-case sentinels, NOT measured values.`;
    } else {
      const r = rec.result;
      const mapped = mapRecommendedToPaymentTerm(r.recommendedTerms);
      decision = {
        recommendedTerms: mapped,
        pd1y: r.pd1y,
        lgd: r.lgd,
        gleifStatus: r.gleifStatus,
        financialHealthScore: r.financialHealthScore,
        defensive: false,
      };
      rationale =
        `${r.legalEntityName} — GLEIF ${r.gleifStatus}, health ${r.financialHealthScore}, ` +
        `pd1y ${r.pd1y}, lgd ${r.lgd} → ${r.recommendedTerms} mapped to ${mapped}. ${r.rationale}`;
    }

    const attestation = await ctx.credentials.sign(ctx.agentRef, decision);
    return {
      agentRef: ctx.agentRef,
      decision,
      rationale,
      attestation,
      decidedAt: new Date().toISOString(),
    };
  }
}
