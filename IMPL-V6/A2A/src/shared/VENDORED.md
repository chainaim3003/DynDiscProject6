# VENDORED — src/shared/

This directory mixes **two kinds** of files:

1. **Net-new V6 domain types** (authored in IMPL-V6, source of truth = here):
   - `inquiry-types.ts`, `quote-types.ts`
   - `due-diligence-types.ts`, `fulfillment-types.ts`, `demand-types.ts`, `round-types.ts`
   (Named `due-diligence-types.ts`, NOT `dd-types.ts`, deliberately — see collision note below.)

2. **Vendored from DynDiscProject5** (byte-exact copies; source of truth = the
   sibling repo). Re-sync by re-copying from the source path on update.

## Vendored files (closure verified self-contained)

Source dir: `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\DynDiscProject5\A2A\js\src\shared\`

| Vendored file | Why | Imports (closure) |
|---|---|---|
| `provider-types.ts` | `ConsultationRecord<T>`, `ConsultationMetadata`, `DefensiveAction(+Record)`, `GleifStatus`, `RecommendedTerms`, provider I/O types | `./negotiation-mode.js` (type `ProviderMode`) |
| `negotiation-types.ts` | `DecisionTrailEntry`, `TreasuryConsultationSummary`, `NegotiationStatus`, `NegotiationAudit`, … | `./intent-types.js` (`ScenarioIntentExcerpt`) |
| `negotiation-mode.ts` | 5-tier `SellerResponseMode` resolver + `resolveProviderModes` (used by the L2 engine later) | (none — pure, lazy `process.env`) |
| `intent-types.ts` | `ScenarioIntentExcerpt`, `Scenario`, intent types (audit-only) | (none — pure types) |

Closure confirmed complete: `negotiation-mode.ts` and `intent-types.ts` have **zero** imports; `provider-types`/`negotiation-types` import only the two above. No fifth file is pulled in.

## NOT vendored yet (deferred to the negotiation-node build)

The L2 tactics **engine** and the live-I/O **providers** are intentionally NOT
copied here yet — they're needed when the negotiation node is built, and per
`01` §5.1 the providers are "ported + **EXTENDED**" (re-implemented against
IMPL-V6 `src/clients` / `src/erpnext`), not copied verbatim:
- engine: `l2-executive.ts`, `l2-wire.ts`, `advisor-math-aggregator.ts`, `outcome-quality.ts`, `consultation-router.ts`
- providers (rework, not copy): `treasury-provider.ts`, `inventory-provider.ts`, `logistics-provider.ts`, `credit-provider.ts` (+ their `actus-client.ts`, `market-data-client.ts`, etc.)
- `consultation-router.ts` will be rewired into `src/orchestrator/router/` and pointed at the reworked providers.

## Collision / terminology note (do not "fix" by renaming back)

DynDiscProject5's `shared/` has its **own** `dd-types.ts` — but there "DD" =
**Dynamic Discounting** (`DDOfferData`, `dd-calculator.ts`), whereas in V6 "DD" =
**Due Diligence** (`DDResult`, P08). To avoid a filename collision if/when the
DvP / dynamic-discounting work later vendors that file, the V6 due-diligence
types live in `due-diligence-types.ts`. The channel TYPE is still `DDResult`
(per `04` §3.1); only the filename differs.

## Minor pre-existing duplication (informational)

`negotiation-mode.ts` exports a `ProviderMode` type; `src/config/flags.ts` also
defines a `ProviderMode`. Different modules, no conflict today. Unify if a
single import site ever needs both.
