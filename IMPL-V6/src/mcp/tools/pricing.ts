// ================= IMPL-V6 — SHARED PRICING LAYER (Item Price reads) =================
//
// Shared helpers for the quote_* MCP tools. Pricing is a DETERMINISTIC
// computation (04 §2: "No 'Pricing' agent ... it lives inside Quoting"), so the
// output envelope here is a plain QuoteToolResult — NOT a ConsultationRecord
// (that contract is for the closed provider sub-agent vocab treasury|inventory|
// logistics|credit, which is left unchanged per the standing rules).
//
// VERIFICATION STATUS (Rule 2 / Rule 3 — fact vs assumption, stated plainly):
//   The ERPNext `Item Price` DocType JSON could NOT be read from disk — the
//   ERPNext app source lives only inside the frappe_docker container images,
//   not on the host. So the field names below are the STABLE, STANDARD ERPNext
//   Item Price fields (present across versions), NOT read from this instance's
//   schema. They are exposed as an overridable ItemPriceFieldNames map so a
//   mismatch is a one-line override, never an internal edit. Verify against the
//   live instance before trusting prices (a confirming GET is given in chat).
//
//   `min_qty` is intentionally OMITTED — its presence on Item Price is version-
//   dependent and uncertain; quantity-break pricing is handled via `Pricing
//   Rule` (03 §4 item 2) in quote_with_quantity, not by an assumed Item Price
//   field.

import type { ErpNextClient } from "../../erpnext/client.js";

// ─── Configurable Item Price field names (standard defaults — verify) ────────

export interface ItemPriceFieldNames {
  /** DocType name. */
  doctype: string;
  /** Link -> Item. */
  itemCode: string;
  /** Link -> Price List. */
  priceList: string;
  /** Currency (Currency rate value). */
  rate: string;
  /** Link -> Currency. */
  currency: string;
  /** Check: is this a selling price? */
  selling: string;
  /** Date the price becomes valid. */
  validFrom: string;
  /** Link -> Customer (customer-specific price), optional. */
  customer: string;
  /** Link -> UOM. */
  uom: string;
}

/** Standard ERPNext Item Price field names. Override via tool options if your DB differs. */
export const DEFAULT_ITEM_PRICE_FIELDS: Readonly<ItemPriceFieldNames> = Object.freeze({
  doctype: "Item Price",
  itemCode: "item_code",
  priceList: "price_list",
  rate: "price_list_rate",
  currency: "currency",
  selling: "selling",
  validFrom: "valid_from",
  customer: "customer",
  uom: "uom",
});

/** The Item Price columns we read back (subset of the DocType). */
export interface ItemPriceRow {
  name?: string;
  item_code?: string;
  price_list?: string;
  price_list_rate?: number;
  currency?: string;
  valid_from?: string;
  uom?: string;
}

// ─── Result envelope (shared by all quote_* tools) ───────────────────────────

export interface QuoteProvenance {
  /** Always "real" — these tools always read the live ERPNext instance. */
  dataMode: "real";
  /** Human-readable description of exactly what was queried. */
  dataSource: string;
  /** ISO timestamp when the tool ran. */
  performedAt: string;
  /** Round-trip latency in ms. */
  latencyMs: number;
}

/**
 * Quote-tool output envelope. `success=false` carries an honest `error` and NO
 * fabricated price; the provenance block is always present (audit-always-on).
 */
export interface QuoteToolResult<R> {
  success: boolean;
  result?: R;
  error?: string;
  provenance: QuoteProvenance;
}

/** Build a provenance block from a query description and a start timestamp. */
export function makeProvenance(dataSource: string, startedAt: number, performedAt: string): QuoteProvenance {
  return { dataMode: "real", dataSource, performedAt, latencyMs: Date.now() - startedAt };
}

// ─── Item Price lookup ───────────────────────────────────────────────────────

export interface ItemPriceLookupOptions {
  itemCode: string;
  priceList: string;
  /** Constrain to a currency (recommended; INR for V6). */
  currency?: string;
  /** Customer-specific price, if any. */
  customer?: string;
  /** ISO date: only prices with valid_from on/before this date. */
  asOf?: string;
  /** Override the standard field-name map. */
  fields?: ItemPriceFieldNames;
}

/**
 * Look up the most recent SELLING Item Price for an item in a price list.
 * Returns the best-matching row, or null when none exists (e.g. no prices are
 * seeded yet — the caller turns this into an honest "no price" result, never a
 * guessed rate).
 *
 * NOTE: `valid_upto` is not filtered (single-filter-list simplicity); ordering
 * by valid_from desc takes the latest effective price. Refine if expiry matters.
 */
export async function lookupSellingItemPrice(
  client: ErpNextClient,
  opts: ItemPriceLookupOptions,
): Promise<ItemPriceRow | null> {
  const F = opts.fields ?? DEFAULT_ITEM_PRICE_FIELDS;

  const filters: Array<[string, string, unknown]> = [
    [F.itemCode, "=", opts.itemCode],
    [F.selling, "=", 1],
    [F.priceList, "=", opts.priceList],
  ];
  if (opts.currency) filters.push([F.currency, "=", opts.currency]);
  if (opts.customer) filters.push([F.customer, "=", opts.customer]);
  if (opts.asOf) filters.push([F.validFrom, "<=", opts.asOf]);

  const rows = await client.list<ItemPriceRow>(F.doctype, {
    filters,
    fields: ["name", F.itemCode, F.priceList, F.rate, F.currency, F.validFrom, F.uom],
    orderBy: `${F.validFrom} desc`,
    limit: 1,
  });

  return rows[0] ?? null;
}

/** Describe an Item Price query for the provenance dataSource string. */
export function describeItemPriceQuery(opts: ItemPriceLookupOptions): string {
  const parts = [
    `item_code=${opts.itemCode}`,
    `price_list=${opts.priceList}`,
    "selling=1",
  ];
  if (opts.currency) parts.push(`currency=${opts.currency}`);
  if (opts.customer) parts.push(`customer=${opts.customer}`);
  if (opts.asOf) parts.push(`valid_from<=${opts.asOf}`);
  return `ERPNext Item Price [${parts.join(", ")}]`;
}
