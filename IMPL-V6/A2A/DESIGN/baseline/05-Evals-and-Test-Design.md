# IMPL-V6 — Evals & Test Design

> Anchored to three first-class invariants you named:
> - **INV-1 Response-Guarantee** — every inquiry produces a response (sync or async). No silent drops.
> - **INV-2 Inquiry-Quote Correlation** — every inquiry and its quote(s) are correlated by a stable, end-to-end ID.
> - **INV-3 Audit-Always-Available** — both inquiry and quote are visible to the audit framework *at all times*, including mid-saga.
>
> The eval pyramid (unit → integration → E2E → property → adversarial → perf → negotiation-quality) is designed to *prove* these invariants, not just sample behavior.

> Extends, doesn't replace: existing test infrastructure in `DynDiscProject5/A2A/js/scripts/` (listed but **not read** this session — listed in §10 as extension points).

---

## 1. The three invariants — formal definitions and what tests them

### INV-1 — Response-Guarantee

**Statement:** For every inquiry the system accepts, exactly one terminal outcome is recorded within a bounded time, and it is delivered back to the caller.

**Possible terminal outcomes:**
- `QUOTED` — a quote was issued (P01-P06 paths).
- `ACCEPTED` — negotiation reached an agreed quote (P07-P10).
- `NO_DEAL` — both sides walked away (target unmet, no overlap).
- `ESCALATED` — max rounds reached, sent to human.
- `REJECTED_DD` — DD blocked the deal (e.g. buyer LEI lapsed at GLEIF).
- `DEFENSIVE_ABORT` — a critical provider failed and no fallback was acceptable.

**Tests:**
- **PROP-1.1** *(property test)* — For every `Opportunity` row created in ERPNext, after `negotiationId` saga terminates, `audit.db` contains exactly one row with `status ∈ {terminal outcomes}` for that `thread_id`. No orphans; no doubles. Run as a SQL cross-DB join in CI.
- **PROP-1.2** *(SLO test)* — Saga termination time stays within budget: P01 ≤ 5s, P05 ≤ 8s, P08 ≤ 20s, P10 ≤ 25s (p95). Anything over budget = test fail, even if outcome was correct.
- **CHAOS-1.3** *(adversarial)* — Inject provider timeout / process crash mid-saga. Resumed thread still produces a terminal outcome (PROP-1.1) within budget+50%.

### INV-2 — Inquiry-Quote Correlation

**The correlation chain (every link verified by tests):**

```
prompt text
   │
   ▼
negotiationId  ← generated at intake (UUID-v4-ish, ULID for sortability)
   │
   ├──→ T2/T5 audit.db          (thread_id = negotiationId)
   │       (SqliteSaver checkpoints + audit JSON + decisionTrail)
   │
   ├──→ T4 ERPNext Opportunity  (custom_inquiry_id = negotiationId)
   │
   ├──→ T4 ERPNext Quotation    (custom_negotiation_id = negotiationId,
   │                              opportunity → Opportunity.name)
   │
   ├──→ Quotation Item rows     (prevdoc_doctype="Opportunity",
   │                              prevdoc_docname=Opportunity.name)
   │
   └──→ signed envelopes        (custom_signed_envelope_hash on Quotation)
            ↕
       T5 audit blocks          (envelopeHash on each log entry)
```

**Tests:**
- **PROP-2.1** *(property test)* — For every `Quotation` written in ERPNext, the following five-way join succeeds: `Opportunity.custom_inquiry_id == Quotation.custom_negotiation_id == audit.db.thread_id == signed_envelope.negotiationId == Quotation.opportunity → Opportunity.name`.
- **PROP-2.2** — For every `Quotation Item`, `prevdoc_docname` resolves to a row in `Opportunity Item` with matching `item_code` and same parent Opportunity. (Line-level correlation.)
- **PROP-2.3** — Revision chain integrity: walking `Quotation.amended_from` from the final revision backwards eventually terminates at the root, all sharing the same `custom_negotiation_id`. `custom_quote_revision` is strictly monotonic along the chain.
- **PROP-2.4** *(envelope integrity)* — Every `envelopeHash` referenced from the persisted Quotation exists in `audit.db.envelopes` with matching `negotiationId`. Existing `scripts/test-envelope-ordering.ts` (verified to exist) already enforces ordering across the chain — extend it to cross-check ERPNext.
- **PROP-2.5** *(no cross-thread leakage)* — Sample 100 audit rows; none reference an `opportunityName` from a different `negotiationId`. Tests against the buyer-safe namespace privacy invariant.

