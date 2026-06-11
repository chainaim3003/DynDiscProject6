# dd-credit sub-agent — SKILL.md

> Transcribed from REFINED-MultiAgent-Design-vLEI.md §6 (S1 — Due-Diligence & Credit).
> Collapses the design's former Credit + Info-Collection agents into one ECR decision-owner
> with two internal analyst tools (no own identity).

```yaml
name: dd-credit-subagent
identity: { role_type: ECR, ecr: "Credit Officer", aid_binding: delegated-from-credit-officer }
owns_decision: "recommendedTerms ∈ {Net-0, Net-30, Net-60} + pd1y + lgd + rationale"
tools: [verify_lei_gleif, edgar_companyfacts, companies_house, website_fetch_nologin]
flags: { CREDIT_MODE: real, DD_REQUIRED: auto, ALLOWED_TERMS: "Net-0,Net-30,Net-60" }
guardrails: ["no social-media scraping", "rationale always recorded to audit"]
```

## Internal analysts (tools, no own AID) → `analysts/`
- `credit.ts` — GLEIF v1, SEC EDGAR companyfacts, commodity index.
- `kyc.ts` — buyer's own website (no login), buyer-disclosed handles, Companies House.
  NO scraping of LinkedIn/IG/FB (locked in design 04 §9.3).
