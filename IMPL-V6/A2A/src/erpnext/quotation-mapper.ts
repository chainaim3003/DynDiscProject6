// ================= IMPL-V6 — ERPNext QUOTATION MAPPER (domain Quote -> Quotation) =================
//
// Maps a domain Quote -> a POST /api/resource/Quotation body. Mirrors the proven
// pattern in mappers.ts (prune, payment-term name map, date-only) and reuses its
// exported helpers so there is ONE payment-term mapping in the codebase.
//
// GROUNDING + HONEST LIMIT (Rule 2/4):
//   - NATIVE Quotation / Quotation Item / Payment Schedule fields are stock ERPNext
//     (docs.frappe.io selling/quotation) and are always emitted.
//   - The CUSTOM identity fields (custom_negotiation_id, custom_quoted_by_agent,
//     custom_quoted_by_oor, custom_seller_lei, custom_signed_envelope_hash,
//     custom_credential_mode, custom_quote_revision) referenced in quote-types.ts §2.2
//     have NO fixture in erpnextEnh1 yet (only Opportunity has custom fields). Posting
//     them now would fail/drop. So they are GATED behind ctx.includeCustomFields
//     (default false). Create the erpnextEnh1 quotation custom fixture (mirroring
//     opportunity.json), THEN set includeCustomFields:true. Until then the identity
//     lives in the signed domain Quote + the audit attestations, not in ERPNext.

import type { Quote } from "../shared/quote-types.js";
import {
  DEFAULT_BUYER_CUSTOMER_NAME,
  resolvePaymentTermName,
  type MapOpportunityContext,
} from "./mappers.js";

function toDateOnly(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/** ERPNext Payment Schedule requires due_date; Frappe won't auto-derive it on a
 *  direct REST insert. Derive due_date = transaction_date + credit_days (Net-0 -> same day). */
function dueDateFromTerm(quotedAtIso: string | undefined, creditDays: number | undefined): string | undefined {
  const base = toDateOnly(quotedAtIso);
  if (!base) return undefined;
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (creditDays ?? 0));
  return d.toISOString().slice(0, 10);
}

function prune(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export interface MapQuotationContext
  extends Pick<MapOpportunityContext, "company" | "customerName" | "conversionRate" | "paymentTermNameMap"> {
  /** Quotation.company — the SELLER (Jupiter). flags.ERPNEXT_COMPANY. */
  company: string;
  /**
   * Emit the erpnextEnh1 custom identity fields. DEFAULT false — only flip to true
   * AFTER the quotation custom-field fixture exists in erpnextEnh1 (see header).
   */
  includeCustomFields?: boolean;
}

/** Map one QuoteLine -> a Quotation Item child row (native fields). */
function mapLine(line: Quote["lines"][number]): Record<string, unknown> {
  return prune({
    item_code: line.itemCode,
    qty: line.qty,
    uom: line.uom,
    rate: line.rate,
    warehouse: line.warehouse,
    prevdoc_doctype: line.prevdocDoctype,
    prevdoc_docname: line.prevdocDocname,
  });
}

/**
 * Build the Quotation POST body from a (signed) domain Quote.
 * Native fields always; custom identity fields only when ctx.includeCustomFields.
 */
export function mapQuoteToQuotationPayload(
  quote: Quote,
  ctx: MapQuotationContext,
): Record<string, unknown> {
  const customerName = ctx.customerName ?? DEFAULT_BUYER_CUSTOMER_NAME;

  const native = prune({
    // ── native header ──────────────────────────────────────────────────────
    quotation_to: "Customer",
    party_name: customerName,
    company: ctx.company,
    currency: quote.currency,
    conversion_rate: ctx.conversionRate ?? 1,
    transaction_date: toDateOnly(quote.quotedAt),
    valid_till: toDateOnly(quote.validTill),
    // ── lines ────────────────────────────────────────────────────────────
    items: quote.lines.map(mapLine),
    // ── payment schedule (single 100% row — §1 invariant) ──────────────────
    payment_schedule: quote.payment.schedule.map((s) =>
      prune({
        payment_term: resolvePaymentTermName(s.paymentTerm, ctx.paymentTermNameMap),
        invoice_portion: s.invoicePortion,
        credit_days: s.creditDays,
        payment_amount: s.paymentAmount,
        due_date: toDateOnly(s.dueDate) ?? dueDateFromTerm(quote.quotedAt, s.creditDays),
      }),
    ),
  });

  if (!ctx.includeCustomFields) return native;

  // Custom identity fields — ONLY once the erpnextEnh1 quotation fixture exists.
  return {
    ...native,
    ...prune({
      custom_negotiation_id: quote.negotiationId,
      custom_quoted_by_agent: quote.issuer?.agent,
      custom_quoted_by_oor: quote.issuer?.oor,
      custom_seller_lei: quote.issuer?.sellerLei,
      custom_seller_agent_aid: quote.issuer?.sellerAgentAid,
      custom_credential_mode: quote.issuer?.credentialMode,
      custom_signed_envelope_hash: quote.signedEnvelopeHash,
      custom_quote_revision: quote.revision,
      amended_from: quote.amendedFrom,
    }),
  };
}
