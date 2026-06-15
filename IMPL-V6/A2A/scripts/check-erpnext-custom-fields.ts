// ================= IMPL-V6 — ERPNext CUSTOM-FIELD INSTALL VERIFIER (read-only) =================
//
// Purpose: answer the ONE fact the filesystem cannot — are the erpnextEnh1
// `chainaim_proc` custom fields actually INSTALLED + MIGRATED on the LIVE
// frappe_docker site (ERPNEXT_URL), or do they only exist as fixtures on disk?
//
// This gates the Quotation custom-field integration: if a field is not live,
// Frappe silently DROPS it on insert (unknown fields are ignored), so flipping
// persistCustomFields on would persist nothing. Run this FIRST.
//
// WHY THIS SCRIPT EXISTS (Rule 2/3): a fixture JSON on disk is NOT proof of a
// live DB column. The only source of truth is the running site. This reads it.
//
// SAFETY: READ-ONLY. Issues GET /api/resource/Custom Field (+ a whoami auth
// gate) only. It never inserts, updates, deletes, or migrates anything.
//
// AI vs MANUAL (Rule 9): AI-written; RUNNING it is MANUAL (needs your machine's
// seeded ERPNext reachable at ERPNEXT_URL with ERPNEXT_API_KEY/SECRET in .env).
//
//   npx tsx scripts/check-erpnext-custom-fields.ts
//   npx tsx scripts/check-erpnext-custom-fields.ts --json
//   npx tsx scripts/check-erpnext-custom-fields.ts --url http://localhost:8080 \
//       --doctypes "Quotation,Quotation Item" --fixtures-dir ../../erpnextEnh1/apps/chainaim_proc/chainaim_proc/custom
//   npx tsx scripts/check-erpnext-custom-fields.ts --help
//
// GROUNDING (read, not assumed):
//   - Client + auth gate:  src/erpnext/client.ts  (createErpNextClient, whoami, list)
//   - Flag surface:        src/config/flags.ts     (ERPNEXT_URL/API_KEY/API_SECRET, loadFlags)
//   - dotenv convention:   src/mcp/server-sse.ts    (import "dotenv/config" before loadFlags)
//   - Fixture shape:       erpnextEnh1/.../custom/{opportunity,opportunity_item,
//                          quotation,quotation_item}.json  ({ custom_fields: [{ fieldname, ... }] })

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
// Load .env BEFORE loadFlags() reads process.env (flags.ts contract; same as
// src/mcp/server-sse.ts). dotenv/config applies at import time and reads .env
// from process.cwd() — run this script from the IMPL-V6 root.
import "dotenv/config";

import { loadFlags } from "../src/config/flags.js";
import { createErpNextClient, ErpNextError } from "../src/erpnext/client.js";

// ─── Defaults (all overridable via flags; nothing hardcoded into internals) ───
const DEFAULTS = {
  // The four DocTypes the agent saga writes custom fields onto (intake + persist).
  doctypes: "Opportunity,Opportunity Item,Quotation,Quotation Item",
  // erpnextEnh1 custom fixtures, relative to IMPL-V6/ (the cwd you run tsx from).
  fixturesDir: "../../erpnextEnh1/apps/chainaim_proc/chainaim_proc/custom",
} as const;

function printHelp(): void {
  console.log(`
IMPL-V6 — ERPNext custom-field install verifier (READ-ONLY)

Reports, per DocType, which erpnextEnh1 custom fields are LIVE on the site at
ERPNEXT_URL vs only present as fixtures on disk. Issues GETs only.

USAGE
  npx tsx scripts/check-erpnext-custom-fields.ts [options]

OPTIONS
  --doctypes <csv>       DocTypes to check (default "${DEFAULTS.doctypes}")
  --fixtures-dir <path>  Dir holding <doctype>.json fixtures
                         (default "${DEFAULTS.fixturesDir}", relative to cwd)
  --url <baseUrl>        Override ERPNEXT_URL for this run (default: flags/.env)
  --json                 Emit a machine-readable JSON report
  --help                 Show this help

EXIT CODE
  0  every expected custom field is live on every checked DocType
  1  at least one expected field is MISSING (not migrated) — or a connection/auth error
`);
}

/** DocType display name -> fixture filename stem (e.g. "Quotation Item" -> "quotation_item"). */
function fixtureFileFor(doctype: string): string {
  return `${doctype.trim().toLowerCase().replace(/\s+/g, "_")}.json`;
}

interface FixtureShape {
  doctype?: string;
  custom_fields?: Array<{ fieldname?: string; fieldtype?: string }>;
}

