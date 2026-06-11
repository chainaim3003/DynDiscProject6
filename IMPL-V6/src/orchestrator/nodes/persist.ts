// ================= IMPL-V6 — Φ5 PERSIST NODE (sign + persist Quotation) =================
//
// The seller's final phase (REFINED-MultiAgent-Design-vLEI.md §5.2 phase 5):
// "Persist + sign + audit — apply the delegated-AID signature here (this is the
// vLEI materialization point)."
//
// What it does, in order:
//   1. SIGN the drafted quote under the jupiterSellerAgent identity
//      (provider.sign → plain sha256 attestation).
//   2. STAMP the domain Quote with issuer identity + signedEnvelopeHash (provenance).
//   3. RECORD an AgentAttestation into state.attestations (§7 — who signed what).
//   4. PERSIST a Quotation to ERPNext (native fields; custom identity fields are
//      gated in the mapper until the erpnextEnh1 quotation fixture exists).
//
// HONEST FAILURE (Rule 2/8): a failed ERPNext insert THROWS (ErpNextError) — the
// system-of-record write is real; we never report a fabricated quotationName. The
// SIGN/ATTEST steps do not require ERPNext and always run first, so the signature
// is computed even if persistence later fails (the error names the cause).

import type { NegStateType, AgentAttestation } from "../state/neg-state.js";
import type { Quote } from "../../shared/quote-types.js";
import type { OrchestratorFlags } from "../../config/flags.js";
import type { ErpNextClient } from "../../erpnext/client.js";
import type { CredentialProvider } from "../../identity/CredentialProvider.js";
import { mapQuoteToQuotationPayload } from "../../erpnext/quotation-mapper.js";
import {
  idempotentInsertByField,
  idempotentInsertViaLedger,
  getIdempotencyLedger,
} from "../../erpnext/idempotency.js";

export const PERSIST_NODE = {
  persist: "persist.signAndPersist",
} as const;

/** The seller principal signs the quote. */
const SELLER_REF = "jupiterSellerAgent";

export interface PersistDeps {
  erp: ErpNextClient;
  /** Identity provider (plain) — used to sign the quote. */
  provider: CredentialProvider;
  flags: OrchestratorFlags;
  /** Buyer Customer doc name (default = seeded buyer in the mapper). */
  customerName?: string;
  /** Emit ERPNext custom identity fields — only once the erpnextEnh1 fixture exists. */
  includeCustomFields?: boolean;
}

export interface PersistNodes {
  signAndPersist: (state: NegStateType) => Promise<Partial<NegStateType>>;
}

export function buildPersistNode(deps: PersistDeps): PersistNodes {
  async function signAndPersist(state: NegStateType): Promise<Partial<NegStateType>> {
    const quote = state.quoteDraft;
    if (quote === undefined || quote === null) {
      throw new Error("[persist.signAndPersist] no quoteDraft in state — run quoting first");
    }

    // 1. SIGN the quote under the seller's identity (covers the economic content).
    const presentation = await deps.provider.present(SELLER_REF);
    const attestation = await deps.provider.sign(SELLER_REF, quote);

    // 2. STAMP issuer + signature into the domain quote (provenance metadata).
    const stamped: Quote = {
      ...quote,
      issuer: {
        agent: SELLER_REF,
        oor: presentation.holder,
        sellerLei: state.sellerLEI,
        sellerAgentAid: presentation.aid || undefined,
        credentialMode: deps.provider.mode,
      },
      signedEnvelopeHash: attestation.signature,
      status: "Open",
    };

    // 3. RECORD the attestation (§7 — append-only journal of signed decisions).
    const record: AgentAttestation = {
      agentRef: SELLER_REF,
      role: presentation.role,
      aid: attestation.aid,
      subject: "quote",
      signature: attestation.signature,
      signingMode: attestation.signingMode,
      signedAt: attestation.signedAt,
    };

    // 4. PERSIST to ERPNext (system of record). Throws on failure — no fake name.
    //    IDEMPOTENT on re-run (gap G3): a repeated saga for the same negotiationId
    //    reuses the prior Quotation instead of inserting a duplicate.
    //      - includeCustomFields=true  → custom_negotiation_id IS written + queryable
    //                                    → ERPNext-side dedupe (idempotentInsertByField).
    //      - includeCustomFields=false → custom_negotiation_id is GATED OFF
    //                                    (quotation-mapper.ts, no fixture yet) → dedupe
    //                                    via the local ledger in AUDIT_DB_PATH.
    const body = mapQuoteToQuotationPayload(stamped, {
      company: deps.flags.ERPNEXT_COMPANY,
      customerName: deps.customerName,
      includeCustomFields: deps.includeCustomFields,
    });

    const negotiationId = state.negotiationId ?? stamped.negotiationId ?? "";
    const idempotent = deps.flags.IDEMPOTENT_WRITES;

    let quotationName: string;
    if (deps.includeCustomFields) {
      const r = await idempotentInsertByField(deps.erp, {
        doctype: "Quotation",
        keyField: "custom_negotiation_id",
        keyValue: negotiationId,
        body,
        enabled: idempotent,
      });
      quotationName = r.name;
    } else {
      const r = await idempotentInsertViaLedger(
        deps.erp,
        getIdempotencyLedger(deps.flags.AUDIT_DB_PATH),
        { doctype: "Quotation", negotiationId, body, enabled: idempotent },
      );
      quotationName = r.name;
    }

    return {
      quoteDraft: { ...stamped, quotationName },
      quotationName,
      attestations: [record],
      status: "PERSISTED",
    };
  }

  return { signAndPersist };
}
