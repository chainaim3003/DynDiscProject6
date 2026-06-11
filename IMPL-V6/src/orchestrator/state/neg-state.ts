// ================= IMPL-V6 — NEGOTIATION-SAGA STATE (Annotation.Root) =================
//
// The LangGraph.js StateGraph channels for the negotiation saga. Transcribed
// from 04-Orchestration-Design.md §3.1 (the channel spec) — field set, reducers,
// and defaults match it exactly:
//   - concat reducer (append-only journals): consultations, rounds, defensive,
//     attestations → replayable / time-travel friendly (04 §3.1 reducer note, §7.1)
//   - last-write: everything else.
//
// API NOTE (verified against @langchain/langgraph@1.3.6): when an options
// object is passed to Annotation<T>(...), it MUST carry a reducer (`reducer` or
// `value`); a `{ default }`-only object does not typecheck. So "last-write with
// a default" is written explicitly as { reducer: (_p, n) => n, default: ... }.
// Bare last-write channels with NO default stay as Annotation<T>() (no options).
// (04 §3.1's `{ default: () => 0 }` shorthand was spec pseudo-code, not final.)
//
// thread_id for the SqliteSaver checkpointer = negotiationId (04 §7.1, §8).
//
// Payload types are imported from src/shared/*.

import { Annotation } from "@langchain/langgraph";

import type { Inquiry } from "../../shared/inquiry-types.js";
import type { Quote }   from "../../shared/quote-types.js";
import type { DDResult } from "../../shared/due-diligence-types.js";
import type { FulfillmentPlan } from "../../shared/fulfillment-types.js";
import type { DemandView } from "../../shared/demand-types.js";
import type { RoundOutcome } from "../../shared/round-types.js";
import type {
  ConsultationRecord,
  DefensiveActionRecord,
  GleifStatus,
} from "../../shared/provider-types.js";

// last-write reducer: incoming update wins (LangGraph requires an explicit
// reducer once any option — e.g. `default` — is supplied).
const lastWrite = <T>(_prev: T, next: T): T => next;

// Orchestrator status union (04 §3.1 — distinct from the engine's
// NegotiationStatus; this tracks the saga's phase, not the bilateral deal state).
export type NegStatus =
  | "INTAKE" | "ACKED" | "DD_RUNNING" | "DD_DONE"
  | "QUOTING" | "QUOTED" | "CLARIFY"
  | "NEGOTIATING" | "ACCEPTED" | "NO_DEAL" | "ESCALATED"
  | "PERSISTING" | "PERSISTED";

// ─── Agent attestation (§7 attribution) ──────────────────────────────────────
//
// One signed decision/output, recorded so the audit can answer "which agent
// (AID + human role) stands behind this?". Written by the sub-agents (their
// decisions) and the persist node (the signed quote). Append-only journal.
export interface AgentAttestation {
  /** binding-map ref, e.g. "fulfillmentAgent" | "jupiterSellerAgent". */
  agentRef: string;
  /** OOR/ECR human role, e.g. "Operations Officer" / "Chief Sales Officer". */
  role: string;
  /** The signer's AID ("" until minted on Host B in plain mode — honest, not faked). */
  aid: string;
  /** What was signed, e.g. "fulfillment-decision" | "credit-decision" | "quote". */
  subject: string;
  /** plain: hex sha256; acdc: IPEX grant SAID. */
  signature: string;
  signingMode: "plain" | "acdc";
  signedAt: string;
}

export const NegState = Annotation.Root({
  // ── identity / linkage (bare last-write, no default) ──────────────────────
  negotiationId:   Annotation<string>(),
  opportunityName: Annotation<string | null>(),
  quotationName:   Annotation<string | null>(),
  buyerLEI:        Annotation<string>(),   // 54930012QJWZMYHNJW95
  sellerLEI:       Annotation<string>(),   // 3358004DXAMRWRUIYJ05

  // ── inquiry (parsed) ───────────────────────────────────────────────────────
  inquiry:       Annotation<Inquiry>(),
  clarifyRounds: Annotation<number>({ reducer: lastWrite, default: () => 0 }), // bounded by CLARIFY_MAX_ROUNDS

  // ── consultations (append-only journal) ────────────────────────────────────
  consultations: Annotation<ConsultationRecord<unknown>[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),

  // ── intermediate results per phase (bare last-write, no default) ────────────
  gleif:           Annotation<{ buyer: GleifStatus; seller: GleifStatus } | null>(),
  ddResult:        Annotation<DDResult | null>(),
  fulfillmentPlan: Annotation<FulfillmentPlan | null>(),
  quoteDraft:      Annotation<Quote | null>(),
  demandView:      Annotation<DemandView | null>(),

  // ── negotiation (append-only) ───────────────────────────────────────────────
  rounds: Annotation<RoundOutcome[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
  negotiationRounds: Annotation<number>({ reducer: lastWrite, default: () => 0 }), // bounded by NEGOTIATION_MAX_ROUNDS

  // ── identity attribution (§7) — append-only journal of signed decisions ─────
  attestations: Annotation<AgentAttestation[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),

  // ── outcome ──────────────────────────────────────────────────────────────────
  status: Annotation<NegStatus>(),
  defensive: Annotation<DefensiveActionRecord[]>({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

// Convenience alias for node signatures: (state: NegStateType) => Partial<NegStateType>
export type NegStateType = typeof NegState.State;
