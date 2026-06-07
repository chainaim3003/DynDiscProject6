# IMPL-V6 — Iteration Plan

> Derived from the project structure (`06-Project-Structure.md`) and the four prior design docs (prompts, schemas, orchestration, evals). This is the **build sequence** that realizes the tree; the 10 prompts are the **judging sequence**.

---

## Three load-bearing observations from the tree

1. **Asymmetric work.** 6 of 14 agents are 🆕, 7 are ⚪ PORTED. All of `mcp/`, `orchestrator/`, `erpnext/` is net-new. The 🆕 work depends on the ⚪ foundation → port `shared/`, `identity/`, `messaging/` **before** building any agent.

2. **erpnextEnh1 is a hard prerequisite for P03+.** P03–P10 read live `Bin`, write `Opportunity`, write `Quotation`. Without Custom Fields installed, every write fails validation. erpnextEnh1 must land before P03.

3. **Determinism first, LLM second.** 11/14 nodes are deterministic (Orch Design §0); only DD + Negotiation + Buyer-clarify use LLM. P01–P06 build and test **deterministically**; non-determinism enters at P07. INV-1/2/3 property tests stabilize CI before L7 negotiation-quality scoring lands.

---

## The 9 iteration cells

Each row is one focused session. Rule 9 — AI vs Manual is split explicitly; manual steps are walked one at a time during execution, not dumped as a block here.

| # | Goal | AI does | Manual (walked one step at a time during exec) | Exit criteria |
|---|---|---|---|---|
| **V6.0** | Scaffold + clear the NOT-READ list | Read 5 pending `.ts`: `negotiation-mode`, `l2-executive`, `l2-wire`, `seller-agent/index`, `outcome-quality`. Read 6 pending ERPNext DocTypes: `Item`, `Item Price`, `Pricing Rule`, `Incoterm`, `Shipping Rule`, `Payment Term`. Create root files: `README.md`, `SKILL.md`, `ROLE-NOTE-FOR-JUDGES.md`, `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `railway.json`. Copy `agent-cards/` verbatim. Copy the 7 DESIGN docs into `DESIGN/baseline/`. | Decide: Frappe Cloud vs self-hosted `frappe_docker`. | `npm install` succeeds; empty TS compile passes; 11 source files read with notes captured. |
| **V6.1** | erpnextEnh1 layer | Write 6 seed scripts (`00-bootstrap-masters` → `90-export-fixtures`) + 4 Custom Field JSONs (`opportunity`, `opportunity_item`, `quotation`, `quotation_item`) + Frappe app skeleton (`hooks.py`, `pyproject.toml`, `MANIFEST.in`, `__init__.py`). | (a) Provision ERPNext. (b) Generate API key/secret. (c) Paste creds into `.env`. (d) Run seeds 00→04. | `GET /api/resource/Customer/Tommy Hilfiger Europe B.V.` returns Tommy w/ `custom_buyer_lei`. `TH-TEE-RN-180-M` variant exists. `Custom Field opportunity-custom_inquiry_id` exists. |
| **V6.2** | Shared port + MCP entry | Port `shared/`, `identity/`, `messaging/`. Build `src/mcp/server-sse.ts` registering only `verify_lei_gleif` initially. | Run `npm run dev`; in stock OpenClaw paste *"verify Jupiter via GLEIF — LEI 3358004DXAMRWRUIYJ05"*. | Tool returns ACTIVE; `routerLatencyMs` recorded; audit row written; SSE health endpoint green. |
| **V6.3** | P01–P02 happy path (deterministic) | Build `orchestrator/state/{neg-state,reducers}.ts`, nodes `intake.parse`, `intake.mirrorToERPNext`, `ackToBuyer`, `quoting.draftQuote`. Build `erpnext/{client,inquiry-repo,mappers}.ts`. MCP tools: `create_inquiry`, `quote_unit_price`, `quote_size_curve`, `quote_with_payment_term`. L1 unit tests (reducers, payment-schedule builder, negotiationId). L3 tests P01, P02. | Paste P01 verbatim into OpenClaw. Then P02. | Both return per-size lines + 18% GST + freight + Incoterm + `payment_schedule[0].invoice_portion=100`. Opportunity written. INV-1 + INV-2 pass for both. |
| **V6.4** | P03–P06 quoting depth (deterministic) | Build `agents/fulfillment/` + `fulfillment.plan` node. Add MCP tools `quote_with_delivery`, `quote_with_logistics`, `quote_multiline`, `propose_split_shipment`. ATP-short Bin fixtures. Madras→Rotterdam + Madras→Hamburg DCSA fixtures. L3 tests P03–P06. | Paste P03 → P06 in order. | P03: at least one line `canFulfill=false` + `earliestShipDate > requiredDeliveryDate`. P04: 8 line items across 2 destinations with 2 freight legs. P06: split plan whose qtys sum exactly to inquiry qty. |
| **V6.5** | P07–P08 negotiation + DD (LLM enters) | Build `agents/dd/`, `agents/info-collection/`. Negotiation nodes: `proposeOffer` (LLM Pro), `validate`, `treasuryVeto`, `recordRound`. Wire ported `l2-executive` + `l2-wire` + tactics engine. MCP tools `negotiate_quote`, `run_due_diligence`. L3 tests P07, P08. | Paste P07. Then P08 (set OpenClaw timeout ≥ 25s). | P07 closes in ≤ 1 round. P08 terminal status ∈ {ACCEPTED, NO_DEAL, ESCALATED} within 20s p95. DD ran all 4 parallel branches (verified in graph trace). |
| **V6.6** | P09–P10 capstone + persist | Build `agents/demand-planning/` + `consult_demand_planning` tool. Add persist nodes: `signEnvelope`, `writeQuotation`, `audit.close`. MCP tool `persist_quote_erpnext`. GraphQL resolvers `inquiry-by-negotiation-id`, `quote-by-negotiation-id`, `revision-chain`. L3 tests P09, P10. | Paste P09. Then P10. After P10 returns, query GraphQL with the returned `negotiationId`. | P10 returns `quotationName` (`SAL-QTN-2026-####`), `revision`, `custom_quoted_by_agent`, `custom_quoted_by_oor`, `custom_quoted_at`. PROP-2.1 five-way SQL join returns 0 rows. |
| **V6.7** | Invariants + hardening | Implement L4 property tests (13 across INV-1/2/3), L5 chaos (8), L6 perf (10 SLO budget tests), L7 negotiation quality with 5 TKI personas. Implement 3-mode runner (fast / integration / e2e). | `npm test -- --mode=fast`, then `--mode=integration`, then nightly `--mode=e2e`. | fast < 30s green; integration < 5 min green; e2e < 30 min green. All 13 INV tests pass. |
| **V6.8** | Deferred — post-MVP | Build `dvp-saga.ts` separate StateGraph + `agents/dvp/`. Activate `identity/VleiProvider.ts` (ITER7). | Bank/chain webhook endpoints; KERI witness set. | Out of scope for the 10 prompts; only if DvP demo is needed for Phase 2. |

