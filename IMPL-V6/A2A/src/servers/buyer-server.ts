// ================= IMPL-V6 — BUYER A2A SERVER (standalone networked buyer) =================
//
// Improvement 1 (network-based A2A): runs the Tommy buyer as a SEPARATE service the seller
// calls over the wire (@a2a-js/sdk v0.3.x, JSON-RPC). This is the counterparty process — its
// own port, its own Agent Card, its own CredentialProvider/AID — the cross-org boundary where
// vLEI authentication will later be enforced.
//
// The buyer agent is constructed EXACTLY as src/agents/runtime.ts builds it (same provider
// factory, same agentRef "tommyBuyerAgent", same default strategy) so a networked round is
// behaviourally identical to the in-process round — only the transport differs.
//
// WIRE CONTRACT (must match agents/transport/a2a-buyer-client.ts):
//   request : Message{ role:"user",  parts:[ DataPart{ data: EvaluateQuoteInput } ] }
//   reply   : Message{ role:"agent", parts:[ DataPart{ data: AgentDecision<BuyerEvaluation> } ] }
//
// AI vs MANUAL: this file is AI-written and runnable with `tsx`. STARTING it is a manual step
// (a long-lived process on your machine) — see the run instructions in chat. It binds
// BUYER_A2A_PORT and advertises BUYER_A2A_URL on its Agent Card.
//
// Run:  tsx src/servers/buyer-server.ts [--port <n>] [--url <baseUrl>]
//   defaults come from flags (BUYER_A2A_PORT / BUYER_A2A_URL), env overrides via .env.

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";

import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  A2AError,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { AgentCard, Message, Part } from "@a2a-js/sdk";

import { loadFlags } from "../config/flags.js";
import { loadIdentityFlags } from "../config/identity-flags.js";
import { createCredentialProvider } from "../identity/index.js";
import { TommyBuyerAgent, type EvaluateQuoteInput } from "../agents/principals/tommy-buyer/index.js";
import type { AgentContext } from "../agents/agent-contract.js";

const A2A_PROTOCOL_VERSION = "0.3.0"; // A2A spec line the installed SDK (0.3.x) speaks.

/** Extract + validate the EvaluateQuoteInput from the inbound message. Fail loud, never default. */
function parseEvaluateInput(parts: Part[]): EvaluateQuoteInput {
  const part = parts.find((p): p is Extract<Part, { kind: "data" }> => p.kind === "data");
  if (part === undefined) {
    throw A2AError.invalidParams("buyer expects a DataPart carrying EvaluateQuoteInput; none found");
  }
  const data = part.data;
  const required = ["sellerUnitPrice", "buyerMaxUnitPrice", "round", "maxRounds"] as const;
  for (const key of required) {
    const v = data[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw A2AError.invalidParams(`EvaluateQuoteInput.${key} must be a finite number (got ${JSON.stringify(v)})`);
    }
  }
  return {
    sellerUnitPrice: data["sellerUnitPrice"] as number,
    buyerMaxUnitPrice: data["buyerMaxUnitPrice"] as number,
    round: data["round"] as number,
    maxRounds: data["maxRounds"] as number,
  };
}

/** A2A executor that delegates each message to the real buyer agent and replies synchronously. */
class BuyerAgentExecutor implements AgentExecutor {
  constructor(private readonly buyer: TommyBuyerAgent) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const input = parseEvaluateInput(requestContext.userMessage.parts);
    // Real decision, signed under the buyer's own AID (no mock).
    const decision = await this.buyer.evaluateQuote(input);

    // Visible proof each call crossed the wire (one line per seller→buyer round).
    const counter =
      decision.decision.counterPrice !== undefined ? ` @${decision.decision.counterPrice}` : "";
    // eslint-disable-next-line no-console
    console.log(
      `[buyer-server] evaluateQuote round ${input.round}/${input.maxRounds} ` +
        `seller=${input.sellerUnitPrice} reservation=${input.buyerMaxUnitPrice} ` +
        `→ ${decision.decision.move}${counter}`,
    );

    const reply: Message = {
      kind: "message",
      messageId: randomUUID(),
      role: "agent",
      contextId: requestContext.contextId,
      taskId: requestContext.taskId,
      parts: [{ kind: "data", data: decision as unknown as Record<string, unknown> }],
    };
    eventBus.publish(reply);
    eventBus.finished();
  }

  // evaluateQuote is synchronous request/reply — nothing is left running to cancel.
  async cancelTask(_taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    /* no-op: no long-running task to cancel */
  }
}

function buildBuyerAgent(): TommyBuyerAgent {
  // Mirror runtime.ts: one plain CredentialProvider, buyer under agentRef "tommyBuyerAgent".
  const flags = loadFlags();
  const identityFlags = loadIdentityFlags();
  const provider = createCredentialProvider(flags, identityFlags);
  const ctx: AgentContext = { credentials: provider, agentRef: "tommyBuyerAgent" };
  return new TommyBuyerAgent(ctx);
}

function buildAgentCard(publicUrl: string): AgentCard {
  return {
    name: "Tommy Buyer Agent",
    description:
      "Networked principal BUYER (A2A). Evaluates a seller's unit price and returns ACCEPT/COUNTER/REJECT, " +
      "signed under the buyer's AID. Counterparty service for the Jupiter seller saga.",
    url: publicUrl,
    version: "0.1.0",
    protocolVersion: A2A_PROTOCOL_VERSION,
    preferredTransport: "JSONRPC",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: "evaluate-quote",
        name: "Evaluate Quote",
        description:
          "Given sellerUnitPrice, buyerMaxUnitPrice (reservation), round and maxRounds, decide " +
          "accept / counter (conceding upward toward reservation) / reject.",
        tags: ["negotiation", "procurement", "buyer"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };
}

/** Minimal flag override parser: --port <n> and --url <baseUrl>. Defaults come from flags. */
function resolveServerConfig(argv: string[]): { port: number; url: string } {
  const flags = loadFlags();
  let port = flags.BUYER_A2A_PORT;
  let url = flags.BUYER_A2A_URL;
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--port") {
      const n = Number.parseInt(argv[i + 1]!, 10);
      if (!Number.isFinite(n)) throw new Error(`--port must be an integer (got "${argv[i + 1]}")`);
      port = n;
    } else if (argv[i] === "--url") {
      url = argv[i + 1]!;
    }
  }
  return { port, url };
}

export function startBuyerServer(opts: { port: number; url: string }) {
  const buyer = buildBuyerAgent();
  const agentCard = buildAgentCard(opts.url);
  const requestHandler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), new BuyerAgentExecutor(buyer));

  const app = express();
  app.use(express.json());
  // Agent card first (path-scoped), then JSON-RPC at root.
  app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return app.listen(opts.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[buyer-server] Tommy buyer A2A server listening on :${opts.port}\n` +
        `[buyer-server] agent card: ${opts.url.replace(/\/$/, "")}/.well-known/agent-card.json\n` +
        `[buyer-server] advertised url (card.url): ${opts.url}`,
    );
  });
}

// Run directly (tsx src/servers/buyer-server.ts). Guarded so the module can also be imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("buyer-server.ts")) {
  const cfg = resolveServerConfig(process.argv.slice(2));
  startBuyerServer(cfg);
}
