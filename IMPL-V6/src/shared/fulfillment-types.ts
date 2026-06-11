// ================= IMPL-V6 — FULFILLMENT PLAN TYPES =================
//
// NET-NEW (no literal TS exists). Derived from:
//   04-Orchestration-Design.md §2 #12 (Fulfillment — "ATP-only vs CTP-needed
//      vs split?"), #7 (Inventory), and §1 Φ3 (quoting phase)
//   04 §3.2 (fulfillment.plan join node) and the verified Bin fixture story in
//   01 (requested qty may exceed availableQty → credible later ship date)
// Produced by the Fulfillment node; written to NegState.fulfillmentPlan (04 §3.1).

// ATP  = available-to-promise (fulfillable now from free stock)
// CTP  = capable-to-promise  (needs production lead time)
// SPLIT= partial now + remainder later (P06 split shipment)
export type FulfillmentMode = "ATP" | "CTP" | "SPLIT";

export interface FulfillmentSplit {
  qty:      number;
  shipDate: string;   // ISO
}

export interface FulfillmentLinePlan {
  itemCode:      string;
  requestedQty:  number;
  requestedDate?: string;            // per-line required date (from InquiryLine)
  mode:          FulfillmentMode;
  availableQty?: number;             // ATP: free stock (ERPNext Bin: available − reserved − safety)
  leadTimeDays?: number;             // CTP: production lead time when short
  earliestShipDate?: string;         // CTP/SPLIT: earliest realistic ship date
  splits?:       FulfillmentSplit[]; // SPLIT only
  canFulfill:    boolean;            // can this line hit requestedDate?
  warehouse?:    string;             // default MADRAS-WH-1
  rationale?:    string;
}

export interface FulfillmentPlan {
  lines:            FulfillmentLinePlan[];
  overallCanFulfill: boolean;        // every line meets its requested date
  worstCaseShipDate?: string;        // latest earliestShipDate across lines
  generatedAt:      string;          // ISO
}
