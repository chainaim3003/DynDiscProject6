// ================= IMPL-V6 — ERPNext MAPPERS (domain <-> DocType) =================
//
// Pure mapping functions between the agent's domain types (Inquiry / InquiryLine)
// and ERPNext REST payloads. NO network, NO env reads, NO hidden state — the
// caller (intake node) passes a resolved context built from flags + invariants,
// so these functions are deterministic and unit-testable.
//
// GROUNDING (Rule 8 — field names read, not recalled):
//   - Native Opportunity / Opportunity Item fields:
//       DESIGN_6/03-Inquiry-and-Quote-Schemas.md §1.1, §1.2, §1.6 (example payload)
//   - Custom (erpnextEnh1) fields, verbatim from the installed fixtures:
//       erpnextEnh1/apps/chainaim_proc/chainaim_proc/custom/opportunity.json
//       erpnextEnh1/apps/chainaim_proc/chainaim_proc/custom/opportunity_item.json
//
// PAYMENT-TERM NAMING (FACT vs design — flagged):
//   03 §1.6 shows custom_payment_term_requested = "Net-30" (hyphen), but the
//   live seed 00-bootstrap-masters.py creates Payment Term docs named "Net 30"
//   (space: term_name = f"Net {days}"). custom_payment_term_requested is a
//   Link -> Payment Term, so the value MUST be an existing Payment Term name.
//   The seed is the ground truth, so DEFAULT_PAYMENT_TERM_NAME_MAP maps the
//   domain hyphen form -> the seeded space form. Override via ctx if your DB
//   differs. (Same map will serve the Quotation payment_terms_template later.)
//
// BUYER CUSTOMER NAME:
//   party_name is a Dynamic Link to Customer. Customer has NO LEI field (per the
//   00 seed docstring), so we cannot resolve the Customer from inquiry.buyerLei.
//   The buyer Customer name is a deployment invariant (the seeded buyer); it is
//   a sensible DEFAULT here, overridable via ctx.customerName — never hardcoded
//   inside the body builder.

import type { Inquiry, InquiryLine } from "../shared/inquiry-types.js";
import type { PaymentTerm } from "../shared/quote-types.js";

// ─── Deployment defaults (overridable via context) ──────────────────────────

/** Seeded buyer Customer (00-bootstrap-masters.py --customer-name). */
export const DEFAULT_BUYER_CUSTOMER_NAME = "Tommy Hilfiger Europe B.V.";

/**
 * Domain PaymentTerm (hyphen) -> ERPNext Payment Term / Payment Terms Template
 * document name (space), as created by 00-bootstrap-masters.py.
 */
export const DEFAULT_PAYMENT_TERM_NAME_MAP: Readonly<Record<PaymentTerm, string>> = Object.freeze({
  "Net-0": "Net 0",
  "Net-30": "Net 30",
  "Net-60": "Net 60",
});

// ─── Mapping context (resolved by the caller from flags + invariants) ────────

