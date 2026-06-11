// ================= IMPL-V6 — Φ1 INTAKE NODES (deterministic) =================
//
// The three deterministic Φ1 nodes of the negotiation StateGraph (04 §3.2):
//   intake.parse  ->  intake.mirrorToERPNext  ->  ackToBuyer
//
// All three are DETERMINISTIC (no LLM). The LLM free-text intake parser (Gemini
// Flash, 04 §3.3) is deferred to its prompt rung — for V6.3 the inbound arrives
// already structured (from OpenClaw / the caller), and intake.parse is genuine
// normalization + validation of that structured input, NOT a stand-in stub.
//
// The validation+normalization is factored into the exported pure function
// `normalizeInquiry`, reused by run.ts to build a complete, valid Inquiry for the
// graph seed (the channel type requires a full Inquiry). intake.parse calls the
// same function, so the canonical (checkpointed) parse step and the seed agree
// and re-running it is idempotent.
//
// DEPENDENCY INJECTION (factory closures): buildIntakeNodes({ flags, erp })
// returns the node functions closed over resolved flags + one ErpNextClient.
// Flags are resolved ONCE at startup (run.ts) and threaded — nodes never re-read
// process.env (per orchestrator/memory/checkpointer.ts guidance). Testable: pass
// a fake erp client / overridden flags.
//
// GROUNDING:
//   - State channels + NegStatus: orchestrator/state/neg-state.ts
//   - Inquiry domain shape:       shared/inquiry-types.ts
//   - Opportunity payload mapping: erpnext/mappers.ts (real native + custom fields)

import { z } from "zod";

import type { NegStateType } from "../state/neg-state.js";
import type { Inquiry, InquiryDimension, InquiryLine } from "../../shared/inquiry-types.js";
import type { OrchestratorFlags } from "../../config/flags.js";
import { ErpNextClient, ErpNextError } from "../../erpnext/client.js";
import { mapInquiryToOpportunityPayload, type MapOpportunityContext } from "../../erpnext/mappers.js";
import { idempotentInsertByField } from "../../erpnext/idempotency.js";

// ─── Node names (single source for graph wiring) ─────────────────────────────

export const INTAKE_NODE = {
  parse: "intake.parse",
  mirror: "intake.mirrorToERPNext",
  ack: "ackToBuyer",
} as const;

// ─── Inbound inquiry schema (what OpenClaw / the caller seeds) ────────────────
//
// Looser than the canonical Inquiry: a few fields are optional/defaulted and
// filled deterministically by normalizeInquiry (receivedAt, dimensions, negotiationId).

const PAYMENT_TERMS = ["Net-0", "Net-30", "Net-60"] as const;
const DIMENSIONS = ["U", "Q", "Z", "D", "L", "M", "P", "DD", "N", "ERP"] as const;

const InquiryLineInputSchema = z.object({
  itemCode: z.string().trim().min(1),
  itemName: z.string().trim().optional(),
  qty: z.number().positive(),
  uom: z.string().trim().default("Nos"),
  description: z.string().optional(),
  brand: z.string().trim().optional(),
  itemGroup: z.string().trim().optional(),
  size: z.string().trim().optional(),
  requiredDeliveryDate: z.string().trim().optional(),
  targetRate: z.number().optional(),
});

export const InquiryInputSchema = z.object({
  negotiationId: z.string().trim().min(1).optional(),
  buyerLei: z.string().trim().min(1),
  buyerAgent: z.string().trim().default("tommyBuyerAgent"),
  buyerOor: z.string().trim().optional(),
  currency: z.string().trim().default("INR"),
  lines: z.array(InquiryLineInputSchema).min(1, "inquiry must have at least one line"),
  requiredDeliveryDate: z.string().trim().optional(),
  destination: z.string().trim().optional(),
  incotermRequested: z.string().trim().optional(),
  paymentTermRequested: z.enum(PAYMENT_TERMS).optional(),
  targetUnitPrice: z.number().optional(),
  maxNegotiationRounds: z.number().int().nonnegative().optional(),
  dimensions: z.array(z.enum(DIMENSIONS)).optional(),
  rawText: z.string().optional(),
  dimensionsSnapshot: z.string().optional(),
  receivedAt: z.string().trim().optional(),
});

export type InquiryInput = z.infer<typeof InquiryInputSchema>;

// ─── Deterministic dimension derivation ───────────────────────────────────────
//
// Which ladder rungs (01 §1) this inquiry exercises, inferred from its shape.
// Used only when the caller did not supply `dimensions` explicitly. Conservative
// and deterministic: "U" always; the rest gated on a concrete signal. (DD/ERP
// are intent flags the caller states explicitly; not inferred here.)

function deriveDimensions(inq: InquiryInput): InquiryDimension[] {
  const dims = new Set<InquiryDimension>(["U"]);
  if (inq.lines.some((l) => l.qty > 1)) dims.add("Q");
  if (inq.lines.length > 1) dims.add("M");
  if (inq.lines.some((l) => l.size)) dims.add("Z");
  if (inq.requiredDeliveryDate || inq.lines.some((l) => l.requiredDeliveryDate)) dims.add("D");
  if (inq.destination) dims.add("L");
  if (inq.paymentTermRequested) dims.add("P");
  if (inq.maxNegotiationRounds && inq.maxNegotiationRounds > 0) dims.add("N");
  return [...dims];
}

// ─── Pure normalization (shared by intake.parse and run.ts seed) ─────────────

