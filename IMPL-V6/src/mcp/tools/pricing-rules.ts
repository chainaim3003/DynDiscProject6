// ================= IMPL-V6 — PRICING RULE LAYER (qty-break resolution) =================
//
// Resolves a selling `Pricing Rule` quantity slab for an (item, qty) and applies
// it to a base Item Price rate. Used by quote_with_quantity (P02). Deterministic.
//
// VERIFIED against the live instance (DocType/Pricing Rule field dump):
//   parent fields : disable(Check), selling(Check), apply_on(Select "Item Code"),
//                   price_or_product_discount(Select "Price"), rate_or_discount(Select),
//                   rate(Currency), discount_percentage(Float), min_qty(Float),
//                   max_qty(Float), for_price_list(Link Price List), currency(Link),
//                   valid_from(Date), valid_upto(Date), priority(Select), items(Table)
//   item targeting: child Table `items` -> "Pricing Rule Item Code" (has item_code)
// The two Select VALUE labels used as constants below ("Item Code", "Price",
// "Rate", "Discount Percentage") are ERPNext's standard option labels; a rule
// using an unsupported type (e.g. "Discount Amount", product discounts) is
// SKIPPED, never misapplied — so we degrade to the base list rate rather than
// inventing a number (Rule 2/8).
//
// MECHANIC (why two steps, not one):
//   ERPNext targets items through the child table, and a parent list query does
//   NOT return child rows. So: (1) query the child DocType for parents that
//   reference this item_code; (2) fetch each candidate parent (full doc) and
//   filter on the verified parent fields + qty slab in code; (3) pick by
//   priority, then most-specific slab, then most recent. A couple of round trips
//   at demo scale — correct and auditable beats clever.

import type { ErpNextClient } from "../../erpnext/client.js";

// ─── Configurable field names (verified defaults — override if your DB differs) ──

export interface PricingRuleFieldNames {
  doctype: string;            // "Pricing Rule"
  childDoctype: string;       // "Pricing Rule Item Code"
  childItemCode: string;      // child.item_code
  childParent: string;        // child.parent
  disable: string;
  selling: string;
  applyOn: string;
  priceOrProductDiscount: string;
  rateOrDiscount: string;
  rate: string;
  discountPercentage: string;
  minQty: string;
  maxQty: string;
  forPriceList: string;
  currency: string;
  validFrom: string;
  validUpto: string;
  priority: string;
}

export const DEFAULT_PRICING_RULE_FIELDS: Readonly<PricingRuleFieldNames> = Object.freeze({
  doctype: "Pricing Rule",
  childDoctype: "Pricing Rule Item Code",
  childItemCode: "item_code",
  childParent: "parent",
  disable: "disable",
  selling: "selling",
  applyOn: "apply_on",
  priceOrProductDiscount: "price_or_product_discount",
  rateOrDiscount: "rate_or_discount",
  rate: "rate",
  discountPercentage: "discount_percentage",
  minQty: "min_qty",
  maxQty: "max_qty",
  forPriceList: "for_price_list",
  currency: "currency",
  validFrom: "valid_from",
  validUpto: "valid_upto",
  priority: "priority",
});

// Standard ERPNext Select option labels we support.
const APPLY_ON_ITEM_CODE = "Item Code";
const POPD_PRICE = "Price";
const ROD_RATE = "Rate";
const ROD_DISCOUNT_PCT = "Discount Percentage";

/** Parent Pricing Rule doc shape (subset we read). */
interface PricingRuleDoc {
  name?: string;
  disable?: number | boolean;
  selling?: number | boolean;
  apply_on?: string;
  price_or_product_discount?: string;
  rate_or_discount?: string;
  rate?: number;
  discount_percentage?: number;
  min_qty?: number;
  max_qty?: number;
  for_price_list?: string;
  currency?: string;
  valid_from?: string;
  valid_upto?: string;
  priority?: string | number;
}

// ─── Result ──────────────────────────────────────────────────────────────────

export type PricingBasis = "list-price" | "rate-override" | "discount-percentage";

export interface PricingRuleMatch {
  ruleName: string;
  /** Effective unit rate after applying the rule to the base rate. */
  effectiveRate: number;
  basis: Exclude<PricingBasis, "list-price">;
  minQty: number;
  maxQty: number;
  priority: number;
}

