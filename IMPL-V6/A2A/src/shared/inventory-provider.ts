// ================= IMPL-V6 — INVENTORY PROVIDER (real, ERPNext Bin) =================
//
// Real implementation of the existing InventoryProvider interface
// (shared/provider-types.ts) — the Φ3 Inventory sub-agent's data source. Reads
// available-to-promise stock from ERPNext Bin for a (variant item, warehouse)
// and returns the standard ConsultationRecord<InventoryConsultation> so the
// provenance flows verbatim into the audit's consultations[] block.
//
// GROUNDING (Rule 8 — read, not recalled):
//   - Bin is system-derived from the Stock Ledger; you READ it, never POST it.
//     Stock is seeded via a submitted Stock Reconciliation (erpnextEnh1/seed/
//     04-seed-demo-bins.py), which proves `Bin.actual_qty` is the on-hand field.
//   - Free-to-promise = actual_qty − reserved_qty (matches fulfillment-types.ts
//     "available − reserved − safety"; safety stock unset by the seeds → 0).
//   - Warehouse doc NAME carries the company abbr: "MADRAS-WH-1 - JKC" (seed 04
//     default), NOT the bare "MADRAS-WH-1" that flags.ERPNEXT_DEFAULT_WAREHOUSE
//     defaults to. Pass the full name via options.warehouse, else Bin lookups
//     find nothing and everything reads canFulfill=false.
//
// VERIFICATION STATUS: `actual_qty` is proven by the seed; `reserved_qty` is the
// standard companion field (not exercised by the seed). Both are overridable via
// BinFieldNames; a confirming GET is given in chat. Item.lead_time_days is unset
// by the seeds, so lead time defaults to 0 (readItemLeadTime stays off) and the
// fulfillment node flags "lead time unknown" when a line is short — no invented
// ship dates.

import type {
  ConsultationRecord,
  InventoryConsultation,
  InventoryConsultationInput,
  InventoryProvider,
} from "./provider-types.js";
import { ErpNextClient, ErpNextError } from "../erpnext/client.js";

// ─── Configurable Bin field names (standard defaults — verify) ───────────────

export interface BinFieldNames {
  doctype: string; // "Bin"
  itemCode: string; // "item_code"
  warehouse: string; // "warehouse"
  actualQty: string; // "actual_qty" (proven by seed 04)
  reservedQty: string; // "reserved_qty" (standard companion)
}

export const DEFAULT_BIN_FIELDS: Readonly<BinFieldNames> = Object.freeze({
  doctype: "Bin",
  itemCode: "item_code",
  warehouse: "warehouse",
  actualQty: "actual_qty",
  reservedQty: "reserved_qty",
});

// ─── Options ─────────────────────────────────────────────────────────────────

export interface InventoryProviderOptions {
  /** ERPNext Warehouse doc NAME (with abbr), e.g. "MADRAS-WH-1 - JKC". Required — no guessing. */
  warehouse: string;
  /** Override Bin field names if your schema differs. */
  binFields?: BinFieldNames;
  /** Lead time (days) when Item.lead_time_days is unavailable/unset. Default 0. */
  leadTimeDaysDefault?: number;
  /** Also read Item.lead_time_days (off by default — the seeds leave it unset). */
  readItemLeadTime?: boolean;
  /** Injectable clock (ISO yyyy-mm-dd) for deterministic tests. */
  todayIso?: () => string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const num = (v: unknown, dflt = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

const defaultToday = (): string => new Date().toISOString().slice(0, 10);

function addDaysIso(baseIso: string, days: number): string {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Provider ──────────────────────────────────────────────────────────────

class ErpNextInventoryProvider implements InventoryProvider {
  readonly subAgent = "inventory" as const;
  readonly mode = "real" as const;

  private readonly client: ErpNextClient;
  private readonly warehouse: string;
  private readonly F: BinFieldNames;
  private readonly leadTimeDaysDefault: number;
  private readonly readItemLeadTime: boolean;
  private readonly today: () => string;

  constructor(client: ErpNextClient, opts: InventoryProviderOptions) {
    this.client = client;
    this.warehouse = opts.warehouse;
    this.F = opts.binFields ?? DEFAULT_BIN_FIELDS;
    this.leadTimeDaysDefault = opts.leadTimeDaysDefault ?? 0;
    this.readItemLeadTime = opts.readItemLeadTime ?? false;
    this.today = opts.todayIso ?? defaultToday;
  }

  async consult(input: InventoryConsultationInput): Promise<ConsultationRecord<InventoryConsultation>> {
    const performedAt = new Date().toISOString();
    const startedAt = Date.now();
    const dataSource = `ERPNext Bin [${this.F.itemCode}=${input.productCode}, ${this.F.warehouse}=${this.warehouse}]`;

    try {
      const row = await this.client.findOne<Record<string, unknown>>(this.F.doctype, {
        filters: [
          [this.F.itemCode, "=", input.productCode],
          [this.F.warehouse, "=", this.warehouse],
        ],
        fields: ["name", this.F.itemCode, this.F.warehouse, this.F.actualQty, this.F.reservedQty],
      });

      const actualQty = num(row?.[this.F.actualQty], 0);
      const reservedQty = num(row?.[this.F.reservedQty], 0);
      const freeQty = Math.max(0, actualQty - reservedQty); // available-to-promise

      let leadTimeDays = this.leadTimeDaysDefault;
      if (this.readItemLeadTime) {
        const item = await this.client.getDoc<{ lead_time_days?: number }>("Item", input.productCode);
        leadTimeDays = num(item?.lead_time_days, this.leadTimeDaysDefault);
      }

      const canFulfill = freeQty >= input.quantity;
      const today = this.today();
      const earliestShipDate = canFulfill ? today : addDaysIso(today, leadTimeDays);

      const result: InventoryConsultation = {
        productCode: input.productCode,
        availableQty: freeQty, // free (actual − reserved), per the type's "not reserved" note
        reservedQty,
        leadTimeDays,
        earliestShipDate,
        canFulfill,
        warehouseRef: this.warehouse,
      };

      return {
        metadata: {
          subAgent: "inventory",
          dataMode: "real",
          performedAt,
          dataSource: `${dataSource} (actual=${actualQty}, reserved=${reservedQty}, free=${freeQty})`,
          latencyMs: Date.now() - startedAt,
        },
        success: true,
        result,
      };
    } catch (err) {
      const msg = err instanceof ErpNextError ? err.message : `unexpected error: ${String(err)}`;
      return {
        metadata: {
          subAgent: "inventory",
          dataMode: "real",
          performedAt,
          dataSource,
          latencyMs: Date.now() - startedAt,
        },
        success: false,
        error: msg,
      };
    }
  }
}

/**
 * Build the real ERPNext-Bin inventory provider.
 *
 *   const inv = createInventoryProvider(erp, { warehouse: "MADRAS-WH-1 - JKC" });
 */
export function createInventoryProvider(
  client: ErpNextClient,
  opts: InventoryProviderOptions,
): InventoryProvider {
  return new ErpNextInventoryProvider(client, opts);
}
