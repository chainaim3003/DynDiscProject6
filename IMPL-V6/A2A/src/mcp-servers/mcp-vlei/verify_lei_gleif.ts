// ================= MCP TOOL — verify_lei_gleif =================
//
// Plain GLEIF v1 active-status check for a single LEI. One of the tools
// registered on the MCP-over-SSE server (see mcp/tools/index.ts).
//
// DESIGN GROUNDING (read, not assumed):
//   - 04-Orchestration-Design.md §9.4: "verify_lei_gleif MCP tool runs PLAIN
//     GLEIF active-status check."
//   - provider-types.ts: returns the existing ConsultationRecord<T> envelope so
//     provenance (subAgent, dataMode, dataSource, latencyMs) is carried verbatim
//     into the audit's consultations[] block. GLEIF is the *credit* sub-agent's
//     tool (04 §2: "No 'Identity' agent. GLEIF lookup is a tool ... wrapped
//     under DD"), so metadata.subAgent = "credit".
//   - gleif-client.ts (vendored this iteration): real GLEIF v1 lookup, no mocks.
//
// FLAG-AWARENESS (userPreferences Rule 8):
//   - CREDENTIAL_MODE is fixed to "plain" (the vLEI/KERI/Host-B layer was removed
//     in the IMPL-V6 no-vLEI restructure), so this tool always runs the live
//     GLEIF active-status check. The `flags` param is retained for a uniform MCP
//     handler signature across tools.
//   - `forceFresh` (default false) bypasses the GLEIF in-memory cache.
//
// DELIBERATE DEVIATION from the original proposal signature (was
//   Pick<OrchestratorFlags,"CREDENTIAL_MODE"|"CREDIT_MODE">):
//   CREDIT_MODE governs the *credit sub-agent's* full GLEIF+EDGAR composite
//   (real vs demo fixtures). This standalone verify tool always performs a LIVE
//   GLEIF lookup — that is its whole purpose — so metadata.dataMode is "real".
//   If you want CREDIT_MODE=demo to short-circuit this tool to a fixture, say so
//   and I'll add a demo branch (needs a GLEIF fixture defined first — none today,
//   and I will not ship a placeholder).
//
// AUDIT ROW: this tool returns the ConsultationRecord only. Writing the audit
// row + routerLatencyMs is the server-sse boundary's job (orchestrator/memory
// API), keeping the tool a pure consultation. See server-sse.ts.

import { z } from "zod";
import type { OrchestratorFlags } from "../../config/flags.js";
import type { ConsultationRecord } from "../../shared/provider-types.js";
import type { ProviderMode } from "../../shared/negotiation-mode.js";
import type { GleifStatus } from "../../shared/compliance/gleif-types.js";
import { checkCompliance } from "../../shared/compliance/gleif-client.js";

// ── Input schema (validated at the MCP boundary) ────────────────────────────

/**
 * LEI is normalized (trim + uppercase) then validated against ISO 17442 shape.
 * The GLEIF client re-validates (incl. MOD 97-10 checksum) — this is the cheap
 * first gate so malformed input never reaches the network.
 */
export const VerifyLeiGleifInputSchema = z.object({
  lei: z
    .string()
    .trim()
    .toUpperCase()
    .length(20, "LEI must be exactly 20 characters (ISO 17442)")
    .regex(/^[A-Z0-9]{18}[0-9]{2}$/, "LEI must be 18 alphanumerics + 2 check digits"),
  /** Bypass the GLEIF in-memory cache and force a fresh live lookup. */
  forceFresh: z.boolean().optional().default(false),
});

/** Parsed/normalized input (forceFresh resolved to a concrete boolean). */
export type VerifyLeiGleifInput = z.infer<typeof VerifyLeiGleifInputSchema>;

// ── Result payload ──────────────────────────────────────────────────────────

/**
 * GLEIF-only verification payload. Narrower than CreditConsultation (no pd1y /
 * lgd / recommendedTerms — those need EDGAR + Treasury and are out of scope
 * here). Raw GLEIF values are carried verbatim for honesty; `isActive` is the
 * derived signal the human summary turns into "ACTIVE".
 */
