// ================= IMPL-V6 — identity-client (public surface) =================
//
// Realizes REFINED-Project-Structure.md §2's identity-client/ package. For now
// the CredentialProvider INTERFACE + the plain implementation still physically
// live in ../identity/ (PlainJsonProvider, CredentialProvider.ts); this package
// adds the vlei-mode pieces and re-exports the shared types so callers can depend
// on a single import site.
//
// MIGRATION NOTE (honest — not a hidden shortcut): the design's final shape moves
// PlainJsonProvider + CredentialProvider.ts physically into this folder and points
// every importer here. That file move + importer rewrite is the remaining,
// mechanical P1 step (deferred). FUNCTIONALLY, vlei mode is already reachable:
// identity/index.ts's createCredentialProvider returns VleiServiceClient when
// CREDENTIAL_MODE=vlei — no caller changes needed to activate it.

// ── vlei-mode components (new, this package) ─────────────────────────────────
export { VleiServiceClient } from "./VleiServiceClient.js";
export { SallyVerifierClient, type VerifyParty, type SallyVerifierOptions } from "./sally-verifier-client.js";
export { resolveOobiConfig, assertVleiEndpoints, type OobiConfig } from "./oobi-config.js";
export {
  loadBindingMapFile,
  findBindingEntry,
  resolveCardPath,
  loadCardIfPresent,
  resolveAidFromBinding,
  type BindingKind,
} from "./delegation.js";

// ── shared interface + types (re-exported from the current home in ../identity) ──
export type { CredentialMode } from "../config/flags.js";
export type {
  CredentialProvider,
  AidResolution,
  CredentialPresentation,
  SignedAttestation,
  VerificationResult,
  AgentCard,
  BindingMap,
  BindingEntry,
  RoleType,
  BindingStatus,
} from "../identity/CredentialProvider.js";
