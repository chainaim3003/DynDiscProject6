// ================= IMPL-V6 — NEGOTIATION StateGraph (DD + ATP + Negotiate/Veto + Persist/Sign) =================
//
// Builds + compiles the LangGraph.js StateGraph for the negotiation saga.
//
//   START → intake.parse → intake.mirrorToERPNext → ackToBuyer
//         → dueDiligence.run            (GLEIF + credit → payment term; pass-through if no "DD")
//         → quoting.start → fulfillment.plan → quoting.draftQuote
//         → negotiate.run ─┬─(deal / pass-through)→ persist.signAndPersist → END
//                          └─(NO_DEAL / ESCALATED)──────────────────────────→ END
//
// Identity (REFINED-MultiAgent-Design-vLEI.md §2/§5/§6/§7): one agent runtime, one shared
// CredentialProvider. Signed + attributed decisions: DD/credit (Credit Officer), fulfillment
// ATP/CTP (Operations Officer), the BINDING treasury veto (Treasurer) + buyer moves (CPO)
// per round, and the final quote (Chief Sales Officer at persist). All append to
// state.attestations (§7).
//
// DD + NEGOTIATION are no-op pass-throughs when not requested (no "DD"/"N" dimension and no
// buyer target), so the deterministic happy path (P01-P02) is unchanged.
//
// thread_id = negotiationId is supplied per-invocation (run.ts). Every super-step
// checkpoints to the shared SqliteSaver (T2/T5); the T3 Store is attached.
//
// WAREHOUSE: the inventory provider needs the ERPNext Warehouse DOC NAME (with company
// abbr, e.g. "MADRAS-WH-1 - JKC"). Set ERPNEXT_DEFAULT_WAREHOUSE or pass deps.warehouse.
//
// CREDIT PROVIDER: inject deps.creditProvider (real), or pass deps.creditFixturesDir to use
// the fixture-backed demo provider. If neither is supplied, a "DD"-dimension inquiry fails
// loud at the credit step (no fabrication); non-DD inquiries pass through DD untouched.
//
// DEFERRED: Logistics (DCSA), the LLM optimizer (negotiate uses a deterministic placeholder),
// real ACTUS for treasury, real EDGAR/Companies-House for credit, A2A two-party transport.

import { StateGraph, START, END } from "@langchain/langgraph";

import { NegState, type NegStateType } from "./state/neg-state.js";
import { buildIntakeNodes, INTAKE_NODE } from "./nodes/intake.js";
import { buildDueDiligenceNode, DUE_DILIGENCE_NODE } from "./nodes/due-diligence.js";
import { buildQuotingNodes, QUOTING_NODE } from "./nodes/quoting.js";
import { buildFulfillmentNode, FULFILLMENT_NODE } from "./nodes/fulfillment.js";
import { buildNegotiateNode, NEGOTIATE_NODE } from "./nodes/negotiate.js";
import { buildPersistNode, PERSIST_NODE } from "./nodes/persist.js";
import { createCheckpointer } from "./memory/checkpointer.js";
import { createStore } from "./memory/store.js";
import { createInventoryProvider } from "../shared/inventory-provider.js";
import { createDemoCreditProvider } from "../shared/credit-provider.js";
import { buildAgentRuntime } from "../agents/runtime.js";
import { createBuyerTransport } from "../agents/transport/buyer-transport.js";
import type { CredentialProvider } from "../identity/CredentialProvider.js";
import type { CreditProvider } from "../shared/provider-types.js";
import type { OrchestratorFlags } from "../config/flags.js";
import type { ErpNextClient } from "../erpnext/client.js";

export interface BuildGraphDeps {
  /** Resolved once at startup; threaded into nodes (no per-node env reads). */
  flags: OrchestratorFlags;
  /** Single ERPNext client (intake.mirror writes Opportunity; inventory reads Bin; persist writes Quotation). */
  erp: ErpNextClient;
  /** Selling Price List the quoting nodes read. Default "Standard Selling". */
  priceList?: string;
  /** ERPNext Warehouse doc NAME for Bin lookups. Default flags.ERPNEXT_DEFAULT_WAREHOUSE. */
  warehouse?: string;
  /** Identity provider shared by all agents. Defaults to one built from flags. */
  provider?: CredentialProvider;
  /** Credit provider for DD (real GLEIF/EDGAR). Else built from creditFixturesDir (demo). */
  creditProvider?: CreditProvider;
  /** Directory of <lei>.json credit fixtures for the demo CreditProvider (if creditProvider not injected). */
  creditFixturesDir?: string;
  /** Configured treasury floor (price/unit) for negotiate in demo mode. Real mode → ACTUS (not wired). */
  negotiateDemoFloor?: number;
  /** Buyer reservation (max price/unit) override; else the inquiry's stated target. */
  buyerMaxUnitPrice?: number;
  /** Emit ERPNext custom identity fields — only once the erpnextEnh1 quotation fixture exists. */
  persistCustomFields?: boolean;
  /** Inject a checkpointer (e.g. ":memory:" for tests); else built from flags. */
  checkpointer?: ReturnType<typeof createCheckpointer>;
  /** Inject a Store; else built from flags. */
  store?: ReturnType<typeof createStore>;
}