export interface ResolveQtyRuleOptions {
  itemCode: string;
  qty: number;
  priceList: string;
  baseRate: number;
  currency?: string;
  /** ISO date; if set, validity (valid_from/valid_upto) is enforced. */
  asOf?: string;
  /** Cap on candidate parent rules fetched (safety). */
  maxCandidates?: number;
  fields?: PricingRuleFieldNames;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isTrue = (v: unknown): boolean => v === 1 || v === true || v === "1";
const num = (v: unknown, dflt = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

/** Does `qty` fall in [min_qty, max_qty]? max_qty 0/absent ⇒ no upper bound. */
function qtyInSlab(rule: PricingRuleDoc, qty: number): boolean {
  const min = num(rule.min_qty, 0);
  const max = num(rule.max_qty, 0);
  if (qty < min) return false;
  if (max > 0 && qty > max) return false;
  return true;
}

/** Validity check against asOf (if provided). Empty bounds = open-ended. */
function validOn(rule: PricingRuleDoc, asOf?: string): boolean {
  if (!asOf) return true;
  if (rule.valid_from && rule.valid_from > asOf) return false;
  if (rule.valid_upto && rule.valid_upto < asOf) return false;
  return true;
}

/** Compute the effective rate for a supported rule type; null if unsupported. */
function effectiveRateFor(rule: PricingRuleDoc, baseRate: number): { rate: number; basis: PricingRuleMatch["basis"] } | null {
  if (rule.price_or_product_discount !== POPD_PRICE) return null; // product discounts: not a price change here
  if (rule.rate_or_discount === ROD_RATE && typeof rule.rate === "number") {
    return { rate: rule.rate, basis: "rate-override" };
  }
  if (rule.rate_or_discount === ROD_DISCOUNT_PCT && typeof rule.discount_percentage === "number") {
    return { rate: baseRate * (1 - rule.discount_percentage / 100), basis: "discount-percentage" };
  }
  return null; // "Discount Amount" / unknown → skip (do not fabricate)
}

// ─── Public: resolve the best matching qty Pricing Rule ──────────────────────

/**
 * Find the best selling Pricing Rule for (itemCode, qty) in `priceList` and
 * return the effective rate. Returns null when no applicable, supported rule
 * exists (caller falls back to the base list rate).
 *
 * Selection order: highest priority, then most specific slab (largest min_qty),
 * then most recent valid_from.
 */
export async function resolveQtyPricingRule(
  client: ErpNextClient,
  opts: ResolveQtyRuleOptions,
): Promise<PricingRuleMatch | null> {
  const F = opts.fields ?? DEFAULT_PRICING_RULE_FIELDS;
  const cap = opts.maxCandidates ?? 50;

  // (1) candidate parents that target this item via the child table
  const childRows = await client.list<{ parent?: string }>(F.childDoctype, {
    filters: [
      [F.childItemCode, "=", opts.itemCode],
      ["parenttype", "=", F.doctype],
    ],
    fields: [F.childParent],
    limit: cap,
  });
  const parentNames = [...new Set(childRows.map((r) => r.parent).filter((n): n is string => !!n))];
  if (parentNames.length === 0) return null;

  // (2) fetch + filter each parent on verified fields + slab + validity
  const matches: PricingRuleMatch[] = [];
  for (const name of parentNames) {
    const rule = await client.getDoc<PricingRuleDoc>(F.doctype, name);
    if (!rule) continue;
    if (isTrue(rule.disable)) continue;
    if (!isTrue(rule.selling)) continue;
    if (rule.apply_on !== APPLY_ON_ITEM_CODE) continue;
    if (rule.for_price_list && rule.for_price_list !== opts.priceList) continue;
    if (opts.currency && rule.currency && rule.currency !== opts.currency) continue;
    if (!qtyInSlab(rule, opts.qty)) continue;
    if (!validOn(rule, opts.asOf)) continue;

    const eff = effectiveRateFor(rule, opts.baseRate);
    if (!eff) continue;

    matches.push({
      ruleName: rule.name ?? name,
      effectiveRate: eff.rate,
      basis: eff.basis,
      minQty: num(rule.min_qty, 0),
      maxQty: num(rule.max_qty, 0),
      priority: num(typeof rule.priority === "string" ? Number(rule.priority) : rule.priority, 0),
    });
  }
  if (matches.length === 0) return null;

  // (3) pick: priority desc, then min_qty desc (most specific slab)
  matches.sort((a, b) => b.priority - a.priority || b.minQty - a.minQty);
  return matches[0]!;
}
