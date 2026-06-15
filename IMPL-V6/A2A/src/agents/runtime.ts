// ================= IMPL-V6 — AGENT RUNTIME =================
//
// The single place that constructs the identity layer and the 5 agents, so the
// orchestrator can act UNDER an agent's identity (REFINED-MultiAgent-Design-vLEI.md
// §2/§7 — every decision attributable to an AID).
//
// It builds ONE CredentialProvider (PlainJsonProvider, selected by CREDENTIAL_MODE=plain
// via createCredentialProvider) and an AgentContext per agent. Principals receive their context at construction;
// sub-agents receive it per decide() call, so the runtime exposes contextFor().
//
// Sub-agents that need configuration/tools get it here:
//   - FulfillmentAgent → the InventoryProvider (ERPNext Bin).
//   - TreasuryAgent    → its mode (TREASURY_MODE: real=ACTUS / demo=configured floor).
//   - DdCreditAgent    → the CreditProvider (real GLEIF/EDGAR or fixture-backed demo).

import { loadFlags, type OrchestratorFlags } from "../config/flags.js";
import { loadIdentityFlags, type IdentityFlags } from "../config/identity-flags.js";
import { createCredentialProvider } from "../identity/index.js";
import type { CredentialProvider } from "../identity/CredentialProvider.js";
import type { InventoryProvider, CreditProvider } from "../shared/provider-types.js";
import type { ProviderMode } from "../config/flags.js";
import type { AgentContext, AgentRef } from "./agent-contract.js";

import { JupiterSellerAgent } from "./principals/jupiter-seller/index.js";
import { TommyBuyerAgent } from "./principals/tommy-buyer/index.js";
import { DdCreditAgent } from "./subagents/dd-credit/index.js";
import { TreasuryAgent } from "./subagents/treasury/index.js";
import { FulfillmentAgent } from "./subagents/fulfillment/index.js";

/** Everything the orchestrator needs to run agents under their identities. */
export interface AgentRuntime {
  /** The one identity provider (plain) all agents share. */
  provider: CredentialProvider;
  /** Build an AgentContext (identity + ref) for any agent. */
  contextFor(agentRef: AgentRef): AgentContext;
  /** Principal agents (constructed with their own context). */
  seller: JupiterSellerAgent;
  buyer: TommyBuyerAgent;
  /** Seller sub-agents (decide(input, ctx) — use contextFor() to supply ctx). */
  ddCredit: DdCreditAgent;
  treasury: TreasuryAgent;
  fulfillment: FulfillmentAgent;
}

export interface BuildAgentRuntimeOptions {
  /** Pre-resolved orchestration flags (else loadFlags()). */
  flags?: Readonly<OrchestratorFlags>;
  /** Pre-resolved identity flags (else loadIdentityFlags()). */
  identityFlags?: Readonly<IdentityFlags>;
  /** Inject a provider directly (e.g. a fake in tests); else built from flags. */
  provider?: CredentialProvider;
  /** Inventory analyst tool for the Fulfillment sub-agent (ERPNext Bin provider). */
  inventoryProvider?: InventoryProvider;
  /** Credit analyst tool for the DD sub-agent (GLEIF/EDGAR real, or fixture-backed demo). */
  creditProvider?: CreditProvider;
  /** Treasury mode override; else flags.TREASURY_MODE (real=ACTUS / demo=configured floor). */
  treasuryMode?: ProviderMode;
}

/**
 * Build the agent runtime. Resolves flags, creates the credential provider once,
 * and instantiates all 5 agents.
 *
 *   const rt = buildAgentRuntime();                       // from env flags
 *   const rt = buildAgentRuntime({ flags, inventoryProvider, creditProvider });
 *   await rt.fulfillment.decide(input, rt.contextFor("fulfillmentAgent"));
 */
export function buildAgentRuntime(opts: BuildAgentRuntimeOptions = {}): AgentRuntime {
  const flags = opts.flags ?? loadFlags();
  const identityFlags = opts.identityFlags ?? loadIdentityFlags();
  const provider = opts.provider ?? createCredentialProvider(flags, identityFlags);

  const contextFor = (agentRef: AgentRef): AgentContext => ({
    credentials: provider,
    agentRef,
  });

  return {
    provider,
    contextFor,
    seller: new JupiterSellerAgent(contextFor("jupiterSellerAgent")),
    buyer: new TommyBuyerAgent(contextFor("tommyBuyerAgent")),
    ddCredit: new DdCreditAgent({ provider: opts.creditProvider }),
    treasury: new TreasuryAgent({ mode: opts.treasuryMode ?? flags.TREASURY_MODE }),
    fulfillment: new FulfillmentAgent({ provider: opts.inventoryProvider }),
  };
}
