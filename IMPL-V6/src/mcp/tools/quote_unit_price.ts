// ================= MCP TOOL — quote_unit_price (P01) =================
//
// V6.3 / P01: the simplest quote — a single item's selling unit price from
// ERPNext Item Price, times a quantity. Deterministic (04 §2: pricing lives in
// Quoting, it is not a provider consultation), so it returns a QuoteToolResult
// envelope, NOT a ConsultationRecord.
//
// GROUNDING:
//   - 03-Inquiry-and-Quote-Schemas.md §2.2 (Quotation Item rate/amount),
//     §4 item 2 (Item Price for unit price; Pricing Rule for qty breaks).
//   - Item Price field names: src/mcp/tools/pricing.ts (standard defaults,
//     overridable — see the verification note there).
//
// HONEST "NO PRICE" PATH (Rule 2/8): nothing seeds Item Prices yet
// (00-bootstrap-masters + 01-seed-items-variants create masters + items but no
// prices). When no selling Item Price exists, this tool returns success:false
// with a clear error and NO fabricated rate. Seed prices (a future
// 05-seed-item-prices) and it starts returning real numbers — no code change.
//
// FLAGS / NAMED ARGS (Rule 8): priceList, currency, customer, asOf are explicit
// inputs with sensible defaults; the ERPNext connection comes from flags
// (ERPNEXT_URL/KEY/SECRET) via createErpNextClient.

import { z } from "zod";

import type { OrchestratorFlags } from "../../config/flags.js";
import { createErpNextClient, ErpNextError } from "../../erpnext/client.js";
import {
  lookupSellingItemPrice,
  describeItemPriceQuery,
  makeProvenance,
  type QuoteToolResult,
  type ItemPriceFieldNames,
} from "./pricing.js";

// ── Input schema ─────────────────────────────────────────────────────────────

export const QuoteUnitPriceInputSchema = z.object({
  /** Variant Item code, e.g. "TH-TEE-RN-180-M". */
  itemCode: z.string().trim().min(1, "itemCode is required"),
  /** Quantity to price (unit rate × qty). Default 1. */
  qty: z.number().int().positive().default(1),
  /** Selling Price List to read. Default ERPNext's built-in "Standard Selling". */
  priceList: z.string().trim().default("Standard Selling"),
  /** Currency constraint (INR invariant for V6). */
  currency: z.string().trim().default("INR"),
  /** Customer-specific price, if any. */
  customer: z.string().trim().optional(),
  /** ISO date; only prices effective on/before it. Default: latest. */
  asOf: z.string().trim().optional(),
});

export type QuoteUnitPriceInput = z.infer<typeof QuoteUnitPriceInputSchema>;

// ── Result payload ─────────────────────────────────────────────────────────

export interface QuoteUnitPriceResult {
  itemCode: string;
  itemName?: string;
  qty: number;
  /** Unit selling rate from Item Price (price_list_rate). */
  unitRate: number;
  /** unitRate × qty. */
  amount: number;
  currency: string;
  priceList: string;
  /** Item Price document name (audit traceability). */
  itemPriceName?: string;
  validFrom?: string;
}

/** Optional override of Item Price field names (DB schema differs from defaults). */
export interface QuoteUnitPriceDeps {
  itemPriceFields?: ItemPriceFieldNames;
}

// ── Tool implementation ──────────────────────────────────────────────────────

/**
 * Price one item line at its selling unit rate.
 *
 *   success=true  → result.unitRate/amount populated from a real Item Price.
 *   success=false → Item not found, no selling Item Price, or ERPNext error.
 *                   No rate is ever fabricated.
 */
export async function quoteUnitPrice(
  input: QuoteUnitPriceInput,
  flags: Pick<OrchestratorFlags, "ERPNEXT_URL" | "ERPNEXT_API_KEY" | "ERPNEXT_API_SECRET">,
  deps: QuoteUnitPriceDeps = {},
): Promise<QuoteToolResult<QuoteUnitPriceResult>> {
  const performedAt = new Date().toISOString();
  const startedAt = Date.now();
  const lookupOpts = {
    itemCode: input.itemCode,
    priceList: input.priceList,
    currency: input.currency,
    customer: input.customer,
    asOf: input.asOf,
    fields: deps.itemPriceFields,
  };
  const dataSource = describeItemPriceQuery(lookupOpts);

  try {
    const client = createErpNextClient(flags);

    // 1) Item must exist — distinguishes "unknown SKU" from "no price".
    const item = await client.getDoc<{ item_name?: string }>("Item", input.itemCode);
    if (item === null) {
      return {
        success: false,
        error: `Item "${input.itemCode}" not found in ERPNext.`,
        provenance: makeProvenance(`ERPNext Item/${input.itemCode}`, startedAt, performedAt),
      };
    }

    // 2) Selling Item Price lookup.
    const row = await lookupSellingItemPrice(client, lookupOpts);
    if (!row || typeof row.price_list_rate !== "number") {
      return {
        success: false,
        error:
          `No selling Item Price for "${input.itemCode}" in price list "${input.priceList}" ` +
          `(currency ${input.currency}). Seed Item Prices or check the price list name.`,
        provenance: makeProvenance(dataSource, startedAt, performedAt),
      };
    }

    const unitRate = row.price_list_rate;
    const result: QuoteUnitPriceResult = {
      itemCode: input.itemCode,
      itemName: item.item_name,
      qty: input.qty,
      unitRate,
      amount: unitRate * input.qty,
      currency: row.currency ?? input.currency,
      priceList: input.priceList,
      itemPriceName: row.name,
      validFrom: row.valid_from,
    };

    return { success: true, result, provenance: makeProvenance(dataSource, startedAt, performedAt) };
  } catch (err) {
    const msg = err instanceof ErpNextError ? err.message : `unexpected error: ${String(err)}`;
    return { success: false, error: msg, provenance: makeProvenance(dataSource, startedAt, performedAt) };
  }
}

// ── Human-readable summary (MCP text result) ─────────────────────────────────

export function formatQuoteUnitPriceSummary(out: QuoteToolResult<QuoteUnitPriceResult>): string {
  if (!out.success || !out.result) {
    return `quote_unit_price failed: ${out.error ?? "unknown error"}`;
  }
  const r = out.result;
  return (
    `${r.itemCode} × ${r.qty} @ ${r.unitRate} ${r.currency} = ${r.amount} ${r.currency} ` +
    `[${r.priceList}, ${out.provenance.latencyMs}ms]`
  );
}
