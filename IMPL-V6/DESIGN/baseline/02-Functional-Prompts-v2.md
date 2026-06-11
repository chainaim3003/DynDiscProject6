# IMPL-V6 — Functional Prompts v2 (for stock OpenClaw)

> Supersedes Part 1 of `IMPL-V6-DESIGN-Prompts-Schema-Structure.md`.
> Two changes from v1: (1) every prompt is **addressed to the Jupiter seller agent**; (2) every prompt is a **complete inquiry** — it always contains the base dimensions (item, quantity, size split, delivery date, destination). The 10 prompts differ by *higher-order* complexity, still ramping P01→P10.

## Role note for judges (put in SKILL.md description and/or hand to judges)

> This skill is the autonomous **seller agent for Jupiter Knitting Company** (`jupiterSellerAgent`, LEI `3358004DXAMRWRUIYJ05`). In each test you act as the **buyer** — Tommy Hilfiger Europe B.V. (LEI `54930012QJWZMYHNJW95`) — sending an inquiry to the seller agent. Paste a prompt verbatim. The seller agent will verify both LEIs via GLEIF, consult its inventory / logistics / credit / treasury sub-agents, negotiate if asked, and return a quote. You only need to read the quote it returns — you don't need to name any tools.

## Locked invariants
- Buyer = **Tommy Hilfiger Europe B.V.**, LEI `54930012QJWZMYHNJW95` (tommyBuyerAgent).
- Seller = **Jupiter Knitting Company**, LEI `3358004DXAMRWRUIYJ05` (jupiterSellerAgent).
- Currency **INR (₹)**, **GST 18%**, UOM **Nos**.
- **Payment is always a single one-time payment** — only its due date varies: **Net-0 (prepaid) / Net-30 / Net-60**. No advance+balance, no milestones.
- Identity = **PLAIN GLEIF** (no vLEI in these 10).
- Items: `TH-TEE-RN-180` (round-neck tee), `TH-POLO-PIQ-220` (piqué polo), `TH-HOOD-FLC-320` (fleece hoodie) — each with sizes **S/M/L/XL**.
- **Default size spread** (document in SKILL.md so "usual spread" is unambiguous): **20% S / 40% M / 30% L / 10% XL**.

## B0 — the base inquiry present in ALL 10 prompts
item(s) + quantity + size split + required delivery date + destination → seller returns: per-size line prices, order total incl. 18% GST, freight, the Incoterm quoted on, and delivery feasibility (can-ship-by-date / earliest date).

---

### P01 — Simplest complete inquiry (B0 + prepaid, firm quote)
> Jupiter seller agent — this is an inquiry from Tommy Hilfiger Europe B.V. (buyer LEI 54930012QJWZMYHNJW95) to you, Jupiter Knitting Company (seller LEI 3358004DXAMRWRUIYJ05).
> We'd like round-neck cotton tees, item TH-TEE-RN-180: **1,000 pieces — 200 S, 400 M, 300 L, 100 XL — delivered to Rotterdam, Netherlands by 30 September 2026**. We'll pay in full up front (prepaid).
> Please confirm you're a live, GLEIF-registered entity, then send a quote: price per size line, order total with 18% GST, freight, the Incoterm you're quoting on, and whether you can hit the date.

*Adds beyond B0:* identity confirmation; one-time prepaid term.

### P02 — Compare prepaid vs Net-30
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> We want **3,000 round-neck tees (TH-TEE-RN-180): 600 S, 1,200 M, 900 L, 300 XL, delivered to Rotterdam by 30 September 2026**.
> We'd pay in a **single payment 30 days after dispatch (Net-30)**. Quote it **both ways — prepaid and Net-30** — so we can compare: per-size lines, totals incl. 18% GST, freight, Incoterm, and delivery feasibility.

*Adds:* payment-term comparison (Treasury working-capital delta).

### P03 — Large volume → ATP-short, earliest-ship honesty
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> We need a large run of round-neck tees (TH-TEE-RN-180): **40,000 pieces — 8,000 S, 16,000 M, 12,000 L, 4,000 XL — to Rotterdam, prepaid, ideally by 15 August 2026**.
> Tell us honestly whether you can fully ship by that date; if not, **what you can ship by then and the earliest date for the balance**. Send per-size lines, total incl. GST, freight and Incoterm.

*Adds:* ATP shortfall → lead-time / earliest-ship (Inventory + Fulfillment).

### P04 — 2-style basket, two destinations, Net-30
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> **Two styles in one order, Net-30, by 30 September 2026:**
> • 5,000 round-neck tees (TH-TEE-RN-180): 1,000 S, 2,000 M, 1,500 L, 500 XL → **deliver to Rotterdam**
> • 2,000 piqué polos (TH-POLO-PIQ-220): 400 S, 800 M, 600 L, 200 XL → **deliver to Hamburg**
> Quote each style with per-size lines, **separate freight per destination**, the Incoterm for each, the basket total incl. 18% GST, and feasibility per line.

*Adds:* multi-line basket + split destinations (Logistics per leg).

### P05 — Jupiter runs DD on Tommy → credit-driven payment term
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> We'd like **6,000 fleece hoodies (TH-HOOD-FLC-320): 1,200 S, 2,400 M, 1,800 L, 600 XL, to Rotterdam by 31 October 2026**.
> Before quoting, **run your own due-diligence on us and tell us which single payment term you're comfortable offering — prepaid / Net-30 / Net-60 — based on that**, then quote on that term: per-size lines, total incl. GST, freight, Incoterm, feasibility, and the basis for the term you chose.

*Adds:* full DD (Credit + Info-Collection) → `recommendedTerms` drives the quote.