---

## Critical path

```
V6.0 → V6.1 → V6.2
         │
         ▼
       V6.3 → V6.4 → V6.5 → V6.6 → V6.7
                                      │
                                      ▼
                                    V6.8 (post-MVP)
```

- V6.0–V6.2 are the unblocking sequence — nothing else compiles or runs without them.
- V6.3 and V6.4 are the cheapest sessions (fully deterministic; mock LLMs in tests).
- V6.5 is the costliest (first LLM in the loop; first non-deterministic E2E behavior).
- V6.6 closes the inquiry→quote correlation chain and lets INV-2 actually be tested.

## Session-count estimate

- **V6.0 – V6.6**: ~7 substantive sessions to reach P10 green.
- **V6.7**: 1–2 sessions for the full test pyramid.
- **V6.8**: post-MVP; sized only when scoped.

## First-blocker callout

V6.1's first Manual step is **provisioning ERPNext**. That decision (Frappe Cloud vs self-hosted `frappe_docker`) should be made **before V6.0 starts**, so V6.1 is not blocked on a procurement/install task.

## Mapping back to the locked iteration ladder

The original ITER1–ITER7 ladder in `01-Prompts-Schema-Structure.md §6` maps onto these cells:

| Original ITER | Cells in this plan |
|---|---|
| ITER1 (PLAIN GLEIF + base quote) | V6.0 + V6.1 + V6.2 + V6.3 (P01, P02) |
| ITER2 (ERPNext ATP live, multi-dim) | V6.4 (P03–P06) |
| ITER2/3 (treasury-driven term) | V6.3 (P07's prepaid vs Net-30) folded in |
| ITER3 (DD + credit + logistics) | V6.5 (P05, P08 do full DD) |
| Negotiation core (tactics engine) | V6.5 (P07) + V6.6 (P09) |
| Capstone + ERPNext persist | V6.6 (P10) |
| Tests as a first-class layer | V6.7 |
| ITER4 partial/SKU-split | V6.4 covers it (P06 split plan) |
| ITER5 DvP/L-C | V6.8 (deferred) |
| ITER7 vLEI | V6.8 (deferred) |

The judging ladder (P01→P10) and the build ladder (V6.0→V6.8) are now aligned: every cell ends with a verifiable OpenClaw test from the 10 prompts, plus invariant tests.

*End of iteration plan.*
