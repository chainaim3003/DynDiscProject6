# IMPL-V6

Autonomous **Jupiter seller agent** for the DynDisc V6 build: a single **MCP-over-SSE**
process backed by a **LangGraph.js** orchestrator (the negotiation saga), with **ERPNext**
as the system-of-record. An MCP host (e.g. OpenClaw) connects over SSE and drives the
seller, acting as the buyer counterparty.

> Design baseline (single source of truth): `DESIGN/baseline/01..07`.
> Build sequence / iteration history: `DESIGN/baseline/07-Iteration-Plan.md`.

## What this is

A working implementation — **not** a scaffold. The MCP-SSE server (`src/mcp/server-sse.ts`)
exposes four tools and an orchestrator graph that runs the full negotiation saga end-to-end.

### MCP tools (`src/mcp/tools/`)

| Tool | What it does |
|---|---|
| `verify_lei_gleif` | GLEIF v1 active-status check for a 20-char ISO 17442 LEI; returns registration/entity status, a derived `isActive`, and full provenance. |
| `quote_unit_price` | Deterministic P01 quote: ERPNext Item Price unit rate × quantity (no fabricated rate if the Item/price is missing). |
| `quote_with_quantity` | P02 quote: unit price + any matching selling Pricing Rule quantity slab; exposes base vs. effective rate. |
| `run_negotiation` | The full saga end-to-end (below). **Mutating** + makes **live GLEIF** calls per invocation. |

### Orchestrator saga (`src/orchestrator/graph.ts`)

```
intake.parse → intake.mirror (ERPNext Opportunity) → ack
  → due-diligence (GLEIF + credit → payment term)
  → quoting.start → fulfillment.plan (ATP) → quoting.draftQuote
  → negotiate (bounded rounds + BINDING treasury veto)
      ├─ deal ............... → persist.signAndPersist (ERPNext Quotation) → END
      └─ NO_DEAL / ESCALATED → END
```

Due-diligence and negotiation are no-op pass-throughs when an inquiry doesn't request them,
so the deterministic quote path is unchanged. Every super-step checkpoints to a shared
SQLite saver (`AUDIT_DB_PATH`); per-agent decisions (credit, fulfillment, treasury veto,
final quote) are signed and recorded to the attestation journal.

## Prerequisites

- **Node.js >= 20** (required by `@langchain/core` 1.x).
- An **ERPNext** (Frappe) instance reachable at `ERPNEXT_URL`, with masters / Item Prices
  seeded — required for the quoting and persist paths.
- A **Google AI Studio** key (`GEMINI_API_KEY`) when `NEGOTIATION_OPTIMIZER=llm`.

## Setup

# 0. Be in the right folder
cd C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\DynDiscProject6\IMPL-V6\A2A

```bash
npm install
cp .env.example .env      # fill in ERPNEXT_URL / key / secret and GEMINI_API_KEY
npm run typecheck         # tsc --noEmit over src/
npm run build             # tsc -> dist/
npm run start             # MCP-SSE server on PORT (default 3000)
```


