// ================= fulfillment sub-agent (REAL decide + decidePlan) =================
//
// S3 — Fulfillment (REFINED-MultiAgent-Design-vLEI.md §6). ECR: Operations Officer.
// OWNS the decision: ATP-only vs CTP-needed (+ SPLIT later) and the promised ship
// dates. The ATP/CTP logic mirrors the former orchestrator node behavior exactly,
// so the FulfillmentPlan shape quoting consumes is unchanged — the difference is
// the decision is now OWNED by this sub-agent and SIGNED under its identity (§7).
//
// Two entry points:
//   - decide(input)     : one line → a signed FulfillmentDecision (ad-hoc/testing).
//   - decidePlan(input)  : the whole inquiry → a signed FulfillmentPlan + the
//                          per-line ConsultationRecords (used by the graph node).
//
// Data source = the same InventoryProvider the node used (ERPNext Bin in real mode).
// No fabrication: a failed consult → canFulfill=false with the error; no invented date.

import type { AgentContext, AgentDecision, SubAgent } from "../../agent-contract.js";
import type { SignedAttestation } from "../../../identity/CredentialProvider.js";
import type {
  InventoryProvider,
  ConsultationRecord,
  InventoryConsultation,
} from "../../../shared/provider-types.js";
import type { InquiryLine } from "../../../shared/inquiry-types.js";
import type {
  FulfillmentPlan,
  FulfillmentLinePlan,
  FulfillmentMode,
} from "../../../shared/fulfillment-types.js";

export interface FulfillmentInput {
  itemCode: string;
  quantity: number;
  requestedDate?: string;
}

export interface FulfillmentDecision {
  mode: FulfillmentMode;
  canFulfill: boolean;
  promisedShipDates: string[];
  availableQty?: number;
  leadTimeDays?: number;
  warehouse?: string;
}

export interface FulfillmentDeps {
  /** ERPNext Bin provider (real), or a demo provider. Same one the node used. */
  provider?: InventoryProvider;
}

/** Whole-inquiry result: the signed plan + the raw consults for the audit journal. */
export interface FulfillmentPlanResult {
  plan: FulfillmentPlan;
  consultations: ConsultationRecord<InventoryConsultation>[];
  attestation: SignedAttestation;
}

/** Latest ISO date across inputs (yyyy-mm-dd sorts lexicographically). */
function latestIsoDate(dates: Array<string | undefined>): string | undefined {
  const present = dates.filter((d): d is string => typeof d === "string" && d.length > 0);
  if (present.length === 0) return undefined;
  return present.reduce((a, b) => (a >= b ? a : b));
}

export class FulfillmentAgent implements SubAgent<FulfillmentInput, FulfillmentDecision> {
  readonly agentRef = "fulfillmentAgent";
  readonly ecrRole = "Operations Officer";

  constructor(private readonly deps: FulfillmentDeps = {}) {}

  /** Consult inventory for one line and build its FulfillmentLinePlan (node-identical). */
  private async planLine(
    itemCode: string,
    qty: number,
    requestedDate?: string,
  ): Promise<{ line: FulfillmentLinePlan; rec: ConsultationRecord<InventoryConsultation> }> {
    if (!this.deps.provider) {
      throw new Error(
        "[fulfillment] no InventoryProvider configured. Pass it via " +
        "buildAgentRuntime({ inventoryProvider }) or new FulfillmentAgent({ provider }).",
      );
    }
    const rec = await this.deps.provider.consult({ productCode: itemCode, quantity: qty });

    if (!rec.success || !rec.result) {
      return {
        rec,
        line: {
          itemCode,
          requestedQty: qty,
          requestedDate,
          mode: "CTP",
          canFulfill: false,
          rationale: `inventory consult failed: ${rec.error ?? "unknown error"}`,
        },
      };
    }

    const r = rec.result;
    const stockOk = r.canFulfill;
    const dateOk = !requestedDate || !r.earliestShipDate || r.earliestShipDate <= requestedDate;
    const canFulfill = stockOk && dateOk;
    const mode: FulfillmentMode = canFulfill ? "ATP" : "CTP";
    const rationale = stockOk
      ? canFulfill
        ? `ATP: free ${r.availableQty} >= ${qty}`
        : `stock ok (free ${r.availableQty}) but earliest ship ${r.earliestShipDate} > required ${requestedDate}`
      : `short: free ${r.availableQty} < ${qty}; lead time ${r.leadTimeDays}d`;

    return {
      rec,
      line: {
        itemCode,
        requestedQty: qty,
        requestedDate,
        mode,
        availableQty: r.availableQty,
        leadTimeDays: r.leadTimeDays,
        earliestShipDate: r.earliestShipDate,
        canFulfill,
        warehouse: r.warehouseRef,
        rationale,
      },
    };
  }

  /** One line → a signed FulfillmentDecision. */
  async decide(
    input: FulfillmentInput,
    ctx: AgentContext,
  ): Promise<AgentDecision<FulfillmentDecision>> {
    const { line } = await this.planLine(input.itemCode, input.quantity, input.requestedDate);
    const decision: FulfillmentDecision = {
      mode: line.mode,
      canFulfill: line.canFulfill,
      promisedShipDates: line.earliestShipDate ? [line.earliestShipDate] : [],
      availableQty: line.availableQty,
      leadTimeDays: line.leadTimeDays,
      warehouse: line.warehouse,
    };
    const attestation = await ctx.credentials.sign(ctx.agentRef, decision);
    return {
      agentRef: ctx.agentRef,
      decision,
      rationale: line.rationale ?? "",
      attestation,
      decidedAt: new Date().toISOString(),
    };
  }

  /** Whole inquiry → a signed FulfillmentPlan (+ the per-line consults). */
  async decidePlan(
    input: { lines: InquiryLine[]; defaultRequestedDate?: string },
    ctx: AgentContext,
  ): Promise<FulfillmentPlanResult> {
    const results = await Promise.all(
      input.lines.map((l) =>
        this.planLine(l.itemCode, l.qty, l.requiredDeliveryDate ?? input.defaultRequestedDate),
      ),
    );
    const lines = results.map((r) => r.line);
    const consultations = results.map((r) => r.rec);

    const plan: FulfillmentPlan = {
      lines,
      overallCanFulfill: lines.every((l) => l.canFulfill),
      worstCaseShipDate: latestIsoDate(lines.map((l) => l.earliestShipDate)),
      generatedAt: new Date().toISOString(),
    };

    const attestation = await ctx.credentials.sign(ctx.agentRef, plan);
    return { plan, consultations, attestation };
  }
}
