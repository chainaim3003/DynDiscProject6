// ================= IMPL-V6 — PlainJsonProvider (CREDENTIAL_MODE=plain) =================
//
// The DEFAULT identity provider. Works fully offline — no Host B (vLEIEnh1),
// no KERIA, no Sally. It is REAL, not a mock:
//   - resolveAid : reads the agent's AID from its card (source of truth).
//   - present    : assembles the card's verification path + OOBIs for display.
//   - sign       : sha256 over a CANONICAL JSON serialization of the payload —
//                  this is exactly what SIGNING_MODE=plain means elsewhere in V6
//                  (server-sse / messaging). Deterministic + verifiable by anyone
//                  who recomputes the hash.
//   - verify     : STRUCTURAL checks only (LEI well-formed, card present, AID
//                  present). It explicitly reports method="structural" and does
//                  NOT claim a cryptographic chain walk — that is the vlei
//                  provider's job (Increment 2). Honesty over false assurance.
//
// What plain mode deliberately CANNOT do: prove that a counterparty's AID is
// genuinely delegated from a real human officer. That requires Sally walking the
// KERI chain (CREDENTIAL_MODE=vlei). verify() says so in its `reason`.

import { createHash } from "node:crypto";

import type {
  AgentCard,
  AidResolution,
  BindingEntry,
  BindingMap,
  CredentialPresentation,
  CredentialProvider,
  SignedAttestation,
  VerificationResult,
} from "./CredentialProvider.js";
import {
  agentAidFromCard,
  delegatorAidFromCard,
  findBinding,
  loadAgentCard,
  loadBindingMap,
} from "./agent-card-loader.js";
import type { IdentityFlags } from "../config/identity-flags.js";

const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/; // ISO 17442: 20 chars, last 2 are check digits.

/** Stable, key-sorted JSON so the same payload always hashes identically. */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return v;
}

export class PlainJsonProvider implements CredentialProvider {
  readonly mode = "plain" as const;

  private map?: BindingMap;

  constructor(private readonly flags: IdentityFlags) {}

  /** Lazily load + cache the binding map (one disk read per process). */
  private async bindingMap(): Promise<BindingMap> {
    if (!this.map) this.map = await loadBindingMap(this.flags);
    return this.map;
  }

  /** Resolve binding + card together; tolerate a missing card for placeholders. */
  private async load(agentRef: string): Promise<{ entry: BindingEntry; card?: AgentCard }> {
    const map = await this.bindingMap();
    const entry = findBinding(map, agentRef);
    try {
      const card = await loadAgentCard(this.flags.AGENT_CARDS_DIR, entry.card);
      return { entry, card };
    } catch (err) {
      // Placeholder agents (sub-agents not yet generated on Host B) have no card
      // yet. That's an expected, declared state — not an error to fabricate past.
      if (entry.status === "placeholder") return { entry };
      throw err; // an ACTIVE agent with no readable card IS a real error.
    }
  }

  async resolveAid(agentRef: string): Promise<AidResolution> {
    const { entry, card } = await this.load(agentRef);
    const aid = card ? agentAidFromCard(card) ?? "" : "";
    return {
      agentRef,
      aid,
      roleType: entry.roleType,
      role: entry.role,
      holder: entry.holder,
      lei: entry.lei,
      delegatorAid: card ? delegatorAidFromCard(card) : undefined,
      status: aid ? entry.status : "placeholder",
    };
  }

  async present(agentRef: string): Promise<CredentialPresentation> {
    const { entry, card } = await this.load(agentRef);
    const meta = card?.extensions?.vLEImetadata;
    return {
      agentRef,
      mode: this.mode,
      aid: (card && agentAidFromCard(card)) ?? "",
      roleType: entry.roleType,
      role: entry.role,
      holder: entry.holder,
      verificationPath: meta?.verificationPath,
      oobis: {
        delegatee: meta?.delegateeOOBI,
        delegator: meta?.delegatorOOBI,
        legalEntity: meta?.leOOBI,
      },
    };
  }

  async sign(agentRef: string, payload: unknown): Promise<SignedAttestation> {
    const { card } = await this.load(agentRef);
    const aid = (card && agentAidFromCard(card)) ?? "";
    // Bind the signer's AID into the hashed envelope so the attestation is
    // tied to a specific identity, not just the payload bytes.
    const envelope = canonicalize({ aid, payload });
    const signature = createHash("sha256").update(envelope, "utf8").digest("hex");
    return {
      agentRef,
      signingMode: "plain",
      aid,
      signature,
      alg: "sha256(canonicalJSON{aid,payload})",
      signedAt: new Date().toISOString(),
    };
  }

  async verify(
    input: CredentialPresentation | { agentRef: string },
  ): Promise<VerificationResult> {
    const agentRef = input.agentRef;
    const { entry, card } = await this.load(agentRef);

    if (entry.status === "placeholder" || !card) {
      return {
        verified: false,
        method: "structural",
        agentRef,
        reason:
          `agent "${agentRef}" is a placeholder (no card/AID generated on Host B yet); ` +
          `cannot verify in plain mode`,
      };
    }

    const aid = agentAidFromCard(card) ?? "";
    const lei = entry.lei;
    const leiOk = lei ? LEI_RE.test(lei) : true; // sub-agents may inherit LEI.
    const aidOk = aid.length > 0;

    if (!aidOk || !leiOk) {
      return {
        verified: false,
        method: "structural",
        agentRef,
        aid,
        reason: !aidOk
          ? `card for "${agentRef}" has no agent AID`
          : `LEI "${lei}" is not a well-formed ISO 17442 identifier`,
      };
    }

    return {
      verified: true,
      method: "structural",
      agentRef,
      aid,
      reason:
        `structural check passed (card present, AID present, LEI well-formed). ` +
        `NOTE: plain mode does NOT cryptographically walk the delegation chain — ` +
        `set CREDENTIAL_MODE=vlei for a Sally-verified chain.`,
    };
  }
}
