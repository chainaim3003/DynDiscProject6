# IMPL-V6 — Design ↔ Implementation Conformance Review

**Scope:** end-to-end multi-agent workflow, ERPNext integration, Docker/runtime deployment,
orchestration, data flow, external APIs, and project structure.
**Excluded (per request):** all vLEI-specific components (KERI/ACDC, OOR/ECR delegation, Sally,
`identity-client/` internals, `messaging/AcdcSigner`, HOST B `vLEIEnh1`).
**Method:** direct reads of the two design docs and the implementation files listed in
§Appendix. No memory-based claims; deferred/placeholder items use the code's own labels.

> **Framing caveat (important):** `REFINED-Project-Structure.md` is explicitly headed
> *"Status: proposal. No codebase is changed,"* and `REFINED-MultiAgent-Design-vLEI.md` marks
> §2–§8 as *"architectural recommendation."* So these are **target** documents. "Conformance"
> below therefore means *how far the code has realized the proposal*, not deviation from a frozen
> spec. Many "gaps" are items the code itself marks DEFERRED.

---

## 1. Verdict summary

| Area | Verdict | Notes |
|---|---|---|
| Agent boundary (2 principals + 3 sub-agents) | **Conforms** | `src/agents/principals/*`, `src/agents/subagents/*` match design §2/§6 |
| Orchestration graph (LangGraph StateGraph) | **Conforms (topology)** | Linear saga in `graph.ts`; nodes match the 5 phases |
| End-to-end data flow ERPNext→agents→external→ERPNext | **Works via library entry; NOT via the MCP API** | `runNegotiation()` drives it; MCP-SSE server does not expose it |
| ERPNext integration | **Conforms (real)** | Real REST client + mappers; Quotation custom fields gated (no fixture yet) |
| External integrations | **Partial** | GLEIF real; credit = fixture demo; ACTUS/treasury, DCSA logistics = deferred |
| MCP-over-SSE API surface | **Partial / deviates** | Exposes only 3 tools; the saga + DD/negotiate/persist tools are absent |
| A2A two-party transport | **Not implemented (deferred)** | Buyer is invoked in-process; no `@a2a-js/sdk` dependency |
| LLM negotiation optimizer | **Not implemented (placeholder)** | Deterministic concession; Gemini deps present but unused |
| Docker deployment (HOST A) | **N/A by design — correctly absent** | HOST A is Railway/NIXPACKS; Docker belongs to HOST B (vLEI, excluded) |
| Project structure (full refined tree) | **Partially realized** | Core present; `tools/`, `api/`, `test/`, some `orchestrator/` subfolders absent |
| Test suite (L1–L7 pyramid) | **Not implemented** | Only standalone `tsx` scripts; `npm test` is a placeholder |

---

## 2. Project structure conformance

**Realized as designed**
- `src/agents/principals/{jupiter-seller,tommy-buyer}` and `src/agents/subagents/{dd-credit,treasury,fulfillment}` — the 2+3 collapse from design §2 is present, each with `SKILL.md` + `index.ts`.
- `src/orchestrator/{state,nodes,memory}` with `neg-state.ts`, the five node files, `checkpointer.ts`, `store.ts`, `namespaces.ts`.
- `src/erpnext/{client,mappers,quotation-mapper}.ts`.
- `src/mcp/{server-sse,tools/}`.
- `identity/agent-cards/` exists at the project root (per root listing).

