// ================= IMPL-V6 — QUOTE DOMAIN TYPES =================
//
// Domain model for the seller's quote (recorded in ERPNext as a `Quotation`
// (+ Quotation Item) once persisted, P10). DERIVED — not copied (no literal TS
// exists) and not fabricated — from:
//   DESIGN/baseline/01-Prompts-Schema-Structure.md §1  (10-prompt dimension ladder)
//   DESIGN/baseline/01-Prompts-Schema-Structure.md §2.2 (Quotation(+Item) native
//                                                        fields + erpnextEnh1 custom fields)
// Each field cites its 01 source. The ERPNext DocType <-> domain mapping lives
// in src/erpnext/mappers.ts (NOT here): these are clean domain shapes, not the
// raw ERPNext JSON.
//
// zod schemas for MCP tool I/O validation are a SEPARATE artifact under
// src/mcp/tools/* (package has zod + zod-to-json-schema); these are plain TS
// domain interfaces.

// ─── Payment term vocabulary ────────────────────────────────────────────────
//
// §1 invariant: a single one-time payment; only WHEN it's due varies
// (Net-0 / Net-30 / Net-60). Matches .env PAYMENT_TERMS_ALLOWED and ERPNext
// `Payment Terms Template` names.
//
// DESIGN NOTE / open mapping (flag): the credit sub-agent's `RecommendedTerms`
// (provider-types.ts) uses a different vocabulary — "PRE_PAID" | "COD" |
// "NET_15".."NET_90". A mapper RecommendedTerms → PaymentTerm is needed where DD
// drives the term (P08). For V6 the allowed set is constrained to these three.
export type PaymentTerm = "Net-0" | "Net-30" | "Net-60";

// ─── Payment schedule (ERPNext `Payment Schedule` child, §2.2) ──────────────
//
// §1 invariant: EXACTLY ONE row, invoice_portion = 100 (no advance+balance, no
// milestones — DvP deferred). Typed as an array to mirror ERPNext's
// `payment_schedule` child table; mappers.ts MUST assert length === 1.
export interface PaymentScheduleRow {
  paymentTerm:    PaymentTerm;   // payment_term
  invoicePortion: number;        // invoice_portion — ALWAYS 100 in V6
  creditDays:     number;        // credit_days — 0 | 30 | 60
  dueDate?:       string;        // due_date (ISO; derived from dispatch + creditDays)
  paymentAmount?: number;        // payment_amount (= grand_total when invoice_portion=100)
  modeOfPayment?: string;        // mode_of_payment
}

// ─── Quote line (ERPNext `Quotation Item`, §2.2) ────────────────────────────
export interface QuoteLine {
  itemCode:          string;     // item_code (variant code for sizes, P03)
  qty:               number;     // qty
  uom:               string;     // uom — "Nos" for garments (§1 invariant)
  rate:              number;     // rate (per-unit, INR)
  amount:            number;     // amount (= qty * rate)
  warehouse?:        string;     // warehouse (default MADRAS-WH-1)
  prevdocDoctype?:   string;     // prevdoc_doctype — "Opportunity" (inquiry→quote join)
  prevdocDocname?:   string;     // prevdoc_docname — the Opportunity name
  customerItemCode?: string;     // customer_item_code
  itemTaxTemplate?:  string;     // item_tax_template (GST template)
  // ── ATP feasibility (P04) — from Inventory/Fulfillment; NOT native to Quotation Item ──
  canFulfill?:       boolean;    // can this line hit the requested date?
  earliestShipDate?: string;     // earliest realistic ship date if not
}

// ─── Freight / Incoterm (P05, §2.2 + §2.3) ──────────────────────────────────
export interface QuoteFreight {
  incoterm:     string;          // Quotation.incoterm (e.g. "FOB", "CIF")
  namedPlace?:  string;          // Quotation.named_place (e.g. "Chennai", "Rotterdam")
  amount:       number;          // freight as a Sales Taxes and Charges / Shipping Rule line
  currency:     string;          // freight quote currency (logistics quotes in USD; see USD_INR in math aggregator)
  transitDays?: number;          // from Logistics consult
  carrierScac?: string;          // best-carrier SCAC
}

// ─── Issuer identity block (P10, §2.2 custom identity fields) ───────────────
//
// The "who quoted" the user explicitly asks for: the agent + the officer it
// acts for (OOR). Sourced from the Jupiter agent card.
export interface IssuerIdentity {
  agent:          string;              // custom_quoted_by_agent — "jupiterSellerAgent"
  oor:            string;              // custom_quoted_by_oor — "Jupiter_Chief_Sales_Officer"
  sellerLei:      string;              // custom_seller_lei — "3358004DXAMRWRUIYJ05"
  sellerAgentAid?: string;             // custom_seller_agent_aid — KERI AID (card)
  credentialMode: "plain" | "vlei";    // custom_credential_mode — "plain" for these 10
}

// ─── Totals (§2.2 native) ────────────────────────────────────────────────────
export interface QuoteTotals {
  totalQty:             number;  // total_qty
  netTotal:             number;  // net_total (Σ line amounts, pre-tax, pre-freight)
  gstRate:              number;  // §1 invariant — 18 (percent)
  totalTaxesAndCharges: number;  // total_taxes_and_charges (GST + freight)
  grandTotal:           number;  // grand_total
  roundedTotal?:        number;  // rounded_total
  inWords?:             string;  // in_words
}

// ERPNext Quotation.status lifecycle (§2.2).
export type QuoteStatus = "Draft" | "Open" | "Replied" | "Ordered" | "Lost" | "Expired";

// ─── The quote (ERPNext `Quotation` header + children) ──────────────────────
export interface Quote {
  // ── linkage ────────────────────────────────────────────────────────────
  negotiationId:    string;          // custom_negotiation_id (joins T2/T5/Opportunity)
  opportunityName:  string | null;   // Quotation.opportunity — null until inquiry mirrored to Opportunity
  quotationName:    string | null;   // naming_series SAL-QTN-2026-##### — null until persisted (P10)

  // ── buyer / currency ─────────────────────────────────────────────────────
  buyerLei:      string;             // links to Customer (Tommy)
  customerName?: string;             // party_name / customer_name
  currency:      string;             // §1 invariant — INR

  // ── content ────────────────────────────────────────────────────────────
  lines:    QuoteLine[];             // → Quotation Item rows (1+; multi-line P06)
  freight?: QuoteFreight;            // P05+
  // §1 single one-time payment → schedule has EXACTLY 1 row (invoice_portion=100)
  payment:  { term: PaymentTerm; schedule: PaymentScheduleRow[] };
  totals:   QuoteTotals;
  validTill?: string;                // valid_till
  status:     QuoteStatus;

  // ── revision (P09/P10 — native amend chain) ──────────────────────────────
  revision:    number;               // custom_quote_revision (friendly R1/R2/R3)
  amendedFrom?: string;              // amended_from (prior Quotation name)

  // ── issuer identity (P10) ─────────────────────────────────────────────────
  issuer?: IssuerIdentity;

  // ── provenance / audit ────────────────────────────────────────────────────
  quotedAt:           string;        // custom_quoted_at (ISO, agent-stamped)
  signedEnvelopeHash?: string;       // custom_signed_envelope_hash (sha256; SIGNING_MODE=plain)
  actusSimId?:        string;        // custom_actus_sim_id (P07+; ACTUS PAM sim behind the price)
}