### P06 — 3-style basket, tight date → split-shipment plan
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> **Three styles, Net-30, hard deadline 10 August 2026 for our autumn launch, all to Rotterdam** (usual size spread — 20% S / 40% M / 30% L / 10% XL each):
> • 10,000 round-neck tees (TH-TEE-RN-180)
> • 4,000 piqué polos (TH-POLO-PIQ-220)
> • 3,000 fleece hoodies (TH-HOOD-FLC-320)
> If you can't deliver all of it by the 10th, **propose a split — what ships by the deadline and what follows, with dates** — rather than refusing. Give per-style/per-size lines, totals incl. GST, freight, Incoterm, and the split plan.

*Adds:* partial/split-shipment decision under a binding date (Fulfillment depth).

### P07 — Target price, single counter-round
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> We want **8,000 round-neck tees (TH-TEE-RN-180), usual size spread, to Rotterdam by 30 September 2026, Net-30**.
> Our **target is ₹300 per piece**. Please quote, and if you can meet ₹300 say so; if not, **counter once** with your best price and the reason. Include per-size lines, total incl. GST, freight, Incoterm, feasibility.

*Adds:* single-round negotiation to a target.

### P08 — Aggressive targets, 3-round negotiation, Net-60, DD
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> Basket, **all to Rotterdam by 31 October 2026, and we're asking for Net-60** (single payment 60 days after dispatch), usual size spread:
> • 12,000 round-neck tees (TH-TEE-RN-180)
> • 5,000 piqué polos (TH-POLO-PIQ-220)
> **Run your diligence on us first to decide if Net-60 is acceptable.** Our targets are **₹295 per tee and ₹520 per polo**. Negotiate with us — **up to 3 rounds** — and show each round. End with your final per-line prices, totals incl. GST, freight, Incoterm, feasibility, and the agreed payment term.

*Adds:* full 3-round multi-dimensional negotiation + longer one-time term gated by DD.

### P09 — Demand-aware quoting (against Jupiter's own order book)
> Jupiter seller agent — inquiry from Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95).
> We need **25,000 round-neck tees (TH-TEE-RN-180), usual size spread, to Rotterdam by 20 September 2026, Net-30**.
> Please quote **with your current order book in mind — consider what you've already committed to other customers and your other open quotes before promising our dates and price**. Our target is **₹298 per piece**; meet it or counter (up to 2 rounds). Show per-size lines, totals incl. GST, freight, Incoterm, and a realistic delivery plan given your existing commitments.

*Adds:* demand-aware quoting (Quoting consults Demand-Planning, `QUOTE_DEMAND_AWARE=on`).

### P10 — Capstone: everything + persist final quote with revision + OOR + timestamp
> Jupiter seller agent — **formal inquiry** from Tommy Hilfiger Europe B.V. (buyer LEI 54930012QJWZMYHNJW95).
> Three styles, **all to Rotterdam by 30 September 2026, single payment Net-30** (revisit if your diligence says otherwise):
> • 15,000 round-neck tees (TH-TEE-RN-180): 3,000 S, 6,000 M, 4,500 L, 1,500 XL
> • 6,000 piqué polos (TH-POLO-PIQ-220): 1,200 S, 2,400 M, 1,800 L, 600 XL
> • 4,000 fleece hoodies (TH-HOOD-FLC-320): 800 S, 1,600 M, 1,200 L, 400 XL
> Run the whole process: **confirm both LEIs via GLEIF**, **do your diligence on us and confirm the payment term**, **check what you can ship by the date and propose a split if needed**, **quote freight and Incoterm**, and **negotiate to our targets (₹300 tee / ₹520 polo / ₹880 hoodie) over up to 3 rounds**.
> When we agree, **record the final quote in your system as a formal quotation** and give us back: the **quotation number**, the **revision number**, the **issue timestamp**, and **who issued it — the seller agent and the officer it acts for** — plus per-line prices, totals incl. 18% GST, freight, Incoterm and the delivery plan.

*Adds:* end-to-end + durable persistence to ERPNext (`Quotation` with `amended_from` revision chain + `custom_quoted_by_agent`/`custom_quoted_by_oor`/`custom_seller_lei` + `custom_quoted_at`), linked to the `Opportunity` inquiry.

---

## Complexity ladder (what each prompt adds beyond B0)

| # | Payment | Stock scenario | Lines | Destinations | DD | Negotiation | Demand-aware | Persist |
|---|---|---|---|---|---|---|---|---|
| P01 | prepaid | in-stock | 1 style | 1 | GLEIF id | — | — | — |
| P02 | prepaid vs Net-30 | in-stock | 1 | 1 | GLEIF id | — | — | — |
| P03 | prepaid | **ATP-short** | 1 | 1 | GLEIF id | — | — | — |
| P04 | Net-30 | in-stock | **2 styles** | **2** | GLEIF id | — | — | — |
| P05 | **credit-driven** | in-stock | 1 | 1 | **full DD** | — | — | — |
| P06 | Net-30 | tight → **split** | **3 styles** | 1 | GLEIF id | — | — | — |
| P07 | Net-30 | in-stock | 1 | 1 | GLEIF id | **1 round** | — | — |
| P08 | **Net-60** (DD-gated) | in-stock | 2 | 1 | full DD | **3 rounds** | — | — |
| P09 | Net-30 | in-stock | 1 | 1 | GLEIF id | 2 rounds | **on** | — |
| P10 | Net-30 (DD-gated) | mixed → split | 3 styles | 1 | full DD | 3 rounds | on | **yes** |

*End of prompts v2.*
