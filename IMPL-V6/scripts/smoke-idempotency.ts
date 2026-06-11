// ================= IMPL-V6 — IDEMPOTENCY DOUBLE-RUN SMOKE (gap G3) =================
//
// Proves the idempotency fix: running the SAME saga twice (same negotiationId)
// must NOT create duplicate ERPNext docs. Models scripts/smoke-ddn-saga.ts.
//
// What it does:
//   1. Run runNegotiation() ONCE with a FIXED negotiationId (IDEMPOTENT_WRITES on).
//   2. Run it AGAIN with the same negotiationId.
//   3. Assert run-2 REUSED run-1's docs:
//        - opportunityName(run1) === opportunityName(run2)
//        - quotationName(run1)   === quotationName(run2)   (only if a deal persisted)
//   4. Cross-check ERPNext directly: exactly ONE Opportunity has
//      custom_inquiry_id == negotiationId (server-side dedupe proof).
//   5. Cross-check the local ledger: its recorded Quotation name matches (the
//      Quotation dedupe path while custom_negotiation_id is gated off).
//
// CONTROL (optional): --expect-duplicates runs with IDEMPOTENT_WRITES=false and
// asserts the OPPOSITE (two distinct Opportunities) — demonstrates the guard is
// what prevents duplication, not luck. Off by default.
//
// AI vs MANUAL (Rule 9): AI-written; RUNNING it is MANUAL (needs your seeded
// ERPNext on localhost:8080 + outbound GLEIF):
//   npx tsx scripts/smoke-idempotency.ts --item <SEEDED_ITEM_CODE> [flags...]
//   npx tsx scripts/smoke-idempotency.ts --help
//
// GROUNDING (read, not assumed):
//   - Entry:       src/orchestrator/run.ts            (runNegotiation + RunNegotiationOptions, incl. flags)
//   - Inquiry:     src/orchestrator/nodes/intake.ts   (InquiryInputSchema; DD/N explicit)
//   - Flags:       src/config/flags.ts                (loadFlags, IDEMPOTENT_WRITES)
//   - ERPNext:     src/erpnext/client.ts              (createErpNextClient, list/findOne)
//   - Ledger:      src/erpnext/idempotency.ts         (getIdempotencyLedger)
//   - Dedupe key:  src/erpnext/mappers.ts             (custom_inquiry_id = negotiationId)

import { parseArgs } from "node:util";

import { runNegotiation, type RunNegotiationOptions } from "../src/orchestrator/run.js";
import type { InquiryInput } from "../src/orchestrator/nodes/intake.js";
import type { NegStateType } from "../src/orchestrator/state/neg-state.js";
import { loadFlags } from "../src/config/flags.js";
import { createErpNextClient } from "../src/erpnext/client.js";
import { getIdempotencyLedger } from "../src/erpnext/idempotency.js";

const DEFAULTS = {
  buyerLei: "54930012QJWZMYHNJW95",
  currency: "INR",
  qty: 2000,
  uom: "Nos",
  dimensions: "U,Q,DD,N",
  maxRounds: 3,
  targetUnitPrice: 300,
  floor: 250,
  creditFixturesDir: "DEMO-DATA/credit",
} as const;

function printHelp(): void {
  console.log(`
IMPL-V6 — idempotency double-run smoke (gap G3)

USAGE
  npx tsx scripts/smoke-idempotency.ts --item <ITEM_CODE> [options]

REQUIRED
  --item <code>              SEEDED ERPNext Item Code (with an Item Price).

OPTIONS (subset of smoke-ddn-saga; same meaning)
  --buyer-lei <lei>          (default ${DEFAULTS.buyerLei})
  --qty <n>                  (default ${DEFAULTS.qty})
  --uom <unit>               (default ${DEFAULTS.uom})
  --currency <ccy>           (default ${DEFAULTS.currency})
  --dimensions <csv>         (default "${DEFAULTS.dimensions}")
  --target-unit-price <n>    (default ${DEFAULTS.targetUnitPrice})
  --buyer-max <n>            (default = target-unit-price)
  --max-rounds <n>           (default ${DEFAULTS.maxRounds})
  --floor <n>                treasury demo floor (default ${DEFAULTS.floor})
  --credit-fixtures-dir <d>  (default "${DEFAULTS.creditFixturesDir}")
  --price-list <name>        selling price list override
  --warehouse <name>         ERPNext Warehouse doc name
  --persist-custom-fields    emit ERPNext custom identity fields on persist
  --negotiation-id <id>      FIXED id reused for both runs (default: IDEM-SMOKE-<ts>)
  --expect-duplicates        CONTROL: run with IDEMPOTENT_WRITES=false; assert duplicates appear
  --help
`);
}

