// ================= jupiterSellerAgent — principal (INTERFACE STUB) =================
//
// Principal SELLER agent (REFINED-MultiAgent-Design-vLEI.md §5.2). Owns: intake
// validity, quote assembly, negotiation moves, persist+sign. Delegates to the 3
// sub-agents. Faces tommyBuyerAgent over the A2A channel.
//
// STATUS: clearly-labeled STUB (Rule 8 / no-hallucination). Real wiring (Increment 4)
// attaches the existing orchestrator nodes (intake/quoting + new negotiation/persist)
// as this principal's skills, and applies the delegated-AID signature in persist via
// the identity-client. No fake decisions are returned here.

import type { AgentContext, PrincipalAgent } from "../../agent-contract.js";

export class JupiterSellerAgent implements PrincipalAgent {
  readonly agentRef = "jupiterSellerAgent";
  readonly oorRole = "Chief Sales Officer";

  constructor(private readonly ctx: AgentContext) {}

  /** Present this seller's credential to a counterparty (delegates to identity-client). */
  present() {
    return this.ctx.credentials.present(this.agentRef);
  }

  /** Sign a quote/offer under the seller's AID (plain sha256, or ACDC in vlei mode). */
  sign(payload: unknown) {
    return this.ctx.credentials.sign(this.agentRef, payload);
  }

  /**
   * Run the negotiation saga for one inquiry. NOT IMPLEMENTED in this increment.
   * Increment 4 binds this to the LangGraph negotiation graph (orchestrator/graph.ts)
   * and the sub-agent consults (dd-credit, treasury, fulfillment).
   */
  async handleInquiry(_inquiry: unknown): Promise<never> {
    throw new Error(
      "[jupiterSellerAgent] handleInquiry() not implemented yet (Increment 4): " +
      "wire to orchestrator negotiation graph + sub-agent delegation. See SKILL.md.",
    );
  }
}