/** Read the expected custom-field names for a DocType from its on-disk fixture. */
function expectedFieldsFromFixture(fixturesDir: string, doctype: string): string[] {
  const file = join(fixturesDir, fixtureFileFor(doctype));
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `[check-cf] cannot read fixture for "${doctype}" at ${file}: ${String(err)}. ` +
        `Pass --fixtures-dir if your layout differs.`,
    );
  }
  let parsed: FixtureShape;
  try {
    parsed = JSON.parse(raw) as FixtureShape;
  } catch (err) {
    throw new Error(`[check-cf] fixture ${file} is not valid JSON: ${String(err)}`);
  }
  const names = (parsed.custom_fields ?? [])
    .map((f) => f.fieldname)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (names.length === 0) {
    throw new Error(`[check-cf] fixture ${file} declared no custom_fields[].fieldname`);
  }
  return names;
}

interface DocTypeReport {
  doctype: string;
  expected: string[];
  live: string[];
  missing: string[];
  extraLive: string[]; // live custom fields not in the fixture (informational)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      doctypes: { type: "string" },
      "fixtures-dir": { type: "string" },
      url: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const doctypes = (values.doctypes ?? DEFAULTS.doctypes)
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  const fixturesDir = resolve(process.cwd(), values["fixtures-dir"] ?? DEFAULTS.fixturesDir);

  // Resolve flags from .env (loaded above); allow a per-run base-url override.
  // createErpNextClient fails loud if creds are still unresolved.
  const flags = loadFlags();
  const erp = createErpNextClient(flags, values.url ? { baseUrl: values.url } : {});

  const baseUrl = values.url ?? flags.ERPNEXT_URL;
  console.log(`\n=== ERPNext custom-field verifier (READ-ONLY) ===`);
  console.log(`site         ${baseUrl}`);
  console.log(`fixtures-dir ${fixturesDir}`);
  console.log(`doctypes     [${doctypes.join(", ")}]\n`);

  // Auth + connectivity gate — fail loud here, not mid-loop.
  let user: string;
  try {
    user = await erp.whoami();
  } catch (err) {
    if (err instanceof ErpNextError) {
      console.error(`CONNECTION/AUTH FAILED (${err.code}): ${err.message}`);
      console.error(
        `Cannot verify against the live site. Check ERPNEXT_URL (${baseUrl}) is up and ` +
          `ERPNEXT_API_KEY/ERPNEXT_API_SECRET are set in IMPL-V6/.env.`,
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`Connected as: ${user}\n`);

  const reports: DocTypeReport[] = [];
  for (const doctype of doctypes) {
    const expected = expectedFieldsFromFixture(fixturesDir, doctype);

    // Live custom fields are "Custom Field" docs filtered by their target DocType (dt).
    const rows = await erp.list<{ fieldname?: string }>("Custom Field", {
      filters: [["dt", "=", doctype]],
      fields: ["fieldname"],
      limit: 500,
    });
    const live = rows.map((r) => r.fieldname).filter((n): n is string => typeof n === "string");
    const liveSet = new Set(live);
    const expectedSet = new Set(expected);

    reports.push({
      doctype,
      expected,
      live,
      missing: expected.filter((f) => !liveSet.has(f)),
      extraLive: live.filter((f) => !expectedSet.has(f)),
    });
  }

  if (values.json) {
    console.log(JSON.stringify({ site: baseUrl, user, reports }, null, 2));
  } else {
    for (const r of reports) {
      const ok = r.missing.length === 0;
      console.log(`── ${r.doctype} ${ok ? "✓ all live" : `✗ ${r.missing.length} MISSING`}`);
      console.log(`   expected ${r.expected.length}  live ${r.live.length}`);
      if (r.missing.length > 0) console.log(`   MISSING: ${r.missing.join(", ")}`);
      if (r.extraLive.length > 0) console.log(`   (extra live, not in fixture: ${r.extraLive.join(", ")})`);
      console.log("");
    }
  }

  const anyMissing = reports.some((r) => r.missing.length > 0);
  if (anyMissing) {
    console.log(
      `RESULT: NOT FULLY MIGRATED — some custom fields are absent on ${baseUrl}.\n` +
        `Until they exist, persisting custom identity fields would silently drop them.\n` +
        `Fix: install + migrate the chainaim_proc app on the frappe_docker site (see next step).`,
    );
    process.exit(1);
  }
  console.log(`RESULT: ALL EXPECTED CUSTOM FIELDS ARE LIVE on ${baseUrl}.`);
}

main().catch((err) => {
  console.error("\nCUSTOM-FIELD VERIFIER CRASHED:\n", err);
  process.exit(1);
});
