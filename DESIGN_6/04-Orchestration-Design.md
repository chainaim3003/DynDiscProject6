# IMPL-V6 — Multi-Agent Orchestration Design

> Grounded in:
> - **Locked architecture** (continuation prompt §4.1; `DynDisc-NANDA-ENT-Sim-Ph1-Architecture.md` + `LangGraph-TS-MemoryDesign.md`).
> - **Verified existing code** (this session): `provider-types.ts`, `inventory-provider.ts`, `negotiation-types.ts`, `consultation-router.ts`.
> - **Verified ERPNext schemas** (this session): Opportunity, Quotation + items, Payment Schedule, Item Variant Attribute.
> - **Anthropic, "Building Effective Agents"** patterns the locked design references (workflow > agent where possible; augmented LLM; routing; parallelization; orchestrator-workers; evaluator-optimizer).

This document covers what you asked for explicitly: **task decomposition**, **sub-agents**, **branching/join**, **looping**, **sequential / parallel**, **recursion**, **agent-wise memory**, **latency**, **StateGraph**.

---

## 0. Honest framing — "agent or workflow?"

The locked decomposition principle (from continuation prompt §4.1, grounded in Anthropic's guidance): **an agent only when it owns a decision, holds private state/memory, or must be independently callable. Otherwise tool-call.** That's why GLEIF / EDGAR / ERPNext / DCSA / ACTUS fetches are **tools, not agents**. And it's why most of the 14 nodes below are **deterministic workflow nodes**, not LLM-driven agents. Only **DD** and **Negotiation** carry true LLM reasoning; the rest are routed, parallelized, and join-merged plain code.

This matters for the graph: deterministic nodes are cheap, predictable, and parallelizable; LLM nodes are the latency and non-determinism budget.

---

## 1. Task decomposition — 5 phases, each prompt's path through them

| Phase | What happens | Always runs? | LLM in this phase? | Output |
|---|---|---|---|---|
| **Φ1 INTAKE** | Parse buyer message, mirror to ERPNext as `Opportunity`, ACK | yes (all 10) | no (deterministic parse) | `inquiry`, `opportunityName`, `negotiationId` |
| **Φ2 DD** | GLEIF on both LEIs + (optional) Credit on buyer + (optional) Info-Collection | conditional (gated by `inquiry.custom_dd_required` and prompt) | optional (LLM for credit rationale) | `gleifVerified`, `recommendedTerms`, `creditSummary` |
| **Φ3 QUOTING** | Per-line Inventory (ATP) + Logistics (per destination) + Treasury (per candidate term) + optional Demand-Planning → priced quote draft | yes | no | `quoteDraft` (lines + freight + Incoterm + payment-schedule) |
| **Φ4 NEGOTIATION** | Bounded loop (max-rounds=3): LLM propose → constraints → Treasury veto → emit | conditional (gated by target prices + `max_negotiation_rounds > 0`) | **yes** (Gemini 2.5 Pro per round) | `rounds[]`, `agreedQuote` or `escalated` |
| **Φ5 PERSIST** | Sign envelope → write `Quotation` to ERPNext → PDF → audit close | yes (Φ4 outcome decides what gets persisted) | no | `quotationName`, `revision`, `envelopeHash` |

**Prompt → phases activated:**

| Prompt | Φ1 | Φ2 (DD) | Φ3 (Quote) | Φ4 (Negot) | Φ5 (Persist) |
|---|---|---|---|---|---|
| P01–P02 | ✓ | GLEIF only | ✓ | — | — (or draft only) |
| P03 | ✓ | GLEIF only | ✓ + ATP-short | — | — |
| P04 | ✓ | GLEIF only | ✓ × 2 destinations | — | — |
| P05 | ✓ | **full DD → recommendedTerms** | ✓ | — | — |
| P06 | ✓ | GLEIF only | ✓ + **split shipment** | — | — |
| P07 | ✓ | GLEIF only | ✓ | **1 round** | — |
| P08 | ✓ | full DD | ✓ | **3 rounds** | — |
| P09 | ✓ | GLEIF only | ✓ + **demand-aware** | 2 rounds | — |
| P10 | ✓ | full DD | ✓ + demand-aware + split | 3 rounds | **✓ final quote** |

---

## 2. The 14 sub-agents — boundaries, IO contracts, "owns a decision?"

| # | Agent | Net-new? | Owns which decision | Private state (T1+T2) | Reads | Writes | Tools it wraps |
|---|---|---|---|---|---|---|---|
| 1 | **Orchestrator shell** (jupiterSellerAgent entry) | shell | "what phase next" | full `NegState` | all T2 | all T2 | (none; routes) |
| 2 | **Intake** | extension of existing seller | "is this a valid inquiry?" | parsed inquiry, OpportunityName | prompt text | T2.`inquiry`, T4.Opportunity | ERPNext REST |
| 3 | **Buyer** (tommyBuyerAgent) | reused, minimal | "build inquiry / answer clarification" | buyer-safe projection | T2 buyer-safe namespace only | sends OFFER/COUNTER | n/a (called by judge via OpenClaw) |
| 4 | **DD (orchestrates Credit + Info-Collection)** | **net-new** | "what payment term will we offer?" | DD findings | GLEIF, Credit, Info-Collection results | T2.`ddResult`, T3.`buyers/{lei}/profile` | (delegates) |
| 5 | **Info-Collection** | **net-new** | "is this buyer who they claim?" (no scraping — see §9) | website text, disclosed handles | buyer's website (no-login), disclosed handles, Companies House | T3.`buyers/{lei}/profile` | website fetch, EDGAR, CH |
| 6 | **Credit** | reused | "pd1y, lgd, recommendedTerms" | last credit consult | GLEIF + EDGAR + commodity index | T2.consultations, T3.`buyers/{lei}/profile` | GLEIF v1, EDGAR companyfacts |
| 7 | **Inventory** | reused | "can we fulfill this line by this date?" | last ATP per line | ERPNext `Bin` live | T2.consultations | ERPNext REST `/api/resource/Bin` |
| 8 | **Logistics** | reused | "freight quote, transit days, Incoterm fit" | last carrier quote | DCSA carrier feed (real or demo) | T2.consultations | DCSA T&T |
| 9 | **Treasury** | reused | "is this price/term approved? minViablePrice?" | last sim | ACTUS PAM (port 8083) + balance-sheet snapshot | T2.consultations | ACTUS RiskService |
| 10 | **Quoting** | **net-new** | "draft quote from ATP/freight/term inputs" | quote draft | all consultations | T2.`quoteDraft` | (deterministic merge) |
| 11 | **Demand-Planning** | **net-new** | "given other commitments, can we promise this?" | committed orders + open quotes snapshot | T3.`demand/portfolio`, ERPNext `Sales Order` | T2.`demandView` | ERPNext REST |
| 12 | **Fulfillment** | **net-new** | "ATP-only vs CTP-needed vs split?" | per-line plan | Inventory + Demand-Planning | T2.`fulfillmentPlan` | (deterministic) |
| 13 | **DvP** | **net-new, DEFERRED** | "milestone reached, release funds?" | milestone state | external webhooks (bank/chain) | DvP saga T2 | escrow, bank/chain (Algorand) |
| 14 | **Audit-Reporting** | reused | "finalize T5 — signed envelope, PDF, GraphQL index" | audit record | all T2 | T5 SQLite, PDF disk, GraphQL | PDFKit, sqlite |

Boundary justification — agents I considered but did **not** create:
- **No "Pricing" agent.** Pricing is a deterministic computation (`Item Price` + `Pricing Rule` + Treasury floor); it lives inside Quoting.
- **No "Identity" agent.** GLEIF lookup is a tool, not a decision-owner. Wrapped under DD.
- **No per-channel "Notification" agent.** WhatsApp/email render is a sink at the audit boundary, not a decision-owner.

---

## 3. StateGraph topology (LangGraph.js)

### 3.1 Channels (`Annotation.Root`) — what flows between nodes

```ts
// orchestrator/state/neg-state.ts (specification — not the final code)
const NegState = Annotation.Root({
  // ── identity / linkage ─────────────────────────────────
  negotiationId:    Annotation<string>(),
  opportunityName:  Annotation<string | null>(),
  quotationName:    Annotation<string | null>(),
  buyerLEI:         Annotation<string>(),    // 54930012QJWZMYHNJW95
  sellerLEI:        Annotation<string>(),    // 3358004DXAMRWRUIYJ05

  // ── inquiry (parsed) ───────────────────────────────────
  inquiry:          Annotation<Inquiry>(),                       // see Schemas doc §1
  clarifyRounds:    Annotation<number>({ default: () => 0 }),

  // ── consultations (append-only journal) ────────────────
  consultations:    Annotation<ConsultationRecord[]>({
    reducer: (a, b) => a.concat(b), default: () => []
  }),

  // ── intermediate results per phase ─────────────────────
  gleif:            Annotation<{ buyer: GleifStatus; seller: GleifStatus } | null>(),
  ddResult:         Annotation<DDResult | null>(),               // recommendedTerms + rationale
  fulfillmentPlan:  Annotation<FulfillmentPlan | null>(),        // ATP/CTP per line, splits
  quoteDraft:       Annotation<Quote | null>(),                  // see Schemas doc §2
  demandView:       Annotation<DemandView | null>(),

  // ── negotiation (append-only) ──────────────────────────
  rounds:           Annotation<RoundOutcome[]>({
    reducer: (a, b) => a.concat(b), default: () => []
  }),
  negotiationRounds:Annotation<number>({ default: () => 0 }),

  // ── outcome ────────────────────────────────────────────
  status:           Annotation<
    "INTAKE" | "ACKED" | "DD_RUNNING" | "DD_DONE" |
    "QUOTING" | "QUOTED" | "CLARIFY" |
    "NEGOTIATING" | "ACCEPTED" | "NO_DEAL" | "ESCALATED" |
    "PERSISTING" | "PERSISTED"
  >(),
  defensive:        Annotation<DefensiveActionRecord[]>({
    reducer: (a, b) => a.concat(b), default: () => []
  }),
});
```

Reducer choice — `concat` for `consultations`, `rounds`, `defensive` (append-only journals → replayable / time-travel friendly). Last-write for everything else.

### 3.2 Graph (Mermaid — renders inline in GitHub/IDE markdown)

```mermaid
flowchart TD
  START([prompt arrives via MCP]) --> A1[intake.parse]
  A1 --> A2[intake.mirrorToERPNext\n→ Opportunity]
  A2 --> A3{ambiguous?}
  A3 -- yes & clarifyRounds<2 --> A4[buyer.clarify\nbounded loop]
  A4 --> A1
  A3 -- no --> B0[ackToBuyer]

  B0 --> C1{dd_required?}
  C1 -- no --> Q0
  C1 -- yes --> D0[dd.start]
  D0 ==parallel fan-out==> D1[gleif.verify buyer]
  D0 ==parallel fan-out==> D2[gleif.verify seller]
  D0 ==parallel fan-out==> D3[credit.consult buyer]
  D0 ==parallel fan-out==> D4[info-collection.gather]
  D1 & D2 & D3 & D4 --> D5[dd.join\n→ recommendedTerms]
  D5 --> Q0

  Q0[quoting.start] ==parallel per-LINE==> Q1[inventory.consult line_i]
  Q0 ==parallel per-DEST==> Q2[logistics.consult dest_j]
  Q0 ==parallel==> Q3[treasury.consult \(per term\)]
  Q1 & Q2 & Q3 --> Q4[fulfillment.plan\n→ ATP/CTP/split]
  Q4 --> Q5{demand_aware?}
  Q5 -- yes --> Q6[demand-planning.consult]
  Q5 -- no --> Q7
  Q6 --> Q7[quoting.draftQuote]
  Q7 --> N0{negotiate?}

  N0 -- no --> P0
  N0 -- yes --> N1{round < max?}
  N1 -- no --> N5[mark NO_DEAL or ESCALATED]
  N5 --> P0
  N1 -- yes --> N2[llm.proposeOffer]
  N2 --> N3[constraints.validate]
  N3 --> N4[treasury.veto check]
  N4 --> N6{accept?}
  N6 -- yes --> N7[mark ACCEPTED]
  N7 --> P0
  N6 -- no & buyer counters --> N8[recordRound]
  N8 --> N1

  P0[persist.signEnvelope] --> P1[persist.writeQuotation\n→ ERPNext + amended_from]
  P1 --> P2[audit-reporting.close\n→ PDF + GraphQL]
  P2 --> END([return to OpenClaw])

  D1 -. on failure .-> Z[defensive.branch\nrecord, continue]
  D3 -. on failure .-> Z
  Q1 -. on failure .-> Z
  Q3 -. veto .-> N1
  Z --> Q0
```

### 3.3 Nodes — type tags

| Node | Pattern (Anthropic taxonomy) | Deterministic / LLM | Parallel inside? |
|---|---|---|---|
| `intake.parse` | augmented-LLM | LLM (small Gemini Flash) | no |
| `intake.mirrorToERPNext` | tool call | det | no |
| `buyer.clarify` | augmented-LLM | LLM (Flash) | no |
| `dd.start` | router | det | dispatches |
| `gleif.verify {buyer,seller}` | tool | det | siblings parallel |
| `credit.consult` | augmented-LLM + tool | LLM for rationale | no |
| `info-collection.gather` | router + tools | det (fetch only; no scraping) | sources parallel |
| `dd.join` | parallelization-join | det | no |
| `quoting.start` | router | det | dispatches |
| `inventory.consult line_i` | tool | det | **N parallel** |
| `logistics.consult dest_j` | tool | det | **M parallel** |
| `treasury.consult` | tool | det | per term parallel |
| `fulfillment.plan` | parallelization-join | det | no |
| `demand-planning.consult` | tool | det | no |
| `quoting.draftQuote` | augmented-LLM | det (LLM optional, narrative only) | no |
| `llm.proposeOffer` | evaluator-optimizer (optimizer) | LLM (Pro) | no |
| `constraints.validate` | evaluator-optimizer (evaluator) | det | no |
| `treasury.veto` | evaluator-optimizer (evaluator) | det | no |
| `recordRound` | append to journal | det | no |
| `persist.*` | sequential tool chain | det | no |
| `audit-reporting.close` | sink | det | no |

---

## 4. Patterns catalogue — branching, join, parallel, sequential, loop, sub-graph, recursion

### 4.1 Parallel fan-out + join
- **DD phase:** 4 parallel branches (GLEIF×2, Credit, Info-Collection) → single `dd.join` that synthesizes `recommendedTerms`. Latency = max(branches), not sum.
- **Quoting phase:** parallel **per line** (Inventory), parallel **per destination** (Logistics), parallel **per candidate payment term** (Treasury — P02's prepaid-vs-Net-30 compares two sims). The existing `consultAll()` is the primitive (Promise.all, never throws, surfaces each failure). LangGraph models this as a single `quoting.start` node that fires N concurrent edges and `quoting.join` waits on all.

### 4.2 Conditional branching (routing)
- `intake → ambiguous?` → clarify-loop or proceed.
- `ackToBuyer → dd_required?` → DD phase or skip.
- `quoteDraft → demand_aware?` → demand consult or skip.
- `quoteDraft → negotiate?` → negotiation loop or persist.
- `negotiationLoop → round_done?` → re-enter loop, accept, or escalate.

LangGraph primitive: `addConditionalEdges(node, routerFn, mapping)`. The `routerFn` reads the current state and returns the next node name.

### 4.3 Bounded loops (not recursion)
- **Clarify loop:** `CLARIFY_MAX_ROUNDS = 2` (flag). Each iteration increments `clarifyRounds`; conditional edge exits at the cap.
- **Negotiation loop:** `NEGOTIATION_MAX_ROUNDS = 3` (flag). Each iteration appends to `rounds[]` (concat reducer) and increments `negotiationRounds`. Exit conditions: accept (counterparty), reject-final (counterparty), max-rounds (escalate), treasury-veto-with-no-floor (abandon).
- **Defensive retry:** **none.** Provider failures take a defensive action (record + continue), they do not retry. Retrying a 30-second ACTUS timeout means a 90-second total — no.

### 4.4 Sub-graph (not recursion)
- **DvP saga** is a **separate StateGraph** with its own `thread_id` (linked to `negotiationId`, not nested in it). It interrupts and waits for external webhooks (bank settlement, chain confirmation). LangGraph **interrupts** are the durable-pause primitive — the saga sleeps, and the webhook handler resumes by thread id. **Not implemented in these 10 prompts; deferred to ITER5+.**

### 4.5 Recursion — honestly, **none**
- No node calls the graph from inside itself. The negotiation loop **looks** recursive but is an explicit bounded iteration with a counter — deliberately, so it's auditable and time-travel friendly.
- Per-line quote could be modeled as recursive (the parent quote calls a per-line sub-graph), but for 3-20 lines a flat `Promise.all` inside one node is cheaper and simpler than spinning N sub-graphs. **Decision: flat fan-out, not recursion.**

### 4.6 Sequential dependencies (cannot parallelize)
- Intake → ACK → DD. (ACK before DD; the buyer must know we received the inquiry before we go silent for 4-30 seconds of consults.)
- ACK → mirror-to-ERPNext (Opportunity name needed for `prevdoc_docname` in Quotation Item).
- DD → Quoting (term affects price via Treasury; term affects basket cost on Net-60 vs Net-30).
- Quoting → Negotiation (need a draft before counter-proposing).
- Negotiation accept → Persist → Audit (signed envelope must contain the final agreed-on terms).

### 4.7 Evaluator-optimizer (within negotiation round)
Per round:
1. **Optimizer** (`llm.proposeOffer`) — Gemini 2.5 Pro proposes next price/term given buyer's last move + state.
2. **Evaluator A** (`constraints.validate`) — deterministic: never below `marginPrice`, never below `recommendedTerms`-implied floor.
3. **Evaluator B** (`treasury.veto`) — ACTUS sim: if `approved=false`, override price to `minViablePrice`.
4. Emit. If buyer accepts → ACCEPTED. If buyer counters → next iteration. If max rounds → ESCALATED.

The optimizer's output never reaches the buyer un-evaluated.

### 4.8 Defensive branches (provenance preserved)
Every provider returns `ConsultationRecord<T>` with `success: bool` + `error?: string`. On `success=false` the graph takes one of (continuation prompt §4 vocabulary): `no-action` / `fallback-to-demo-fixture` / `refused-deferred-terms` / `abandoned-negotiation` / `downgraded-tier` / `asked-for-collateral`. Recorded in `state.defensive[]` and surfaced in audit's `extras.defensive`.

---

## 5. Per-agent memory map — what each agent reads/writes in T1–T5

| Agent | T1 working (channels it reads/writes) | T2 saga (audit.db namespace) | T3 semantic (Store namespace) | T4 ERPNext (DocType) | T5 audit |
|---|---|---|---|---|---|
| Orchestrator | reads `status`, writes status transitions | the whole NegState thread | — | — | the whole audit JSON |
| Intake | writes `inquiry`,`opportunityName` | `intake:{negId}` | `items/{code}/spec` (read) | **writes Opportunity** | parse trace |
| Buyer | reads only **buyer-safe projection** | `buyer-safe:{negId}` (ONLY) | own profile cache (no PD, no floor) | reads Customer | own audit JSON |
| DD | reads gleif/credit/info results; writes `ddResult` | `dd:{negId}` | **writes `buyers/{lei}/profile`** | reads Customer | DD trace |
| Info-Collection | writes website text + handle verification | `info-collection:{negId}` | `buyers/{lei}/profile` (append) | reads Customer | source list |
| Credit | writes credit consultation | append to `consultations[]` | `buyers/{lei}/profile`, `buyers/{lei}/deals` | reads Customer | consultation + rationale |
| Inventory | per-line ATP results | append to `consultations[]` | — | reads **Bin live** | consultation w/ provenance |
| Logistics | per-leg carrier results | append to `consultations[]` | — | — | consultation |
| Treasury | per-term sim results | append to `consultations[]`, writes `lastTreasuryResult` | — | — | sim + minViablePrice |
| Quoting | reads consultations; writes `quoteDraft` | `quoting:{negId}` | reads `items/{code}/spec` | — (until Persist) | draft snapshot |
| Demand-Planning | writes `demandView` | `demand:{negId}` | **reads `demand/portfolio`** | reads Sales Order | portfolio digest |
| Fulfillment | writes `fulfillmentPlan` | `fulfillment:{negId}` | — | reads Bin (cached via Inventory) | plan with splits |
| Negotiation (lives inside seller orchestrator) | writes `rounds[]` | append to `rounds[]` | reads `buyers/{lei}/deals` (tactics) | — | decisionTrail per round |
| Persist | writes `quotationName`, `revision` | `persist:{negId}` | — | **writes Quotation** | envelope hash + Quotation name |
| Audit-Reporting | reads everything | — | — | — | signed PDF, GraphQL index |

**Privacy invariant** (continuation prompt §4.4): the buyer agent **only** reads the `buyer-safe:{negId}` namespace — never the effective floor, never raw PD, never minViablePrice. The orchestrator emits a buyer-safe projection on every round commit.

---

## 6. Latency budget — and the parallel-vs-sequential decisions it forces

Verified latencies from existing fixtures and code; speculative latencies marked `[ASSUMPTION]`.

| Sub-agent / tool | p50 | p95 | Source |
|---|---|---|---|
| Intake parse (Flash) | 300 ms | 800 ms | `[ASSUMPTION]` — Flash typical |
| ERPNext Bin read | 100 ms | 250 ms | fixture latency 142 ms |
| ERPNext Opportunity write | 200 ms | 500 ms | `[ASSUMPTION]` |
| ERPNext Quotation write (submit) | 350 ms | 900 ms | `[ASSUMPTION]` |
| GLEIF v1 lookup | 300 ms | 800 ms | live API typical |
| EDGAR companyfacts | 600 ms | 1.8 s | live, large payload |
| DCSA carrier quote | 200 ms | 600 ms | `[ASSUMPTION]` |
| ACTUS PAM sim | 500 ms | **2.0 s** | `[ASSUMPTION]` — fattest tail |
| LLM negotiate round (Pro) | 1.5 s | 3.5 s | Gemini 2.5 Pro typical |
| PDF sign + write | 200 ms | 600 ms | existing audit-pdf code |

**End-to-end budgets the parallelism choices are derived from:**

- **P01 (simplest):** Intake (0.5s) → GLEIF×1 (0.5s) → Inventory (0.2s) → Logistics (0.4s) → Treasury (1s) → Quoting (0.1s) → **≈ 2.5–3.5 s** with parallel fan-out vs ≈ 4–5 s serial.
- **P05 (DD-driven):** Intake (0.5s) → **DD parallel: max(GLEIF×2, Credit, Info-Coll) ≈ 1.5s** → Quoting parallel ≈ 1.5s → **≈ 4–5 s**.
- **P08 (3-round negot + DD):** ≈ 5s setup + 3 × (LLM 2s + Treasury 1s) = **≈ 14 s**.
- **P10 (capstone + persist):** ≈ 14s + persist 2s + audit 1s = **≈ 17–22 s** target.

These force two design choices:

1. **Treasury is fat-tailed.** Run it **in parallel** with everything else it doesn't depend on. For P02 (compare Net-0 vs Net-30) fire **two parallel** Treasury sims, not two sequential ones.
2. **ACK to buyer before DD/Quoting.** A 4-22s silence with no ACK looks broken in OpenClaw. ACK lands at ~0.5s, then the long work runs.

**SLO recording:** the existing `routerLatencyMs` field (verified) already captures the wall-clock of each fan-out node — keep it. Add per-node spans to T5 audit.

---

## 7. The two sagas — one in scope, one deferred

### 7.1 Negotiation saga (in scope for P01–P10)
Implemented as the **main `StateGraph`** above. `thread_id = negotiationId`. Every super-step writes a SqliteSaver checkpoint to `audit.db`. Time-travel = rewind to a prior round and re-run with a different LLM seed; LangGraph supports this natively. Pending-writes resilience = if the process dies mid-round, the resumed thread re-emits the round's pending writes idempotently.

### 7.2 DvP saga (deferred — ITER5+)
A **separate `StateGraph`** with its own `thread_id`, **linked** to the negotiation thread via shared `negotiationId` and shared `audit.db`. Milestones are nodes (`INVOICE_ISSUED → AWAITING_PAYMENT → GOODS_SHIPPED → DELIVERED → SETTLED`). LangGraph **interrupts** are the durable pause; webhook handlers (bank settlement, chain confirmation) resume by thread id. **Not built for these 10 prompts** — but the design accommodates it without touching the negotiation graph.

---

## 8. What gets checkpointed when (T2 superstep boundaries)

Every node transition emits a SqliteSaver checkpoint. Critical superstep boundaries (for replay and forensic review):

1. After `intake.mirrorToERPNext` — `opportunityName` is now durable.
2. After `dd.join` — `recommendedTerms` is locked.
3. After `quoting.draftQuote` — initial draft is auditable.
4. After **every** negotiation round (`recordRound`) — full round trace.
5. After `persist.signEnvelope` — envelope hash is the audit anchor.
6. After `persist.writeQuotation` — `quotationName` + revision are durable.

If the process crashes between step 5 and 6, the resumed thread idempotently retries the ERPNext write using the envelope hash as an idempotency key.

---

## 9. Cross-cutting concerns

### 9.1 Provenance (existing `ConsultationRecord` contract, do not change)
Every sub-agent's output carries `metadata.{subAgent, dataMode, performedAt, dataSource, latencyMs}`. The audit's `consultations[]` block embeds these verbatim. **The graph never strips provenance.**

### 9.2 Defensive vocabulary (existing, do not invent new ones)
`no-action | fallback-to-demo-fixture | refused-deferred-terms | abandoned-negotiation | downgraded-tier | asked-for-collateral`. New entries get added to `provider-types.ts`, not synthesized at call sites.

### 9.3 Info-Collection scope (locked, restated)
**No scraping** of LinkedIn / Instagram / Facebook. Compliant scope: buyer's own website (no-login, robots.txt respected), buyer-disclosed handles (store + verify existence, do not fetch content), GLEIF + SEC EDGAR + Companies House.

### 9.4 Identity mode
`CREDENTIAL_MODE = plain` for P01–P10. `verify_lei_gleif` MCP tool runs PLAIN GLEIF active-status check. vLEI delegation (KERI chain) deferred to ITER7.

### 9.5 Signing
`SIGNING_MODE = plain` (sha256 envelope). Envelope hash on every emitted message + on the persisted Quotation (`custom_signed_envelope_hash`).

---

## 10. What I have NOT read yet that the actual code will need (Rule 3)

Before generating the graph code, read in a fresh session:
1. `DynDiscProject5/A2A/js/src/shared/negotiation-mode.ts` — to map our P01–P10 to existing `SellerResponseMode` ranks (BASIC / L1 / L2 / L3 / L4) and the `resolveProviderModes()` function.
2. `DynDiscProject5/A2A/js/src/shared/l2-executive.ts` and `l2-wire.ts` — the existing L2 reasoning + wire-in path. The negotiation node's evaluator-optimizer pattern should re-use the existing tactics engine, not rebuild it.
3. `DynDiscProject5/A2A/js/src/agents/seller-agent/index.ts` — the existing orchestrator entry; our LangGraph wrap should preserve its existing decision points, not replace them.
4. `DynDiscProject5/A2A/js/src/shared/audit-writer.ts` and `audit-paths.ts` — how the existing audit JSON is composed; T5 close must extend, not parallel.
5. ERPNext `Item`, `Item Price`, `Pricing Rule`, `Incoterm`, `Shipping Rule`, `Payment Term` DocType field lists (from the Schemas doc Part 4).

These reads are blocking for **code**, not for **design** — the design above stands.

---

## 11. Sanity check against Anthropic's "Building Effective Agents"

| Anthropic pattern | Where it shows up in V6 |
|---|---|
| **Workflow > Agent when possible** | 11 of 14 nodes are deterministic; only DD / Negotiation / Buyer-clarify use LLM |
| **Augmented LLM** | Negotiation's optimizer is LLM-with-tools (Treasury sim, market-data) |
| **Routing** | `ddDecide`, `demand_aware?`, `negotiate?` — three explicit routers |
| **Parallelization** | DD fan-out, Quoting fan-out (per line, per destination, per term) |
| **Orchestrator-workers** | Orchestrator shell dispatches to all 13 worker agents |
| **Evaluator-optimizer** | Each negotiation round: LLM propose → constraints + Treasury veto |
| **Bounded loops, not recursion** | Clarify ≤2, Negotiate ≤3, no node self-calls |
| **Durable pause for external events** | DvP saga interrupts (deferred) |

*End of orchestration design.*
