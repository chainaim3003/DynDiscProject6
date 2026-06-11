# IMPL-V6 — Agent Workflow Validation Runbook (CLI)

> Grounded in code read on this date: `src/orchestrator/graph.ts`, `run.ts`,
> `state/neg-state.ts`, `nodes/intake.ts`, `nodes/persist.ts`, `src/agents/runtime.ts`,
> `scripts/{smoke-ddn-saga,test-negotiate-veto,smoke-saga,check-erpnext-custom-fields}.ts`,
> `src/config/flags.ts`, `src/erpnext/{client,mappers,quotation-mapper}.ts`.
> Anything labelled NOT-READ below was not opened — verify before relying on it.

## 0. What this system actually is (so your assertions are calibrated)

- **One process, one LangGraph StateGraph.** Not multiple networked services.
- **Agents / sub-agents are in-process objects** built by `buildAgentRuntime()` and
  invoked *inside* graph nodes:
  - `runtime.ddCredit`  (ECR Credit Officer)     ← invoked by `dueDiligence.run`
  - `runtime.fulfillment` (ECR Operations Officer) ← invoked by `fulfillment.plan`
  - `runtime.treasury`  (ECR Treasurer, binding veto) ← invoked by `negotiate.run`
  - `runtime.buyer`     (OOR CPO principal, IN-PROCESS) ← invoked by `negotiate.run`
  - `runtime.seller` / persist (OOR CSO) signs the final quote ← `persist.signAndPersist`
- **No A2A network transport** (`graph.ts`: "DEFERRED … A2A two-party transport").
  Buyer↔seller exchange is visible only in the `rounds[]` channel, not on the wire.
- **Outputs = state channels** (`state/neg-state.ts`). The per-agent attribution trail
  is `attestations[]` (append-only: agentRef, role, subject, signature, signingMode, signedAt).
- **Deferred/placeholder (do not assert against):** negotiate uses a DETERMINISTIC
  placeholder optimizer (not the LLM); Treasury runs in DEMO-FLOOR mode (ACTUS not wired);
  Logistics/EDGAR/Companies-House deferred.

## Execution chain (verified from graph.ts edges)

```
START
 → intake.parse              (deterministic; normalizes inquiry)          [status: INTAKE]
 → intake.mirrorToERPNext    (POST Opportunity + Items)                   → opportunityName
 → ackToBuyer                                                              [status: ACKED]
 → dueDiligence.run          (ddCredit sub-agent: GLEIF + credit→term)    → gleif, ddResult (+attestation: credit-decision)
 → quoting.start             (pull Item Price / assemble)
 → fulfillment.plan          (fulfillment sub-agent: ATP/CTP/split)       → fulfillmentPlan (+attestation: fulfillment-decision)
 → quoting.draftQuote        (assemble draft)                             → quoteDraft
 → negotiate.run             (treasury veto + buyer, bounded loop)        → rounds[], (+attestations per round)
     ├─ deal/passthrough → persist.signAndPersist (seller signs)          → quotationName (+attestation: quote) [status: PERSISTED]
     └─ NO_DEAL/ESCALATED → END                                           (no Quotation)
```

DD activates only with the `DD` dimension; negotiation only with `N` (or a buyer target).
Otherwise both pass through (the P01–P02 happy path).

---

## 1. Prereqs

```bash
cd C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\DynDiscProject6\IMPL-V6
# .env must have ERPNEXT_URL + ERPNEXT_API_KEY + ERPNEXT_API_SECRET (live runs)
# typecheck the tree before driving it
npm run typecheck
```

---

## 2. Layered validation (run in this order)

### L0 — Foundation runs (infra only; NO agents)
```bash
npx tsx scripts/smoke-saga.ts
```
Proves: SqliteSaver opens, InMemoryStore round-trips, NegState reducers (concat vs
last-write) apply, thread_id checkpoint persists, buyer-safe privacy guard fires.
EXPECT: `=== ALL CHECKS PASSED ===`. Touches NO ERPNext (`:memory:` checkpointer).

### L1 — Single sub-agent in isolation: Treasury binding veto + Buyer
```bash
npx tsx scripts/test-negotiate-veto.ts
```
Proves the most important invariant: the seller counter NEVER drops below the Treasury
floor, and an unmeetable floor ESCALATES instead of crossing it. Uses the REAL
`TreasuryAgent` + `TommyBuyerAgent` with an in-memory fake credential provider (no network).
EXPECT: `RESULT: all assertions PASSED — binding veto holds.`

> ⚠️ BLOCKER (verified): this script currently imports `../src/identity-client/CredentialProvider.js`,
> but that folder is now `src/identity/`. It will fail to import until the path is fixed
> (`identity-client` → `identity`). Ask Claude to patch it (AI-side, one line).

### L2 — External dependency in isolation: GLEIF (DD's verify step)
```bash
npx tsx scripts/verify-lei.ts --help     # NOT-READ: confirm its exact flags from --help
# or:  npm run verify:lei
```
Proves the GLEIF verification path the DD sub-agent depends on, without the full saga.
(The flag set of this script was not read when writing this runbook — use `--help`.)