### INV-3 — Audit-Always-Available

**Statement:** At any time during a saga's lifetime, querying the audit framework (GraphQL on port 5000, `audit.db` directly, or the `index.jsonl` stream) returns a **consistent partial view** of the inquiry+quote state. No "tearing," no lost writes, no view-stale-for-minutes.

**What "consistent partial view" means:**
- If the saga is at superstep N, the audit contains supersteps 1..N's checkpoints.
- The `index.jsonl` is append-only — readers always see entries in commit order.
- ERPNext's Opportunity row is committed *before* the saga moves past `intake.mirrorToERPNext` (sequential dependency, §6 below).
- ERPNext's Quotation row is committed *before* `audit-reporting.close` writes the audit-close marker.
- These ordering rules mean: if a reader sees an audit-close marker, the Quotation is durable; if it sees the Opportunity but no close marker, the saga is in flight.

**Tests:**
- **PROP-3.1** *(read-during-write)* — While a P08-style saga is running (multiple rounds, long Treasury sims), an external reader querying GraphQL every 500ms gets a strictly monotonically-growing view (no log entries disappear or reorder).
- **PROP-3.2** *(audit-close → ERPNext write ordering)* — A reader that observes `audit-reporting.close` for `negotiationId X` can immediately read the corresponding Quotation row from ERPNext without retrying. Fails if ordering is reversed.
- **PROP-3.3** *(crash-consistency)* — Kill the process mid-saga (between superstep N and N+1). Restart. Pre-crash audit entries are still readable; on resume, no entries are duplicated and the resumed thread continues from N (LangGraph SqliteSaver guarantees).
- **PROP-3.4** *(graphQL freshness)* — The GraphQL endpoint's freshness lag from the SQLite write is ≤500ms p95 (existing GraphQL audit-query server on port 5000 is already an in-process SQLite reader, so this should be near-zero — assert it).
- **PROP-3.5** *(no orphan in either direction)* — No Opportunity without an audit row; no audit row without an Opportunity (only valid orphan is `REJECTED_DD` before intake completes — explicit allowed exception in the test).

---

## 2. Sync vs Async response model

OpenClaw calls the seller skill via MCP. The response model **varies by prompt** but the invariants above hold across both modes.

### 2.1 Sync response (P01–P10 for these 10 prompts)

All 10 prompts complete synchronously from OpenClaw's perspective — one MCP tool call returns the final outcome.

**Within that "sync" call, the seller skill streams MCP progress notifications** for long-running phases (DD ~1.5s, per-round LLM ~2s). OpenClaw sees:
```
mcp.tool.call(seller_inquiry, {prompt})  ──┐
                                            ├─ progress: "Verifying LEIs via GLEIF…"
                                            ├─ progress: "Running due diligence…"
                                            ├─ progress: "Negotiating round 1/3 …"
                                            ├─ progress: "Negotiating round 2/3 …"
                                            ├─ progress: "Persisting Quotation…"
                                            └─ result: { status:"ACCEPTED", quotationName:"SAL-QTN-2026-00042",
                                                          revision:3, quotedAt:"…", quote:{...} }
```

**Tests for sync mode:**
- **TEST-2.1** — Progress notifications fire within 1s of phase boundaries (no >1s silence after intake ACK).
- **TEST-2.2** — Final result includes `quotationName`, `revision`, `custom_quoted_by_agent`, `custom_quoted_by_oor`, `custom_quoted_at`, full `quote` object.
- **TEST-2.3** — If a fatal error occurs, result is `{status:"DEFENSIVE_ABORT", defensive:[…]}` — never an empty result, never a thrown exception bubbling out.

