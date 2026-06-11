// ================= IMPL-V6 — MCP TOOL: run_negotiation (gap G1) =================
//
// Exposes the FULL LangGraph negotiation saga over MCP-over-SSE so OpenClaw can
// drive the end-to-end multi-agent flow — the project intent in
// DESIGN_6/REFINED-MultiAgent-Design-vLEI.md (§2/§3) and conformance gap G1
// (DESIGN-VS-IMPL-CONFORMANCE.md). Until now the saga ran ONLY via the in-process
// runNegotiation() library call; the MCP surface exposed just the three
// deterministic tools (verify_lei_gleif, quote_unit_price, quote_with_quantity).
// This descriptor wraps runNegotiation() as a tool handler — exactly the seam the
// server-sse.ts header reserved ("invoke it from inside a tool handler here").
//
// SIDE-EFFECTS (read from orchestrator/nodes/{intake,persist}.ts, NOT assumed):
//   This tool performs REAL, MUTATING work on every call: it INSERTs an ERPNext
//   Opportunity (intake.mirrorToERPNext) and, on a deal, an ERPNext Quotation
//   (persist.signAndPersist), and makes LIVE GLEIF calls during due-diligence.
//   There is NO idempotency layer yet (conformance gap G3) — re-invoking with the
//   same inquiry CREATES DUPLICATE ERPNext docs. Treat as create-only until G3.
//
// GROUNDING (all files read this session before writing):
//   - runNegotiation signature/options : orchestrator/run.ts
//   - inquiry input schema (REUSED)    : orchestrator/nodes/intake.ts (InquiryInputSchema)
//   - final-state channels             : orchestrator/state/neg-state.ts (NegStateType/NegStatus)
//   - descriptor + audit contract      : mcp/tools/index.ts, mcp/server-sse.ts, mcp/tool-audit.ts

import { z } from "zod";

import type { OrchestratorFlags } from "../../config/flags.js";
import { runNegotiation } from "../../orchestrator/run.js";
import { InquiryInputSchema } from "../../orchestrator/nodes/intake.js";
import type { NegStateType, NegStatus } from "../../orchestrator/state/neg-state.js";

// ─── Input schema ─────────────────────────────────────────────────────────────
//
// Reuses InquiryInputSchema verbatim (single source of truth for the inbound
// inquiry — NO re-declared fields, so it cannot drift from intake.ts). The
// remaining knobs are exactly RunNegotiationOptions (orchestrator/run.ts),
// surfaced as explicit, named, flag-style arguments with sensible defaults
// (userPreferences Rule 8: behavior configurable via flags, visible in the signature).

export const RunNegotiationInputSchema = z.object({
  /** The inbound buyer inquiry (the same shape seeded elsewhere via intake). */
  inquiry: InquiryInputSchema,

  // ── run knobs (mirror RunNegotiationOptions; all optional) ──────────────────
  /** Saga thread id override; else the inquiry's, else a generated NEG-<ts>. */
  negotiationId: z.string().trim().min(1).optional(),
  /** Seller LEI override; else the Jupiter invariant (DEFAULT_SELLER_LEI in run.ts). */
  sellerLEI: z.string().trim().min(1).optional(),
  /** Selling Price List the quoting nodes read (else run.ts default "Standard Selling"). */
  priceList: z.string().trim().min(1).optional(),
  /** ERPNext Warehouse doc NAME for Bin/ATP lookups (else flags default). */
  warehouse: z.string().trim().min(1).optional(),
  /** Directory of <lei>.json credit fixtures → enables the demo CreditProvider for DD. */
  creditFixturesDir: z.string().trim().min(1).optional(),
  /** Configured treasury floor (price/unit) the negotiate veto enforces (demo mode). */
  negotiateDemoFloor: z.number().positive().optional(),
  /** Buyer reservation (max price/unit) override; else the inquiry's stated target. */
  buyerMaxUnitPrice: z.number().positive().optional(),
  /** Emit ERPNext custom identity fields on persist (only once the quotation fixture exists). */
  persistCustomFields: z.boolean().default(false),
  /** Include the full raw NegState in the result (verbose; default false). */
  includeFullState: z.boolean().default(false),
});

export type RunNegotiationInput = z.infer<typeof RunNegotiationInputSchema>;

// ─── Result envelope ──────────────────────────────────────────────────────────
//
// Top-level `success`/`metadata`/`error` so the server-sse audit bridge
// (registerOneTool → mcp/tool-audit.ts) records a meaningful row, matching the
// ConsultationRecord / QuoteToolResult convention the other tools use.
//
// `success` = "the saga reached a terminal state without throwing" (a TOOL-level
// outcome). The BUSINESS outcome is carried separately by `dealReached` + `status`:
// NO_DEAL / ESCALATED are valid business results, NOT tool failures. A genuine
// failure (e.g. ERPNext insert throws) propagates out of runNegotiation and is
// caught + audited (ok:false, isError) by server-sse — this handler does not mask it.

