// ================= IMPL-V6 — DUE-DILIGENCE RESULT TYPES =================
//
// NET-NEW (no literal TS exists). Derived from:
//   04-Orchestration-Design.md §2 #4 (DD agent — "what payment term will we
//      offer?"), #5 (Info-Collection), #6 (Credit), and §9.3 (Info-Collection scope)
//   04 §1 Φ2 output: gleifVerified, recommendedTerms, creditSummary
// Produced by the DD node; written to NegState.ddResult (04 §3.1) and to T3
// buyers/{lei}/profile (04 §5).

import type { PaymentTerm } from "./quote-types.js";
import type { GleifStatus, RecommendedTerms } from "./provider-types.js";

// Credit sub-agent's verdict, projected for the DD result (04 §2 #6).
export interface CreditSummary {
  lei:                 string;
  legalEntityName:     string;
  gleifStatus:         GleifStatus;       // GLEIF registration (live or last-known if demo)
  financialHealthScore: number;           // composite 0-100
  pd1y:                number;            // 1-yr probability of default [0,1]
  lgd:                 number;            // loss given default [0,1]
  recommendedTerms:    RecommendedTerms;  // credit vocabulary (NET_x/PRE_PAID/COD)
  rationale:           string;
}

// Info-Collection result — COMPLIANT scope only (04 §9.3): buyer's own website
// (no-login, robots respected), buyer-disclosed handles (existence verified, NOT
// content-scraped), GLEIF + EDGAR + Companies House. NO social scraping.
export interface InfoCollectionResult {
  websiteVerified:         boolean;       // buyer's own site reachable + matches claimed entity
  disclosedHandlesChecked: string[];      // handles whose EXISTENCE was checked (no content fetch)
  edgarMatched?:           boolean;
  companiesHouseMatched?:  boolean;
  notes?:                  string;
}

// What the DD node writes to NegState.ddResult.
export interface DDResult {
  // Identity (P08): GLEIF on both LEIs.
  gleif:         { buyer: GleifStatus; seller: GleifStatus };
  gleifVerified: boolean;                 // both ACTIVE

  // Credit-driven term selection.
  creditSummary?:  CreditSummary;
  // The term DD will actually offer — mapped from creditSummary.recommendedTerms
  // (NET_x) into the V6 PaymentTerm vocabulary (Net-0/30/60). Mapper TBD (see
  // quote-types.ts PaymentTerm note).
  recommendedTerm: PaymentTerm;

  infoCollection?: InfoCollectionResult;
  rationale:       string;                // operator-facing, one paragraph
  performedAt:     string;                // ISO
}
