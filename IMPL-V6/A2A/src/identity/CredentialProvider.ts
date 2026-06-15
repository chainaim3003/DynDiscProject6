// ================= IMPL-V6 — CredentialProvider INTERFACE =================
//
// The identity seam both design docs hinge on. From REFINED-Project-Structure.md
// §1: the identity-client's only job is to "resolve an agent's AID, present its
// credential, sign/grant via IPEX, and verify a counterparty's chain." §2 names
// the interface methods: resolveAid / present / sign / verify.
//
// ONE interface, TWO implementations (selected by CREDENTIAL_MODE — see index.ts):
//   - PlainJsonProvider  (CREDENTIAL_MODE=plain, default) — reads cards locally,
//     signs with a sha256 envelope hash, verifies structurally. NO Host B.
//   - VleiServiceClient  (CREDENTIAL_MODE=vlei) — HTTP client to vLEIEnh1 (Host B);
//     present/sign via IPEX, verify via Sally. [Increment 2 — not in this file.]
//
// These types are framework-neutral (no LangGraph / no MCP imports) so any node,
// skill, or sub-agent can depend on them.

import type { CredentialMode } from "../config/flags.js";

/** A human role binding type per GLEIF: statutory officer (OOR) or custom role (ECR). */
export type RoleType = "OOR" | "ECR";

/** Whether the agent's card/credential exists on Host B yet. */
export type BindingStatus = "active" | "placeholder";

/**
 * One entry of identity/binding-map.json (agent → human role → card).
 * AIDs are NOT stored here — they are resolved from the referenced card.
 */
export interface BindingEntry {
  /** LEI of the legal entity the agent acts for (principals only; sub-agents inherit). */
  lei?: string;
  roleType: RoleType;
  /** Human-readable role, e.g. "Chief Sales Officer" / "Treasurer". */
  role: string;
  /** Named holder alias, e.g. "Jupiter_Chief_Sales_Officer". */
  holder: string;
  /** Card filename, relative to its cards dir (sub-agents include "subagents/"). */
  card: string;
  /** The alias this agent's AID is delegated FROM (an OOR holder, or the seller). */
  delegatedFrom: string;
  /** vLEIEnh1 shell script that mints this delegation (for the manual Host B steps). */
  delegationScript?: string;
  /** Decision this agent owns (sub-agents). Documentation/audit aid. */
  ownsDecision?: string;
  status: BindingStatus;
  /**
   * Grounded Host B (vLEIEnh1) facts vs the design target. Populated for sub-agents
   * from the §6 resolution in binding-map.json (read from
   * configBuyerSellerAIAgent1-with-subdelegation.json): sub-agents are sub-delegated
   * from jupiterSellerAgent, and only Treasury is configured today. Optional, so the
   * plain provider and principals (which omit it) are unaffected.
   */
  hostB?: {
    /** Is this sub-agent present in the Host B sub-delegation config today? */
    configuredInSubdelegation?: boolean;
    /** The alias used on Host B (e.g. "JupiterTreasuryAgent"), or null if not configured. */
    configAlias?: string | null;
    /** How the AID is delegated (e.g. "agent-subdelegation-from-jupiterSellerAgent"). */
    delegationModel?: string;
    /** Permission scope recorded on Host B (e.g. "treasury_operations"). */
    scope?: string;
    /** Whether a distinct human ECR-officer person exists on Host B (currently false). */
    ecrOfficerPersonExists?: boolean;
    note?: string;
  };
}

export interface BindingMap {
  schemaVersion: string;
  principals: Record<string, BindingEntry>;
  subAgents: Record<string, BindingEntry>;
}

/**
 * The KERI/vLEI metadata block carried by an agent card. Field names are taken
 * VERBATIM from the real card read on disk
 * (agent-cards/jupiterSellerAgent-card.json → extensions.vLEImetadata /
 *  extensions.keriIdentifiers). Optional because plain-mode dev cards may omit them.
 */
