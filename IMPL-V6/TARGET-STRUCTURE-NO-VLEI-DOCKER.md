# IMPL-V6 — Target Structure (NO vLEI · WITH Docker · ERPNext kept)

Derived from `DESIGN_6/REFINED-Project-Structure.md` §2, with the vLEI/HOST-B layer removed,
a Docker layer added for HOST A, and the ERPNext integration retained and hardened.

**Legend:** `KEEP` exists & stays · `SLIM` keep but strip vLEI · `NEW` create ·
`DROP` remove (vLEI/KERI) · `MOVE` relocate · `OPT` optional/cosmetic.

> **vLEI boundary:** removing vLEI does NOT remove signing. Plain sha256 attestations
> (`CredentialProvider` + `PlainJsonProvider` + `PlainHashSigner`) are the non-vLEI baseline and
> stay — they're what populate `state.attestations`. Only the KERI/ACDC/Host-B network pieces go.

```
IMPL-V6/
├─ README.md                                  KEEP (update: drop vLEI/HOST-B sections)
├─ SKILL.md                                    KEEP
├─ package.json  tsconfig.json                 KEEP (package.json: fix "graphql" script; see G6)
├─ railway.json                                KEEP (Railway path stays; Docker is an alternative)
├─ .env / .env.example                         SLIM (drop the entire vLEI block — see §Env below)
├─ .dockerignore                               NEW
│
├─ docker/                                      NEW  ◀── the "with docker" ask (HOST A only)
│  ├─ Dockerfile                               NEW  multi-stage; handles better-sqlite3 native build
│  └─ docker-compose.yml                       NEW  agent service; ERPNext reached as external (env)
│
├─ identity/                                    SLIM  (was the vLEI seam)
│  ├─ agent-cards/                             KEEP  but as PLAIN role-label JSON, not vLEI-minted
│  │  ├─ jupiterSellerAgent-card.json          KEEP  (OOR string = label only)
│  │  ├─ tommyBuyerAgent-card.json             KEEP
│  │  └─ subagents/*.json                      KEEP  (ECR strings = labels only)
│  └─ binding-map.json                         OPT   (agentRef → role label; no AID/delegation)
│
├─ src/
│  ├─ index.ts                                 KEEP
│  │
│  ├─ config/
│  │  ├─ flags.ts                              KEEP  (strip vLEI flag reads)
│  │  └─ identity-flags.ts                     SLIM  (keep CREDENTIAL_MODE=plain/SIGNING_MODE=plain
│  │                                                  only; drop VLEI_*/KERIA_*/SALLY_*/OOBI/verify-required)
│  │
│  ├─ identity/                                 ◀── MOVE from src/identity-client/  (de-vLEI'd, plain only)
│  │  ├─ index.ts                              KEEP
│  │  ├─ CredentialProvider.ts                 KEEP  (interface: resolveAid/present/sign/verify)
│  │  ├─ PlainJsonProvider.ts                  KEEP  (the only provider now; sha256 signing)
│  │  ├─ agent-card-loader.ts                  KEEP  (loads the plain role-label cards)
│  │  ├─ VleiServiceClient.ts                  DROP
│  │  ├─ sally-verifier-client.ts              DROP
│  │  ├─ delegation.ts                         DROP
│  │  └─ oobi-config.ts                        DROP
│  │
│  ├─ messaging/
│  │  ├─ PlainHashSigner.ts                    KEEP  (SIGNING_MODE=plain)
│  │  ├─ MessageSigner.ts                      KEEP
│  │  ├─ signed-message.ts                     KEEP
│  │  └─ (AcdcSigner.ts)                       N/A   (never built — do NOT add)
│  │
│  ├─ orchestrator/                             KEEP topology; subfolder reshape is OPT
│  │  ├─ graph.ts                              KEEP  (flat is fine; refined graphs/ + edges/ are OPT)
│  │  ├─ run.ts                                KEEP
│  │  ├─ state/neg-state.ts                    KEEP  (reducers inline; refined reducers.ts is OPT)
│  │  ├─ nodes/{intake,due-diligence,quoting,  KEEP
│  │  │         fulfillment,negotiate,persist}.ts
│  │  └─ memory/{checkpointer,store,namespaces}.ts  KEEP
│  │
│  ├─ agents/                                   KEEP  (the 2+3 design is already realized)
│  │  ├─ runtime.ts  agent-contract.ts         KEEP  (runtime: builds the PlainJsonProvider only)
│  │  ├─ principals/{jupiter-seller,tommy-buyer}/  KEEP
│  │  └─ subagents/{dd-credit,treasury,fulfillment}/  KEEP
│  │
│  ├─ erpnext/                                  ◀── KEEP + HARDEN (the "ERPNext integration" ask)
│  │  ├─ client.ts                             KEEP  (real Frappe REST client)
│  │  ├─ mappers.ts                            KEEP  (Inquiry → Opportunity)
│  │  ├─ quotation-mapper.ts                   KEEP  (Quote → Quotation)
│  │  ├─ idempotency.ts                        NEW   ◀── upsert guard (fixes G3 duplicate-write risk)
│  │  ├─ inquiry-repo.ts                       NEW   (find/insert Opportunity by custom_inquiry_id)
│  │  └─ quote-repo.ts                         NEW   (find/insert Quotation by custom_negotiation_id)
│  │
│  ├─ mcp/
│  │  ├─ server-sse.ts                         KEEP  (/health /sse /messages)
│  │  ├─ tool-audit.ts                         KEEP
│  │  └─ tools/
│  │     ├─ verify_lei_gleif.ts                KEEP
│  │     ├─ quote_unit_price.ts                KEEP
│  │     ├─ quote_with_quantity.ts             KEEP
│  │     ├─ pricing.ts  pricing-rules.ts       KEEP
│  │     ├─ index.ts                           KEEP  (TOOL_REGISTRY)
│  │     ├─ create_inquiry.ts                  NEW   ◀── expose the saga (fixes G1)
│  │     ├─ run_due_diligence.ts               NEW
│  │     ├─ negotiate_quote.ts                 NEW
│  │     └─ persist_quote_erpnext.ts           NEW   (or one run_negotiation tool → runNegotiation())
│  │
│  ├─ shared/                                   KEEP (types + providers)
│  │  ├─ compliance/{gleif-client,gleif-types}.ts   KEEP  (refined tools/gleif/ MOVE is OPT)
│  │  ├─ credit-provider.ts inventory-provider.ts   KEEP
│  │  └─ *-types.ts  negotiation-mode.ts  VENDORED.md  KEEP
│  │
│  └─ api/                                      NEW (OPT, later phase) — audit observability
│     └─ graphql/index.ts                       NEW   (fixes the broken `npm run graphql` script, G6)
│
├─ scripts/                                     KEEP (smoke-saga, smoke-ddn-saga, test-negotiate-veto, verify-lei)
├─ test/                                        NEW (OPT, later phase) — L1–L7 pyramid; pick vitest
├─ DEMO-DATA/  data/                            KEEP
└─ erpnextEnh1/  (sibling)                       KEEP (ERPNext customization/seed layer — external)

   DROP ENTIRELY (out of scope): vLEIEnh1/ HOST-B Docker stack, all KERI/ACDC/Sally artifacts.
```