export interface GleifVerification {
  lei: string;
  legalEntityName: string;
  /** Raw GLEIF registration status (ISSUED/LAPSED/RETIRED/...). Verbatim. */
  registrationStatus: GleifStatus;
  /** Raw GLEIF top-level entity status (ACTIVE/INACTIVE/NULL/UNKNOWN). Verbatim. */
  entityStatus: string;
  /** Derived: registration ISSUED && entity ACTIVE. The "is it good to trade?" bit. */
  isActive: boolean;
  /** ISO 3166-1 alpha-2 (omitted if GLEIF returned none). */
  country?: string;
  /** Whether the record came from a live call or the in-memory cache. */
  gleifSource: "GLEIF_API_LIVE" | "GLEIF_CACHE";
  /** sha256 of GLEIF's raw response — audit reproducibility. */
  rawResponseHash?: string;
  /** Honest list of checks the client actually ran. */
  checksPerformed: string[];
  /** Soft flags (e.g. lapsed registration, sanctioned country). */
  warnings: string[];
}

const SUB_AGENT = "credit" as const; // GLEIF is the credit sub-agent's data source

// ── Tool implementation ──────────────────────────────────────────────────────

/**
 * Perform a plain GLEIF v1 active-status verification for `input.lei`.
 *
 * Returns a ConsultationRecord:
 *   - success === true  → GLEIF returned a record (active OR not — see result.isActive).
 *   - success === false → defensive branch: invalid format, LEI not found, or
 *                         network/timeout.
 * Provenance (metadata) is always populated, including on the failure path
 * (INV-3: audit-always-available).
 *
 * `flags` is currently unused (CREDENTIAL_MODE is fixed to "plain" after the
 * no-vLEI restructure) but kept for the uniform MCP handler signature.
 */
export async function verifyLeiGleif(
  input: VerifyLeiGleifInput,
  flags: Pick<OrchestratorFlags, "CREDENTIAL_MODE">,
): Promise<ConsultationRecord<GleifVerification>> {
  void flags; // retained for handler-signature uniformity; no longer gates behavior
  const performedAt = new Date().toISOString();
  const startedAt = Date.now();
  const dataMode: ProviderMode = "real"; // live external GLEIF call

  // ── Live GLEIF v1 active-status check ─────────────────────────────────────
  const compliance = await checkCompliance(input.lei, { forceFresh: input.forceFresh });
  const latencyMs = Date.now() - startedAt;

  // No record ⇒ defensive branch (invalid format / not found / network error).
  if (!compliance.record) {
    return {
      metadata: {
        subAgent: SUB_AGENT,
        dataMode,
        performedAt,
        dataSource: `GLEIF v1 /lei-records/${input.lei} @ api.gleif.org`,
        latencyMs,
      },
      success: false,
      error: compliance.errors.join("; ") || "GLEIF lookup returned no record",
    };
  }

  const rec = compliance.record;
  const isActive = rec.registrationStatus === "ISSUED" && rec.entityStatus === "ACTIVE";

  const result: GleifVerification = {
    lei: rec.lei,
    legalEntityName: rec.legalEntityName,
    registrationStatus: rec.registrationStatus,
    entityStatus: rec.entityStatus,
    isActive,
    country: rec.country || undefined,
    gleifSource: rec.source,
    rawResponseHash: rec.rawResponseHash,
    checksPerformed: compliance.checksPerformed,
    warnings: compliance.warnings,
  };

  return {
    metadata: {
      subAgent: SUB_AGENT,
      dataMode,
      performedAt,
      dataSource: `GLEIF v1 /lei-records/${rec.lei} @ api.gleif.org (${rec.source})`,
      latencyMs,
    },
    success: true,
    result,
  };
}

// ── Human-readable summary (what OpenClaw shows) ─────────────────────────────

/**
 * One-line summary for the MCP text result. This is where the exit-criterion
 * word "ACTIVE" comes from (derived from isActive — the raw status stays
 * ISSUED in the structured payload).
 */
export function formatVerificationSummary(rec: ConsultationRecord<GleifVerification>): string {
  if (!rec.success || !rec.result) {
    return `GLEIF verification failed: ${rec.error ?? "unknown error"}`;
  }
  const v = rec.result;
  const status = v.isActive
    ? "ACTIVE"
    : `NOT ACTIVE (registration=${v.registrationStatus}, entity=${v.entityStatus})`;
  const src = v.gleifSource === "GLEIF_CACHE" ? "cached" : "live";
  const warn = v.warnings.length ? ` — warnings: ${v.warnings.join("; ")}` : "";
  return `${v.legalEntityName || v.lei} (LEI ${v.lei}): ${status} [${src} GLEIF, ${rec.metadata.latencyMs ?? "?"}ms]${warn}`;
}