export interface CardVleiMetadata {
  agentName?: string;
  oorHolderName?: string;
  delegatorAID?: string;
  delegateeAID?: string;
  delegatorOOBI?: string;
  delegateeOOBI?: string;
  leAID?: string;
  leOOBI?: string;
  verificationPath?: string[];
}

export interface CardKeriIdentifiers {
  agentAID?: string;
  oorHolderAID?: string;
  legalEntityAID?: string;
  qviAID?: string;
}

/** The subset of the agent card the identity layer consumes (cards may carry more). */
export interface AgentCard {
  name: string;
  description?: string;
  extensions?: {
    gleifIdentity?: { lei?: string; legalEntityName?: string; qvi?: string };
    vLEImetadata?: CardVleiMetadata;
    keriIdentifiers?: CardKeriIdentifiers;
    gleifVerification?: { gleifVerificationEndpoint?: string };
  };
  /** Anything else on the card, preserved but not interpreted here. */
  [k: string]: unknown;
}

/** Result of resolving an agent reference to its on-chain identifier. */
export interface AidResolution {
  /** The binding-map key, e.g. "jupiterSellerAgent". */
  agentRef: string;
  /** The agent's own KERI AID (delegatee). Empty string if not yet minted. */
  aid: string;
  roleType: RoleType;
  role: string;
  holder: string;
  lei?: string;
  /** The delegator AID the chain anchors to, when present on the card. */
  delegatorAid?: string;
  status: BindingStatus;
}

/** What an agent presents to a counterparty as proof of who stands behind it. */
export interface CredentialPresentation {
  agentRef: string;
  mode: CredentialMode;
  aid: string;
  roleType: RoleType;
  role: string;
  holder: string;
  /** The full AID→OOR/ECR→LE→QVI→GLEIF path, when the card carries it. */
  verificationPath?: string[];
  /** OOBIs a verifier can resolve to fetch key state (vlei mode). */
  oobis?: { delegatee?: string; delegator?: string; legalEntity?: string };
}

/** A signed attestation over an arbitrary payload (quote, offer, envelope…). */
export interface SignedAttestation {
  agentRef: string;
  /** "plain" → sha256(canonical(payload)); "acdc" → IPEX grant SAID (vlei mode). */
  signingMode: "plain" | "acdc";
  aid: string;
  /** The signature/hash value. For plain mode this is the hex sha256 digest. */
  signature: string;
  /** Canonicalization algorithm used before hashing/signing (provenance). */
  alg: string;
  signedAt: string;
}

/** Outcome of verifying a counterparty (or self) credential/chain. */
export interface VerificationResult {
  verified: boolean;
  /** "structural" (plain: card/LEI well-formed) or "cryptographic" (vlei: Sally walked the chain). */
  method: "structural" | "cryptographic";
  agentRef?: string;
  aid?: string;
  /** Human-readable reason — especially important when verified=false (no silent failure). */
  reason: string;
  /** Raw verifier response (vlei mode) for audit, when available. */
  raw?: unknown;
}

/**
 * The provider contract. Implementations MUST NOT fabricate identity data:
 * if an AID/credential is absent, resolve to status="placeholder" and let
 * verify() return verified=false with a reason, rather than inventing values.
 */
export interface CredentialProvider {
  /** Which mode this concrete provider implements. */
  readonly mode: CredentialMode;
  /** Resolve an agent reference (binding-map key) to its AID + role metadata. */
  resolveAid(agentRef: string): Promise<AidResolution>;
  /** Build the credential presentation a counterparty would verify. */
  present(agentRef: string): Promise<CredentialPresentation>;
  /** Sign/attest over a payload under the agent's identity. */
  sign(agentRef: string, payload: unknown): Promise<SignedAttestation>;
  /** Verify a presentation (or, by ref, a counterparty's chain). */
  verify(input: CredentialPresentation | { agentRef: string }): Promise<VerificationResult>;
}