## Env (`.env` / `.env.example`) — after de-vLEI

**KEEP:** `ORCHESTRATOR, CHECKPOINTER_KIND, AUDIT_DB_PATH, MEMORY_STORE_KIND, EMBEDDING_MODEL,
CLARIFY_MAX_ROUNDS, NEGOTIATION_MAX_ROUNDS, QUOTE_DEMAND_AWARE, INVENTORY_MODE, CREDIT_MODE,
LOGISTICS_MODE, TREASURY_MODE, CREDENTIAL_MODE=plain, SIGNING_MODE=plain, ERPNEXT_URL,
ERPNEXT_API_KEY, ERPNEXT_API_SECRET, ERPNEXT_COMPANY, ERPNEXT_CURRENCY, ERPNEXT_DEFAULT_WAREHOUSE,
QUOTE_PERSIST_MODE, PAYMENT_TERMS_ALLOWED, GST_RATE, EVAL_MODE` + `PORT` (server listen).

**DROP (the whole vLEI block):** `AGENT_CARDS_DIR/SUBAGENT_CARDS_DIR/BINDING_MAP` (vLEI variants),
`VLEI_API_URL, SALLY_VERIFIER_URL, KERIA_ADMIN_URL, KERIA_BOOT_URL, SCHEMA_OOBI_URL,
VLEI_VERIFY_REQUIRED`. (If `CREDENTIAL_MODE`/`SIGNING_MODE` ever lose their `vlei`/`acdc` branches,
they can be removed too — but keeping `=plain` is harmless and lets the audit trail stand.)

## Phasing (see chat for AI/Manual detail)
P1 Docker (done now) · P2 de-vLEI refactor · P3 ERPNext idempotency/repos · P4 saga MCP tools +
fix graphql script · P5 (OPT) tools/ reorg + api/ + test/ pyramid.
