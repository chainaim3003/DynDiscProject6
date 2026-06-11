# IMPL-V6 — Structure Alignment Status vs the DESIGN_6 refined design docs

"DONE" = real files exist and work; "STUB" = typed interface that throws (no behavior,
no fake data); "DEFERRED" = not written, reason given. (Rule 2/Rule 8 — no fabrication.)

## DONE — real
- identity/binding-map.json
- src/config/identity-flags.ts
- src/identity-client/CredentialProvider.ts        (interface + types)
- src/identity-client/PlainJsonProvider.ts         (CREDENTIAL_MODE=plain, offline)
- src/identity-client/agent-card-loader.ts
- src/identity-client/oobi-config.ts               (Host B endpoint config + guards)
- src/identity-client/delegation.ts                (delegation-chain resolver from cards)
- src/identity-client/sally-verifier-client.ts     (REAL — api-server :4000 verify routes)
- src/identity-client/VleiServiceClient.ts         (REAL — CREDENTIAL_MODE=vlei: verify via Sally, sign via IPEX grant)
- src/identity-client/index.ts                     (factory: plain + vlei both wired)
- src/messaging/signed-message.ts                  (envelope types + canonical JSON)
- src/messaging/MessageSigner.ts                   (interface)
- src/messaging/PlainHashSigner.ts                 (SIGNING_MODE=plain sha256)
- .env.example                                     (§4 flag block)

  vLEI runtime contract was GROUNDED by reading the real source:
  github.com/chainaim3003/vLEIEnh1 → legentvLEI/api-server/server.js + README.md.
  Verify: POST /api/buyer/verify/seller | /api/seller/verify/buyer (+ ext DEEP-EXT).
  Sign:   POST /api/seller/ipex/issue-and-grant → { success, credentialSAID, grantSAID }.

## STUB — structure + contract only, behavior THROWS
- src/agents/agent-contract.ts (real types) + principals/{jupiter-seller,tommy-buyer}
  + subagents/{dd-credit,treasury,fulfillment} (SKILL.md real; index.ts throws)

## DEFERRED — not written, reason
- src/messaging/AcdcSigner.ts — wrap VleiServiceClient.sign (IPEX grant) as a MessageSigner.
  (Now UNBLOCKED — the IPEX contract is known; this is the clean next file.)
- Sub-agent behavior: decide() methods + analysts/ tools (credit/kyc, inventory/demand) +
  provider clients ACTUS PAM, EDGAR, Companies House, DCSA (each needs its real API contract).
- Seller orchestration: DD-delegation, negotiation skill (LLM ≤3 rounds, Treasury veto),
  persist+sign node, audit.close — build on existing orchestrator nodes (read them first).
- Identity attribution (§7): nodes run UNDER their agent AID; signature/audit names the AID.
- A2A transport (@a2a-js/sdk) between the two principals.
- src/tools/ consolidation; test/ pyramid + test/identity/.

## Known limitation (honest)
The api-server verify routes cover the two PRINCIPALS only (seller/buyer). Sub-agent
chain verification over REST is NOT among the routes read (the repo has a
DEEP-EXT-subagent.sh script, but no api-server route was found for it). So sub-agent
cryptographic verification may need a new api-server route or an out-of-band script run —
flagged, not assumed.