### L3 — FULL workflow end-to-end (all agents + sub-agents, LIVE ERPNext + GLEIF)
This is the primary command. It calls `runNegotiation()` and prints every output channel.

```bash
# 3a. Happy path — intake → quoting → persist (no DD, no negotiation)
npx tsx scripts/smoke-ddn-saga.ts --item <SEEDED_ITEM_CODE> --dimensions U,Q

# 3b. + Due-diligence sub-agent (GLEIF + credit → payment term)
npx tsx scripts/smoke-ddn-saga.ts --item <SEEDED_ITEM_CODE> \
    --dimensions U,Q,DD --credit-fixtures-dir DEMO-DATA/credit

# 3c. + Negotiation (Treasury veto + Buyer, bounded rounds) → DEAL
npx tsx scripts/smoke-ddn-saga.ts --item <SEEDED_ITEM_CODE> \
    --dimensions U,Q,DD,N --credit-fixtures-dir DEMO-DATA/credit \
    --max-rounds 3 --target-unit-price 300 --floor 250

# 3d. No-deal path → ESCALATED (floor above buyer reservation; NO Quotation written)
npx tsx scripts/smoke-ddn-saga.ts --item <SEEDED_ITEM_CODE> \
    --dimensions U,Q,N --target-unit-price 250 --floor 400 --max-rounds 3

# 3e. Full machine-readable state dump (every channel) — best for assertions
npx tsx scripts/smoke-ddn-saga.ts --item <SEEDED_ITEM_CODE> \
    --dimensions U,Q,DD,N --credit-fixtures-dir DEMO-DATA/credit \
    --max-rounds 3 --target-unit-price 300 --floor 250 --json
```
Useful extra flags (from the script's `--help`): `--buyer-lei`, `--seller-lei`, `--qty`,
`--uom`, `--size`, `--currency`, `--destination`, `--required-date`, `--payment-term`,
`--buyer-max`, `--price-list`, `--warehouse`, `--negotiation-id`, `--persist-custom-fields`.

---

## 3. Per-agent execution checklist (what to look for in L3 output)

| Agent / sub-agent | Node | Proof it EXECUTED | Output channel |
|---|---|---|---|
| Intake (seller skill) | `intake.*` | `opportunityName` is non-null | `opportunityName` |
| DD / Credit sub-agent | `dueDiligence.run` | `ddResult` non-null; `gleif` populated; attestation `subject=credit-decision` | `ddResult`, `gleif` |
| Fulfillment sub-agent | `fulfillment.plan` | `fulfillmentPlan` non-null; attestation `subject=fulfillment-decision` | `fulfillmentPlan` |
| Treasury sub-agent (veto) | `negotiate.run` | every `rounds[].sellerCounter >= floor`; attestation for the veto | `rounds[]` |
| Buyer principal (in-proc) | `negotiate.run` | `rounds[]` shows buyer moves across rounds | `rounds[]` |
| Seller principal (sign) | `persist.signAndPersist` | `quotationName` non-null; attestation `subject=quote` | `quotationName`, `attestations[]` |

> The exact attestation `subject` strings above come from the `graph.ts` / `neg-state.ts`
> headers. Confirm the literal values in the `--json` dump's `attestations[]` rather than
> trusting this table — the dump is ground truth.

The `attestations[]` array IS the "which agent ran and signed what" evidence. In a passing
DD+N run you should see ~4 distinct `agentRef`s: `ddCreditAgent`, `fulfillmentAgent`,
`treasuryAgent` (per round), `jupiterSellerAgent`.

## 4. Verifying the FINAL OUTPUTS

- **ERPNext docs:** open the printed `opportunityName` and `quotationName` in the ERPNext
  UI (`<ERPNEXT_URL>/app/opportunity/<name>`, `/app/quotation/<name>`), or GET them via REST.
- **Custom-field landing (provenance):** add `--persist-custom-fields`. NOTE: the mapper
  currently emits only a SUBSET of the live custom fields and NONE of the line-level ones
  (`custom_promised_ship_date`, `custom_split_index`, `custom_canfulfill`, `custom_lead_time_days`),
  and the live field is `custom_canfulfill` (lowercase), not the fixture's `custom_canFulfill`.
  Completing that mapping is a separate task.
- **Audit checkpoint (T2/T5):** every super-step is checkpointed to `./data/audit.db`
  with `thread_id = negotiationId`. Re-running the same `--negotiation-id` resumes the thread.
- **Schema readiness gate:** `npx tsx scripts/check-erpnext-custom-fields.ts` (read-only).

## 5. Known gaps (do not try to validate these — they don't exist yet)

1. No A2A network transport — buyer is in-process; no wire traffic to inspect.
2. Saga not exposed over MCP/SSE — only `verify_lei_gleif` + quote tools are; no MCP trigger.
3. negotiate optimizer is a deterministic placeholder (not the LLM).
4. Treasury real mode (ACTUS) not wired — demo floor only.
5. `test-negotiate-veto.ts` has a stale `identity-client` import (see L1 blocker).
