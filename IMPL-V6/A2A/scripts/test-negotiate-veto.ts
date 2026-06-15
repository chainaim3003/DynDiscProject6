// ================= IMPL-V6 — TEST: negotiate binding-veto invariant =================
//
// Proves the design's single most important guarantee (REFINED-MultiAgent-Design-vLEI.md
// §5.2 phase 4): the negotiate node NEVER emits a seller price below the Treasury floor,
// and a real no-deal (floor above buyer reservation) escalates instead of crossing it.
//
// Standalone — no test framework needed (the repo's runner isn't wired yet). Run:
//   npx tsx scripts/test-negotiate-veto.ts
// Exits 0 on PASS, 1 on any assertion failure.
//
// Uses the REAL TreasuryAgent + TommyBuyerAgent with an in-memory fake CredentialProvider
// (no disk, no network, no Host B), so it tests the actual negotiation logic.

import { createHash } from "node:crypto";

import { buildNegotiateNode } from "../src/orchestrator/nodes/negotiate.js";
import { TreasuryAgent } from "../src/agents/subagents/treasury/index.js";
import { TommyBuyerAgent } from "../src/agents/principals/tommy-buyer/index.js";
import type {
  CredentialProvider,
  SignedAttestation,
  CredentialPresentation,
  AidResolution,
  VerificationResult,
} from "../src/identity/CredentialProvider.js";
import type { AgentContext } from "../src/agents/agent-contract.js";
import type { OrchestratorFlags } from "../src/config/flags.js";
import type { NegStateType } from "../src/orchestrator/state/neg-state.js";
import type { Quote } from "../src/shared/quote-types.js";
import type { Inquiry } from "../src/shared/inquiry-types.js";

// ── In-memory fake CredentialProvider (plain-style sha256, no disk/network) ──
class FakeCredentialProvider implements CredentialProvider {
  readonly mode = "plain" as const;
  async resolveAid(agentRef: string): Promise<AidResolution> {
    return { agentRef, aid: "", roleType: "ECR", role: "test", holder: `${agentRef}-holder`, status: "placeholder" };
  }
  async present(agentRef: string): Promise<CredentialPresentation> {
    return { agentRef, mode: "plain", aid: "", roleType: "ECR", role: "test", holder: `${agentRef}-holder` };
  }
  async sign(agentRef: string, payload: unknown): Promise<SignedAttestation> {
    const signature = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return { agentRef, signingMode: "plain", aid: "", signature, alg: "sha256-json", signedAt: new Date().toISOString() };
  }
  async verify(_input: CredentialPresentation | { agentRef: string }): Promise<VerificationResult> {
    return { verified: true, method: "structural", reason: "fake provider (test)" };
  }
}

// ── Minimal test fixtures ────────────────────────────────────────────────────
const fake = new FakeCredentialProvider();
const ctx = (agentRef: string): AgentContext => ({ credentials: fake, agentRef });
const flags = { NEGOTIATION_MAX_ROUNDS: 3, GST_RATE: 18 } as unknown as OrchestratorFlags;

function makeState(startPrice: number): NegStateType {
  const inquiry: Inquiry = {
    negotiationId: "NEG-TEST",
    buyerLei: "54930012QJWZMYHNJW95",
    buyerAgent: "tommyBuyerAgent",
    currency: "INR",
    lines: [{ itemCode: "TH-TEE-RN-180-M", qty: 1000, uom: "Nos" }],
    dimensions: ["N"],
    receivedAt: new Date().toISOString(),
    maxNegotiationRounds: 3,
  };
  const quote: Quote = {
    negotiationId: "NEG-TEST",
    opportunityName: null,
    quotationName: null,
    buyerLei: "54930012QJWZMYHNJW95",
    currency: "INR",
    lines: [{ itemCode: "TH-TEE-RN-180-M", qty: 1000, uom: "Nos", rate: startPrice, amount: startPrice * 1000 }],
    payment: { term: "Net-0", schedule: [{ paymentTerm: "Net-0", invoicePortion: 100, creditDays: 0, paymentAmount: startPrice * 1000 }] },
    totals: { totalQty: 1000, netTotal: startPrice * 1000, gstRate: 18, totalTaxesAndCharges: 0, grandTotal: startPrice * 1000 },
    status: "Draft",
    revision: 1,
    quotedAt: new Date().toISOString(),
  };
  return {
    negotiationId: "NEG-TEST",
    buyerLEI: "54930012QJWZMYHNJW95",
    sellerLEI: "3358004DXAMRWRUIYJ05",
    inquiry,
    quoteDraft: quote,
    status: "QUOTED",
    consultations: [],
    rounds: [],
    attestations: [],
    defensive: [],
  } as unknown as NegStateType;
}

function buildNode(demoFloor: number, buyerMaxUnitPrice: number) {
  return buildNegotiateNode({
    flags,
    treasury: new TreasuryAgent({ mode: "demo" }),
    treasuryContext: ctx("treasuryAgent"),
    buyer: new TommyBuyerAgent(ctx("tommyBuyerAgent")),
    sellerContext: ctx("jupiterSellerAgent"),
    demoFloor,
    buyerMaxUnitPrice,
  });
}

// ── Assertions ───────────────────────────────────────────────────────────────
let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

async function main(): Promise<void> {
  // Scenario 1 — floor ABOVE buyer reservation: must NEVER cross the floor, must escalate.
  console.log("Scenario 1: demoFloor=300 > buyerMax=250 (must escalate, never emit < 300)");
  const out1 = await buildNode(300, 250).negotiate(makeState(400));
  const rounds1 = out1.rounds ?? [];
  check("at least one round was run", rounds1.length > 0);
  check(
    "every sellerCounter >= floor (300) — THE BINDING VETO",
    rounds1.every((r) => typeof r.sellerCounter === "number" && r.sellerCounter >= 300),
  );
  check("no deal: status is ESCALATED or NO_DEAL", out1.status === "ESCALATED" || out1.status === "NO_DEAL");
  check("no quote price applied on no-deal (quoteDraft not returned)", out1.quoteDraft === undefined);

  // Scenario 2 — floor BELOW buyer reservation: deal reached at/above floor.
  console.log("Scenario 2: demoFloor=200 < buyerMax=350 (deal expected at/above 200)");
  const out2 = await buildNode(200, 350).negotiate(makeState(400));
  const rounds2 = out2.rounds ?? [];
  check("every sellerCounter >= floor (200)", rounds2.every((r) => typeof r.sellerCounter === "number" && r.sellerCounter >= 200));
  check("status is ACCEPTED", out2.status === "ACCEPTED");
  const dealRate = out2.quoteDraft?.lines[0]?.rate;
  check("deal price applied to quote and >= floor (200)", typeof dealRate === "number" && dealRate >= 200);
  check("deal price <= buyer reservation (350)", typeof dealRate === "number" && dealRate <= 350);

  console.log("");
  if (failures > 0) {
    console.error(`RESULT: ${failures} assertion(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("RESULT: all assertions PASSED — binding veto holds.");
  }
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exitCode = 1;
});