**Deviations / not-yet-realized vs `REFINED-Project-Structure.md` §2**
- **`src/tools/` directory does not exist.** The proposed pull-out of deterministic capabilities (`tools/gleif`, `tools/dcsa`, `tools/actus`, `tools/edgar`, `tools/companies-house`, `tools/audit`) was not done. GLEIF still lives at `src/shared/compliance/gleif-client.ts`; `credit-provider.ts` lives in `src/shared/`. *(Inference: the structural reorg is the part the proposal doc itself says is unbuilt.)*
- **`src/api/` does not exist** — but `package.json` still ships `"graphql": "tsx src/api/graphql/index.ts"`. **That script references a path that is not present in `src/` (verified against the `src` tree).** The GraphQL/audit observability API in design §2 is unimplemented and the script would fail.
- **`orchestrator/` sub-shape differs:** design proposed `graphs/`, `edges/`, `router/`, `state/reducers.ts`, `memory/buyer-safe-projection.ts`. Actual uses a flat `graph.ts`, conditional edges inline in `graph.ts`, reducers inline in `neg-state.ts`, and the buyer-safe projection inside `memory/namespaces.ts`. Functionally equivalent; structurally different. No `router/consultation-router.ts` and no `nodes/audit.close.ts`.
- **`src/config/` is not in the design tree** but exists in code (`flags.ts`, `identity-flags.ts`). Reasonable; flag resolution has to live somewhere.
- **`src/erpnext/` is missing `inquiry-repo.ts`, `quote-repo.ts`, `idempotency.ts`** from the design tree. The current client is a generic REST client; there is no repository layer and **no idempotency layer** (see §4 risk).
- **`test/` tree (L1–L7 pyramid) absent.** Only `scripts/{smoke-saga,test-negotiate-veto,verify-lei}.ts` plus the new `smoke-ddn-saga.ts`. `package.json` `test` script is an explicit placeholder.

---

## 3. End-to-end workflow & data flow

**Graph topology (verified in `graph.ts`)** — a single linear seller saga:

```
START → intake.parse → intake.mirrorToERPNext → ackToBuyer
      → dueDiligence.run            (gated on "DD" dimension; else pass-through)
      → quoting.start → fulfillment.plan → quoting.draftQuote
      → negotiate.run ─┬─ deal/pass-through → persist.signAndPersist → END
                       └─ NO_DEAL / ESCALATED ──────────────────────→ END
```

This matches the design's 5-phase flow (intake → DD → quoting/ATP → negotiate+veto → persist+sign).

**The ERPNext → Multi-Agent → External → ERPNext loop (verified):**
1. **ERPNext IN** — `intake.mirrorToERPNext` → `erp.insert("Opportunity", …)` via `mapInquiryToOpportunityPayload` (native + custom `opportunity.json` fields). Fails loud if no `name` returned.
2. **External** — `dueDiligence.run` calls `verifyLeiGleif` (live GLEIF v1) on **both** LEIs, then `DdCreditAgent.decide()` via the injected `CreditProvider`.
3. **ERPNext READ** — `fulfillment.plan` → `FulfillmentAgent.decidePlan()` using an `InventoryProvider` built from the ERPNext client (`createInventoryProvider(deps.erp,{warehouse})` in `graph.ts`) → ERPNext `Bin`. *(Wiring verified in `graph.ts`; provider internals not re-read this session.)*
4. **Pricing** — `quoting.draftQuote` prices each line through `quoteWithQuantity` (the same handler the MCP pricing tool exposes), reading ERPNext Item Price; throws on any unpriced line (no phantom rates).
5. **Negotiate** — bounded loop, **binding** treasury veto (clamps to floor, never emits below it), buyer evaluation **in-process**, per-round signed `RoundOutcome` + attestations.
6. **ERPNext OUT** — `persist.signAndPersist` signs the quote, then `erp.insert("Quotation", …)` via `mapQuoteToQuotationPayload`. Throws on failure; never fabricates a `quotationName`.

**Verdict:** the full loop is **implemented and coherent end-to-end when driven through `runNegotiation()`** (the library entry / the `smoke-ddn-saga.ts` harness). Every phase writes a real ERPNext doc or calls a real/injected provider, with fail-loud semantics throughout.

**Key deviation — the two-principal A2A channel:** design §3 shows two cross-org principals exchanging signed envelopes over an **A2A NEGOTIATION CHANNEL (MCP-over-SSE)**. In code the buyer (`TommyBuyerAgent`) is a **co-located object invoked inside `negotiate.run`** (`deps.buyer.evaluateQuote(...)`). There is **no network transport between two independently running agents**, and **no `@a2a-js/sdk` dependency** in `package.json`. `graph.ts` itself lists *"A2A two-party transport"* as DEFERRED. So the "multi-agent negotiation" is currently an in-process evaluator-optimizer, not two networked principals.

---

## 4. ERPNext integration (detail)

