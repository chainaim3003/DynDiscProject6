# IMPL-V6 — As-Built Detailed Design (Plain Mode, no vLEI)

> **What this is:** the system *as it actually runs today*, grounded in the code and in a
> verified green end-to-end run (`status=PERSISTED`, `SAL-QTN-2026-00001`). This is the
> companion to the aspirational `DESIGN_6/REFINED-*` docs — where they describe the target,
> this describes what executes now.
> **Scope:** `CREDENTIAL_MODE=plain` (vLEI deferred), single-process, in-process buyer.
> **Grounding ledger:** facts read from `config/flags.ts`, `orchestrator/run.ts`,
> `orchestrator/nodes/quoting.ts`, `erpnext/{quotation-mapper,client}.ts`,
> `agents/agent-contract.ts`, `identity-client/index.ts`, `.env`, the smoke harness, and the
> live run output. Items not directly read are flagged "(inferred)".

---

## 1. Purpose

An autonomous **B2B apparel-trade negotiation** between two companies' agents:

- **Seller** — Jupiter Knitting Company (`jupiterSellerAgent`, LEI `3358004DXAMRWRUIYJ05`)
- **Buyer** — Tommy Hilfiger Europe B.V. (`tommyBuyerAgent`, LEI `54930012QJWZMYHNJW95`)

The seller agent verifies the counterparty, decides a credit/payment term, checks fulfilment,
assembles and prices a quote, negotiates inside a Treasury-vetoed floor, and persists a signed
Quotation to ERPNext. Every decision is signed and attributed to a named role — the structure
that vLEI would later peg to a real human officer.

**Locked invariants:** currency INR (₹), GST 18%, UOM Nos; one-time payment (Net-0/30/60 only);
fixed 3-SKU catalog (`TH-TEE-RN-180`, `TH-POLO-PIQ-220`, `TH-HOOD-FLC-320`), sizes S/M/L/XL.

---

## 2. Architecture — three layers

| Layer | Engine | Status today |
|---|---|---|
| Orchestration | LangGraph StateGraph (single process) | **Live** — the saga runs end-to-end |
| Transport (principal ↔ principal) | A2A (`@a2a-js/sdk`) | **Deferred** — buyer is in-process |
| Identity / signing | vLEI via `vLEIEnh1` (HOST B) | **Deferred** — plain sha256 instead |

Plain mode reads **none** of the HOST B URLs; local dev is fully self-contained (`.env`).

---

## 3. Agent model

A component is a first-class **Agent** only if it (1) owns a human-accountable decision,
(2) holds private state, and (3) needs its own identity peggable to a human via **OOR**
(statutory role) or **ECR** (functional role). Everything else is a **tool** running *under*
an agent's identity. This collapses the original 14 "agents" to **2 principals + 3 sub-agents**.

```
tommyBuyerAgent (OOR CPO)  ──inquiry/counter/accept──▶  jupiterSellerAgent (OOR CSO)
                                                              │ delegates to
                                          ┌───────────────────┼───────────────────┐
                                   dd-credit (ECR)      treasury (ECR)      fulfillment (ECR)
                                   Credit Officer        Treasurer          Operations Officer
```

### 3.1 Principals (cross-org, OOR-pegged)

**`jupiterSellerAgent`** — OOR Chief Sales Officer
- **Skills (its own acts):** intake parse, quote assembly, negotiation moves, persist + sign.
- **Tools:** `verify_lei_gleif`, ERPNext REST, pricing handler (`quote_with_quantity`), `PlainHashSigner`.
- **Resources:** ERPNext Opportunity + Quotation; `audit.db` (SQLite checkpoint).
- **Guardrails:** ACK before long work; never expose floor/`minViablePrice` to buyer; Treasury veto is binding.

