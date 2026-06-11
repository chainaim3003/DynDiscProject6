// ================= IMPL-V6 — INQUIRY DOMAIN TYPES =================
//
// Domain model for the buyer's inbound inquiry (the seller records it in
// ERPNext as an `Opportunity` (+ Opportunity Item) at intake, Φ1). DERIVED —
// not copied (no literal TS exists) and not fabricated — from:
//   DESIGN/baseline/01-Prompts-Schema-Structure.md §1  (10-prompt dimension ladder)
//   DESIGN/baseline/01-Prompts-Schema-Structure.md §2.1 (Opportunity(+Item) native
//                                                        fields + erpnextEnh1 custom fields)
// Each field cites its 01 source. ERPNext DocType <-> domain mapping lives in
// src/erpnext/mappers.ts (NOT here).

import type { PaymentTerm } from "./quote-types.js";

// ─── Dimension ladder (01 §1 legend) ────────────────────────────────────────
//   U  unit price · Q  quantity · Z  sizes · D  delivery date ·
//   L  destination/logistics · M  multi-SKU · P  payment term ·
//   DD due-diligence/identity · N  negotiation · ERP persist to ERPNext.
// `dimensions` records which rungs a given inquiry exercises (P01 = [U];
// P10 = all). Drives which graph phases/nodes activate (04 §1 prompt→phase map).
export type InquiryDimension =
  | "U" | "Q" | "Z" | "D" | "L" | "M" | "P" | "DD" | "N" | "ERP";

// ─── Inquiry line (ERPNext `Opportunity Item`, §2.1) ────────────────────────
export interface InquiryLine {
  itemCode:    string;           // item_code (variant code for sizes, P03; e.g. TH-TEE-RN-180-M)
  itemName?:   string;           // item_name
  qty:         number;           // qty (P02)
  uom:         string;           // uom — "Nos" for garments (§1 invariant)
  description?: string;          // description
  brand?:      string;           // brand (native Opportunity Item)
  itemGroup?:  string;           // item_group (native Opportunity Item)
  // §2.1 custom_size — only a convenience when a size is referenced against a
  // NON-variant item; sizes are normally modelled as distinct variant itemCodes.
  size?:       string;
  // §2.1 Opportunity Item.custom_required_delivery_date — per-line date (basket
  // lines can differ, P06).
  requiredDeliveryDate?: string;
  targetRate?: number;           // §2.1 custom_target_rate — per-line target (P09)
}

// ─── The inquiry (ERPNext `Opportunity` header + children) ──────────────────
export interface Inquiry {
  // ── linkage (§2.1) ─────────────────────────────────────────────────────
  negotiationId: string;         // custom_inquiry_id = saga thread id (joins T2/T5)

  // ── buyer identity (§1 invariants; OOR used DD+) ──────────────────────────
  buyerLei:    string;           // custom_buyer_lei  — "54930012QJWZMYHNJW95"
  buyerAgent:  string;           // custom_buyer_agent — "tommyBuyerAgent"
  buyerOor?:   string;           // custom_buyer_oor   — "Tommy_Chief_Procurement_Officer" (P08+)

  currency:    string;           // §1 invariant — INR

  // ── content ────────────────────────────────────────────────────────────
  lines: InquiryLine[];          // → Opportunity Item rows (1+; multi-line P06)

  // ── header-level dimensions (present per the rung this inquiry exercises) ──
  requiredDeliveryDate?: string;     // custom_required_delivery_date — header date (P04)
  destination?:          string;     // custom_delivery_destination — e.g. "Rotterdam, NL" (P05)
  incotermRequested?:    string;     // custom_incoterm_requested (Link→Incoterm) (P05)
  paymentTermRequested?: PaymentTerm; // custom_payment_term_requested (P07)
  targetUnitPrice?:      number;     // custom_target_unit_price — buyer target ₹ (P09)
  maxNegotiationRounds?: number;     // custom_max_negotiation_rounds — default 3 (P09)

  // ── audit / provenance ────────────────────────────────────────────────────
  dimensions:         InquiryDimension[]; // which rungs this inquiry activates
  rawText?:           string;            // verbatim buyer message (parse provenance)
  dimensionsSnapshot?: string;           // custom_inquiry_dimensions_json — audit-safe JSON snapshot
  receivedAt:         string;            // ISO timestamp of intake
}