- **`client.ts`** — a real, typed Frappe/ERPNext REST client: token auth, `whoami`, `getDoc`/`exists`/`list`/`findOne`/`insert`/`update`/`callMethod`, 30s timeout, 403/404→null/[] (existence reads clean), typed `ErpNextError` on genuine failures, fail-fast if API key/secret unresolved. Documented as a faithful port of the proven `erpnextEnh1` Python seed contract. **Solid, conforms.**
- **`mappers.ts`** — `Inquiry`→`Opportunity` (header + items), native + custom fields verbatim from the installed `opportunity.json` / `opportunity_item.json` fixtures. Handles the **hyphen-vs-space payment-term naming** mismatch (domain `Net-30` → seeded `Net 30`) explicitly. Prunes null/undefined. **Conforms.**
- **`quotation-mapper.ts`** — `Quote`→`Quotation` native fields always; the seven custom identity fields are **gated behind `includeCustomFields` (default false) because no `erpnextEnh1` Quotation custom-field fixture exists yet**. Honest and correct — matches the handoff's open item #6.

**Risk flag (not in design, not in code):** there is **no idempotency layer** (design tree listed `erpnext/idempotency.ts`). `intake.mirrorToERPNext` and `persist.signAndPersist` both do raw `insert`. Re-running a saga on the same `negotiationId` will create **duplicate** Opportunity/Quotation docs — the SQLite checkpointer resumes graph state but does not dedupe ERPNext writes. Recommend an idempotency/upsert guard before any repeated/live runs.

---

## 5. External integrations & API surface

**External providers**
- **GLEIF — real** (`verify_lei_gleif` wrapping `shared/compliance/gleif-client.ts`; called live in DD). Conforms.
- **Credit (EDGAR / Companies House) — not implemented.** DD uses a **fixture-backed demo `CreditProvider`** (`createDemoCreditProvider({fixturesDir})`). Design's `tools/edgar`, `tools/companies-house` absent.
- **Treasury / ACTUS PAM — not wired.** `negotiate.run` uses a **configured `demoFloor`**; real mode would derive the floor from ACTUS, which throws / is an open item. No `tools/actus`.
- **DCSA logistics — deferred** (per `graph.ts` header). No `tools/dcsa`.

**MCP-over-SSE API (`server-sse.ts` + `tools/index.ts`)**
- Real Express server: `GET /health` (Railway healthcheck), `GET /sse` (one `McpServer`+transport per connection), `POST /messages?sessionId=…`. SDK usage documented as read from the installed `@modelcontextprotocol/sdk` typings. **Transport plumbing conforms.**
- **`TOOL_REGISTRY` exposes only three tools:** `verify_lei_gleif`, `quote_unit_price`, `quote_with_quantity`.
- **Deviation:** design §2 lists MCP tools `create_inquiry`, `run_due_diligence`, `negotiate_quote`, `persist_quote_erpnext`. **None exist.** The `server-sse.ts` header openly states the orchestrator + remaining tools are V6.3+ and that the graph should later be *"invoke[d] from inside a tool handler here."* **Consequence:** the multi-agent saga is **not reachable over the MCP-over-SSE API** that OpenClaw connects to — only the 3 deterministic tools are. The saga runs only via the in-process `runNegotiation()` library call.

---

## 6. Docker & runtime/deployment

- **No `Dockerfile` / `docker-compose.yml` in `IMPL-V6`** (verified by root listing). `railway.json` uses the **NIXPACKS** builder, `npm run build` → `npm run start` (`node dist/mcp/server-sse.js`), healthcheck `/health`.
- This **matches the design**: `REFINED-Project-Structure.md` §1/§3 places Docker **entirely on HOST B (`vLEIEnh1/legentvLEI`)** — a separate Linux/WSL Docker stack for the vLEI identity layer (KERIA, witnesses, Sally, schema server). HOST A (`IMPL-V6`) is plain Node/TS and *"does not vendor KERI code."*
- **Since you excluded vLEI, the only Docker in scope is HOST B, which is the excluded layer.** So: **there is no in-scope Docker deployment to validate, and its absence on HOST A is correct per design.** The HOST A runtime architecture (single Node process, MCP-SSE server as the entry, Railway/NIXPACKS) is implemented as designed.

