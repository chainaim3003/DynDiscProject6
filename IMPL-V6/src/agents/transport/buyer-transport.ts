// ================= IMPL-V6 — BUYER TRANSPORT SEAM (in-process | A2A) =================
//
// Improvement 1 (network-based A2A): the negotiate node (Φ4) talks to the buyer through
// THIS seam instead of holding a concrete TommyBuyerAgent. The seam is exactly the subset
// of the buyer that negotiate.ts actually consumes — verified against
// orchestrator/nodes/negotiate.ts:
//     deps.buyer.evaluateQuote(...)   deps.buyer.agentRef   deps.buyer.oorRole
// …and nothing else. So swapping the concrete agent for a transport is type-safe and
// behaviour-preserving on the in-process path.
//
// TWO implementations, selected by BUYER_TRANSPORT (config/flags.ts):
//   - "inprocess" (default): InProcessBuyerTransport wraps the existing TommyBuyerAgent.
//     Zero wire, zero behaviour change — the deterministic happy path (P01-P02) and the
//     current live negotiation runs are byte-identical.
//   - "a2a": A2aBuyerTransport (a2a-buyer-client.ts) is an @a2a-js/sdk JSON-RPC client to a
//     SEPARATE buyer server (own Agent Card, own port, own AID). This is the cross-org seam
//     where vLEI authentication of the buyer↔seller call will later live.
//
// HONEST BOUNDARY (Rule 8): the A2A transport NEVER silently falls back to in-process. A
// networked buyer that fails is a real failure of the cross-org link; degrading to a local
// stand-in would fabricate the counterparty. It throws loud instead (see a2a-buyer-client.ts).
// (Contrast the LLM optimizer, whose deterministic fallback is a SAFE LOCAL degradation.)

import type { AgentDecision } from "../agent-contract.js";
import type {
  TommyBuyerAgent,
  EvaluateQuoteInput,
  BuyerEvaluation,
} from "../principals/tommy-buyer/index.js";
import type { OrchestratorFlags } from "../../config/flags.js";
import { A2aBuyerTransport } from "./a2a-buyer-client.js";

/**
 * The buyer surface the seller's negotiate node depends on — and the ONLY surface. Any
 * BuyerTransport (local or networked) is interchangeable behind this interface.
 */
export interface BuyerTransport {
  /** The buyer's binding-map key (e.g. "tommyBuyerAgent"), recorded on the round attestation. */
  readonly agentRef: string;
  /** The buyer's GLEIF OOR role (e.g. "Chief Procurement Officer"), recorded on the attestation. */
  readonly oorRole: string;
  /**
   * Evaluate the seller's current unit price → ACCEPT | COUNTER | REJECT, signed under the
   * buyer's AID. Same contract as TommyBuyerAgent.evaluateQuote, whether local or over the wire.
   */
  evaluateQuote(input: EvaluateQuoteInput): Promise<AgentDecision<BuyerEvaluation>>;
}

/**
 * In-process transport: a thin pass-through to the real TommyBuyerAgent in the same runtime.
 * No serialization, no network — identical behaviour to calling the agent directly.
 */
export class InProcessBuyerTransport implements BuyerTransport {
  readonly agentRef: string;
  readonly oorRole: string;

  constructor(private readonly agent: TommyBuyerAgent) {
    this.agentRef = agent.agentRef;
    this.oorRole = agent.oorRole;
  }

  evaluateQuote(input: EvaluateQuoteInput): Promise<AgentDecision<BuyerEvaluation>> {
    return this.agent.evaluateQuote(input);
  }
}

/**
 * Resolve the buyer transport from flags. Synchronous (so the graph builder stays sync):
 *   - "inprocess" → wrap the injected agent.
 *   - "a2a"       → construct an A2aBuyerTransport pointed at BUYER_A2A_URL. The underlying
 *                   A2A client connects lazily on first call. We fail loud here if the URL
 *                   is blank rather than invent an endpoint (Rule 2 / Rule 8).
 *
 * @param flags resolved OrchestratorFlags (carries BUYER_TRANSPORT / BUYER_A2A_URL / timeout).
 * @param agent the local TommyBuyerAgent — used by the in-process transport, and as the source
 *              of the buyer's stable identity (agentRef / oorRole) advertised by the A2A transport.
 */
export function createBuyerTransport(
  flags: OrchestratorFlags,
  agent: TommyBuyerAgent,
): BuyerTransport {
  switch (flags.BUYER_TRANSPORT) {
    case "inprocess":
      return new InProcessBuyerTransport(agent);
    case "a2a": {
      const url = flags.BUYER_A2A_URL.trim();
      if (url === "") {
        throw new Error(
          "[buyer-transport] BUYER_TRANSPORT=a2a but BUYER_A2A_URL is empty. " +
            "Set it to the buyer server's base URL (e.g. http://localhost:41242). No endpoint fabricated.",
        );
      }
      return new A2aBuyerTransport({
        url,
        agentRef: agent.agentRef,
        oorRole: agent.oorRole,
        timeoutMs: flags.BUYER_A2A_TIMEOUT_MS,
      });
    }
    default: {
      // Exhaustiveness guard — flags.ts validates the enum, this catches drift.
      const never: never = flags.BUYER_TRANSPORT;
      throw new Error(`[buyer-transport] unknown BUYER_TRANSPORT: ${String(never)}`);
    }
  }
}
