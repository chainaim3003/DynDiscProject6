// ================= IMPL-V6 — identity FACTORY (plain only) =================
//
// Plain sha256 attestations are this project's credential baseline. The vLEI /
// KERI / Host-B layer (VleiServiceClient, Sally verifier, delegation resolver,
// OOBI config) was removed in the IMPL-V6 "no-vLEI" restructure. PlainJsonProvider
// is now the ONLY CredentialProvider; CREDENTIAL_MODE is fixed to "plain".
//
// Removing vLEI does NOT remove signing: PlainJsonProvider still produces the
// sha256 attestations that populate state.attestations (REFINED design §7).
//
// Usage:
//   import { createCredentialProvider } from "./identity/index.js";
//   const provider = createCredentialProvider(flags, identityFlags);
//   const att = await provider.sign("jupiterSellerAgent", quotePayload);

import type { OrchestratorFlags } from "../config/flags.js";
import type { IdentityFlags } from "../config/identity-flags.js";
import type { CredentialProvider } from "./CredentialProvider.js";
import { PlainJsonProvider } from "./PlainJsonProvider.js";
import { VleiServiceClient } from "../identity-client/VleiServiceClient.js";

export type { CredentialProvider } from "./CredentialProvider.js";
export * from "./CredentialProvider.js";
export { PlainJsonProvider } from "./PlainJsonProvider.js";
export {
  loadBindingMap,
  loadAgentCard,
  findBinding,
} from "./agent-card-loader.js";

export function createCredentialProvider(
  flags: Readonly<OrchestratorFlags>,
  identityFlags: Readonly<IdentityFlags>,
): CredentialProvider {
  switch (flags.CREDENTIAL_MODE) {
    case "plain":
      return new PlainJsonProvider(identityFlags);
    case "vlei":
      // Host B (vLEIEnh1) provider: resolveAid/present/verify are real; sign()
      // throws until messaging/AcdcSigner lands (see VleiServiceClient).
      return new VleiServiceClient(identityFlags);
    default: {
      // Exhaustiveness guard over CredentialMode ("plain" | "vlei").
      const _never: never = flags.CREDENTIAL_MODE;
      throw new Error(`[identity] unknown CREDENTIAL_MODE: ${String(_never)}`);
    }
  }
}
