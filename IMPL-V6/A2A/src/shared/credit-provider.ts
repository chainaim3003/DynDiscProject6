// ================= IMPL-V6 — DEMO CREDIT PROVIDER (fixture-backed) =================
//
// Option A: a fixture-backed CreditProvider (provider-types.ts) for CREDIT_MODE=demo.
// Mirrors the inventory-provider pattern: same interface as a future real GLEIF/EDGAR/
// Companies-House provider, distinguished only by metadata (dataMode:"demo", source ref).
//
// Reads DEMO-DATA/credit/<lei>.json. NO fabrication (Rule 2):
//   - Missing/invalid/non-JSON fixture → success:false with a diagnostic (the dd-credit
//     agent then takes its conservative defensive branch). No numbers invented here.
//   - A fixture marked "_placeholder": true is REFUSED by default (success:false) so
//     placeholder data can never silently flow as a real credit assessment. Set
//     allowPlaceholderFixtures:true ONLY for plumbing/wiring tests.
//
// Replace the placeholder fixtures with real reference data (GLEIF status + EDGAR-derived
// pd1y/lgd) to make the demo meaningful.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CreditProvider,
  CreditConsultationInput,
  CreditConsultation,
  ConsultationRecord,
  ConsultationMetadata,
  GleifStatus,
  RecommendedTerms,
} from "./provider-types.js";

export interface DemoCreditProviderOptions {
  /** Directory holding <lei>.json credit fixtures (e.g. IMPL-V6/DEMO-DATA/credit). */
  fixturesDir: string;
  /** Serve fixtures explicitly marked "_placeholder": true. Default false (refuse). */
  allowPlaceholderFixtures?: boolean;
}

const VALID_GLEIF: readonly GleifStatus[] = [
  "ACTIVE", "LAPSED", "RETIRED", "MERGED", "PENDING", "DUPLICATE",
];
const VALID_TERMS: readonly RecommendedTerms[] = [
  "PRE_PAID", "COD", "NET_15", "NET_30", "NET_45", "NET_60", "NET_90",
];

export function createDemoCreditProvider(opts: DemoCreditProviderOptions): CreditProvider {
  const allowPlaceholder = opts.allowPlaceholderFixtures ?? false;

  return {
    subAgent: "credit",
    mode: "demo",

    async consult(
      input: CreditConsultationInput,
    ): Promise<ConsultationRecord<CreditConsultation>> {
      const t0 = Date.now();
      const file = path.join(opts.fixturesDir, `${input.lei}.json`);
      const baseMeta: ConsultationMetadata = {
        subAgent: "credit",
        dataMode: "demo",
        performedAt: new Date().toISOString(),
        dataSource: `demo fixture ${file}`,
        demoSourceKind: "fixture",
        demoSourceRef: file,
      };
      const fail = (error: string): ConsultationRecord<CreditConsultation> => ({
        metadata: { ...baseMeta, latencyMs: Date.now() - t0 },
        success: false,
        error,
      });

      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (e) {
        return fail(`credit fixture not found for LEI ${input.lei} at ${file}: ${String(e)}`);
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        return fail(`credit fixture for ${input.lei} is not valid JSON: ${String(e)}`);
      }

      if (parsed._placeholder === true && !allowPlaceholder) {
        return fail(
          `credit fixture for ${input.lei} is a PLACEHOLDER (_placeholder:true). Replace it with ` +
          `real reference data, or construct createDemoCreditProvider({ allowPlaceholderFixtures:true }) ` +
          `for plumbing tests only.`,
        );
      }

      const errors: string[] = [];
      const gleifStatus = parsed.gleifStatus as GleifStatus;
      if (!VALID_GLEIF.includes(gleifStatus)) errors.push(`gleifStatus '${String(parsed.gleifStatus)}'`);
      const recommendedTerms = parsed.recommendedTerms as RecommendedTerms;
      if (!VALID_TERMS.includes(recommendedTerms)) errors.push(`recommendedTerms '${String(parsed.recommendedTerms)}'`);
      if (typeof parsed.legalEntityName !== "string") errors.push("legalEntityName (string)");
      for (const k of ["financialHealthScore", "pd1y", "lgd"] as const) {
        if (typeof parsed[k] !== "number") errors.push(`${k} (number)`);
      }
      if (errors.length > 0) {
        return fail(`credit fixture for ${input.lei} invalid/missing fields: ${errors.join(", ")}`);
      }

      const result: CreditConsultation = {
        lei: input.lei,
        legalEntityName: parsed.legalEntityName as string,
        gleifStatus,
        financialHealthScore: parsed.financialHealthScore as number,
        pd1y: parsed.pd1y as number,
        lgd: parsed.lgd as number,
        recommendedTerms,
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "demo fixture",
      };
      return { metadata: { ...baseMeta, latencyMs: Date.now() - t0 }, success: true, result };
    },
  };
}
