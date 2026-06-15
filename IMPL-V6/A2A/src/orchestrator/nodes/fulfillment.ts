// ================= IMPL-V6 — Φ3 FULFILLMENT NODE (agent-owned) =================
//
// Re-homed (REFINED-MultiAgent-Design-vLEI.md §6 S3 + §7): the ATP/CTP decision is
// now OWNED by the FulfillmentAgent sub-agent and SIGNED under its identity. This
// node is a thin wrapper that calls agent.decidePlan(), writes the resulting
// FulfillmentPlan (unchanged shape — quoting is unaffected), appends the per-line
// inventory ConsultationRecords to consultations[], and records an AgentAttestation
// into attestations[] (§7 — who decided this, under which ECR/AID).
//
// GROUNDING:
//   - Agent + plan logic: src/agents/subagents/fulfillment/index.ts
//   - FulfillmentPlan:     shared/fulfillment-types.ts
//   - Attestation channel: orchestrator/state/neg-state.ts

import type { NegStateType, AgentAttestation } from "../state/neg-state.js";
import type { AgentContext } from "../../agents/agent-contract.js";
import type { FulfillmentAgent } from "../../agents/subagents/fulfillment/index.js";

export const FULFILLMENT_NODE = {
  plan: "fulfillment.plan",
} as const;

export interface FulfillmentDeps {
  /** The Fulfillment sub-agent (constructed with the ERPNext Bin provider). */
  agent: FulfillmentAgent;
  /** Identity context for signing the plan under the fulfillmentAgent AID. */
  context: AgentContext;
}

export interface FulfillmentNodes {
  fulfillmentPlan: (state: NegStateType) => Promise<Partial<NegStateType>>;
}

export function buildFulfillmentNode(deps: FulfillmentDeps): FulfillmentNodes {
  async function fulfillmentPlan(state: NegStateType): Promise<Partial<NegStateType>> {
    const inquiry = state.inquiry;
    if (inquiry === undefined || inquiry === null) {
      throw new Error("[fulfillment.plan] no inquiry in state — run intake first");
    }

    const out = await deps.agent.decidePlan(
      { lines: inquiry.lines, defaultRequestedDate: inquiry.requiredDeliveryDate },
      deps.context,
    );

    const attestation: AgentAttestation = {
      agentRef: deps.agent.agentRef,
      role: deps.agent.ecrRole,
      aid: out.attestation.aid,
      subject: "fulfillment-plan",
      signature: out.attestation.signature,
      signingMode: out.attestation.signingMode,
      signedAt: out.attestation.signedAt,
    };

    // consultations[] + attestations[] both use concat reducers → arrays append.
    return {
      fulfillmentPlan: out.plan,
      consultations: out.consultations,
      attestations: [attestation],
    };
  }

  return { fulfillmentPlan };
}
