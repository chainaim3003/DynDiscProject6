// ================= IMPL-V6 — LIVE DD+N SAGA SMOKE HARNESS =================
//
// Purpose: drive the REAL negotiation saga end-to-end via runNegotiation() with a
// due-diligence + negotiation ("DD"/"N") inquiry, against a LIVE seeded ERPNext
// (localhost:8080) and LIVE GLEIF (api.gleif.org). This is Next-Step-1 of the
// IMPL-V6 handoff. Unlike scripts/smoke-saga.ts (which is in-memory ORCHESTRATION
// PLUMBING only — throwaway 2-node graph, no ERPNext, no DD/N), this exercises the
// full graph: intake -> DD(GLEIF+credit->term) -> quoting/ATP -> negotiate(binding
// treasury veto) -> persist+sign.
//
// AI vs MANUAL (Rule 9): this harness is AI-written and unit-shaped, but RUNNING it
// is MANUAL — it requires your machine's seeded ERPNext + outbound GLEIF. Drive it:
//
//   npx tsx scripts/smoke-ddn-saga.ts --item <SEEDED_ITEM_CODE> [flags...]
//   npx tsx scripts/smoke-ddn-saga.ts --help
//
// GROUNDING (read, not assumed):
//   - Entry:        src/orchestrator/run.ts            (runNegotiation + RunNegotiationOptions)
//   - Inquiry:      src/orchestrator/nodes/intake.ts   (InquiryInputSchema; DD/ERP are NEVER
//                                                        inferred — must be passed explicitly)
//   - State:        src/orchestrator/state/neg-state.ts(channels printed below: ddResult,
//                                                        quoteDraft, rounds, attestations, ...)
//
// NOTE ON DD DATA: with only the PLACEHOLDER credit fixture present, the demo
// CreditProvider refuses it by default, so DD takes the conservative defensive
// (Net-0) branch. That still proves the DD wiring end-to-end. Point --credit-fixtures-dir
// at REAL reference data to get a non-defensive recommended term (handoff Next-Step-2).

import "dotenv/config";
import { parseArgs } from "node:util";

import { runNegotiation, type RunNegotiationOptions } from "../src/orchestrator/run.js";
import type { InquiryInput } from "../src/orchestrator/nodes/intake.js";
import type { NegStateType } from "../src/orchestrator/state/neg-state.js";

// ─── Defaults (all overridable via flags; nothing hardcoded into internals) ───
const DEFAULTS = {
  buyerLei: "54930012QJWZMYHNJW95", // Tommy Hilfiger Europe B.V. (01 §1 invariant)
  currency: "INR",
  qty: 2000,
  uom: "Nos",
  dimensions: "U,Q,DD,N", // DD must be explicit; N also added by maxRounds>0
  maxRounds: 3,
  targetUnitPrice: 300,
  floor: 250, // treasury demo floor the negotiate veto enforces
  creditFixturesDir: "DEMO-DATA/credit",
} as const;

