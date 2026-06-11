// ================= IMPL-V6 — Φ3 QUOTING NODES (deterministic) =================
//
// The V6.3 (P01-P02) quoting nodes of the negotiation StateGraph (04 §3.2):
//   quoting.start  ->  (fulfillment.plan)  ->  quoting.draftQuote
//
// DETERMINISTIC (04 §2: "No 'Pricing' agent ... pricing lives inside Quoting").
// quoting.draftQuote prices each inquiry line through the SAME handler the MCP
// tool exposes (quote_with_quantity) — single source of truth for pricing — then
// assembles a domain Quote draft into the `quoteDraft` channel, stamping each
// line's ATP feasibility (canFulfill / earliestShipDate) from the Fulfillment
// plan if one is present (it is, once fulfillment.plan runs between start and
// draft). Nothing is persisted to ERPNext here (Quotation write is Φ5 / P10);
// `quotationName` stays null.
//
// PAYMENT TERM: prefers the DD/credit-recommended term (state.ddResult.recommendedTerm)
// when due-diligence ran, else the buyer's requested term, else Net-0.
//
// HONEST FAILURE (Rule 2/8): if any line cannot be PRICED (no Item / no selling
// Item Price), the node THROWS with the exact list of unpriced item codes rather
// than emitting a quote with phantom zero rates. An UNFULFILLABLE line (short
// stock) is NOT a failure — the quote still drafts with canFulfill=false (the
// P03 ATP-short shape).
//
// GROUNDING:
//   - State channels:   orchestrator/state/neg-state.ts
//   - Quote domain:     shared/quote-types.ts (native + custom ERPNext mapping in 03 §2)
//   - Pricing handler:  mcp/tools/quote_with_quantity.ts
//   - Fulfillment plan: shared/fulfillment-types.ts (written by nodes/fulfillment.ts)

import type { NegStateType } from "../state/neg-state.js";
import type {
  Quote,
  QuoteLine,
  QuoteTotals,
  PaymentTerm,
  PaymentScheduleRow,
} from "../../shared/quote-types.js";
import type { OrchestratorFlags } from "../../config/flags.js";
import { quoteWithQuantity } from "../../mcp/tools/quote_with_quantity.js";

// ─── Node names ───────────────────────────────────────────────────────────────

export const QUOTING_NODE = {
  start: "quoting.start",
  draft: "quoting.draftQuote",
} as const;

// ─── Payment term → credit days (matches 00-bootstrap-masters Payment Terms) ──

const CREDIT_DAYS: Readonly<Record<PaymentTerm, number>> = Object.freeze({
  "Net-0": 0,
  "Net-30": 30,
  "Net-60": 60,
});

// ─── Dependencies ──────────────────────────────────────────────────────────

export interface QuotingDeps {
  flags: OrchestratorFlags;
  /** Selling Price List to quote from. Default ERPNext "Standard Selling". */
  priceList?: string;
}

export interface QuotingNodes {
  quotingStart: (state: NegStateType) => Partial<NegStateType>;
  quotingDraftQuote: (state: NegStateType) => Promise<Partial<NegStateType>>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ─── Node factory ─────────────────────────────────────────────────────────────

export function buildQuotingNodes(deps: QuotingDeps): QuotingNodes {
  const priceList = deps.priceList ?? "Standard Selling";

  function quotingStart(_state: NegStateType): Partial<NegStateType> {
    return { status: "QUOTING" };
  }

  /**
   * Price every inquiry line and assemble a Quote draft. Real Item Price (+ qty
   * Pricing Rule) per line; GST from flags.GST_RATE; single 100% payment row;
   * ATP feasibility stamped from the Fulfillment plan (per-line, by position).
   */
  async function quotingDraftQuote(state: NegStateType): Promise<Partial<NegStateType>> {
    const inquiry = state.inquiry;
    if (inquiry === undefined || inquiry === null) {
      throw new Error("[quoting.draftQuote] no inquiry in state — run intake first");
    }

    // Price each line concurrently via the canonical pricing handler.
    const priced = await Promise.all(
      inquiry.lines.map(async (line) => {
        const out = await quoteWithQuantity(
          {
            itemCode: line.itemCode,
            qty: line.qty,
            priceList,
            currency: inquiry.currency,
          },
          deps.flags,
        );
        return { line, out };
      }),
    );

    // Fail loud on any unpriced line — no phantom rates.
    const failures = priced.filter((p) => !p.out.success || !p.out.result);
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `${f.line.itemCode}: ${f.out.error ?? "no price"}`)
        .join("; ");
      throw new Error(
        `[quoting.draftQuote] cannot draft quote — ${failures.length} line(s) unpriced: ${detail}`,
      );
    }

    // Fulfillment plan (if present) is positionally aligned with inquiry.lines.
    const plan = state.fulfillmentPlan;

    // Build quote lines from real prices, stamped with ATP feasibility.
    const lines: QuoteLine[] = priced.map(({ line, out }, i) => {
      const r = out.result!; // success guaranteed above
      const fl = plan?.lines[i];
      return {
        itemCode: r.itemCode,
        qty: r.qty,
        uom: line.uom,
        rate: r.unitRate,
        amount: round2(r.amount),
        warehouse: deps.flags.ERPNEXT_DEFAULT_WAREHOUSE,
        prevdocDoctype: "Opportunity",
        prevdocDocname: state.opportunityName ?? undefined,
        canFulfill: fl?.canFulfill,
        earliestShipDate: fl?.earliestShipDate,
      };
    });

    // Totals (GST as a single tax bucket; no freight in V6.3).
    const totalQty = lines.reduce((s, l) => s + l.qty, 0);
    const netTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const gstRate = deps.flags.GST_RATE;
    const totalTaxesAndCharges = round2((netTotal * gstRate) / 100);
    const grandTotal = round2(netTotal + totalTaxesAndCharges);
    const totals: QuoteTotals = {
      totalQty,
      netTotal,
      gstRate,
      totalTaxesAndCharges,
      grandTotal,
      roundedTotal: Math.round(grandTotal),
    };

    // Single one-time payment row (01 §1 invariant: invoice_portion = 100).
    // Prefer the DD/credit-recommended term (when DD ran) over the buyer's request.
    const term: PaymentTerm =
      state.ddResult?.recommendedTerm ?? inquiry.paymentTermRequested ?? "Net-0";
    const scheduleRow: PaymentScheduleRow = {
      paymentTerm: term,
      invoicePortion: 100,
      creditDays: CREDIT_DAYS[term],
      paymentAmount: grandTotal,
    };

    const quote: Quote = {
      negotiationId: state.negotiationId,
      opportunityName: state.opportunityName ?? null,
      quotationName: null, // not persisted in V6.3
      buyerLei: inquiry.buyerLei,
      currency: inquiry.currency,
      lines,
      payment: { term, schedule: [scheduleRow] },
      totals,
      status: "Draft",
      revision: 1,
      quotedAt: new Date().toISOString(),
    };

    return { quoteDraft: quote, status: "QUOTED" };
  }

  return { quotingStart, quotingDraftQuote };
}
