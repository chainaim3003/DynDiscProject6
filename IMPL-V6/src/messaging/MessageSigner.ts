// ================= IMPL-V6 — MessageSigner INTERFACE =================
//
// Signs and verifies A2A envelopes. One interface, two implementations selected by
// the SIGNING_MODE flag (REFINED-Project-Structure.md §4):
//   - PlainHashSigner (SIGNING_MODE=plain) — sha256 envelope hash. REAL, offline.
//   - AcdcSigner      (SIGNING_MODE=acdc)  — IPEX grant via vLEIEnh1 sig-wallet (Host B). Deferred.
//
// Framework-neutral: depends only on the envelope types, so any node/agent can sign.

import type {
  Envelope,
  EnvelopeVerification,
  SignedEnvelope,
} from "./signed-message.js";

export interface MessageSigner {
  /** Which SIGNING_MODE this implementation provides. */
  readonly mode: "plain" | "acdc";

  /** Sign an envelope under the given signer AID, returning the signed envelope. */
  sign<T>(envelope: Envelope<T>, signerAid: string): Promise<SignedEnvelope<T>>;

  /** Verify a signed envelope (recompute hash / check IPEX grant). */
  verify<T>(signed: SignedEnvelope<T>): Promise<EnvelopeVerification>;
}