function printHelp(): void {
  console.log(`
IMPL-V6 — live DD+N saga smoke harness

USAGE
  npx tsx scripts/smoke-ddn-saga.ts --item <ITEM_CODE> [options]

REQUIRED
  --item <code>              ERPNext Item Code that is ALREADY SEEDED on your instance
                             (must have an Item Price on the selling price list).

INQUIRY SHAPE
  --buyer-lei <lei>          Buyer LEI            (default ${DEFAULTS.buyerLei})
  --seller-lei <lei>         Seller LEI override  (default: Jupiter invariant in run.ts)
  --qty <n>                  Line quantity        (default ${DEFAULTS.qty})
  --uom <unit>               Unit of measure      (default ${DEFAULTS.uom})
  --size <s>                 Optional size (adds "Z" dimension when derived)
  --currency <ccy>           Currency             (default ${DEFAULTS.currency})
  --destination <text>       Optional ship destination
  --required-date <ISO>      Optional required delivery date
  --payment-term <term>      Net-0 | Net-30 | Net-60 (optional; buyer's requested term)
  --dimensions <csv>         Ladder dimensions    (default "${DEFAULTS.dimensions}")
                             DD and ERP are NEVER inferred — include DD here to run due-diligence.

NEGOTIATION
  --target-unit-price <n>    Buyer's target price/unit (default ${DEFAULTS.targetUnitPrice})
  --buyer-max <n>            Buyer reservation override (default: = target-unit-price)
  --max-rounds <n>           maxNegotiationRounds      (default ${DEFAULTS.maxRounds}; >0 adds "N")
  --floor <n>                Treasury demo floor the veto enforces (default ${DEFAULTS.floor})

PROVIDERS / PERSIST
  --credit-fixtures-dir <d>  Dir of <lei>.json credit fixtures (default "${DEFAULTS.creditFixturesDir}")
  --price-list <name>        Selling Price List the quoting nodes read
  --warehouse <name>         ERPNext Warehouse doc name for Bin lookups
  --persist-custom-fields    Emit ERPNext custom identity fields on persist (only once the
                             erpnextEnh1 Quotation custom-field fixture exists; default off)

MISC
  --negotiation-id <id>      Fixed saga/thread id (default: generated NEG-<ts>)
  --json                     Dump the full final NegState as JSON at the end
  --help                     Show this help
`);
}

