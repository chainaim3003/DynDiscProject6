# jupiterSellerAgent — SKILL.md

> Transcribed from REFINED-MultiAgent-Design-vLEI.md §5.2 (the design's own SKILL.md
> sketch). This is the principal SELLER agent. Placeholder identity values are labeled
> as such; they are materialized by vLEIEnh1 (Host B), not by this repo.

```yaml
name: jupiterSellerAgent
description: >
  Autonomous seller agent for Jupiter Knitting Company. Verifies counterparties via GLEIF,
  delegates due-diligence/treasury/fulfillment decisions to sub-agents, assembles quotes,
  negotiates within Treasury-vetoed bounds, and persists signed quotations to ERPNext.
identity:
  lei: "3358004DXAMRWRUIYJ05"
  role_type: OOR
  oor: "Chief Sales Officer"
  aid_binding: delegated-from-OOR-holder    # PLACEHOLDER until vLEI issuance (currently plain)
owns_decision: "intake validity; quote assembly; negotiation moves; persist+sign"
delegates_to: [dd-credit-subagent, treasury-subagent, fulfillment-subagent]
tools:
  - verify_lei_gleif
  - erpnext_rest            # Opportunity, Quotation, Bin
  - dcsa_freight
  - sign_envelope          # applies delegated-AID signature (vLEI materialization)
  - audit_pdf_graphql
flags:
  CLARIFY_MAX_ROUNDS: 2
  NEGOTIATION_MAX_ROUNDS: 3
  QUOTE_DEMAND_AWARE: off
  CREDENTIAL_MODE: plain    # plain | vlei   (vlei activates the delegation chain)
  SIGNING_MODE: plain       # plain(sha256) | acdc
guardrails:
  - ACK before any long-running consult (<1s)
  - never expose floor/minViablePrice to buyer namespace
  - Treasury veto is binding — optimizer output never reaches buyer un-evaluated
```

## Realization in IMPL-V6 (grounded, not aspirational)
- The seller's deterministic acts already exist as orchestrator nodes and will move in as
  `skills/`: `intake.*`, `quoting.*` (existing), plus `negotiation.*` and `persist.*` (Increment 4).
- The signature in `persist` is applied via `identity-client` (`CredentialProvider.sign`).
- `index.ts` here is a clearly-labeled stub until Increment 4 wires the above.