## Scripts

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src/` |
| `npm run build` | `tsc` → `dist/` |
| `npm run dev` | `tsx watch src/mcp/server-sse.ts` |
| `npm run start` | `node dist/mcp/server-sse.js` |
| `npm run graphql` | audit / correlation GraphQL endpoint |
| `npm run verify:lei` | `tsx scripts/verify-lei.ts` |
| `npm test` | placeholder — the test pyramid is not yet wired |

Additional runnable checks live in `scripts/` (run with `npx tsx scripts/<file>.ts`):
`smoke-saga.ts`, `smoke-ddn-saga.ts`, `smoke-idempotency.ts`, `test-negotiate-veto.ts`,
`check-erpnext-custom-fields.ts`.

## Endpoints (MCP-SSE server)

- `GET  /health` — status JSON (used by the Docker + Railway healthchecks).
- `GET  /sse` — establishes the SSE stream (one `McpServer` instance per connection).
- `POST /messages?sessionId=...` — client → server JSON-RPC, routed by session.

## Configuration (flags)

All behavior is flag-driven via `.env`. See `.env.example` for the full surface and
`src/config/flags.ts` for the typed loader (defaults + validation; flags are also
overridable in-process for tests). Key groups:

- **Orchestration / memory**: `ORCHESTRATOR`, `CHECKPOINTER_KIND`, `AUDIT_DB_PATH`,
  `MEMORY_STORE_KIND`, `CLARIFY_MAX_ROUNDS`, `NEGOTIATION_MAX_ROUNDS`, `QUOTE_DEMAND_AWARE`.
- **Provider modes**: `INVENTORY_MODE` (real = ERPNext Bin), `CREDIT_MODE`
  (real = GLEIF live; EDGAR/Companies-House demo), `LOGISTICS_MODE`, `TREASURY_MODE`.
- **Credential / signing**: `CREDENTIAL_MODE=plain` is the supported path in this build;
  `vlei` scaffolding exists behind the flag. `SIGNING_MODE=plain` (sha256 envelope).
- **Negotiation**: `NEGOTIATION_OPTIMIZER=deterministic|llm`, plus `GEMINI_API_KEY`,
  `NEGOTIATION_LLM_MODEL`, `NEGOTIATION_LLM_TEMPERATURE` when `llm`.
- **ERPNext (T4)**: `ERPNEXT_URL`, `ERPNEXT_API_KEY`, `ERPNEXT_API_SECRET`, `ERPNEXT_COMPANY`,
  `ERPNEXT_CURRENCY`, `ERPNEXT_DEFAULT_WAREHOUSE`, `QUOTE_PERSIST_MODE`,
  `PAYMENT_TERMS_ALLOWED`, `GST_RATE`.
- **Idempotency**: `IDEMPOTENT_WRITES` (default on — see below).
- **Eval**: `EVAL_MODE=fast|integration|e2e`.

## Idempotency

`run_negotiation` is mutating. With `IDEMPOTENT_WRITES=on` (default), re-running the same
`negotiationId` does **not** create duplicate ERPNext docs:

- **Opportunity** dedupes on a queryable `custom_inquiry_id` (ERPNext-side lookup).
- **Quotation** currently dedupes via a local SQLite ledger (kept in `AUDIT_DB_PATH`)
  because the ERPNext Quotation identity custom-field fixture does not exist yet
  (tracked as gap **G8**); once it lands and `persistCustomFields` is enabled, persistence
  switches to ERPNext-side dedupe.

Set `IDEMPOTENT_WRITES=off` to reproduce the legacy blind-insert behavior.

## Runtime data

`data/` holds `audit.db` (saga checkpoints + tool-call audit + the idempotency ledger).
It is **gitignored** (`data/`, `*.db`, `*.db-wal`, `*.db-shm`).

## Docker

```bash
docker compose -f docker/docker-compose.yml up --build
```

Multi-stage build: the full `node:20-bookworm` image compiles the `better-sqlite3` native
addon; the slim runtime receives the prebuilt `node_modules` + `dist`. The container
healthchecks `GET /health` and persists `/app/data` as a volume. **ERPNext is not
containerized here** — it is the external system-of-record, reached over the network via
`ERPNEXT_URL` (defaults to `host.docker.internal:8080` so the container can reach an
ERPNext running on the host).

## Deployment

`railway.json` deploys a single SSE service via Nixpacks (`npm run build` → `npm run start`)
with healthcheck path `/health`.

## Known gaps / deferred

- **vLEI** (KERI/ACDC) credential path is behind `CREDENTIAL_MODE=vlei`; `plain` is the
  supported mode in this build.
- **Test pyramid** (`npm test`) is a placeholder; the `scripts/` smoke checks cover the
  saga in the meantime.
- **ERPNext Quotation custom-field fixture** (gap G8) — until it lands, `persistCustomFields`
  defaults off and Quotation idempotency uses the local ledger.
- **Real provider clients** for ACTUS PAM (treasury), EDGAR / Companies House (credit beyond
  GLEIF), and DCSA (logistics) are demo/deferred per the provider-mode flags.
