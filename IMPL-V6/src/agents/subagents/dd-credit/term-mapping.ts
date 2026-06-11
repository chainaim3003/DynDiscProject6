// ================= dd-credit — term vocabulary mapper =================
//
// The design flags this mapper explicitly (quote-types.ts PaymentTerm note +
// due-diligence-types.ts DDResult.recommendedTerm): the credit sub-agent speaks the
// RecommendedTerms vocabulary (PRE_PAID/COD/NET_15..NET_90), but the V6 quote allows
// only PaymentTerm = Net-0 / Net-30 / Net-60. This collapses the former into the latter.
//
// COLLAPSE RULE (documented decision — the allowed set is only three):
//   PRE_PAID, COD        → Net-0   (pay now / on delivery)
//   NET_15, NET_30       → Net-30
//   NET_45, NET_60, NET_90 → Net-60  (NET_45/90 are CAPPED to Net-60 — the allowed ceiling)
//
// This is a deterministic, total mapping (exhaustive switch). No fabrication — it only
// translates a term the provider already returned.

import type { PaymentTerm } from "../../../shared/quote-types.js";
import type { RecommendedTerms } from "../../../shared/provider-types.js";

export function mapRecommendedToPaymentTerm(rt: RecommendedTerms): PaymentTerm {
  switch (rt) {
    case "PRE_PAID":
    case "COD":
      return "Net-0";
    case "NET_15":
    case "NET_30":
      return "Net-30";
    case "NET_45":
    case "NET_60":
    case "NET_90":
      return "Net-60"; // NET_45/NET_90 capped to the allowed ceiling
    default: {
      const _exhaustive: never = rt;
      throw new Error(`[dd-credit] unmapped RecommendedTerms: ${String(_exhaustive)}`);
    }
  }
}