export interface MapOpportunityContext {
  /** Opportunity.company — flags.ERPNEXT_COMPANY (the SELLER, Jupiter). */
  company: string;
  /** Opportunity.currency — flags.ERPNEXT_CURRENCY (INR invariant). */
  currency: string;
  /** party_name (the buyer Customer doc name). Defaults to the seeded buyer. */
  customerName?: string;
  /** Opportunity.conversion_rate (1 for INR-INR). */
  conversionRate?: number;
  /** Opportunity.status at intake. */
  status?: string;
  /** Opportunity.opportunity_type. */
  opportunityType?: string;
  /** Override the domain->ERPNext payment-term name map. */
  paymentTermNameMap?: Readonly<Record<PaymentTerm, string>>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** ISO timestamp -> "YYYY-MM-DD" (ERPNext Date fields). Passes through plain dates. */
function toDateOnly(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  // Accept "2026-09-30" or "2026-09-30T..." — take the date portion.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/** Drop keys whose value is undefined or null (never POST nulls into ERPNext). */
function prune(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * Resolve a domain PaymentTerm to the ERPNext Payment Term document name.
 * Returns undefined for undefined input (so the field is simply omitted).
 * Throws on an unknown term rather than POSTing a value that will fail the
 * Link validation (fail loud, not silently wrong — Rule 2).
 */
export function resolvePaymentTermName(
  term: PaymentTerm | undefined,
  map: Readonly<Record<PaymentTerm, string>> = DEFAULT_PAYMENT_TERM_NAME_MAP,
): string | undefined {
  if (term === undefined) return undefined;
  const name = map[term];
  if (name === undefined) {
    throw new Error(
      `[mappers] no ERPNext Payment Term name mapped for domain term "${term}". ` +
        `Known: ${Object.keys(map).join(", ")}. Extend ctx.paymentTermNameMap.`,
    );
  }
  return name;
}

// ─── Opportunity Item (child row) ────────────────────────────────────────────

/**
 * Map one InquiryLine -> an Opportunity Item child row (native + custom fields).
 * `rate` carries the buyer's disclosed target if any, else 0 (03 §1.2);
 * ERPNext computes `amount` on save.
 */
export function mapInquiryLineToOpportunityItem(line: InquiryLine): Record<string, unknown> {
  return prune({
    // native (03 §1.2)
    item_code: line.itemCode,
    item_name: line.itemName,
    description: line.description,
    uom: line.uom,
    qty: line.qty,
    rate: line.targetRate ?? 0,
    item_group: line.itemGroup,
    brand: line.brand,
    // custom (opportunity_item.json)
    custom_size: line.size,
    custom_required_delivery_date: toDateOnly(line.requiredDeliveryDate),
    custom_target_rate: line.targetRate,
  });
}

// ─── Opportunity (header + items) ────────────────────────────────────────────

/**
 * Build the POST /api/resource/Opportunity body from a parsed Inquiry.
 *
 * Only fields with a value are included (prune) — e.g. payment-term / incoterm /
 * destination are omitted on the P01-P02 happy path where the buyer didn't state
 * them, so the deterministic intake never posts empty knobs.
 */
export function mapInquiryToOpportunityPayload(
  inquiry: Inquiry,
  ctx: MapOpportunityContext,
): Record<string, unknown> {
  const customerName = ctx.customerName ?? DEFAULT_BUYER_CUSTOMER_NAME;
  const ddRequired = inquiry.dimensions.includes("DD");

  return prune({
    // ── native header (03 §1.1) ──────────────────────────────────────────
    opportunity_from: "Customer",
    party_name: customerName,
    status: ctx.status ?? "Open",
    opportunity_type: ctx.opportunityType ?? "Sales",
    transaction_date: toDateOnly(inquiry.receivedAt),
    company: ctx.company,
    currency: ctx.currency,
    conversion_rate: ctx.conversionRate ?? 1,
    expected_closing: toDateOnly(inquiry.requiredDeliveryDate),

    // ── custom header (opportunity.json) ─────────────────────────────────
    custom_inquiry_id: inquiry.negotiationId,
    custom_buyer_lei: inquiry.buyerLei,
    custom_buyer_agent: inquiry.buyerAgent,
    custom_buyer_oor: inquiry.buyerOor,
    custom_required_delivery_date: toDateOnly(inquiry.requiredDeliveryDate),
    custom_delivery_destination: inquiry.destination,
    custom_incoterm_requested: inquiry.incotermRequested,
    custom_payment_term_requested: resolvePaymentTermName(
      inquiry.paymentTermRequested,
      ctx.paymentTermNameMap,
    ),
    custom_max_negotiation_rounds: inquiry.maxNegotiationRounds,
    custom_dd_required: ddRequired ? 1 : 0,
    custom_inquiry_dimensions_json:
      inquiry.dimensionsSnapshot ?? JSON.stringify(inquiry.dimensions),

    // ── lines ────────────────────────────────────────────────────────────
    items: inquiry.lines.map(mapInquiryLineToOpportunityItem),
  });
}
