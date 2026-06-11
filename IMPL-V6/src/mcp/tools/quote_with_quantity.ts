// ================= MCP TOOL — quote_with_quantity (P02) =================
//
// V6.3 / P02: unit price (verified Item Price) PLUS any selling Pricing Rule
// quantity slab that applies to (itemCode, qty). Deterministic → QuoteToolResult
// envelope (not a ConsultationRecord).
//
// GROUNDING:
//   - Base unit price: src/mcp/tools/pricing.ts (verified Item Price fields).
//   - Qty slab:        src/mcp/tools/pricing-rules.ts (verified Pricing Rule fields).
//   - 03 §4 item 2: quantity-break pricing is expressed via Pricing Rule.
//
// DEGRADES HONESTLY: with no Pricing Rule seeded (current state), the effective
// rate == the base list rate and pricingBasis = "list-price". With no Item Price,
// success:false and NO fabricated rate (same contract as quote_unit_price).
//
// Single ErpNext client per call (no double item-exists check) — uses the shared
// helpers directly rather than calling quote_unit_price.

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
import {
  resolveQtyPricingRule,
  type PricingBasis,
  type PricingRuleFieldNames,
} from "./pricing-rules.js";

// ── Input schema ─────────────────────────────────────────────────────────────

export const QuoteWithQuantityInputSchema = z.object({
  itemCode: z.string().trim().min(1, "itemCode is required"),
  /** Quantity — drives both the line amount and the Pricing Rule slab. */
  qty: z.number().int().positive().default(1),
  priceList: z.string().trim().default("Standard Selling"),
  currency: z.string().trim().default("INR"),
  customer: z.string().trim().optional(),
  asOf: z.string().trim().optional(),
});

export type QuoteWithQuantityInput = z.infer<typeof QuoteWithQuantityInputSchema>;

// ── Result payload ─────────────────────────────────────────────────────────

export interface QuoteWithQuantityResult {
  itemCode: string;
  itemName?: string;
  qty: number;
  /** Effective unit rate after any qty Pricing Rule. */
  unitRate: number;
  /** List (Item Price) rate before any rule — for transparency. */
  baseUnitRate: number;
  /** unitRate × qty. */
  amount: number;
  currency: string;
  priceList: string;
  itemPriceName?: string;
  validFrom?: string;
  /** Set when a Pricing Rule changed the rate. */
  appliedPricingRule?: string;
  /** How unitRate was derived. */
  pricingBasis: PricingBasis;
}

export interface QuoteWithQuantityDeps {
  itemPriceFields?: ItemPriceFieldNames;
  pricingRuleFields?: PricingRuleFieldNames;
}

// ── Tool implementation ──────────────────────────────────────────────────────

export async function quoteWithQuantity(
  input: QuoteWithQuantityInput,
  flags: Pick<OrchestratorFlags, "ERPNEXT_URL" | "ERPNEXT_API_KEY" | "ERPNEXT_API_SECRET">,
  deps: QuoteWithQuantityDeps = {},
): Promise<QuoteToolResult<QuoteWithQuantityResult>> {
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

  try {
    const client = createErpNextClient(flags);

    // 1) Item must exist.
    const item = await client.getDoc<{ item_name?: string }>("Item", input.itemCode);
    if (item === null) {
      return {
        success: false,
        error: `Item "${input.itemCode}" not found in ERPNext.`,
        provenance: makeProvenance(`ERPNext Item/${input.itemCode}`, startedAt, performedAt),
      };
    }

    // 2) Base selling Item Price.
    const row = await lookupSellingItemPrice(client, lookupOpts);
    if (!row || typeof row.price_list_rate !== "number") {
      return {
        success: false,
        error:
          `No selling Item Price for "${input.itemCode}" in price list "${input.priceList}" ` +
          `(currency ${input.currency}). Seed Item Prices or check the price list name.`,
        provenance: makeProvenance(describeItemPriceQuery(lookupOpts), startedAt, performedAt),
      };
    }
    const baseUnitRate = row.price_list_rate;

    // 3) Qty Pricing Rule (degrades to base when none applies).
    const match = await resolveQtyPricingRule(client, {
      itemCode: input.itemCode,
      qty: input.qty,
      priceList: input.priceList,
      baseRate: baseUnitRate,
      currency: input.currency,
      asOf: input.asOf,
      fields: deps.pricingRuleFields,
    });

    const unitRate = match ? match.effectiveRate : baseUnitRate;
    const pricingBasis: PricingBasis = match ? match.basis : "list-price";

    const result: QuoteWithQuantityResult = {
      itemCode: input.itemCode,
      itemName: item.item_name,
      qty: input.qty,
      unitRate,
      baseUnitRate,
      amount: unitRate * input.qty,
      currency: row.currency ?? input.currency,
      priceList: input.priceList,
      itemPriceName: row.name,
      validFrom: row.valid_from,
      appliedPricingRule: match?.ruleName,
      pricingBasis,
    };

    const dataSource =
      `${describeItemPriceQuery(lookupOpts)} + Pricing Rule[apply_on=Item Code, qty=${input.qty}, selling=1` +
      (match ? `, applied=${match.ruleName}` : ", none") +
      "]";

    return { success: true, result, provenance: makeProvenance(dataSource, startedAt, performedAt) };
  } catch (err) {
    const msg = err instanceof ErpNextError ? err.message : `unexpected error: ${String(err)}`;
    return {
      success: false,
      error: msg,
      provenance: makeProvenance(describeItemPriceQuery(lookupOpts), startedAt, performedAt),
    };
  }
}

// ── Human-readable summary ───────────────────────────────────────────────────

export function formatQuoteWithQuantitySummary(out: QuoteToolResult<QuoteWithQuantityResult>): string {
  if (!out.success || !out.result) {
    return `quote_with_quantity failed: ${out.error ?? "unknown error"}`;
  }
  const r = out.result;
  const ruleNote =
    r.pricingBasis === "list-price"
      ? "list price"
      : `${r.pricingBasis} via ${r.appliedPricingRule} (base ${r.baseUnitRate})`;
  return (
    `${r.itemCode} × ${r.qty} @ ${r.unitRate} ${r.currency} = ${r.amount} ${r.currency} ` +
    `[${r.priceList}, ${ruleNote}, ${out.provenance.latencyMs}ms]`
  );
}
