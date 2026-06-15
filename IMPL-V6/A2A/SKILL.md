# IMPL-V6 — Jupiter Seller Agent (NANDA skill descriptor)

`jupiterSellerAgent` — autonomous seller agent for **Jupiter Knitting Company** (LEI `3358004DXAMRWRUIYJ05`), exposed to stock OpenClaw over MCP-SSE.

## Role note (hand this to judges)

> This skill is the autonomous **seller agent for Jupiter Knitting Company** (`jupiterSellerAgent`, LEI `3358004DXAMRWRUIYJ05`). In each test you act as the **buyer** — Tommy Hilfiger Europe B.V. (LEI `54930012QJWZMYHNJW95`) — sending an inquiry to the seller agent. Paste a prompt verbatim. The seller agent will verify both LEIs via GLEIF, consult its inventory / logistics / credit / treasury sub-agents, negotiate if asked, and return a quote. You only need to read the quote it returns — you don't need to name any tools.

## How to use

1. Connect OpenClaw to this skill's MCP-SSE endpoint (single process; see `README.md`).
2. Open `prompts/P01-simplest-prepaid.md` … `prompts/P10-capstone-persist.md`.
3. Paste a prompt **verbatim** as the buyer. Read the quote the seller returns.

## Locked invariants (so "usual spread" etc. are unambiguous)

- Buyer = Tommy Hilfiger Europe B.V., LEI `54930012QJWZMYHNJW95`; Seller = Jupiter Knitting Company, LEI `3358004DXAMRWRUIYJ05`.
- Currency **INR (₹)**, **GST 18%**, UOM **Nos**.
- Payment is a **single one-time payment**; only the due date varies: **Net-0 (prepaid) / Net-30 / Net-60**.
- Identity = **PLAIN GLEIF** (no vLEI in these 10 prompts).
- Items: `TH-TEE-RN-180`, `TH-POLO-PIQ-220`, `TH-HOOD-FLC-320` — each in **S / M / L / XL**.
- **Default size spread: 20% S / 40% M / 30% L / 10% XL.**

## What the seller returns (B0)

Per-size line prices, order total incl. **18% GST**, freight, the **Incoterm** quoted on, and delivery feasibility (can-ship-by-date / earliest date).

---

*Full role-framing handout: `ROLE-NOTE-FOR-JUDGES.md`. Design baseline: `DESIGN/baseline/`. Build sequence: `DESIGN/baseline/07-Iteration-Plan.md`.*