**`tommyBuyerAgent`** — OOR Chief Procurement Officer
- **Skill:** build inquiry; evaluate quote; accept / counter / reject within mandate.
- **Tools:** none — transport only.
- **Resources:** buyer-safe state projection only (never the seller's floor or credit data).

### 3.2 Seller sub-agents (internal, ECR-pegged, delegated)

| Sub-agent | ECR role | Decision owned | Tools | Resources |
|---|---|---|---|---|
| `dd-credit` | Credit Officer | payment term Net-0/30/60 + rationale (`pd1y`, `lgd`) | GLEIF (live); credit provider (fixtures; EDGAR/CH deferred) | credit fixtures dir; ERPNext Customer |
| `treasury` | Treasurer | price floor / `minViablePrice` / **binding veto** | ACTUS PAM (demo floor now; real deferred) | configured demo floor |
| `fulfillment` | Operations Officer | ATP / CTP / split + ship dates | inventory provider (ERPNext Bin); demand-planning (off by default) | ERPNext Bin; Sales Order |

> Sub-agent `index.ts` decision bodies were originally interface stubs; the live run confirms
> `dd-credit`, `treasury`, and `fulfillment` now execute and sign (attestations present).

---

## 4. Execution flow (the saga)

Single linear StateGraph, `thread_id = negotiationId`, checkpointed every super-step.

```
START
 → intake.parse            normalize inquiry                         [INTAKE]
 → intake.mirrorToERPNext  POST Opportunity (+ items)                → opportunityName
 → ackToBuyer                                                        [ACKED]
 → dueDiligence.run        (gated on "DD") GLEIF + credit → term     → gleif, ddResult (+attestation)
 → quoting.start
 → fulfillment.plan        ATP/CTP/split via ERPNext Bin             → fulfillmentPlan (+attestation)
 → quoting.draftQuote      price each line; fail-loud if unpriced    → quoteDraft
 → negotiate.run           (gated on "N") rounds + treasury veto     → rounds[] (+attestations)
     ├─ deal/passthrough → persist.signAndPersist  sign + POST Quotation → quotationName [PERSISTED]
     └─ NO_DEAL / ESCALATED → END (no Quotation)
```

**Dimensions gate behaviour:** `DD` activates due-diligence; `N` activates negotiation;
without them those phases pass through (the happy path you ran with `U,Q`).

**Fail-loud, no fake data:** an unpriced line or a failed ERPNext write throws with the exact
reason (you saw this for the missing Item Price and warehouse) — it never fabricates a rate or a doc name.

---

## 5. Data model (as observed in the run)

**Inquiry (input):** buyerLei, currency, lines[{itemCode, qty, uom, size?}], destination?,
requiredDeliveryDate?, paymentTermRequested?, targetUnitPrice, maxNegotiationRounds, dimensions[].

**Quote (domain, signed):**
- lines[{itemCode, qty, uom, rate, amount, warehouse, prevdocDoctype, prevdocDocname, canFulfill, earliestShipDate}]
- payment{term, schedule[{paymentTerm, invoicePortion=100, creditDays, paymentAmount, dueDate}]}
- totals{totalQty, netTotal, gstRate, totalTaxesAndCharges, grandTotal, roundedTotal}
- issuer{agent, oor, sellerLei, sellerAgentAid, credentialMode}; signedEnvelopeHash; revision

**ERPNext mapping (`quotation-mapper.ts`):** native Quotation header + Quotation Items + Payment
Schedule. `due_date` is derived = transaction_date + credit_days (Net-0 → same day). Seven custom
identity fields are gated behind `includeCustomFields` (default off; no quotation fixture yet).

> Worked example (live): 2000 × `TH-HOOD-FLC-320-L` @ ₹270 = ₹540,000 + 18% GST ₹97,200
> = **₹637,200**, Net-0, warehouse `MADRAS-WH-1 - JKC`, `SAL-QTN-2026-00001`.

---

## 6. Negotiation mechanics

Bounded loop (default ≤3 rounds). Each round:
1. Buyer offers (in-process `tommyBuyerAgent.evaluateQuote`).
2. Seller proposes a counter — **deterministic concession toward the floor** (placeholder for the
   LLM optimizer; `usedFallback: true`).
3. **Treasury veto (binding):** clamps to the floor; the counter never drops below `minViablePrice`.
4. Accept / counter / escalate.

Proven invariants (offline test + live run): every `sellerCounter >= floor`; an unmeetable floor
**ESCALATES** rather than crossing it. Live example: buyer 300 → seller counter 270 (floor 250) → ACCEPT.

---

## 7. Identity & signing (plain mode)

- Each agent signs its decision with `PlainHashSigner` (sha256 over canonical JSON).
- Output is an append-only `attestations[]` trail: {agentRef, role, subject, signature, signingMode, aid, signedAt}.
- In plain mode `aid` reads `(unminted/plain)` for sub-agents; principals carry a placeholder AID string.
- **The vLEI seam:** flipping `CREDENTIAL_MODE=vlei` would route signing/verify through `identity-client`
  (`VleiServiceClient`, Sally verifier) to HOST B, replacing sha256 with ACDC/IPEX and minting real
  delegated AIDs. The attestation *shape* is already in place — only the signer and AID source change.

---

## 8. Tools & resources layer (shared, no identity of their own)

GLEIF v1 API (live) · ERPNext REST (Opportunity/Quotation/Bin/Sales Order/Item Price) ·
pricing handler `quote_with_quantity` · ACTUS PAM (demo) · credit provider (fixtures) ·
SQLite checkpointer (`audit.db`) · `PlainHashSigner`. The MCP-over-SSE server additionally
exposes `verify_lei_gleif`, `quote_unit_price`, `quote_with_quantity`, and `run_negotiation`.

---

## 9. Configuration (key flags, from `flags.ts` / `.env`)

| Flag | Default | Meaning |
|---|---|---|
| `CREDENTIAL_MODE` | `plain` | plain (sha256) \| vlei (HOST B) |
| `SIGNING_MODE` | `plain` | sha256 envelope |
| `TREASURY_MODE` | `real`→ set `demo` | demo avoids the unwired ACTUS endpoint |
| `INVENTORY_MODE` | `real` | ERPNext Bin |
| `CREDIT_MODE` | `real` | GLEIF live; EDGAR demo |
| `LOGISTICS_MODE` | `demo` | DCSA deferred |
| `IDEMPOTENT_WRITES` | `on` | dedupe ERPNext writes by negotiationId |
| `NEGOTIATION_MAX_ROUNDS` | `3` | bound on the loop |
| `ERPNEXT_DEFAULT_WAREHOUSE` | `MADRAS-WH-1 - JKC` | source warehouse on quote lines |

Per-run flags (smoke harness): `--item --qty --dimensions --payment-term --target-unit-price
--floor --max-rounds --destination --required-date --credit-fixtures-dir --warehouse --json`.

---

## 10. What is live vs deferred

**Live (plain mode):** full 5-phase saga; ERPNext Opportunity + Quotation writes; live GLEIF;
binding Treasury veto; fulfilment ATP via Bin; per-agent signed attestations; idempotent writes;
MCP-SSE `run_negotiation` tool.

**Deferred:** vLEI identity (AcdcSigner, delegated-AID signing, ECR pegging, HOST B);
A2A network transport (buyer is in-process); LLM negotiation optimizer (deterministic placeholder);
real credit (EDGAR/Companies House) and real Treasury (ACTUS); DCSA logistics; quotation custom-field fixture.

---

## 11. How to run (plain mode)

```bash
# offline checks
npm run typecheck
npx tsx scripts/test-negotiate-veto.ts          # binding-veto invariant, no network

# live happy path (needs seeded ERPNext + a priced Item)
npx tsx scripts/smoke-ddn-saga.ts --item TH-HOOD-FLC-320-L --qty 2000 --dimensions U,Q

# + due diligence (credit → term)
npx tsx scripts/smoke-ddn-saga.ts --item TH-POLO-PIQ-220-L --dimensions U,Q,DD --payment-term Net-30 --credit-fixtures-dir DEMO-DATA/credit

# + negotiation (buyer↔seller rounds, treasury veto)
npx tsx scripts/smoke-ddn-saga.ts --item TH-HOOD-FLC-320-L --qty 2500 --dimensions U,Q,N --target-unit-price 260 --floor 250 --max-rounds 3
```

Prereqs: ERPNext running at `ERPNEXT_URL` with API key/secret in `.env`; an **Item Price**
(Standard Selling, INR) for each SKU you quote; the source warehouse exists.

---

## 12. Known issues / open items

1. **`--warehouse` not threaded to persist.** Quote lines take the warehouse from
   `flags.ERPNEXT_DEFAULT_WAREHOUSE` (`quoting.ts`), not the `--warehouse` flag (which only feeds the
   Bin lookup). Fix today by setting `ERPNEXT_DEFAULT_WAREHOUSE`; proper fix is to thread the override.
2. **ACTUS endpoint is an open item** — keep `TREASURY_MODE=demo` until wired.
3. **Quotation custom-field case mismatch** — fixture `custom_canFulfill` vs live `custom_canfulfill`;
   only matters when `persistCustomFields` is on (off by default).
4. **Three external integrations are placeholders** — credit (fixtures), treasury (demo floor), logistics (deferred).

---

## Appendix — fixes applied to reach the first green plain-mode run

1. `test-negotiate-veto.ts` import path `identity-client/` → `identity/CredentialProvider.js`.
2. `smoke-ddn-saga.ts` — added `import "dotenv/config"` so live runs load `.env`.
3. `.env` — `TREASURY_MODE=demo`; `ERPNEXT_DEFAULT_WAREHOUSE=MADRAS-WH-1 - JKC`.
4. `quotation-mapper.ts` — derive Payment Schedule `due_date` = transaction_date + credit_days.
5. Seeded ERPNext Item Prices (Standard Selling, INR) for the SKUs under test.