### 2.2 Async response (DvP saga, deferred to ITER5+ — designed in but not tested here)

DvP is async by nature: the tool call returns "settlement pending, here's your tracking handle"; a separate webhook fires when bank/chain settles. Even though deferred, the **correlation invariant must hold by design**:
- The tracking handle returned synchronously is `negotiationId`.
- When the webhook resumes the DvP saga, it writes additional audit rows under the **same** `negotiationId`.
- OpenClaw can poll GraphQL with `negotiationId` or receive a callback (when configured).

**Forward-compatible test:** PROP-1.1 and PROP-3.1 are written so they pass for both sync and async terminal outcomes. We add the actual async tests when DvP ships.

---

## 3. The eval pyramid

```
                ┌──────────────────────────┐
                │  L7  Negotiation Quality │   outcome-quality scorer (existing)
                │      & Adversarial Buyer │   (replay + buyer-personas)
                ├──────────────────────────┤
                │  L6  Perf / SLO          │   latency budget per prompt
                ├──────────────────────────┤
                │  L5  Adversarial / Chaos │   provider failures, mid-saga kill
                ├──────────────────────────┤
                │  L4  Property / Invariants│   INV-1, INV-2, INV-3 (above)
                ├──────────────────────────┤
                │  L3  E2E per prompt      │   P01-P10 acceptance (§4)
                ├──────────────────────────┤
                │  L2  Integration         │   per phase (Intake, DD, Quoting, Negotiate, Persist)
                ├──────────────────────────┤
                │  L1  Unit                │   per agent / tool / reducer
                └──────────────────────────┘
```

### L1 — Unit tests (deterministic, fast, no I/O)

For every agent and every provider:
- **Reducers** (concat reducers for `consultations[]`, `rounds[]`, `defensive[]`) — given two state slices, merge is associative and commutative for journal channels.
- **Mappers** (`erpnext/mappers.ts`) — domain ↔ ERPNext field mapping round-trips losslessly for every required field. Property: `unmarshal(marshal(x)) === x` for all schema-valid `x`.
- **Pure deciders**: `dd.recommendTerms(creditConsult) → "Net-0"|"Net-30"|"Net-60"`. Table-driven tests with all PD×LGD×dealSize bands.
- **Constraint validator** (`applySellerConstraints`) — never returns a price below `marginPrice`; never returns COUNTER below `recommendedTerms`-implied floor.
- **GLEIF parser** — given canned LEI record JSON, returns correct `GleifStatus`.
- **Payment Schedule builder** — `buildPaymentSchedule(term, total, transactionDate) → 1 row, invoice_portion=100, due_date correct`.
- **negotiationId generator** — 1M draws, no collisions, sortable, URL-safe.

### L2 — Integration tests (one phase end-to-end with mocks for downstream)

- **Intake → ERPNext Opportunity**: post P04's two-destination basket prompt; assert Opportunity created with 8 Opportunity Items (2 styles × 4 sizes), `custom_inquiry_dimensions_json` round-trips.
- **DD phase**: feed canned GLEIF + EDGAR responses; assert `recommendedTerms` matches expected for each of the 3 risk buckets.
- **Quoting phase**: feed canned `Bin` (ATP-short) + canned Treasury approve/reject; assert `quoteDraft` carries the right `canFulfill` flags + `earliestShipDate`.
- **Negotiation single round**: feed canned LLM proposal + canned Treasury verdict; assert constraints+veto produce the expected outgoing offer.
- **Persist**: feed a finalized quote; assert `Quotation` row exists with all custom fields populated, `amended_from` correctly set for round > 1, payment_schedule has 1 row at 100%.

### L3 — E2E acceptance per prompt — §4 below.

### L4 — Property/invariant tests — INV-1, INV-2, INV-3 above.

### L5 — Adversarial / chaos

