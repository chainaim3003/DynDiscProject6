# fulfillment sub-agent — SKILL.md

> Transcribed from REFINED-MultiAgent-Design-vLEI.md §6 (S3 — Fulfillment). ECR: Operations
> Officer. Collapses the design's former Inventory + Demand-Planning agents into internal
> analyst tools under one ECR decision-owner.

```yaml
name: fulfillment-subagent
identity: { role_type: ECR, ecr: "Operations Officer", aid_binding: delegated-from-ops-officer }
owns_decision: "ATP | CTP | split plan + promised ship dates"
tools: [erpnext_bin_read, erpnext_sales_order_read]
flags: { QUOTE_DEMAND_AWARE: off, ALLOW_SPLIT: on }
guardrails: ["never promise a date not backed by ATP/CTP", "splits recorded line-level"]
```

## Internal analysts (tools, no own AID) → `analysts/`
- `inventory.ts` — ERPNext `Bin` live (this is the existing inventory provider).
- `demand-planning.ts` — ERPNext `Sales Order` + T3 demand/portfolio, only when
  `QUOTE_DEMAND_AWARE=on`.

NOTE: the existing orchestrator `fulfillment.plan` node already does ATP via the
inventory provider; Increment 4 re-homes it under this sub-agent's identity.
