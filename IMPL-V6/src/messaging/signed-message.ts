// ================= IMPL-V6 — SIGNED MESSAGE (A2A envelope types) =================
//
// The wire shape for the A2A negotiation channel. REFINED-MultiAgent-Design-vLEI.md
// §3: "every message a signed ACDC envelope". This module defines the envelope and
// the canonicalization used to hash/sign it. Two signing modes (SIGNING_MODE flag):
//   - plain : signature = sha256 over the canonical envelope (PlainHashSigner).
//   - acdc  : signature = IPEX grant SAID via vLEIEnh1 (AcdcSigner — deferred, Host B).
//
// No external dependency here — pure types + a deterministic canonicalizer, so both
// the signer and any verifier compute byte-identical input.

/** An unsigned A2A message. */
export interface Envelope<T = unknown> {
  /** Sender binding-map ref, e.g. "jupiterSellerAgent". */
  from: string;
  /** Recipient binding-map ref, e.g. "tommyBuyerAgent". */
  to: string;
  /** Correlates all messages of one negotiation (= LangGraph thread_id). */
  negotiationId: string;
  /** Message kind, e.g. "INQUIRY" | "QUOTE" | "COUNTER" | "ACCEPT" | "REJECT". */
  type: string;
  payload: T;
  /** ISO timestamp set by the sender. */
  sentAt: string;
}

/** A signed A2A message: the envelope plus the signature fields. */
export interface SignedEnvelope<T = unknown> extends Envelope<T> {
  signingMode: "plain" | "acdc";
  /** The signer agent's AID (empty only if identity not yet minted). */
  signerAid: string;
  /** plain: hex sha256 digest; acdc: IPEX grant SAID. */
  signature: string;
  /** Canonicalization + hash/sign algorithm, for provenance. */
  alg: string;
}

/** Result of verifying a signed envelope. */
export interface EnvelopeVerification {
  verified: boolean;
  method: "hash" | "acdc";
  /** Always populated — especially on failure (no silent verification). */
  reason: string;
}

/**
 * Stable, key-sorted JSON. The SAME logical value always serializes to the SAME
 * string, so a verifier that recomputes the hash gets the signer's exact input.
 * (Mirrors the canonicalizer in identity-client/PlainJsonProvider.ts intentionally.)
 */
export function canonicalJson(value: unknown): string {
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
