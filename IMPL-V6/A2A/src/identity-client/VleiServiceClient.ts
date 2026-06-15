// ================= IMPL-V6 — identity-client / VleiServiceClient (CREDENTIAL_MODE=vlei) =================
//
// The vlei-mode CredentialProvider (REFINED-Project-Structure.md §1/§2). Mirrors
// PlainJsonProvider's interface but resolves identity from Host B (vLEIEnh1):
//   - resolveAid : binding-map + synced card  (delegation.ts)                 [REAL]
//   - present    : build the AID→OOR/ECR→LE→QVI→GLEIF presentation from card  [REAL]
//   - verify     : Sally chain walk via the api-server /api/verify/{party}     [REAL]
//   - sign       : IPEX grant via the Host B sig-wallet                        [DEFERRED]
//
// HONEST BOUNDARY (Rule 2/4/8 — the whole reason this is split out):
//   REFINED-Project-Structure.md §6 confirms the api-server exposes ONLY /health
//   + /api/verify/seller|buyer today; issuance/IPEX-grant is driven by Host B
//   SHELL SCRIPTS, not a REST route. So sign() CANNOT call a documented signing
//   endpoint. Rather than fabricate an ACDC SAID, sign() THROWS and points at
//   messaging/AcdcSigner.ts (the SIGNING_MODE=acdc surface, deferred). This keeps
//   the vlei verify path real while never inventing a signature.
//
// PLAIN MODE is unaffected: this class is only constructed when CREDENTIAL_MODE=vlei
// (identity/index.ts factory). With CREDENTIAL_MODE=plain nothing here runs.

import type { CredentialMode } from "../config/flags.js";
import type { IdentityFlags } from "../config/identity-flags.js";
import type {
  AidResolution,
  CredentialPresentation,
  CredentialProvider,
  SignedAttestation,
  VerificationResult,
} from "../identity/CredentialProvider.js";

import { resolveOobiConfig, assertVleiEndpoints, type OobiConfig } from "./oobi-config.js";
import { SallyVerifierClient, type VerifyParty } from "./sally-verifier-client.js";
import {
  loadBindingMapFile,
  findBindingEntry,
  resolveCardPath,
  loadCardIfPresent,
  resolveAidFromBinding,
} from "./delegation.js";
import type { BindingMap } from "../identity/CredentialProvider.js";

/** Principal agentRef → the documented verify route. Sub-agents have no route. */
const PARTY_BY_AGENT: Readonly<Record<string, VerifyParty>> = {
  jupiterSellerAgent: "seller",
  tommyBuyerAgent: "buyer",
};

export class VleiServiceClient implements CredentialProvider {
  readonly mode: CredentialMode = "vlei";

  private readonly idf: Readonly<IdentityFlags>;
  private readonly cfg: OobiConfig;
  private readonly sally: SallyVerifierClient;
  private bindingMap: BindingMap | null = null;

  constructor(identityFlags: Readonly<IdentityFlags>) {
    this.idf = identityFlags;
    this.cfg = resolveOobiConfig(identityFlags);
    this.sally = new SallyVerifierClient({ apiBaseUrl: this.cfg.vleiApiUrl });
  }

  private map(): BindingMap {
    if (!this.bindingMap) this.bindingMap = loadBindingMapFile(this.idf.BINDING_MAP);
    return this.bindingMap;
  }

  /** Resolve agentRef → AID + role metadata (placeholder if the card isn't synced). */
  async resolveAid(agentRef: string): Promise<AidResolution> {
    return resolveAidFromBinding(agentRef, this.idf, this.map());
  }

  /** Build the credential presentation a counterparty/judge would verify. */
  async present(agentRef: string): Promise<CredentialPresentation> {
    const res = resolveAidFromBinding(agentRef, this.idf, this.map());
    const found = findBindingEntry(this.map(), agentRef);
    const card = found ? loadCardIfPresent(resolveCardPath(this.idf, found.entry)) : null;
    const v = card?.extensions?.vLEImetadata;

    return {
      agentRef,
      mode: "vlei",
      aid: res.aid,
      roleType: res.roleType,
      role: res.role,
      holder: res.holder,
      verificationPath: v?.verificationPath,
      oobis: {
        delegatee: v?.delegateeOOBI,
        delegator: v?.delegatorOOBI,
        legalEntity: v?.leOOBI,
      },
    };
  }

  /**
   * Sign/attest under the agent's identity. DEFERRED in vlei mode: a real ACDC
   * IPEX grant requires the Host B sig-wallet, which has no documented REST route
   * today (REFINED-Project-Structure.md §6). Throws rather than fabricate a SAID.
   */
  async sign(agentRef: string, _payload: unknown): Promise<SignedAttestation> {
    throw new Error(
      `[VleiServiceClient] sign() not wired for agentRef="${agentRef}". ACDC/IPEX-grant ` +
        `signing belongs to messaging/AcdcSigner.ts (SIGNING_MODE=acdc), which is deferred: ` +
        `the vLEIEnh1 api-server exposes only /health + /api/verify/* today (no issuance route). ` +
        `Use CREDENTIAL_MODE=plain for sha256 attestations, or implement AcdcSigner against the ` +
        `Host B sig-wallet first. No signature is fabricated.`,
    );
  }

  /** Verify a counterparty (or self) chain via the api-server's Sally route. */
  async verify(
    input: CredentialPresentation | { agentRef: string },
  ): Promise<VerificationResult> {
    // Both union members carry agentRef, so read it directly (a `"agentRef" in input`
    // guard would narrow the else-branch to `never`).
    const agentRef = input.agentRef;
    const party = PARTY_BY_AGENT[agentRef];

    if (!party) {
      return {
        verified: false,
        method: "cryptographic",
        agentRef,
        reason:
          `[VleiServiceClient] no verify route for agentRef="${agentRef}". The api-server ` +
          `exposes /api/verify/seller|buyer only; sub-agent chain verification is not a ` +
          `documented endpoint (REFINED-Project-Structure.md §6).`,
      };
    }

    assertVleiEndpoints(this.cfg, ["vleiApiUrl"]);
    const res = await this.resolveAid(agentRef);
    const result = await this.sally.verifyParty(party, {
      agentRef,
      ...(res.aid ? { aid: res.aid } : {}),
    });
    return { ...result, agentRef, aid: res.aid || undefined };
  }
}