/** After negotiate: a real no-deal escalates (no Quotation); everything else persists. */
function routeAfterNegotiate(state: NegStateType): "persist" | "end" {
  return state.status === "ESCALATED" || state.status === "NO_DEAL" ? "end" : "persist";
}

/**
 * Build and compile the negotiation graph (Φ2 DD → Φ3 quoting/ATP → Φ4 negotiate+veto →
 * Φ5 persist+sign), with agent-owned, signed decisions throughout.
 */
export function buildNegotiationGraph(deps: BuildGraphDeps) {
  const warehouse = deps.warehouse ?? deps.flags.ERPNEXT_DEFAULT_WAREHOUSE;
  const inventory = createInventoryProvider(deps.erp, { warehouse });

  // Credit provider: injected real, or fixture-backed demo from a fixtures dir, or none
  // (DD-dimension inquiries then fail loud at the credit step — no fabrication).
  const creditProvider: CreditProvider | undefined =
    deps.creditProvider ??
    (deps.creditFixturesDir
      ? createDemoCreditProvider({ fixturesDir: deps.creditFixturesDir })
      : undefined);

  // One runtime → one shared CredentialProvider for every agent.
  const runtime = buildAgentRuntime({
    flags: deps.flags,
    provider: deps.provider,
    inventoryProvider: inventory,
    creditProvider,
  });

  const intake = buildIntakeNodes({ flags: deps.flags, erp: deps.erp });
  const dueDiligence = buildDueDiligenceNode({
    flags: deps.flags,
    creditAgent: runtime.ddCredit,
    creditContext: runtime.contextFor("ddCreditAgent"),
  });
  const quoting = buildQuotingNodes({ flags: deps.flags, priceList: deps.priceList });
  const fulfillment = buildFulfillmentNode({
    agent: runtime.fulfillment,
    context: runtime.contextFor("fulfillmentAgent"),
  });
  const negotiate = buildNegotiateNode({
    flags: deps.flags,
    treasury: runtime.treasury,
    treasuryContext: runtime.contextFor("treasuryAgent"),
    buyer: createBuyerTransport(deps.flags, runtime.buyer), // inprocess (default) | a2a, per BUYER_TRANSPORT
    sellerContext: runtime.contextFor("jupiterSellerAgent"),
    demoFloor: deps.negotiateDemoFloor,
    buyerMaxUnitPrice: deps.buyerMaxUnitPrice,
  });
  const persist = buildPersistNode({
    erp: deps.erp,
    provider: runtime.provider,
    flags: deps.flags,
    includeCustomFields: deps.persistCustomFields,
  });

  const builder = new StateGraph(NegState)
    // ── Φ1 intake (deterministic) ──────────────────────────────────────────
    .addNode(INTAKE_NODE.parse, intake.intakeParse)
    .addNode(INTAKE_NODE.mirror, intake.intakeMirrorToERPNext)
    .addNode(INTAKE_NODE.ack, intake.ackToBuyer)
    // ── Φ2 due-diligence (GLEIF + credit → payment term; pass-through if no "DD") ──
    .addNode(DUE_DILIGENCE_NODE.run, dueDiligence.dueDiligence)
    // ── Φ3 quoting + ATP (fulfillment decision agent-owned + signed) ────────
    .addNode(QUOTING_NODE.start, quoting.quotingStart)
    .addNode(FULFILLMENT_NODE.plan, fulfillment.fulfillmentPlan)
    .addNode(QUOTING_NODE.draft, quoting.quotingDraftQuote)
    // ── Φ4 negotiate (bounded loop + BINDING treasury veto) ─────────────────
    .addNode(NEGOTIATE_NODE.run, negotiate.negotiate)
    // ── Φ5 persist + sign (identity materialization point) ──────────────────
    .addNode(PERSIST_NODE.persist, persist.signAndPersist)
    // ── edges ──────────────────────────────────────────────────────────────
    .addEdge(START, INTAKE_NODE.parse)
    .addEdge(INTAKE_NODE.parse, INTAKE_NODE.mirror)
    .addEdge(INTAKE_NODE.mirror, INTAKE_NODE.ack)
    .addEdge(INTAKE_NODE.ack, DUE_DILIGENCE_NODE.run)
    .addEdge(DUE_DILIGENCE_NODE.run, QUOTING_NODE.start)
    .addEdge(QUOTING_NODE.start, FULFILLMENT_NODE.plan)
    .addEdge(FULFILLMENT_NODE.plan, QUOTING_NODE.draft)
    .addEdge(QUOTING_NODE.draft, NEGOTIATE_NODE.run)
    .addConditionalEdges(NEGOTIATE_NODE.run, routeAfterNegotiate, {
      persist: PERSIST_NODE.persist,
      end: END,
    })
    .addEdge(PERSIST_NODE.persist, END);

  const checkpointer = deps.checkpointer ?? createCheckpointer({ flags: deps.flags });
  const store = deps.store ?? createStore({ flags: deps.flags });

  return builder.compile({ checkpointer, store });
}

export type NegotiationGraph = ReturnType<typeof buildNegotiationGraph>;
