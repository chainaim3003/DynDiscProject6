// ================= IMPL-V6 — AGENT CONTRACT (shared types) =================
//
// The common shape for the refined agent model from REFINED-MultiAgent-Design-vLEI.md:
//   2 Principal Agents (tommyBuyerAgent, jupiterSellerAgent) + 3 seller Sub-Agents
//   (dd-credit, treasury, fulfillment). Each agent OWNS a decision and acts UNDER an
//   AID resolved through the identity-client.
//
// IMPORTANT (userPreferences Rule 8 / "no hallucination"): the per-agent index.ts
// files are clearly-labeled INTERFACE STUBS. Their decide() bodies THROW until the
// real logic lands (Increment 4), wiring to the existing orchestrator nodes
// (intake/quoting/fulfillment) and the provider tools (GLEIF, ERPNext Bin, ACTUS).
// They are NOT mock implementations returning fake numbers.

import type {
  CredentialProvider,
  SignedAttestation,
} from "../identity/CredentialProvider.js";

/** A binding-map key, e.g. "jupiterSellerAgent" / "treasuryAgent". */
export type AgentRef = string;

/** What an agent needs to act: its identity provider + its own ref. */
export interface AgentContext {
  /** Identity provider (PlainJsonProvider — plain sha256 attestations). */
  readonly credentials: CredentialProvider;
  /** This agent's binding-map key. */
  readonly agentRef: AgentRef;
}

/** A decision an agent owns, with the rationale and the signature over it. */
export interface AgentDecision<T> {
  agentRef: AgentRef;
  decision: T;
  /** Always recorded to audit (design §6 guardrail). */
  rationale: string;
  /** The agent signs its decision under its AID (plain sha256 attestation). */
  attestation: SignedAttestation;
  decidedAt: string;
}

/** A sub-agent owns exactly one decision type D, computed from input I, under an ECR role. */
export interface SubAgent<I, D> {
  readonly agentRef: AgentRef;
  /** GLEIF Engagement Context Role this sub-agent is pegged to. */
  readonly ecrRole: string;
  decide(input: I, ctx: AgentContext): Promise<AgentDecision<D>>;
}

/** A principal faces a counterparty over the A2A channel, pegged to an OOR role. */
export interface PrincipalAgent {
  readonly agentRef: AgentRef;
  /** GLEIF Official Organizational Role this principal is pegged to. */
  readonly oorRole: string;
}