---

## 7. Consolidated gaps & deviations

| # | Gap / deviation | Severity | Design says |
|---|---|---|---|
| G1 | Saga not exposed over MCP-SSE (only 3 tools) | **High** (blocks OpenClaw-driven end-to-end) | §2 lists run_due_diligence/negotiate_quote/persist_quote_erpnext |
| G2 | A2A two-party transport absent; buyer in-process | **High** (architectural) | §3 two principals over MCP-SSE / A2A |
| G3 | No idempotency on ERPNext writes | **High** (data risk on re-run) | tree listed `erpnext/idempotency.ts` |
| G4 | LLM negotiation optimizer = deterministic placeholder | Medium | §5.2 phase 4 (LLM evaluator-optimizer) |
| G5 | Credit via fixtures, not EDGAR/CH; ACTUS treasury not wired | Medium | §6 S1/S2 real providers |
| G6 | `npm run graphql` → non-existent `src/api/graphql/index.ts` | Medium (broken script) | §2 `src/api/` audit observability |
| G7 | No `test/` pyramid; `npm test` is a placeholder | Medium | §2 test/ L1–L7 + identity tests |
| G8 | Quotation custom identity fields gated (no fixture) | Low (known) | identity persisted to ERPNext |
| G9 | `src/tools/` reorg not done; clients still in `shared/` | Low (cosmetic) | §2 tools/ pull-out |

---

## 8. Recommendations (prioritized; AI vs Manual)

1. **(G3, do first) Add ERPNext idempotency** before any repeated/live run. *AI can do:* add `erpnext/idempotency.ts` — look up existing Opportunity by `custom_inquiry_id` and Quotation by `custom_negotiation_id` (findOne) and upsert instead of blind insert; flag-gate with `--idempotent` default on. *Manual:* confirm the dedupe key fields are queryable on your instance.
2. **(G1) Expose the saga as an MCP tool.** *AI can do:* add a `run_negotiation` tool descriptor whose handler calls `runNegotiation()`, register it in `TOOL_REGISTRY`; optionally `run_due_diligence`/`persist_quote_erpnext` as thinner tools. This is the single change that makes the system end-to-end-drivable the way the design intends.
3. **(G6) Fix or remove the `graphql` script** so the package is internally consistent — either scaffold `src/api/graphql/index.ts` (AI can stub a real Yoga server over the audit DB) or drop the script.
4. **(G4/G5) Replace placeholders with real providers** — LLM optimizer (`@langchain/google-genai` is already a dep; needs `GEMINI` key — *Manual*), then EDGAR/CH credit and ACTUS treasury (**confirm the ACTUS endpoint contract first — it is an open item**).
5. **(G2) A2A transport** is a larger architectural step (stand up the buyer as a separate process/endpoint, add `@a2a-js/sdk`, route signed envelopes). Sequence it after the saga is MCP-exposed.
6. **(G7) Stand up the test suite** (decide vitest vs the existing `tsx` scripts) — start with the channels/veto/determinism cases.

---

## Appendix — files read this session

Design: `REFINED-MultiAgent-Design-vLEI.md`, `REFINED-Project-Structure.md`.
Code: `orchestrator/{run,graph}.ts`, `orchestrator/state/neg-state.ts`,
`orchestrator/nodes/{intake,due-diligence,quoting,fulfillment,negotiate,persist}.ts`,
`erpnext/{client,mappers,quotation-mapper}.ts`, `mcp/server-sse.ts`, `mcp/tools/index.ts`,
`package.json`, `railway.json`, plus the `src` tree, `DEMO-DATA` tree, and root listing.

**Not read this session (so not relied upon):** the agent `index.ts` decision internals
(`dd-credit`, `treasury`, `fulfillment`, `tommy-buyer`), `inventory-provider.ts`,
`credit-provider.ts`, `gleif-client.ts`, `flags.ts`, `README.md`, `STRUCTURE-STATUS.md`.
Claims about those rest on the calling nodes/graph wiring (verified) or the prior-session
handoff (labeled). Say the word and I'll verify any of them directly.