| Scenario | Inject | Expected behavior |
|---|---|---|
| ERPNext down (write fails) | 503 on POST | `defensive: refused-deferred-terms` or `fallback-to-demo-fixture`; record stays in saga; retry on next stable window |
| ERPNext down (read fails) on Bin | 503 on GET Bin | `Inventory` consult `success:false`; if mode allows, `fallback-to-demo-fixture` with audit flag |
| GLEIF down | timeout | DD records `success:false`; saga decides: if `inquiry.dd_required`, terminal `DEFENSIVE_ABORT`; else continue with reduced confidence |
| ACTUS timeout | 30s | Treasury `success:false`; tactics engine uses last good `minViablePrice`; flag in audit |
| LLM 500 / rate limit | injected | one retry with exponential backoff (1 retry max); then fallback rule-based proposal; flag `usedFallback:true` in decisionTrail |
| Process crash mid-round | SIGKILL after `proposeOffer` but before `recordRound` | resumed thread re-emits round (idempotent via envelope hash); no duplicate audit entries |
| Concurrent inquiry storm | 50 inquiries in 1s | All 50 produce terminal outcomes within budget×3; no thread_id collision; audit DB doesn't lock |
| Tampering attempt | manually edit a row in `audit.db` mid-saga | `scripts/test-tamper.ts` (verified to exist) catches it via envelope-chain hash mismatch |

### L6 — Performance / SLO

The latency budgets from Orchestration Design §6. Run as load tests under `scripts/run-mode-matrix.ts` extension:

| Prompt | p50 budget | p95 budget | Mostly bottlenecked by |
|---|---|---|---|
| P01 | 2.5s | 5s | Treasury (1 sim) |
| P02 | 3s | 6s | 2 parallel Treasury sims |
| P03 | 3s | 6s | ATP fan-out (per line) |
| P04 | 4s | 8s | 2 logistics + N inventory parallel |
| P05 | 5s | 9s | full DD parallel max |
| P06 | 5s | 10s | fulfillment plan |
| P07 | 6s | 12s | 1 negot round (LLM ~3s) |
| P08 | 12s | 20s | 3 negot rounds + DD |
| P09 | 7s | 14s | 2 rounds + demand-planning |
| P10 | 17s | 25s | 3 rounds + DD + persist |

### L7 — Negotiation quality (existing `outcome-quality.ts` extension)

Beyond "did it produce a quote?", **was it a *good* quote?**

| Metric | Goal | Source |
|---|---|---|
| Deal-close rate | ≥80% on happy-path scenarios | replay against `shared/scenarios/*.json` (existing fixtures) |
| ZOPA preservation | seller never closes below `marginPrice` (hard) | constraint validator unit + replay |
| Treasury-veto rate | <20% on default scenarios | indicates pricing config is sane |
| Buyer-side fairness | average closed price ∈ [buyer_target × 1.0, buyer_target × 1.12] on closeable scenarios | replay |
| Escalation rate | <15% on happy-path | replay |
| Defensive-action rate | <5% on green-path (no injected failures) | replay |
| Rounds-to-close | mean ≤2.2 / 3 on closeable scenarios | replay |

Existing scorer `shared/outcome-quality.ts` (verified referenced in code, **not read** this session) is the foundation. Extend it with multi-line / multi-destination fairness when those land in V6.

---

## 4. E2E acceptance — per-prompt criteria

Each prompt has an **acceptance test fixture** under `IMPL-V6/test/prompts/Pxx.test.ts` and a **canned-input replay scenario** under `IMPL-V6/DEMO-DATA/scenarios/Pxx-*.json` (extending the existing `shared/scenarios/` pattern).

### P01 — simplest complete inquiry
**Setup:** GLEIF returns ACTIVE for both; ATP sufficient; Treasury approves at `rate=300`.
**Asserts:**
- Status: `QUOTED` within 5s p95.
- `Opportunity` created with 4 items (S,M,L,XL).
- `quoteDraft.items.length === 4`, each with `rate>0`, `qty matches inquiry`, `warehouse === MADRAS-WH-1`, `canFulfill===true`.
- `payment_schedule[0].invoice_portion === 100`, `credit_days === 0`.
- `grand_total === Σ(qty×rate) × 1.18` (GST).
- INV-1 + INV-2 + INV-3 properties hold.

