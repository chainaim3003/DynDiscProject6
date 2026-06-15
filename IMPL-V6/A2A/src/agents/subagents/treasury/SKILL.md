# treasury sub-agent — SKILL.md

> Transcribed from REFINED-MultiAgent-Design-vLEI.md §6 (S2 — Treasury). ECR: Treasurer.
> Owns the VETO — the binding financial control — which is why it earns its own identity.

```yaml
name: treasury-subagent
identity: { role_type: ECR, ecr: "Treasurer", aid_binding: delegated-from-treasurer }
owns_decision: "approve|veto term; floor; minViablePrice"
tools: [actus_pam_risk, balance_sheet_snapshot]
flags: { TREASURY_MODE: real, ACTUS_TIMEOUT_MS: 30000, RETRY: none }   # record+continue, never retry
guardrails: ["veto is binding on the negotiator", "every sim recorded with provenance"]
```

## Tools
- ACTUS PAM RiskService (the design notes the endpoint is an OPEN ITEM, not yet an env flag).
- Balance-sheet snapshot.

The veto is binding on the seller's negotiation skill: the optimizer's output never
reaches the buyer un-evaluated by Treasury (design §5.2 guardrail).
