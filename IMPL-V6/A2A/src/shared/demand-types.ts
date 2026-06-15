// ================= IMPL-V6 — DEMAND-PLANNING VIEW TYPES =================
//
// NET-NEW (no literal TS exists). Derived from:
//   04-Orchestration-Design.md §2 #11 (Demand-Planning — "given other
//      commitments, can we promise this?"), §3.2 (demand-planning.consult node,
//      gated by demand_aware?), §5 (reads T3 demand/portfolio + ERPNext Sales Order)
//   Flag: QUOTE_DEMAND_AWARE (.env) toggles whether Quoting consults this (P09/P10).
// Produced by the Demand-Planning node; written to NegState.demandView (04 §3.1).

export interface DemandView {
  // Open commitments that constrain what we can still promise. Keyed by itemCode.
  committedQtyByItem: Record<string, number>;  // already committed to other Sales Orders
  openQuoteQtyByItem: Record<string, number>;  // tied up in other open quotes
  // Per requested item: can we still promise the inquiry's qty given the above?
  canPromiseByItem:   Record<string, boolean>;
  portfolioAsOf:      string;                   // snapshot timestamp (ISO)
  rationale?:         string;
}
