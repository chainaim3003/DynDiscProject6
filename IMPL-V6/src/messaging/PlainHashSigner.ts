// ================= IMPL-V6 — PlainHashSigner (SIGNING_MODE=plain) =================
//
// The DEFAULT message signer. REAL, fully offline — no Host B. Signs an A2A envelope
// with a sha256 digest over the canonical {signerAid, envelope}, and verifies by
// recomputation. Deterministic and tamper-evident: any change to from/to/type/payload/
// negotiationId/sentAt OR to the signerAid changes the digest, so verify() fails.
//
// This is exactly what "SIGNING_MODE=plain (sha256 envelope)" means in .env.example.
// It does NOT prove the signer's identity is a real delegated AID — that is the acdc
// mode's job (AcdcSigner → vLEIEnh1). verify() reports method="hash" so callers never
// mistake a hash match for a credential proof.

import { createHash } from "node:crypto";

import type { MessageSigner } from "./MessageSigner.js";
import {
  canonicalJson,
  type Envelope,
  type EnvelopeVerification,
  type SignedEnvelope,
} from "./signed-message.js";

const ALG = "sha256(canonicalJSON{signerAid,envelope})";

export class PlainHashSigner implements MessageSigner {
  readonly mode = "plain" as const;

  private digest<T>(envelope: Envelope<T>, signerAid: string): string {
    return createHash("sha256")
      .update(canonicalJson({ signerAid, envelope }), "utf8")
      .digest("hex");
  }

  async sign<T>(envelope: Envelope<T>, signerAid: string): Promise<SignedEnvelope<T>> {
    return {
      ...envelope,
      signingMode: "plain",
      signerAid,
      signature: this.digest(envelope, signerAid),
      alg: ALG,
    };
  }

  async verify<T>(signed: SignedEnvelope<T>): Promise<EnvelopeVerification> {
    if (signed.signingMode !== "plain") {
      return {
        verified: false,
        method: "hash",
        reason:
          `PlainHashSigner cannot verify signingMode="${signed.signingMode}"; ` +
          `use the acdc signer for IPEX-signed envelopes`,
      };
    }
    // Reconstruct the original (unsigned) envelope by dropping the signature fields,
    // then recompute the digest over it with the claimed signerAid.
    const { signingMode, signerAid, signature, alg, ...envelope } =
      signed as SignedEnvelope<T> & Record<string, unknown>;
    void signingMode;
    void alg;
    const expected = this.digest(envelope as unknown as Envelope<T>, signerAid);
    if (expected !== signature) {
      return {
        verified: false,
        method: "hash",
        reason: "sha256 mismatch — envelope was altered after signing, or signerAid differs",
      };
    }
    return {
      verified: true,
      method: "hash",
      reason:
        "sha256 envelope hash matches (tamper-evident). NOTE: this proves integrity, " +
        "not that signerAid is a credentialed delegated AID — use SIGNING_MODE=acdc for that.",
    };
  }
}