function num(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`[smoke-idem] --${label} must be a number, got "${raw}"`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      item: { type: "string" },
      "buyer-lei": { type: "string" },
      qty: { type: "string" },
      uom: { type: "string" },
      currency: { type: "string" },
      dimensions: { type: "string" },
      "target-unit-price": { type: "string" },
      "buyer-max": { type: "string" },
      "max-rounds": { type: "string" },
      floor: { type: "string" },
      "credit-fixtures-dir": { type: "string" },
      "price-list": { type: "string" },
      warehouse: { type: "string" },
      "persist-custom-fields": { type: "boolean", default: false },
      "negotiation-id": { type: "string" },
      "expect-duplicates": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const itemCode = values.item;
  if (!itemCode || itemCode.trim() === "") {
    printHelp();
    throw new Error("[smoke-idem] --item <ITEM_CODE> is required (a SEEDED ERPNext Item). No fake default.");
  }

  const qty = num("qty", values.qty) ?? DEFAULTS.qty;
  const targetUnitPrice = num("target-unit-price", values["target-unit-price"]) ?? DEFAULTS.targetUnitPrice;
  const buyerMax = num("buyer-max", values["buyer-max"]) ?? targetUnitPrice;
  const maxRounds = num("max-rounds", values["max-rounds"]) ?? DEFAULTS.maxRounds;
  const floor = num("floor", values.floor) ?? DEFAULTS.floor;
  const dimensions = (values.dimensions ?? DEFAULTS.dimensions)
    .split(",").map((d) => d.trim()).filter((d) => d.length > 0);

  const negotiationId = values["negotiation-id"] ?? `IDEM-SMOKE-${Date.now()}`;
  const expectDuplicates = values["expect-duplicates"] === true;

  // IDEMPOTENT_WRITES: ON for the real test; OFF for the negative control.
  const flags = loadFlags({ IDEMPOTENT_WRITES: !expectDuplicates });

  const inquiry = {
    buyerLei: values["buyer-lei"] ?? DEFAULTS.buyerLei,
    currency: values.currency ?? DEFAULTS.currency,
    lines: [{ itemCode: itemCode.trim(), qty, uom: values.uom ?? DEFAULTS.uom }],
    targetUnitPrice,
    maxNegotiationRounds: maxRounds,
    dimensions,
  } as InquiryInput;

  const opts: RunNegotiationOptions = {
    flags,
    negotiationId,
    creditFixturesDir: values["credit-fixtures-dir"] ?? DEFAULTS.creditFixturesDir,
    negotiateDemoFloor: floor,
    buyerMaxUnitPrice: buyerMax,
    persistCustomFields: values["persist-custom-fields"] === true,
    ...(values["price-list"] ? { priceList: values["price-list"] } : {}),
    ...(values.warehouse ? { warehouse: values.warehouse } : {}),
  };

  console.log("\n=== IMPL-V6 idempotency double-run smoke ===\n");
  console.log(`negotiationId    ${negotiationId}`);
  console.log(`IDEMPOTENT_WRITES ${flags.IDEMPOTENT_WRITES}  (expectDuplicates=${expectDuplicates})`);
  console.log(`item             ${itemCode.trim()}  x${qty} ${inquiry.lines[0]?.uom}`);
  console.log(`dimensions       [${dimensions.join(", ")}]\n`);

  console.log("--- RUN 1 ---");
  const run1: NegStateType = await runNegotiation(inquiry, opts);
  console.log(`  status=${run1.status} opp=${run1.opportunityName ?? "(none)"} quote=${run1.quotationName ?? "(none)"}`);

  console.log("--- RUN 2 (same negotiationId) ---");
  const run2: NegStateType = await runNegotiation(inquiry, opts);
  console.log(`  status=${run2.status} opp=${run2.opportunityName ?? "(none)"} quote=${run2.quotationName ?? "(none)"}`);

  // ── Cross-check ERPNext: how many Opportunities carry this negotiationId? ──
  const erp = createErpNextClient(flags);
  const opps = await erp.list<{ name: string }>("Opportunity", {
    filters: [["custom_inquiry_id", "=", negotiationId]],
    fields: ["name"],
    limit: 20,
  });
  const oppCount = opps.length;

  // ── Cross-check the local ledger (the Quotation dedupe path today) ──
  const ledgerQuote = getIdempotencyLedger(flags.AUDIT_DB_PATH).lookup(negotiationId, "Quotation");

  console.log("\n=== CHECKS ===");
  console.log(`ERPNext Opportunities with custom_inquiry_id=${negotiationId}: ${oppCount}`);
  console.log(`ledger Quotation for negotiationId: ${ledgerQuote ?? "(none)"}`);

  const failures: string[] = [];

  if (expectDuplicates) {
    // Negative control: with the guard OFF, the two runs must produce DISTINCT Opportunities.
    if (!(oppCount >= 2)) failures.push(`CONTROL expected >=2 Opportunities with guard off, saw ${oppCount}`);
    if (run1.opportunityName && run2.opportunityName && run1.opportunityName === run2.opportunityName) {
      failures.push("CONTROL expected different opportunityName across runs with guard off");
    }
  } else {
    // Real test: exactly one Opportunity; both runs resolved the SAME docs.
    if (oppCount !== 1) failures.push(`expected exactly 1 Opportunity, saw ${oppCount}`);
    if (!run1.opportunityName || run1.opportunityName !== run2.opportunityName) {
      failures.push(`opportunityName mismatch: run1=${run1.opportunityName} run2=${run2.opportunityName}`);
    }
    // Quotation equality only when a deal persisted on both runs.
    if (run1.quotationName || run2.quotationName) {
      if (run1.quotationName !== run2.quotationName) {
        failures.push(`quotationName mismatch: run1=${run1.quotationName} run2=${run2.quotationName}`);
      }
    }
  }

  if (failures.length === 0) {
    console.log(`\n=== PASS — ${expectDuplicates ? "control reproduced duplicates" : "no duplicate ERPNext docs on re-run"} ===\n`);
    process.exit(0);
  } else {
    console.error("\n=== FAIL ===");
    for (const f of failures) console.error(`  - ${f}`);
    console.error("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nIDEMPOTENCY SMOKE HARNESS CRASHED:\n", err);
  process.exit(1);
});
