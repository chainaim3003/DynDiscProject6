# IMPL-V6 — Updated Project Structure (no code yet)

> Integrates every decision from the five V6 design docs:
> 1. `IMPL-V6-DESIGN-Prompts-Schema-Structure.md`
> 2. `IMPL-V6-Functional-Prompts-v2.md`
> 3. `IMPL-V6-Inquiry-and-Quote-Schemas.md`
> 4. `IMPL-V6-Orchestration-Design.md`
> 5. `IMPL-V6-Evals-and-Test-Design.md`

## Legend
- `⚪ PORTED` — copy/extend from `DynDiscProject5/A2A/js/` (verified to exist)
- `🆕 NEW`   — net-new for V6
- `🚧 DEFER` — designed in, not built yet (ITER5+ for DvP, ITER7 for vLEI)
- `📂`        — directory; filled in code phase
- `[Pxx]`    — file/folder used by prompt(s) Pxx

---

```
FINAGENTS1/                                                          # existing root
│
├─ DynDiscProject6/                                                  # existing dir (mostly empty per prior chat)
│  └─ IMPL-V6/                                                       # 🆕 ALL V6 work lives here, isolated from prior impl
│     │
│     ├─ README.md                                                   # 🆕 quickstart, run modes
│     ├─ SKILL.md                                                    # 🆕 NANDA skill descriptor (OpenClaw reads this); embeds Role-Note for judges
│     ├─ ROLE-NOTE-FOR-JUDGES.md                                     # 🆕 the role-framing handout (also in SKILL.md)
│     ├─ package.json                                                # 🆕 Node/TS workspace; @langchain/langgraph etc.
│     ├─ tsconfig.json                                               # 🆕
│     ├─ .env.example                                                # 🆕 all flags (see §below)
│     ├─ .gitignore                                                  # 🆕 ignores data/, node_modules/, *.db, *.db-wal, *.db-shm
│     ├─ railway.json                                                # 🆕 Nixpacks, /health, single SSE entry (matches NANDA_DynDisc)
│     │
│     ├─ agent-cards/                                                # 🆕 (files copied VERBATIM from DynDiscProject5)
│     │  ├─ jupiterSellerAgent-card.json                             # ⚪ PORTED  LEI 3358004DXAMRWRUIYJ05, OOR Jupiter_Chief_Sales_Officer
│     │  └─ tommyBuyerAgent-card.json                                # ⚪ PORTED  LEI 54930012QJWZMYHNJW95, OOR Tommy_Chief_Procurement_Officer
│     │
│     ├─ DESIGN/                                                     # 🆕 the V6 design baseline (single source of truth)
│     │  └─ baseline/
│     │     ├─ 01-Prompts-Schema-Structure.md
│     │     ├─ 02-Functional-Prompts-v2.md
│     │     ├─ 03-Inquiry-and-Quote-Schemas.md
│     │     ├─ 04-Orchestration-Design.md
│     │     ├─ 05-Evals-and-Test-Design.md
│     │     └─ 06-Project-Structure.md                                # this file
│     │
│     ├─ prompts/                                                    # 🆕 the 10 OpenClaw prompts as runnable .md
│     │  ├─ PROMPT-LADDER.md                                         # the dimension matrix
│     │  ├─ P01-simplest-prepaid.md                                  # [P01]
│     │  ├─ P02-compare-prepaid-vs-net30.md                          # [P02]
│     │  ├─ P03-atp-short-earliest-ship.md                           # [P03]
│     │  ├─ P04-multiline-multi-destination.md                       # [P04]
│     │  ├─ P05-credit-driven-term.md                                # [P05]
│     │  ├─ P06-split-shipment.md                                    # [P06]
│     │  ├─ P07-single-counter-round.md                              # [P07]
│     │  ├─ P08-3rounds-net60-dd.md                                  # [P08]
│     │  ├─ P09-demand-aware.md                                      # [P09]
│     │  └─ P10-capstone-persist.md                                  # [P10]
│     │
│     ├─ src/
│     │  │
│     │  ├─ mcp/                                                     # 🆕 MCP-over-SSE entry + tool registrations
│     │  │  ├─ server-sse.ts                                         # 🆕 single process, matches NANDA_DynDisc pattern
│     │  │  └─ tools/                                                # 🆕 one MCP tool per capability (P01-P10 surface)
│     │  │     ├─ verify_lei_gleif.ts                                # 🆕 [P01-P10]
│     │  │     ├─ create_inquiry.ts                                  # 🆕 parse prompt → Opportunity [P01-P10]
│     │  │     ├─ quote_unit_price.ts                                # 🆕 [P01-P10] (B0 base)
│     │  │     ├─ quote_with_payment_term.ts                         # 🆕 [P02, P05, P08, P10]
│     │  │     ├─ quote_with_delivery.ts                             # 🆕 [P01-P10]
│     │  │     ├─ quote_with_logistics.ts                            # 🆕 [P01-P10]
│     │  │     ├─ quote_multiline.ts                                 # 🆕 [P04, P06, P08, P10]
│     │  │     ├─ quote_size_curve.ts                                # 🆕 [P01-P10]
│     │  │     ├─ run_due_diligence.ts                               # 🆕 [P05, P08, P10]
│     │  │     ├─ propose_split_shipment.ts                          # 🆕 [P06, P10]
│     │  │     ├─ consult_demand_planning.ts                         # 🆕 [P09, P10]
│     │  │     ├─ negotiate_quote.ts                                 # 🆕 [P07, P08, P09, P10]
│     │  │     └─ persist_quote_erpnext.ts                           # 🆕 [P10]
│     │  │
│     │  ├─ orchestrator/                                            # 🆕 LangGraph.js (the StateGraph from Orch Design §3)
│     │  │  ├─ graphs/
│     │  │  │  ├─ negotiation-saga.ts                                # 🆕 main StateGraph (P01-P10)
│     │  │  │  └─ dvp-saga.ts                                        # 🚧 DEFER (ITER5+); separate graph, linked thread_id
│     │  │  ├─ state/
│     │  │  │  ├─ neg-state.ts                                       # 🆕 Annotation.Root channels (Orch Design §3.1)
│     │  │  │  └─ reducers.ts                                        # 🆕 concat for consultations[], rounds[], defensive[]
│     │  │  ├─ nodes/                                                # 🆕 one file per StateGraph node (Orch Design §3.3)
│     │  │  │  ├─ intake.parse.ts                                    # LLM Flash; produces parsed Inquiry
│     │  │  │  ├─ intake.mirrorToERPNext.ts                          # writes Opportunity (T4 commit ordering rule #1)
│     │  │  │  ├─ ackToBuyer.ts                                      # emits ACK <1s
│     │  │  │  ├─ buyer.clarify.ts                                   # bounded clarify loop (≤2)
│     │  │  │  ├─ dd.start.ts  dd.join.ts                            # parallel fan-out + join
│     │  │  │  ├─ gleif.verify.ts                                    # tool wrapper [P01-P10]
│     │  │  │  ├─ credit.consult.ts                                  # ⚪ PORTED wrapper [P05, P08, P10]
│     │  │  │  ├─ info-collection.gather.ts                          # 🆕 no scraping (website + disclosed handles only)
│     │  │  │  ├─ quoting.start.ts  quoting.draftQuote.ts            # parallel per-line / per-dest / per-term
│     │  │  │  ├─ inventory.consult.ts                               # ⚪ PORTED ERPNext Bin
│     │  │  │  ├─ logistics.consult.ts                               # ⚪ PORTED DCSA
│     │  │  │  ├─ treasury.consult.ts                                # ⚪ PORTED ACTUS PAM
│     │  │  │  ├─ fulfillment.plan.ts                                # 🆕 ATP/CTP/split decisions
│     │  │  │  ├─ demand-planning.consult.ts                         # 🆕 [P09, P10]
│     │  │  │  ├─ negotiate.proposeOffer.ts                          # LLM Pro (evaluator-optimizer optimizer)
│     │  │  │  ├─ negotiate.validate.ts                              # ⚪ PORTED constraints
│     │  │  │  ├─ negotiate.treasuryVeto.ts                          # evaluator-optimizer evaluator
│     │  │  │  ├─ negotiate.recordRound.ts                           # append to rounds[]
│     │  │  │  ├─ persist.signEnvelope.ts                            # T2 commit (ordering rule #2)
│     │  │  │  ├─ persist.writeQuotation.ts                          # T4 commit; amended_from chain
│     │  │  │  └─ audit.close.ts                                     # T5 commit LAST (ordering rule #3)
│     │  │  ├─ edges/
│     │  │  │  └─ conditional.ts                                     # dd_required? demand_aware? negotiate? round<max?
│     │  │  ├─ memory/                                               # the 5-tier model
│     │  │  │  ├─ checkpointer.ts                                    # T2 — SqliteSaver → ./data/audit.db
│     │  │  │  ├─ store.ts                                           # T3 — LangGraph Store + Gemini embeddings
│     │  │  │  ├─ namespaces.ts                                      # 5 namespaces (Orch Design §5)
│     │  │  │  └─ buyer-safe-projection.ts                           # privacy gate (no floor, no PD)
│     │  │  └─ router/
│     │  │     └─ consultation-router.ts                             # ⚪ PORTED parallel fan-out (consultAll Promise.all)
│     │  │
│     │  ├─ agents/                                                  # the 14 sub-agent modules (Orch Design §2)
│     │  │  ├─ orchestrator-shell/                                   # 🆕 jupiterSellerAgent entry; routes phases
│     │  │  ├─ buyer/                                                # ⚪ PORTED minimal (tommyBuyerAgent)
│     │  │  ├─ intake/                                               # 🆕
│     │  │  ├─ dd/                                                   # 🆕 orchestrates credit + info-collection
│     │  │  ├─ info-collection/                                      # 🆕 no scraping (locked, §9.3)
│     │  │  ├─ credit/                                               # ⚪ PORTED GLEIF + EDGAR
│     │  │  ├─ inventory/                                            # ⚪ PORTED ERPNext Bin
│     │  │  ├─ logistics/                                            # ⚪ PORTED DCSA
│     │  │  ├─ treasury/                                             # ⚪ PORTED ACTUS PAM
│     │  │  ├─ quoting/                                              # 🆕 draft quote from consults
│     │  │  ├─ demand-planning/                                      # 🆕 [P09, P10] QUOTE_DEMAND_AWARE
│     │  │  ├─ fulfillment/                                          # 🆕 ATP/CTP/split planner
│     │  │  ├─ dvp/                                                  # 🚧 DEFER ITER5+
│     │  │  └─ audit-reporting/                                      # ⚪ PORTED PDF + GraphQL + templates
│     │  │
│     │  ├─ shared/                                                  # ported + extended types/providers
│     │  │  ├─ provider-types.ts                                     # ⚪ EXTEND multi-line inputs (ConsultationRecord stays)
│     │  │  ├─ inventory-provider.ts                                 # ⚪ PORTED
│     │  │  ├─ logistics-provider.ts                                 # ⚪ PORTED
│     │  │  ├─ credit-provider.ts                                    # ⚪ PORTED
│     │  │  ├─ treasury-provider.ts                                  # ⚪ PORTED
│     │  │  ├─ actus-client.ts                                       # ⚪ PORTED
│     │  │  ├─ inquiry-types.ts                                      # 🆕 Inquiry + InquiryLine + dimensions
│     │  │  ├─ quote-types.ts                                        # 🆕 Quote + QuoteLine + revision + OOR identity block
│     │  │  ├─ negotiation-types.ts                                  # ⚪ EXTEND single→multi-line; keep audit JSON shape
│     │  │  ├─ negotiation-mode.ts                                   # ⚪ PORTED tier framework (BASIC..L2)
│     │  │  ├─ l2-executive.ts                                       # ⚪ PORTED L2 reasoning
│     │  │  ├─ l2-wire.ts                                            # ⚪ PORTED L2 wire-in
│     │  │  ├─ tactics/                                              # ⚪ PORTED WEDGE1 (effective-floor, Rubinstein δ, NBS, α-utility)
│     │  │  ├─ outcome-quality.ts                                    # ⚪ EXTEND multi-line fairness (eval L7)
│     │  │  ├─ audit-writer.ts  audit-paths.ts  audit-pdf.ts         # ⚪ PORTED
│     │  │  ├─ sqlite-sidecar.ts                                     # ⚪ PORTED
│     │  │  ├─ sse-broadcaster.ts                                    # ⚪ EXTEND with progress notifications (Eval Design §2.1)
│     │  │  ├─ scenario-loader.ts                                    # ⚪ PORTED
│     │  │  └─ utils/compliance/
│     │  │     ├─ gleif-client.ts                                    # ⚪ PORTED
│     │  │     └─ gleif-types.ts                                     # ⚪ PORTED
│     │  │
│     │  ├─ erpnext/                                                 # 🆕 REST integration (T4 system-of-record)
│     │  │  ├─ client.ts                                             # 🆕 REST wrapper: key/secret/retries/defensive
│     │  │  ├─ inquiry-repo.ts                                       # 🆕 Opportunity create/read
│     │  │  ├─ quote-repo.ts                                         # 🆕 Quotation create + amend chain + custom fields
│     │  │  ├─ mappers.ts                                            # 🆕 domain ↔ DocType field mapping (Schemas doc §1-§2)
│     │  │  └─ idempotency.ts                                        # 🆕 negotiationId-keyed write keys
│     │  │
│     │  ├─ identity/                                                # ⚪ PORTED
│     │  │  ├─ index.ts
│     │  │  ├─ CredentialProvider.ts
│     │  │  ├─ PlainJsonProvider.ts                                  # PLAIN mode for P01-P10
│     │  │  ├─ VleiProvider.ts                                       # 🚧 DEFER ITER7
│     │  │  └─ agent-card-loader.ts
│     │  │
│     │  ├─ messaging/                                               # ⚪ PORTED signed envelopes
│     │  │  ├─ index.ts
│     │  │  ├─ KramSigner.ts
│     │  │  ├─ PlainHashSigner.ts                                    # SIGNING_MODE=plain (sha256)
│     │  │  └─ signed-message.ts
│     │  │
│     │  └─ api/                                                     # audit observability surfaces (INV-3)
│     │     ├─ graphql/                                              # ⚪ EXTEND port 5000
│     │     │  ├─ index.ts  schema.ts  resolvers.ts
│     │     │  └─ resolvers/
│     │     │     ├─ inquiry-by-negotiation-id.ts                    # 🆕 (correlation queries)
│     │     │     ├─ quote-by-negotiation-id.ts                      # 🆕
│     │     │     ├─ revision-chain.ts                               # 🆕 (walks amended_from)
│     │     │     └─ audit-stream.ts                                 # 🆕 SSE subscription
│     │     ├─ onboarding-server.ts                                  # ⚪ PORTED
│     │     └─ progress-notifications.ts                             # 🆕 MCP progress streamer (Eval §2.1)
│     │
│     ├─ test/                                                       # 🆕 the L1-L7 eval pyramid (Eval Design §3)
│     │  ├─ README.md                                                # how to run each level (fast/integration/e2e)
│     │  │
│     │  ├─ unit/                                                    # L1 — fast, deterministic, no I/O
│     │  │  ├─ reducers.test.ts
│     │  │  ├─ mappers.test.ts                                       # ERPNext mapper round-trip property
│     │  │  ├─ dd-decide.test.ts                                     # PD×LGD×dealSize table
│     │  │  ├─ constraint-validator.test.ts
│     │  │  ├─ gleif-parser.test.ts
│     │  │  ├─ payment-schedule-builder.test.ts                      # 1 row at 100% invariant
│     │  │  ├─ negotiation-id.test.ts                                # 1M no-collision
│     │  │  └─ buyer-safe-projection.test.ts                         # privacy gate
│     │  │
│     │  ├─ integration/                                             # L2 — one phase end-to-end with mocks
│     │  │  ├─ intake-to-opportunity.test.ts
│     │  │  ├─ dd-phase.test.ts
│     │  │  ├─ quoting-phase.test.ts
│     │  │  ├─ negotiation-single-round.test.ts
│     │  │  └─ persist-phase.test.ts
│     │  │
│     │  ├─ e2e/                                                     # L3 — full saga per prompt
│     │  │  ├─ P01-simplest.test.ts                                  # [P01]
│     │  │  ├─ P02-compare-terms.test.ts                             # [P02]
│     │  │  ├─ P03-atp-short.test.ts                                 # [P03]
│     │  │  ├─ P04-multidest.test.ts                                 # [P04]
│     │  │  ├─ P05-credit-driven.test.ts                             # [P05]
│     │  │  ├─ P06-split.test.ts                                     # [P06]
│     │  │  ├─ P07-counter.test.ts                                   # [P07]
│     │  │  ├─ P08-3rounds.test.ts                                   # [P08]
│     │  │  ├─ P09-demand-aware.test.ts                              # [P09]
│     │  │  └─ P10-capstone.test.ts                                  # [P10]
│     │  │
│     │  ├─ properties/                                              # L4 — INV-1/2/3 (load-bearing)
│     │  │  ├─ INV-1-response-guarantee/
│     │  │  │  ├─ PROP-1.1-no-orphan-inquiry.test.ts
│     │  │  │  ├─ PROP-1.2-slo-budget.test.ts
│     │  │  │  └─ CHAOS-1.3-mid-saga-kill.test.ts
│     │  │  ├─ INV-2-inquiry-quote-correlation/
│     │  │  │  ├─ PROP-2.1-five-way-join.test.ts                     # cross-DB SQL join
│     │  │  │  ├─ PROP-2.2-line-level-correlation.test.ts
│     │  │  │  ├─ PROP-2.3-revision-chain.test.ts
│     │  │  │  ├─ PROP-2.4-envelope-integrity.test.ts
│     │  │  │  └─ PROP-2.5-no-cross-thread-leakage.test.ts
│     │  │  ├─ INV-3-audit-always-available/
│     │  │  │  ├─ PROP-3.1-read-during-write.test.ts
│     │  │  │  ├─ PROP-3.2-close-marker-ordering.test.ts
│     │  │  │  ├─ PROP-3.3-crash-consistency.test.ts
│     │  │  │  ├─ PROP-3.4-graphql-freshness.test.ts
│     │  │  │  └─ PROP-3.5-no-orphan-either-direction.test.ts
│     │  │  └─ helpers/
│     │  │     ├─ cross-db-join.ts                                   # ERPNext ↔ audit.db join helper
│     │  │     └─ envelope-walker.ts
│     │  │
│     │  ├─ chaos/                                                   # L5 — failure injection
│     │  │  ├─ erpnext-down-write.test.ts
│     │  │  ├─ erpnext-down-read.test.ts
│     │  │  ├─ gleif-down.test.ts
│     │  │  ├─ actus-timeout.test.ts
│     │  │  ├─ llm-500.test.ts
│     │  │  ├─ process-crash-mid-round.test.ts
│     │  │  ├─ concurrent-inquiry-storm.test.ts
│     │  │  └─ tamper-detection.test.ts                              # ⚪ EXTEND existing scripts/test-tamper.ts
│     │  │
│     │  ├─ perf/                                                    # L6 — SLO budgets
│     │  │  ├─ p01-budget.test.ts ... p10-budget.test.ts
│     │  │  └─ slo-budgets.json                                      # p50/p95 from Orch Design §6
│     │  │
│     │  ├─ negotiation-quality/                                     # L7 — outcome scoring
│     │  │  ├─ deal-close-rate.test.ts
│     │  │  ├─ zopa-preservation.test.ts
│     │  │  ├─ rounds-to-close.test.ts
│     │  │  ├─ buyer-fairness.test.ts
│     │  │  └─ persona-matrix.test.ts                                # 10 prompts × 5 personas
│     │  │
│     │  ├─ personas/                                                # TKI 5 buyer personas (Eval §8)
│     │  │  ├─ aggressive.json
│     │  │  ├─ assertive.json
│     │  │  ├─ balanced.json
│     │  │  ├─ cooperative.json
│     │  │  └─ win-win-seeking.json
│     │  │
│     │  ├─ fixtures/                                                # canned responses for deterministic replay
│     │  │  ├─ gleif/                                                # ACTIVE / LAPSED / etc.
│     │  │  ├─ edgar/                                                # buyer credit profiles
│     │  │  ├─ erpnext/                                              # Bin, Item, Customer, Pricing Rule canned responses
│     │  │  ├─ actus/                                                # treasury sims
│     │  │  ├─ dcsa/                                                 # carrier quotes
│     │  │  └─ llm/                                                  # canned LLM proposals (deterministic)
│     │  │
│     │  └─ helpers/
│     │     ├─ mode-runner.ts                                        # fast | integration | e2e
│     │     ├─ provider-mock.ts
│     │     ├─ erpnext-sandbox.ts                                    # spins isolated ERPNext for e2e
│     │     ├─ audit-reader.ts                                       # query audit.db / GraphQL
│     │     └─ time-travel.ts                                        # LangGraph time-travel for replay
│     │
│     ├─ scripts/                                                    # operational scripts
│     │  ├─ bootstrap-counterparties.ts                              # ⚪ EXTEND seed Tommy+Jupiter into ERPNext via REST
│     │  ├─ replay-fixtures.ts                                       # ⚪ EXTEND P01-P10 scenarios
│     │  ├─ run-mode-matrix.ts                                       # ⚪ EXTEND 3-mode runner
│     │  ├─ test-envelope-ordering.ts                                # ⚪ EXTEND with ERPNext cross-check (PROP-2.4)
│     │  ├─ test-tamper.ts                                           # ⚪ PORTED
│     │  └─ test-cli-parser.ts                                       # ⚪ EXTEND for prompt→inquiry parsing
│     │
│     ├─ DEMO-DATA/                                                  # fixtures (extended for V6)
│     │  ├─ inventory/                                               # per variant
│     │  │  ├─ erpnext-bin-TH-TEE-RN-180-S.json                      # 🆕 [P03 ATP-short scenarios]
│     │  │  ├─ erpnext-bin-TH-TEE-RN-180-M.json                      # 🆕
│     │  │  ├─ erpnext-bin-TH-TEE-RN-180-L.json                      # 🆕
│     │  │  ├─ erpnext-bin-TH-TEE-RN-180-XL.json                     # 🆕
│     │  │  ├─ erpnext-bin-TH-POLO-PIQ-220-*.json                    # 🆕
│     │  │  ├─ erpnext-bin-TH-HOOD-FLC-320-*.json                    # 🆕
│     │  │  └─ erpnext-bin-FAB-COTTON-180GSM.json                    # ⚪ PORTED
│     │  ├─ treasury/                                                # per term
│     │  │  ├─ jupiter-pricepoint-Net-0.json                         # 🆕
│     │  │  ├─ jupiter-pricepoint-Net-30.json                        # ⚪ PORTED (extend if needed)
│     │  │  └─ jupiter-pricepoint-Net-60.json                        # 🆕
│     │  ├─ logistics/                                               # per destination
│     │  │  ├─ dcsa-MAA-RTM.json                                     # 🆕 Madras→Rotterdam
│     │  │  ├─ dcsa-MAA-HAM.json                                     # 🆕 Madras→Hamburg [P04]
│     │  │  └─ dcsa-MAA-LAX-50000units.json                          # ⚪ PORTED
│     │  ├─ credit/                                                  # buyer profiles
│     │  │  ├─ edgar-tommy-hilfiger-europe.json                      # 🆕
│     │  │  └─ edgar-companyfacts-PHILLIPS-VAN-HEUSEN.json           # ⚪ PORTED
│     │  └─ scenarios/                                               # scripted scenarios per prompt
│     │     ├─ P01-happy-path.json ... P10-capstone.json             # 🆕
│     │     ├─ scenarios-index.json                                  # ⚪ EXTEND
│     │     └─ legacy/                                               # existing cotton scenarios PORTED here
│     │
│     ├─ data/                                                       # runtime; gitignored
│     │  ├─ audit.db                                                 # T2 saga + T5 audit (one file)
│     │  ├─ audit.db-shm  audit.db-wal
│     │  ├─ store.db                                                 # T3 semantic
│     │  ├─ audits/                                                  # forensic JSON dumps
│     │  └─ reports/{daily,on-demand,weekly}/                        # generated reports
│     │
│     └─ ui/                                                         # ⚪ PORTED AgentFlow dashboard (separate Vite app; demo only)
│
└─ erpnextEnh1/                                                      # 🆕 ERPNext customization layer (GPL-safe, REST-only)
   │
   ├─ README.md
   ├─ FIELD-MAP.md                                                   # inquiry/quote ↔ DocType mapping (from Schemas doc)
   │
   ├─ apps/
   │  └─ chainaim_proc/                                              # 🆕 custom Frappe APP (not a fork of erpnext)
   │     ├─ hooks.py
   │     ├─ pyproject.toml
   │     ├─ MANIFEST.in
   │     └─ chainaim_proc/
   │        ├─ __init__.py
   │        ├─ custom/                                               # 🆕 Custom Field + Property Setter JSON
   │        │  ├─ opportunity.json                                   # custom_inquiry_id, custom_buyer_lei, etc.
   │        │  ├─ opportunity_item.json                              # custom_size, custom_required_delivery_date, etc.
   │        │  ├─ quotation.json                                     # custom_quoted_by_agent, custom_quoted_by_oor, etc.
   │        │  └─ quotation_item.json                                # custom_split_index, custom_promised_ship_date, etc.
   │        ├─ fixtures/                                             # 🆕 exportable
   │        │  ├─ custom_field.json
   │        │  ├─ property_setter.json
   │        │  ├─ item_attribute.json                                # Size = {S,M,L,XL}
   │        │  ├─ payment_term.json                                  # Net-0, Net-30, Net-60
   │        │  └─ payment_terms_template.json
   │        └─ webhooks/                                             # 🆕 → IMPL-V6 /sync endpoint
   │           ├─ item_on_update.json
   │           ├─ customer_on_update.json
   │           ├─ sales_order_on_submit.json
   │           ├─ sales_order_on_cancel.json
   │           └─ bin_on_change.json
   │
   └─ seed/                                                          # 🆕 REST seed scripts (Python or TS, flagged)
      ├─ 00-bootstrap-masters.py                                     # Company/Warehouse/UOM/Brand/Item Attr Size/Payment Terms/GST/Customer Tommy
      ├─ 01-seed-items-variants.py                                   # TH-TEE-RN-180 + S/M/L/XL variants + polo + hoodie + FAB
      ├─ 02-install-custom-fields.py                                 # the core of erpnextEnh1
      ├─ 03-install-webhooks.py                                      # register → IMPL-V6 sync endpoint
      ├─ 04-seed-demo-bins.py                                        # ATP profiles: --profile happy|short|mixed
      └─ 90-export-fixtures.py                                       # idempotency / `bench export-fixtures` equivalent
```

