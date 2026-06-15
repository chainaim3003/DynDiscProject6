// ================= IMPL-V6 — A2A BUYER TRANSPORT (networked client) =================
//
// The "a2a" BuyerTransport: an @a2a-js/sdk (v0.3.x) JSON-RPC client that calls the buyer
// as a SEPARATE networked service (servers/buyer-server.ts) instead of in-process.
//
// WIRE CONTRACT (must match servers/buyer-server.ts exactly):
//   request : A2A Message { role:"user",  parts:[ DataPart{ data: EvaluateQuoteInput } ] }
//   response: A2A Message { role:"agent", parts:[ DataPart{ data: AgentDecision<BuyerEvaluation> } ] }
// EvaluateQuoteInput and AgentDecision<BuyerEvaluation> are the SAME types the in-process
// path uses (principals/tommy-buyer + agents/agent-contract) — one source of truth, so the
// seller records identical round attestations regardless of transport.
//
// FAIL LOUD (Rule 2 / Rule 8): every failure path — connect, timeout, non-message reply,
// missing/!malformed data part — THROWS. There is deliberately NO fallback to a local buyer:
// a broken cross-org link must surface, not be masked by impersonating the counterparty.
//
// vLEI HOOK: this is the cross-org boundary. Today the buyer signs under its own (plain)
// AID on the server and the seller records that attestation. When CREDENTIAL_MODE=vlei lands,
// the seller will additionally verify() the returned attestation's chain here before trusting it.

import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import type { Client } from "@a2a-js/sdk/client";
import type { Message, MessageSendParams, Part, Task } from "@a2a-js/sdk";
import { randomUUID } from "node:crypto";

import type { AgentDecision } from "../agent-contract.js";
import type {
  EvaluateQuoteInput,
  BuyerEvaluation,
  BuyerMove,
} from "../principals/tommy-buyer/index.js";
import type { BuyerTransport } from "./buyer-transport.js";

export interface A2aBuyerTransportOptions {
  /** Base URL of the buyer A2A server (its agent card lives at <url>/.well-known/agent-card.json). */
  url: string;
  /** Buyer binding-map key advertised to the negotiate node (the remote buyer's stable identity). */
  agentRef: string;
  /** Buyer GLEIF OOR role advertised to the negotiate node. */
  oorRole: string;
  /** Per-call wall-clock budget in ms before the request is aborted and the call fails. */
  timeoutMs: number;
}

const BUYER_MOVES: readonly BuyerMove[] = ["ACCEPT", "COUNTER", "REJECT"];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Pull the first DataPart payload out of an A2A message, or throw if absent. */
function dataPartOf(parts: Part[]): Record<string, unknown> {
  const part = parts.find((p): p is Extract<Part, { kind: "data" }> => p.kind === "data");
  if (part === undefined) {
    throw new Error("[a2a-buyer] buyer reply contained no DataPart (expected the AgentDecision payload)");
  }
  return part.data;
}

/**
 * Validate + narrow the wire payload to AgentDecision<BuyerEvaluation>. Throws (no coercion,
 * no defaulting) if the buyer returned something off-contract — we never fabricate a decision.
 */
function asBuyerDecision(payload: Record<string, unknown>): AgentDecision<BuyerEvaluation> {
  const decision = payload["decision"] as { move?: unknown } | undefined;
  const move = decision?.move;
  if (typeof move !== "string" || !BUYER_MOVES.includes(move as BuyerMove)) {
    throw new Error(
      `[a2a-buyer] buyer reply has invalid decision.move=${JSON.stringify(move)} ` +
        `(expected one of ${BUYER_MOVES.join(", ")})`,
    );
  }
  const attestation = payload["attestation"];
  if (attestation === undefined || attestation === null) {
    throw new Error("[a2a-buyer] buyer reply missing attestation (unsigned decisions are not accepted)");
  }
  // Shape matches AgentDecision<BuyerEvaluation> produced by TommyBuyerAgent.evaluateQuote.
  return payload as unknown as AgentDecision<BuyerEvaluation>;
}

/**
 * Networked buyer. The A2A Client is built lazily on first call (createFromUrl fetches the
 * agent card), then reused. agentRef / oorRole are the buyer's stable identity, surfaced
 * synchronously so the negotiate node can attribute the round attestation without a round-trip.
 */
export class A2aBuyerTransport implements BuyerTransport {
  readonly agentRef: string;
  readonly oorRole: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private clientPromise?: Promise<Client>;

  constructor(opts: A2aBuyerTransportOptions) {
    this.url = opts.url;
    this.agentRef = opts.agentRef;
    this.oorRole = opts.oorRole;
    this.timeoutMs = opts.timeoutMs;
  }

  /** Lazily build (and cache) the JSON-RPC A2A client for the buyer server. */
  private client(): Promise<Client> {
    if (this.clientPromise === undefined) {
      const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory()] });
      this.clientPromise = factory.createFromUrl(this.url).catch((err: unknown) => {
        // Reset so a later call can retry a transient connect/card-fetch failure.
        this.clientPromise = undefined;
        throw new Error(
          `[a2a-buyer] could not connect to buyer server at ${this.url}: ${errMessage(err)} ` +
            `(no in-process fallback)`,
          { cause: err },
        );
      });
    }
    return this.clientPromise;
  }

  async evaluateQuote(input: EvaluateQuoteInput): Promise<AgentDecision<BuyerEvaluation>> {
    const client = await this.client();

    const message: Message = {
      kind: "message",
      messageId: randomUUID(),
      role: "user",
      parts: [{ kind: "data", data: { ...input } }],
    };
    const params: MessageSendParams = {
      message,
      configuration: { blocking: true, acceptedOutputModes: ["application/json"] },
    };

    let result: Message | Task;
    try {
      result = await client.sendMessage(params, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(
        `[a2a-buyer] evaluateQuote call to ${this.url} failed: ${errMessage(err)} ` +
          `(no in-process fallback — cross-org buyer link is down)`,
        { cause: err },
      );
    }

    if (result.kind !== "message") {
      throw new Error(
        `[a2a-buyer] expected a Message reply from buyer but got kind="${result.kind}" ` +
          `(the buyer server should return its decision synchronously, not a long-running Task)`,
      );
    }
    return asBuyerDecision(dataPartOf(result.parts));
  }
}