export interface RunNegotiationResult {
  success: boolean;
  negotiationId: string;
  /** Saga phase / terminal status (orchestrator/state/neg-state.ts NegStatus). */
  status: NegStatus;
  /** True only for ACCEPTED / PERSISTED; false for NO_DEAL / ESCALATED / non-terminal. */
  dealReached: boolean;
  outcome: {
    /** ERPNext Opportunity doc name created at intake (null if not reached). */
    opportunityName: string | null;
    /** ERPNext Quotation doc name created on persist (null if no deal/persist). */
    quotationName: string | null;
    /** Negotiation rounds executed (0 when the negotiate dimension was inactive). */
    negotiationRounds: number;
  };
  counts: {
    consultations: number;
    rounds: number;
    attestations: number;
    defensive: number;
  };
  /** Per-agent signed-decision journal (small, high-value for the audit/judge). */
  attestations: NegStateType["attestations"];
  /** Due-diligence result (GLEIF + credit); null if the DD dimension was inactive. */
  ddResult: NegStateType["ddResult"];
  /** The drafted / last quote; null if quoting was not reached. */
  quote: NegStateType["quoteDraft"];
  /** Per-round negotiation outcomes (append-only journal). */
  rounds: NegStateType["rounds"];
  /** Provenance echoed into the tool-call audit row (non-sensitive). */
  metadata: { subAgent: string; dataSource: string };
  /** Populated only when success === false. */
  error?: string;
  /** Full raw saga state — only when includeFullState=true (verbose). */
  fullState?: NegStateType;
}

/** Terminal statuses that mean a binding quote/deal was reached (neg-state.ts NegStatus). */
const DEAL_STATUSES: ReadonlyArray<NegStatus> = ["ACCEPTED", "PERSISTED"];

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Drive one negotiation saga end-to-end and project the final NegState into a
 * compact, host-friendly envelope. Flags are passed straight through to
 * runNegotiation (server-sse resolves them once at startup — no second loadFlags()).
 */
export async function runNegotiationToolHandler(
  input: RunNegotiationInput,
  flags: OrchestratorFlags,
): Promise<RunNegotiationResult> {
  const final = await runNegotiation(input.inquiry, {
    flags,
    negotiationId: input.negotiationId,
    sellerLEI: input.sellerLEI,
    priceList: input.priceList,
    warehouse: input.warehouse,
    creditFixturesDir: input.creditFixturesDir,
    negotiateDemoFloor: input.negotiateDemoFloor,
    buyerMaxUnitPrice: input.buyerMaxUnitPrice,
    persistCustomFields: input.persistCustomFields,
  });

  const dealReached = DEAL_STATUSES.includes(final.status);

  const result: RunNegotiationResult = {
    // Reaching this line means runNegotiation returned (did not throw) → the
    // tool ran to a terminal saga state. Business outcome is in dealReached/status.
    success: true,
    negotiationId: final.negotiationId,
    status: final.status,
    dealReached,
    outcome: {
      opportunityName: final.opportunityName ?? null,
      quotationName: final.quotationName ?? null,
      negotiationRounds: final.negotiationRounds ?? 0,
    },
    counts: {
      consultations: final.consultations?.length ?? 0,
      rounds: final.rounds?.length ?? 0,
      attestations: final.attestations?.length ?? 0,
      defensive: final.defensive?.length ?? 0,
    },
    attestations: final.attestations ?? [],
    ddResult: final.ddResult ?? null,
    quote: final.quoteDraft ?? null,
    rounds: final.rounds ?? [],
    metadata: { subAgent: "jupiterSellerAgent", dataSource: "langgraph-saga" },
  };

  if (input.includeFullState) result.fullState = final;
  return result;
}

// ─── One-line human summary (server renders this as content[0]) ─────────────────

export function formatRunNegotiationSummary(out: RunNegotiationResult): string {
  const opp = out.outcome.opportunityName ?? "—";
  const qtn = out.outcome.quotationName ?? "—";
  return (
    `run_negotiation: ${out.negotiationId} → status=${out.status} ` +
    `deal=${out.dealReached ? "yes" : "no"} opp=${opp} quote=${qtn} ` +
    `rounds=${out.outcome.negotiationRounds} ` +
    `(consult=${out.counts.consultations}, attest=${out.counts.attestations}, ` +
    `defensive=${out.counts.defensive})`
  );
}