---

## Cross-reference: design doc → where it lands in the tree

| Design doc | Realized in |
|---|---|
| **01 Prompts-Schema-Structure** (the integrating doc) | `IMPL-V6/DESIGN/baseline/01-…` + the whole tree |
| **02 Functional-Prompts-v2** (the 10 prompts) | `IMPL-V6/prompts/*` + `IMPL-V6/SKILL.md` (role note) + `test/e2e/Pxx-*.test.ts` |
| **03 Inquiry-and-Quote-Schemas** (ERPNext schema) | `erpnextEnh1/apps/chainaim_proc/custom/*` (Custom Fields) + `erpnextEnh1/seed/02-install-custom-fields.py` + `IMPL-V6/src/erpnext/mappers.ts` |
| **04 Orchestration-Design** (StateGraph + 14 agents) | `IMPL-V6/src/orchestrator/*` + `IMPL-V6/src/agents/*` |
| **05 Evals-and-Test-Design** (invariants + pyramid) | `IMPL-V6/test/*` (the L1-L7 layout) |

---

## `.env.example` (the flag surface — recap)

```
# Orchestration / memory (locked)
ORCHESTRATOR=langgraph-ts
CHECKPOINTER_KIND=sqlite
AUDIT_DB_PATH=./data/audit.db          # T2 + T5 share this file
MEMORY_STORE_KIND=memory               # memory | sqlite | postgres   (T3)
EMBEDDING_MODEL=text-embedding-004
CLARIFY_MAX_ROUNDS=2
NEGOTIATION_MAX_ROUNDS=3
QUOTE_DEMAND_AWARE=off                 # on = Quoting consults Demand-Planning ([P09], [P10])

# Provider modes (locked)
INVENTORY_MODE=real                    # ERPNext Bin
CREDIT_MODE=real                       # GLEIF live; EDGAR demo
LOGISTICS_MODE=demo
TREASURY_MODE=real                     # ACTUS PAM
CREDENTIAL_MODE=plain                  # vlei → ITER7
SIGNING_MODE=plain                     # sha256 envelope

# ERPNext (T4)
ERPNEXT_URL=http://localhost:8080
ERPNEXT_API_KEY=
ERPNEXT_API_SECRET=
ERPNEXT_COMPANY=Jupiter Knitting Company
ERPNEXT_CURRENCY=INR
ERPNEXT_DEFAULT_WAREHOUSE=MADRAS-WH-1
QUOTE_PERSIST_MODE=final               # final | every-round (Schemas doc §2.5)
PAYMENT_TERMS_ALLOWED=Net-0,Net-30,Net-60
GST_RATE=18

# Eval modes
EVAL_MODE=fast                         # fast | integration | e2e
```

---

## What this tree does *not* yet include (deferred + open items)

- `🚧 src/orchestrator/graphs/dvp-saga.ts` and `🚧 src/agents/dvp/` — deferred to ITER5+.
- `🚧 src/identity/VleiProvider.ts` activation — deferred to ITER7 (skeleton ported, not wired).
- The 5 source files still to read (Eval §10, Orch §10) before code: `negotiation-mode.ts`, `l2-executive.ts`, `l2-wire.ts`, `seller-agent/index.ts`, `outcome-quality.ts`.
- ERPNext DocType reads still pending: `Item`, `Item Price`, `Pricing Rule`, `Incoterm`, `Shipping Rule`, `Payment Term`.

These are listed so nothing here is silently assumed.

*End of project structure.*