/**
 * Validate + normalize a raw inbound inquiry into the canonical Inquiry.
 * Deterministic (aside from the receivedAt default = now). Fills receivedAt /
 * dimensions / dimensionsSnapshot and resolves negotiationId. Idempotent:
 * passing an already-normalized Inquiry yields an equivalent Inquiry. Throws
 * (loud) on invalid input rather than producing a malformed inquiry.
 */
export function normalizeInquiry(raw: unknown, opts: { negotiationId?: string } = {}): Inquiry {
  const parsed = InquiryInputSchema.parse(raw);

  const negotiationId = opts.negotiationId ?? parsed.negotiationId;
  if (!negotiationId) {
    throw new Error("[normalizeInquiry] negotiationId missing on both the call and the inquiry");
  }

  const receivedAt = parsed.receivedAt ?? new Date().toISOString();
  const dimensions =
    parsed.dimensions && parsed.dimensions.length > 0 ? parsed.dimensions : deriveDimensions(parsed);

  const lines: InquiryLine[] = parsed.lines.map((l) => ({
    itemCode: l.itemCode,
    itemName: l.itemName,
    qty: l.qty,
    uom: l.uom,
    description: l.description,
    brand: l.brand,
    itemGroup: l.itemGroup,
    size: l.size,
    requiredDeliveryDate: l.requiredDeliveryDate,
    targetRate: l.targetRate,
  }));

  return {
    negotiationId,
    buyerLei: parsed.buyerLei,
    buyerAgent: parsed.buyerAgent,
    buyerOor: parsed.buyerOor,
    currency: parsed.currency,
    lines,
    requiredDeliveryDate: parsed.requiredDeliveryDate,
    destination: parsed.destination,
    incotermRequested: parsed.incotermRequested,
    paymentTermRequested: parsed.paymentTermRequested,
    targetUnitPrice: parsed.targetUnitPrice,
    maxNegotiationRounds: parsed.maxNegotiationRounds,
    dimensions,
    rawText: parsed.rawText,
    dimensionsSnapshot: parsed.dimensionsSnapshot ?? JSON.stringify(dimensions),
    receivedAt,
  };
}

// ─── Dependencies ──────────────────────────────────────────────────────────

export interface IntakeDeps {
  flags: OrchestratorFlags;
  erp: ErpNextClient;
}

export interface IntakeNodes {
  intakeParse: (state: NegStateType) => Partial<NegStateType>;
  intakeMirrorToERPNext: (state: NegStateType) => Promise<Partial<NegStateType>>;
  ackToBuyer: (state: NegStateType) => Partial<NegStateType>;
}

// ─── Node factory ─────────────────────────────────────────────────────────────

export function buildIntakeNodes(deps: IntakeDeps): IntakeNodes {
  /**
   * intake.parse — normalize the seeded inbound inquiry into the canonical
   * Inquiry (via normalizeInquiry) and record the INTAKE transition.
   */
  function intakeParse(state: NegStateType): Partial<NegStateType> {
    if (state.inquiry === undefined || state.inquiry === null) {
      throw new Error("[intake.parse] no inquiry seeded in initial state");
    }
    const inquiry = normalizeInquiry(state.inquiry, { negotiationId: state.negotiationId });
    return { inquiry, negotiationId: inquiry.negotiationId, buyerLEI: inquiry.buyerLei, status: "INTAKE" };
  }

  /**
   * intake.mirrorToERPNext — create the ERPNext Opportunity (+ Items) from the
   * parsed inquiry and capture its name (needed as the prevdoc join for the
   * later Quotation). On an ErpNextError the node THROWS (fail loud: no
   * Opportunity = no quote join); the SqliteSaver checkpoint lets the thread be
   * resumed. No Opportunity name is ever fabricated.
   */
  async function intakeMirrorToERPNext(state: NegStateType): Promise<Partial<NegStateType>> {
    if (state.inquiry === undefined || state.inquiry === null) {
      throw new Error("[intake.mirrorToERPNext] no inquiry in state — run intake.parse first");
    }

    const ctx: MapOpportunityContext = {
      company: deps.flags.ERPNEXT_COMPANY,
      currency: deps.flags.ERPNEXT_CURRENCY,
    };
    const payload = mapInquiryToOpportunityPayload(state.inquiry, ctx);

    // Idempotent on re-run: dedupe by custom_inquiry_id (= negotiationId), which
    // mappers.ts always writes to the Opportunity. With IDEMPOTENT_WRITES on, a
    // repeated saga for the same negotiationId reuses the existing Opportunity
    // instead of inserting a duplicate. (idempotentInsertByField throws if a
    // genuine insert returns no name — no Opportunity name is fabricated.)
    const { name: opportunityName } = await idempotentInsertByField(deps.erp, {
      doctype: "Opportunity",
      keyField: "custom_inquiry_id",
      keyValue: state.inquiry.negotiationId,
      body: payload,
      enabled: deps.flags.IDEMPOTENT_WRITES,
    });
    if (!opportunityName) {
      throw new ErpNextError("malformed", "[intake.mirrorToERPNext] Opportunity insert returned no name");
    }

    return { opportunityName };
  }

  /**
   * ackToBuyer — mark the saga ACKED (04 §6: ACK before the long DD/Quoting
   * work). The buyer-facing emission itself is the OpenClaw/transport layer's
   * job, not this deterministic state node; this records the transition only.
   */
  function ackToBuyer(_state: NegStateType): Partial<NegStateType> {
    return { status: "ACKED" };
  }

  return { intakeParse, intakeMirrorToERPNext, ackToBuyer };
}
