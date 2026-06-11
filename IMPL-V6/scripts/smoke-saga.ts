// ================= IMPL-V6 — ORCHESTRATION PLUMBING SMOKE TEST =================
//
// Purpose: prove the FOUNDATION RUNS (not just typechecks) before the 14
// agents + full graph are stacked on top. Exercises, with throwaway data:
//   1. createCheckpointer({ dbPath: ":memory:" })  — SqliteSaver actually opens
//   2. createStore()                                — InMemoryStore put/get round-trips
//   3. a minimal 2-node StateGraph over NegState    — compiles with the checkpointer,
//      runs, and the concat reducer (defensive[]) + last-write channels apply
//   4. thread_id persistence                        — getState() returns the checkpoint
//   5. namespaces + buyer-safe projection           — builder + privacy guard fire
//
// This is NOT part of the build (it lives outside src/, so `npm run typecheck`
// ignores it). Run it directly:  npx tsx scripts/smoke-saga.ts
//
// NB: uses ":memory:" for the checkpointer so it never touches ./data/audit.db.

import { StateGraph, START, END } from "@langchain/langgraph";

import { NegState, type NegStateType } from "../src/orchestrator/state/neg-state.js";
import { createCheckpointer } from "../src/orchestrator/memory/checkpointer.js";
import { createStore } from "../src/orchestrator/memory/store.js";
import {
  buyerSafeNs,
  buyerProfileNs,
  assertBuyerReadable,
  buildBuyerSafeProjection,
} from "../src/orchestrator/memory/namespaces.js";

const ORG = "jupiter";

async function main(): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean) => {
    console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
    if (!ok) failures++;
  };

  console.log("\n=== IMPL-V6 orchestration plumbing smoke test ===\n");

  const negotiationId = `NEG-${Date.now()}`;

  // ── 1. checkpointer (in-memory; SqliteSaver must actually open) ────────────
  const checkpointer = createCheckpointer({ dbPath: ":memory:" });
  check("checkpointer constructed", checkpointer != null);

  // ── 2. store (InMemoryStore) ───────────────────────────────────────────────
  const store = createStore();
  check("store constructed", store != null);

  // ── 3. minimal 2-node StateGraph over NegState ──────────────────────────────
  const intake = (_state: NegStateType): Partial<NegStateType> => ({
    negotiationId,
    buyerLEI: "54930012QJWZMYHNJW95",
    sellerLEI: "3358004DXAMRWRUIYJ05",
    status: "ACKED",
    clarifyRounds: 1, // last-write channel
  });

  const advance = (_state: NegStateType): Partial<NegStateType> => ({
    status: "QUOTING",
    negotiationRounds: 1, // last-write channel
    // concat channel — update is an array, reducer appends it
    defensive: [
      {
        action: "no-action",
        triggeredAt: new Date().toISOString(),
        triggeredBy: "treasury",
        upstreamError: "",
        rationale: "smoke-test defensive record",
      },
    ],
  });

  const graph = new StateGraph(NegState)
    .addNode("intake", intake)
    .addNode("advance", advance)
    .addEdge(START, "intake")
    .addEdge("intake", "advance")
    .addEdge("advance", END)
    .compile({ checkpointer, store });
  check("graph compiled with checkpointer + store", graph != null);

  // ── 4. invoke with a thread_id ──────────────────────────────────────────────
  const config = { configurable: { thread_id: negotiationId } };
  const result = (await graph.invoke({ negotiationId }, config)) as NegStateType;

  check("status advanced to QUOTING (last-write)", result.status === "QUOTING");
  check("clarifyRounds = 1 (last-write w/ default)", result.clarifyRounds === 1);
  check("negotiationRounds = 1 (last-write w/ default)", result.negotiationRounds === 1);
  check("defensive[] appended via concat reducer", Array.isArray(result.defensive) && result.defensive.length === 1);
  check("consultations[] default applied", Array.isArray(result.consultations) && result.consultations.length === 0);
  check("rounds[] default applied", Array.isArray(result.rounds) && result.rounds.length === 0);

  // ── 5. checkpoint persistence (thread_id) ───────────────────────────────────
  const snap = await graph.getState(config);
  check("checkpoint persisted for thread_id", snap?.values?.status === "QUOTING");

  // ── 6. store round-trip + namespaces + buyer-safe projection ────────────────
  const proj = buildBuyerSafeProjection({
    negotiationId,
    round: 1,
    status: "QUOTED",
    offer: { pricePerUnit: 370, quantity: 2000, currency: "INR", paymentTerm: "Net-30" },
  });
  check("buyer-safe projection has NO floor/PD leak", !("effectiveFloor" in proj) && !("pd1y" in proj));

  await store.put(buyerSafeNs(ORG, negotiationId), "round-1", proj as unknown as Record<string, unknown>);
  const got = await store.get(buyerSafeNs(ORG, negotiationId), "round-1");
  check("store put/get round-trips", (got?.value as { round?: number } | undefined)?.round === 1);

  // privacy guard: buyer-safe ns allowed, profile ns refused
  let guardOk = false;
  assertBuyerReadable(buyerSafeNs(ORG, negotiationId)); // must NOT throw
  try {
    assertBuyerReadable(buyerProfileNs(ORG, "54930012QJWZMYHNJW95")); // MUST throw
  } catch {
    guardOk = true;
  }
  check("privacy guard: buyer-safe allowed, profile refused", guardOk);

  console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===\n`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nSMOKE TEST CRASHED:\n", err);
  process.exit(1);
});