/** Parse a flag value into a positive number or throw loud (no silent NaN). */
function num(label: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`[smoke-ddn] --${label} must be a number, got "${raw}"`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      item: { type: "string" },
      "buyer-lei": { type: "string" },
      "seller-lei": { type: "string" },
      qty: { type: "string" },
      uom: { type: "string" },
      size: { type: "string" },
      currency: { type: "string" },
      destination: { type: "string" },
      "required-date": { type: "string" },
      "payment-term": { type: "string" },
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
      json: { type: "boolean", default: false },
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
    throw new Error(
      "[smoke-ddn] --item <ITEM_CODE> is required and must match a SEEDED ERPNext Item " +
        "(with an Item Price on the selling price list). No fake default is used.",
    );
  }

  const qty = num("qty", values.qty) ?? DEFAULTS.qty;
  const targetUnitPrice = num("target-unit-price", values["target-unit-price"]) ?? DEFAULTS.targetUnitPrice;
  const buyerMax = num("buyer-max", values["buyer-max"]) ?? targetUnitPrice;
  const maxRounds = num("max-rounds", values["max-rounds"]) ?? DEFAULTS.maxRounds;
  const floor = num("floor", values.floor) ?? DEFAULTS.floor;

  const dimensions = (values.dimensions ?? DEFAULTS.dimensions)
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  if (!dimensions.includes("DD")) {
    console.warn(
      '[smoke-ddn] WARNING: "DD" not in --dimensions; due-diligence will PASS THROUGH ' +
        "(no GLEIF/credit). Add DD to exercise it.",
    );
  }

  // Build the inbound inquiry. InquiryInputSchema (intake.ts) validates this and
  // throws loud on anything malformed — we do not pre-sanitize past obvious typing.
  const inquiry = {
    buyerLei: values["buyer-lei"] ?? DEFAULTS.buyerLei,
    currency: values.currency ?? DEFAULTS.currency,
    lines: [
      {
        itemCode: itemCode.trim(),
        qty,
        uom: values.uom ?? DEFAULTS.uom,
        ...(values.size ? { size: values.size } : {}),
      },
    ],
    ...(values.destination ? { destination: values.destination } : {}),
    ...(values["required-date"] ? { requiredDeliveryDate: values["required-date"] } : {}),
    ...(values["payment-term"] ? { paymentTermRequested: values["payment-term"] } : {}),
    targetUnitPrice,
    maxNegotiationRounds: maxRounds,
    dimensions,
  } as InquiryInput;

  const opts: RunNegotiationOptions = {
    creditFixturesDir: values["credit-fixtures-dir"] ?? DEFAULTS.creditFixturesDir,
    negotiateDemoFloor: floor,
    buyerMaxUnitPrice: buyerMax,
    persistCustomFields: values["persist-custom-fields"] === true,
    ...(values["seller-lei"] ? { sellerLEI: values["seller-lei"] } : {}),
    ...(values["price-list"] ? { priceList: values["price-list"] } : {}),
    ...(values.warehouse ? { warehouse: values.warehouse } : {}),
    ...(values["negotiation-id"] ? { negotiationId: values["negotiation-id"] } : {}),
  };

  console.log("\n=== IMPL-V6 live DD+N saga smoke ===\n");
  console.log("Inquiry:");
  console.log(`  buyerLei        ${inquiry.buyerLei}`);
  console.log(`  item            ${itemCode.trim()}  x${qty} ${inquiry.lines[0]?.uom}`);
  console.log(`  dimensions      [${dimensions.join(", ")}]`);
  console.log(`  targetUnitPrice ${targetUnitPrice}  buyerMax ${buyerMax}  maxRounds ${maxRounds}`);
  console.log("Options:");
  console.log(`  creditFixturesDir   ${opts.creditFixturesDir}`);
  console.log(`  negotiateDemoFloor  ${opts.negotiateDemoFloor}`);
  console.log(`  persistCustomFields ${opts.persistCustomFields}`);
  console.log(`  priceList           ${opts.priceList ?? "(run.ts default)"}`);
  console.log(`  warehouse           ${opts.warehouse ?? "(flags default)"}`);
  console.log("\nInvoking runNegotiation() against LIVE ERPNext + GLEIF ...\n");

  const final: NegStateType = await runNegotiation(inquiry, opts);

  // ── Grounded summary: only channels confirmed to exist in neg-state.ts ──
  console.log("=== FINAL SAGA STATE ===\n");
  console.log(`status            ${final.status}`);
  console.log(`negotiationId     ${final.negotiationId}`);
  console.log(`opportunityName   ${final.opportunityName ?? "(none)"}`);
  console.log(`quotationName     ${final.quotationName ?? "(none)"}`);
  console.log(`negotiationRounds ${final.negotiationRounds}`);

  console.log("\nGLEIF:");
  console.log(final.gleif ? JSON.stringify(final.gleif, null, 2) : "  (none — DD did not run)");

  console.log("\nDD result (ddResult):");
  console.log(final.ddResult ? JSON.stringify(final.ddResult, null, 2) : "  (none — DD did not run)");

  console.log("\nQuote draft (quoteDraft):");
  console.log(final.quoteDraft ? JSON.stringify(final.quoteDraft, null, 2) : "  (none)");

  console.log("\nNegotiation rounds (rounds[]):");
  console.log(final.rounds.length ? JSON.stringify(final.rounds, null, 2) : "  (none)");

  console.log("\nDefensive actions (defensive[]):");
  console.log(
    final.defensive.length ? JSON.stringify(final.defensive, null, 2) : "  (none — no provider fell back)",
  );

  console.log("\nSigned attestations (attestations[] — the §7 attribution trail):");
  if (final.attestations.length === 0) {
    console.log("  (none)");
  } else {
    for (const a of final.attestations) {
      console.log(
        `  - ${a.subject.padEnd(20)} by ${a.agentRef} [${a.role}] ` +
          `aid=${a.aid || "(unminted/plain)"} mode=${a.signingMode} sig=${a.signature.slice(0, 16)}...`,
      );
    }
  }

  if (values.json) {
    console.log("\n=== FULL NegState (JSON) ===");
    console.log(JSON.stringify(final, null, 2));
  }

  const ok = final.status === "PERSISTED" || final.status === "ACCEPTED";
  console.log(`\n=== ${ok ? "SAGA REACHED A TERMINAL DEAL STATE" : `ENDED IN: ${final.status}`} ===\n`);
  // NO_DEAL / ESCALATED are valid saga outcomes, not crashes — exit 0 unless it threw.
}

main().catch((err) => {
  console.error("\nDD+N SMOKE HARNESS CRASHED:\n", err);
  process.exit(1);
});
