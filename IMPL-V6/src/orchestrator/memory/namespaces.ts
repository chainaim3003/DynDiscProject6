// ================= IMPL-V6 — T3 STORE NAMESPACES + BUYER-SAFE PROJECTION =================
//
// Pure helpers (no I/O, no external API). Two responsibilities:
//
//   1. Namespace key builders for the T3 semantic Store (01 §3). LangGraph's
//      Store addresses values by a string[] namespace prefix + a key; these
//      builders are the single source of truth for the prefixes so no caller
//      hand-assembles them.
//
//   2. The buyer-safe projection (04 §5 privacy invariant): the buyer agent
//      may read ONLY the `buyer-safe:{negotiationId}` namespace and must NEVER
//      see the seller's effective floor, raw PD/LGD, marginPrice, minViablePrice,
//      consultations, or defensive actions. The projection is built as an
//      ALLOWLIST — it accepts only explicitly-safe fields, so private data has
//      no path to leak through it (safer than redacting a full state object).
//
// `orgId` is supplied by the caller (typically the seller org id, e.g. the
// seller LEI) — intentionally NOT hardcoded and NOT a new env flag.

// ─── Namespaces (01 §3) ──────────────────────────────────────────────────────

export type Namespace = string[];

/** [orgId,"buyers",buyerLEI,"profile"] — disclosed handles + verified website text + credit summary (DD agent). */
export function buyerProfileNs(orgId: string, buyerLEI: string): Namespace {
  return [orgId, "buyers", buyerLEI, "profile"];
}

/** [orgId,"buyers",buyerLEI,"deals"] — past deal outcomes (tactics engine). */
export function buyerDealsNs(orgId: string, buyerLEI: string): Namespace {
  return [orgId, "buyers", buyerLEI, "deals"];
}

/** [orgId,"demand","portfolio"] — open quotes + committed orders (Demand-Planning). */
export function demandPortfolioNs(orgId: string): Namespace {
  return [orgId, "demand", "portfolio"];
}

/** [orgId,"items",itemCode,"spec"] — item spec embeddings (Quoting). */
export function itemSpecNs(orgId: string, itemCode: string): Namespace {
  return [orgId, "items", itemCode, "spec"];
}

/** [orgId,"buyer-safe",negotiationId] — the ONLY namespace the buyer agent may read. */
export function buyerSafeNs(orgId: string, negotiationId: string): Namespace {
  return [orgId, "buyer-safe", negotiationId];
}

// ─── Privacy guard (04 §5 invariant) ─────────────────────────────────────────

/** True iff `ns` is a buyer-safe namespace ([orgId,"buyer-safe",...]). */
export function isBuyerReadableNamespace(ns: Namespace): boolean {
  return ns.length >= 2 && ns[1] === "buyer-safe";
}

/**
 * Enforce the privacy invariant: throws if a buyer-side reader attempts any
 * namespace other than buyer-safe. Call this at the buyer agent's Store-read
 * boundary so a mis-wired read fails loudly instead of leaking.
 */
export function assertBuyerReadable(ns: Namespace): void {
  if (!isBuyerReadableNamespace(ns)) {
    throw new Error(
      `[namespaces] buyer agent may read ONLY buyer-safe namespaces; refused: [${ns.join(", ")}]`,
    );
  }
}

// ─── Buyer-safe projection (allowlist) ───────────────────────────────────────

// Coarse, buyer-appropriate status — NOT the orchestrator's internal NegStatus
// (the buyer must not see internal phases like DD_RUNNING / QUOTING).
export type BuyerSafeStatus =
  | "RECEIVED"    // inquiry acknowledged
  | "QUOTED"      // an offer has been emitted
  | "COUNTERED"   // seller countered this round
  | "ACCEPTED"    // deal agreed
  | "DECLINED"    // seller declined / no deal
  | "ESCALATED";  // routed to a human

/** The only offer fields a buyer may see — all of which the buyer would learn
 *  from the offer message anyway. NO floor / PD / margin / minViablePrice. */
export interface BuyerSafeOffer {
  pricePerUnit?: number;
  quantity?:     number;
  deliveryDate?: string;
  paymentTerm?:  string;   // e.g. "Net-30"
  incoterm?:     string;
  currency?:     string;
}

/** Allowlist input — the orchestrator passes only these safe values. */
export interface BuyerSafeInput {
  negotiationId: string;
  round:         number;
  status:        BuyerSafeStatus;
  offer?:        BuyerSafeOffer;
  emittedAt?:    string;   // ISO; defaults to now
}

/** What gets written to buyerSafeNs(...) on each round commit (04 §5). */
export interface BuyerSafeProjection {
  negotiationId: string;
  round:         number;
  status:        BuyerSafeStatus;
  offer?:        BuyerSafeOffer;
  emittedAt:     string;
}

/**
 * Build the buyer-safe projection from explicitly-safe inputs. By taking a
 * narrow allowlist input (never the full NegState), there is no code path by
 * which effectiveFloor / pd1y / lgd / marginPrice / minViablePrice could be
 * projected to the buyer.
 */
export function buildBuyerSafeProjection(input: BuyerSafeInput): BuyerSafeProjection {
  const offer: BuyerSafeOffer | undefined = input.offer
    ? {
        pricePerUnit: input.offer.pricePerUnit,
        quantity:     input.offer.quantity,
        deliveryDate: input.offer.deliveryDate,
        paymentTerm:  input.offer.paymentTerm,
        incoterm:     input.offer.incoterm,
        currency:     input.offer.currency,
      }
    : undefined;

  return {
    negotiationId: input.negotiationId,
    round:         input.round,
    status:        input.status,
    offer,
    emittedAt:     input.emittedAt ?? new Date().toISOString(),
  };
}