### P02 — compare prepaid vs Net-30
**Setup:** identical to P01 but two Treasury sims (Net-0, Net-30) fire in parallel.
**Asserts:**
- Two `treasury` consultations in `consultations[]`, both `subAgent:"treasury"`, distinct `paymentTermsDays` (0 vs 30).
- `routerLatencyMs ≈ max(sim1, sim2)` not sum.
- Quote shows two pricelines; `priceDelta > 0` (Net-30 strictly more expensive).

### P03 — ATP-short, earliest-ship honesty
**Setup:** 40,000 pieces; `Bin` fixture has only 35,000 available; `leadTimeDays=30`.
**Asserts:**
- At least one line has `canFulfill === false`.
- That line carries `earliestShipDate > inquiry.requiredDeliveryDate`.
- Quote NEVER claims the date can be met when it can't (regression on the verified `canFulfill=false` fixture).

### P04 — 2 styles, 2 destinations, Net-30
**Asserts:**
- Two separate Logistics consultations (Rotterdam, Hamburg), in parallel.
- Each style/destination combo has its own freight line in the quote.
- Two distinct `Incoterm`s if appropriate.
- 8 line items in Quotation (2 styles × 4 sizes).

### P05 — full DD → credit-driven term
**Setup:** seed Credit with PD/LGD producing `recommendedTerms="Net-30"`.
**Asserts:**
- `ddResult.recommendedTerms === "Net-30"`.
- Quote uses Net-30 (not what buyer asked, since they didn't specify).
- Quote includes a rationale text non-empty.
- DD ran all 4 parallel branches (assert `dd.start` produced 4 children in graph trace).

### P06 — 3 styles, tight date → split shipment
**Setup:** Bin fixtures designed so 1 style is fully fulfillable, 1 partially, 1 mostly back-ordered.
**Asserts:**
- `fulfillmentPlan` has split rows for the partial and back-ordered styles.
- Each `Quotation Item` for split lines has `custom_split_index` 1..K, distinct `custom_promised_ship_date`.
- No silent demotion: every requested piece is accounted for (sum of split qtys = inquiry qty).

### P07 — single counter-round
**Setup:** seller's `marginPrice=275`; buyer target `300`.
**Asserts:**
- `rounds.length === 1`.
- Round 1 contains LLM proposal + constraint check + treasury veto (or pass).
- Either ACCEPTED or one counter; no infinite loop.

### P08 — 3 rounds, Net-60, DD
**Asserts:**
- `rounds.length ≤ 3`.
- Terminal status ∈ {ACCEPTED, NO_DEAL, ESCALATED}.
- If ACCEPTED: final price ≥ `treasury.minViablePrice` for every line.
- DD ran; `recommendedTerms` either allowed Net-60 (deal proceeds) or forced Net-30 (with rationale in quote).

### P09 — demand-aware
**Setup:** seed T3 `demand/portfolio` with prior commitments overlapping the date.
**Asserts:**
- `demandView` populated in saga state.
- Quote's promised ship dates reflect prior commitments (not pretending capacity is free).
- `QUOTE_DEMAND_AWARE=on` was honored (assert flag was on).

### P10 — capstone + persist
**Asserts:**
- All 14 agents touched in graph trace (assert each agent's namespace has ≥1 row in T2).
- Quotation row exists with **every** required custom field:
  `custom_quoted_by_agent`, `custom_quoted_by_oor`, `custom_seller_lei`, `custom_seller_agent_aid`, `custom_seller_oor_aid`, `custom_quote_revision`, `custom_quoted_at`, `custom_negotiation_id`, `custom_signed_envelope_hash`, `custom_actus_sim_id`, `custom_credential_mode=plain`.
- `Quotation.opportunity` resolves to the inquiry's Opportunity row.
- All three invariants hold; signed PDF generated; GraphQL returns the full audit JSON.

---

## 5. Correlation chain — full ID map and how each link is enforced

| Link | Where it lives | Who writes it | Test that enforces it |
|---|---|---|---|
| `negotiationId` (root ID) | T2 saga thread_id (LangGraph) | Intake (generates ULID) | PROP-1.1, PROP-2.1, PROP-3.5 |
| `Opportunity.name` | T4 ERPNext | `intake.mirrorToERPNext` | PROP-2.1 |
| `Opportunity.custom_inquiry_id = negotiationId` | T4 | Intake | PROP-2.1 |
| `Quotation.name` (incl. `-N` revisions) | T4 | `persist.writeQuotation` | PROP-2.3 (chain) |
| `Quotation.custom_negotiation_id = negotiationId` | T4 | Persist | PROP-2.1 |
| `Quotation.opportunity → Opportunity.name` | T4 native Link | Persist | PROP-2.1 |
| `Quotation Item.prevdoc_doctype="Opportunity"` `prevdoc_docname=Opportunity.name` | T4 child | Persist | PROP-2.2 |
| `Quotation.amended_from` chain | T4 native | Persist (on revision) | PROP-2.3 |
| `Quotation.custom_signed_envelope_hash` | T4 | Persist after sign | PROP-2.4 |
| Audit JSON `negotiationId` field | T5 audit.db | Audit-Reporting | PROP-2.1 |
| `decisionTrail[i].envelopeHash` per round | T5 | each round emit | existing `test-envelope-ordering.ts` |
| `index.jsonl` rows per saga | T5 | every state transition | PROP-3.1 (read-during-write) |

**Practical test query** (PROP-2.1 in SQL — runs in CI):
```sql
-- For every Quotation, the five-way join must return exactly one row:
SELECT q.name, q.opportunity, q.custom_negotiation_id, o.custom_inquiry_id, a.thread_id
FROM   erpnext.tabQuotation q
JOIN   erpnext.tabOpportunity o ON o.name = q.opportunity
JOIN   audit.checkpoints a      ON a.thread_id = q.custom_negotiation_id
WHERE  o.custom_inquiry_id != q.custom_negotiation_id
   OR  a.thread_id != q.custom_negotiation_id
   OR  q.custom_negotiation_id IS NULL;
-- Expected: 0 rows. >0 rows = INV-2 violation; CI red.
```

---

## 6. The ordering rules that make INV-3 hold

The "audit always available" guarantee depends on three **commit-ordering** rules. These are testable.

1. **ERPNext Opportunity write commits BEFORE saga moves past `intake.mirrorToERPNext`.**
   - LangGraph node is `async`; the node's `return` happens only after the REST POST returns 2xx.
   - Test (PROP-3.2): kill the process *right before* the node returns; on resume, the Opportunity exists (idempotent write key = `negotiationId`).
2. **Signed envelope commits to `audit.db` BEFORE Quotation write to ERPNext.**
   - `persist.signEnvelope` writes the envelope to `audit.envelopes` then `persist.writeQuotation` references it via `custom_signed_envelope_hash`.
   - Test: forced-fail the ERPNext write; envelope row still exists in `audit.db`; on retry, no duplicate envelope (idempotent on hash).
3. **`audit-reporting.close` commits LAST.**
   - Any reader that sees a close marker can safely assume Quotation is durable.
   - Test (PROP-3.2): poll GraphQL; the first time `auditClose` appears for a `negotiationId`, query ERPNext for the Quotation — it must exist on first try.

---

## 7. Three eval modes — which tests run when

| Mode | When | Which levels | DBs | Time budget |
|---|---|---|---|---|
| **fast** (pre-commit) | every commit | L1 + L2 + invariants on in-memory mocks | mock providers, SQLite-in-RAM | <30s |
| **integration** (PR) | every PR | + L3 (P01-P10 against demo providers) + L4 (full props) | demo fixtures + SQLite on disk | <5min |
| **e2e** (nightly) | nightly | + L5 (chaos) + L6 (perf) + L7 (negotiation quality) | demo + real ERPNext sandbox + real GLEIF | <30min |

The existing `scripts/run-mode-matrix.ts` (verified to exist, **not read** this session) is the foundation for the mode-matrix runner. Extend it to support the three modes above.

---

## 8. Adversarial buyer personas (for L7)

To stress the negotiation engine, run replay against synthetic buyer personas (existing TKI 5: aggressive / assertive / balanced / cooperative / win-win-seeking — referenced in `negotiation-types.ts`). Each prompt × persona = matrix cell. The scorer reports per-cell deal-close rate, mean rounds, mean delta to fair price.

| Persona | Behavior | Expected seller behavior |
|---|---|---|
| aggressive | undercuts margin; refuses every counter | escalation rate high; treasury veto saves the day |
| assertive | counters once, accepts if seller's R2 is reasonable | most deals close in 2 rounds |
| balanced | meets midway | deals close at NBS midpoint approximately |
| cooperative | accepts seller's first counter | deals close fast at seller-favorable price |
| win-win-seeking | discloses budget; expects seller to share floor | tests buyer-safe namespace invariant |

---

## 9. Audit observability — the operator's view

The audit framework supports three concurrent views; tests must pass against all three:

| View | Endpoint | Use case | Tests |
|---|---|---|---|
| Live stream | SSE on the existing `sse-broadcaster.ts` (verified to exist) | UI dashboard / human follow-along | PROP-3.1 |
| Synchronous query | GraphQL on port 5000 (existing) | regulator on-demand drill-down | PROP-3.4 |
| Bulk replay | `audit.db` direct + `index.jsonl` | forensic / training data | existing `replay-fixtures.ts` |

A regulator must be able to ask, given only a `negotiationId`:
- "Show me the inquiry as it arrived."
- "Show me every consultation and what it returned."
- "Show me every LLM proposal and what was overridden."
- "Show me the final quote and prove it was the same one persisted to ERPNext."
- "Show me what would have required human approval under a stricter posture" (the existing `commitGate.wouldFireAt[]` — verified in `negotiation-types.ts`).

Each of these is a separate test that asserts the GraphQL query returns the expected shape.

---

## 10. Extension points into existing test infrastructure (NOT read this session)

The following test scripts are **verified to exist** in `DynDiscProject5/A2A/js/scripts/` but their internals are **NOT READ**. Read before extending:

| Existing script | Purpose (inferred from name) | V6 extension |
|---|---|---|
| `test-cli-parser.ts` | parser for `start negotiation --product …` CLI | V6 parser for prompt → inquiry struct |
| `test-envelope-ordering.ts` | envelope hash chain ordering | extend with ERPNext cross-check (PROP-2.4) |
| `test-fixtures-parse.ts` | DEMO-DATA fixture parsing | extend for V6 multi-line/multi-dest fixtures |
| `test-gleif.ts` | GLEIF live + canned tests | reuse as-is for INV-1 happy-path |
| `test-l2-executive.ts` | L2 reasoning | extend with multi-line state |
| `test-l2-wire.ts` | L2 wire-in path | extend with V6 channels |
| `test-outcome-quality.ts` | negotiation quality scorer | extend with multi-line fairness (L7) |
| `test-router-and-tactics.ts` | router + tactics | extend with V6 routing decisions |
| `test-tamper.ts` | audit DB tamper detection | reuse as-is for INV-3 PROP-3.5 |
| `test-tier-resolver.ts` | tier-framework + provider mode resolution | extend with V6 modes |
| `run-mode-matrix.ts` | mode-matrix runner | foundation for 3-mode runner (§7) |
| `replay-fixtures.ts` | scenario replay | extend with P01-P10 scenarios |
| `bootstrap-demo-counterparties.ts` | bootstrap demo data | extend to seed Tommy + Jupiter into ERPNext via REST |

---

## 11. What I have NOT verified for this design (Rule 3)

- The contents of every test file listed in §10 — only file existence is verified.
- `outcome-quality.ts` internals — referenced in `negotiation-types.ts` but not read.
- Whether the existing `sse-broadcaster.ts` already supports the granular progress notifications §2.1 needs — possible it does (verified to exist, not read).
- Frappe's behavior under concurrent Custom Field writes — needs verification before assuming the storm test (L5 concurrency) will pass.
- LangGraph SqliteSaver's exact recovery semantics — the design assumes idempotent re-emit on resume; verify in `@langchain/langgraph-checkpoint-sqlite` docs before betting tests on it.

These are blocking for **writing the tests**, not for **this design**. Listed here so they're not silently assumed.

*End of evals & test design.*
