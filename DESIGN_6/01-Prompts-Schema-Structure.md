# IMPL-V6 — 10 OpenClaw Functional Prompts, Refined Multi-Agent Design, ERPNext Schema Sync, Project Structure

> **Status:** DESIGN ONLY. No implementation code in this document (per instruction). Schema/seed scripts are *specified* with their flags and field mappings, not written.
> **Refines, does not replace:** `DynDisc4-ent1/DESIGN/DESIGN-Jun7/{CONTINUATION-PROMPT-Jun7.md, DynDisc-NANDA-ENT-Sim-Ph1-Architecture.md, LangGraph-TS-MemoryDesign.md, TX-PROMPTS-ITERATION-PLAN.md, TX-INTL-PROMPTS-BACKLOG.md}`.
> **New homes:** multi-agent system → `FINAGENTS1/DynDiscProject6/IMPL-V6/`; ERPNext customization → `FINAGENTS1/erpnextEnh1/` (does not exist yet — to be created).

## Provenance of every claim in this doc (Rules 3, 4, 8)

| Fact used below | Status | Source actually read this session |
|---|---|---|
| Jupiter LEI `3358004DXAMRWRUIYJ05`, org JUPITER KNITTING COMPANY, OOR `Jupiter_Chief_Sales_Officer`, agentAID `EOZN-bHzYFTcmDsjGtdcthVEidqHkz8KAomhKLmZlDHc`, LE AID `ENRYTrjfSAy10g0pQQE5C0hD1gRI-oNLfc2HKR2WX0a6`, QVI `EF-yQO-6Oxt631MU0OCTHLY54DNQoBL19vbHGrbX43S9` | **[VERIFIED]** | `DynDiscProject5/A2A/agent-cards/jupiterSellerAgent-card.json` |
| Tommy LEI `54930012QJWZMYHNJW95`, org TOMMY HILFIGER EUROPE B.V., OOR `Tommy_Chief_Procurement_Officer` | **[VERIFIED]** | `DynDiscProject5/A2A/agent-cards/tommyBuyerAgent-card.json` |
| Existing provider contract `ConsultationRecord<T>` w/ provenance + defensive branches; `InventoryProvider`→ERPNext `Bin`; Logistics→DCSA; Credit→GLEIF/EDGAR; Treasury→ACTUS PAM | **[VERIFIED]** | `DynDiscProject5/A2A/js/src/shared/provider-types.ts`, `inventory-provider.ts` |
| Negotiation is currently **single-line, single-price** (qty/deliveryDate/paymentTerms only partially modelled); audit JSON carries party LEI+agentAID+OOR | **[VERIFIED]** | `DynDiscProject5/A2A/js/src/shared/negotiation-types.ts` |
| Canonical item `FAB-COTTON-180GSM`, warehouse `MADRAS-WH-1`, ERPNext `Bin` fixture shape, ACTUS demo (50k @ ₹370 Net-30, minViablePrice ₹335) | **[VERIFIED]** | `DynDiscProject5/A2A/js/DEMO-DATA/inventory/erpnext-bin-FAB-COTTON-180GSM.json`, `.../treasury/jupiter-treasury-pricepoint-370-net30.json` |
| ERPNext **Quotation** fields incl. `naming_series=SAL-QTN-.YYYY.-`, `amended_from` (revision), `is_submittable`, `party_name`, `transaction_date`, `valid_till`, `items`→Quotation Item, `payment_terms_template`+`payment_schedule`, `tc_name`/`terms`, `incoterm`/`named_place`, `opportunity` (link to inquiry), `status` | **[VERIFIED]** | `erpnext/erpnext/selling/doctype/quotation/quotation.json` |
| ERPNext **Quotation Item** fields incl. `item_code`,`qty`,`uom`,`rate`,`amount`,`warehouse`,`prevdoc_doctype`/`prevdoc_docname`,`customer_item_code`,`item_tax_template` | **[VERIFIED]** | `erpnext/.../quotation_item/quotation_item.json` (field_order) |
| ERPNext **Opportunity Item** fields: `item_code`,`item_name`,`uom`,`qty`,`rate`,`amount`,`description`,`brand`,`item_group` | **[VERIFIED]** | `erpnext/erpnext/crm/doctype/opportunity_item/opportunity_item.json` |
| ERPNext **Payment Schedule** fields: `payment_term`,`due_date`,`invoice_portion`,`payment_amount`,`credit_days`,`mode_of_payment` | **[VERIFIED]** | `erpnext/erpnext/accounts/doctype/payment_schedule/payment_schedule.json` |
| Sizes via **Item Variant Attribute** (`variant_of`→Item, `attribute`→Item Attribute, `attribute_value`) | **[VERIFIED]** | `erpnext/erpnext/stock/doctype/item_variant_attribute/item_variant_attribute.json` |
| Opportunity, Request for Quotation, Item Attribute, Payment Terms Template doctypes exist in this ERPNext source | **[VERIFIED]** | `search_files` hit list |
| `Opportunity` (header) full field list; ERPNext `Item` full field list; Pricing Rule / Item Price exact fields | **[NOT-READ]** | (read header + Item + Item Price before writing the seed scripts) |
| `erpnextEnh1/` directory contents | **[NOT-READ — DOES NOT EXIST YET]** | `FINAGENTS1` listing had no `erpnextEnh1` |
| `DynDiscProject6/` current contents | **[NOT-READ]** | only confirmed the dir exists |

---

# PART 1 — THE 10 FUNCTIONAL PROMPTS (run verbatim in stock OpenClaw)

**How these run (mechanic, from continuation prompt §0):** a judge pastes a plain-English prompt to a stock OpenClaw agent. OpenClaw discovers the ChainAim skill via the NANDA Index, reads `SKILL.md`, calls the MCP tools, returns the result. So each prompt is written the way a real procurement officer would talk — no jargon, no tool names — and the *capability* is what advances.

**Invariants across all 10 (locked):**
- Buyer is always **tommyBuyerAgent** — TOMMY HILFIGER EUROPE B.V., LEI `54930012QJWZMYHNJW95`.
- Seller is always **jupiterSellerAgent** — JUPITER KNITTING COMPANY, LEI `3358004DXAMRWRUIYJ05`.
- Currency **INR (₹)**, GST **18%**, UOM **Nos** (pieces) for garments. (Quotation supports multi-currency if EUR is wanted later via `currency`+`conversion_rate`.)
- **Payment is a single one-time payment** throughout. The only thing that varies is *when* that one payment is due (Net-0 / Net-30 / Net-60) → one `Payment Schedule` row at `invoice_portion = 100`. No advance+balance, no milestones. (Milestone/DvP payments are explicitly out of scope here — deferred to ITER5+.)
- Identity is **PLAIN GLEIF** (tool `verify_lei_gleif`). No vLEI delegation in these 10 (ITER7).

**Item catalog to seed (ERPNext Items — see Part 2):**

| Item Code | Description | Variant? | Sizes |
|---|---|---|---|
| `TH-TEE-RN-180` | Tommy round-neck tee, 180 GSM combed cotton | template (`has_variants=1`) | S, M, L, XL → `TH-TEE-RN-180-{S,M,L,XL}` |
| `TH-POLO-PIQ-220` | Tommy piqué polo, 220 GSM | template | S, M, L, XL |
| `TH-HOOD-FLC-320` | Tommy fleece hoodie, 320 GSM | template | S, M, L, XL |
| `FAB-COTTON-180GSM` | Cotton single-jersey knit fabric, 180 GSM (existing fixture) | no | — (UOM kg/m) |

The ladder adds **exactly one new dimension per step**. Dimension legend:
`U`=unit price · `Q`=quantity · `Z`=sizes · `D`=delivery date · `L`=destination/logistics · `M`=multi-SKU · `P`=payment term · `DD`=due-diligence/identity · `N`=negotiation · `ERP`=persist to ERPNext.

---

### P01 — Unit price only `[U]`

> Hi — I'm the procurement agent for Tommy Hilfiger Europe (LEI 54930012QJWZMYHNJW95). Please ask Jupiter Knitting Company (LEI 3358004DXAMRWRUIYJ05) for their **current per-piece price** for the round-neck cotton t-shirt, item TH-TEE-RN-180. I just want the unit price right now — no quantity, no delivery.

- **New dimension:** unit price, one SKU.
- **What the seller agent needs/does:** resolve the item; read its selling price; return one number + currency + how long the price holds.
- **MCP tool:** `quote_unit_price`
- **ERPNext touched (read):** `Item`, `Item Price` (selling Price List).
- **Expected quote:** `{ item: TH-TEE-RN-180, unitRate: ₹X, currency: INR, validTill: <date> }`.

### P02 — + quantity (volume break) `[U Q]`

> …now get Jupiter's price for **2,000 pieces** of the round-neck tee (TH-TEE-RN-180). Tell me the per-piece price *at that volume* and the order total.

- **New dimension:** quantity → volume-break pricing.
- **Seller does:** apply any quantity-slab pricing rule; compute subtotal + GST + grand total.
- **MCP tool:** `quote_with_quantity`
- **ERPNext (read):** `Item Price`, `Pricing Rule` (qty slabs).
- **Expected quote:** `unitRate@2000`, `qty`, `subtotal`, `gst(18%)`, `grandTotal`.

### P03 — + sizes (size curve) `[U Q Z]`

> …price 2,000 round-neck tees (TH-TEE-RN-180) split by size: **400 S, 700 M, 600 L, 300 XL**. Give me a line per size and the overall total.

- **New dimension:** size variants (one style → four variant SKUs).
- **Seller does:** expand template → variant items; one quote line per size; aggregate.
- **MCP tool:** `quote_size_curve`
- **ERPNext (read):** `Item` variants `TH-TEE-RN-180-{S,M,L,XL}` (via `Item Variant Attribute`, attribute `Size`).
- **Expected quote:** 4 lines (`item_code`, `qty`, `rate`, `amount`), `total_qty=2000`, grand total. Maps 1:1 to four `Quotation Item` rows.

### P04 — + delivery date (ATP / lead-time) `[U Q Z D]`

> …same 2,000-piece size split, but I need it **delivered by 25 August 2026**. Tell me whether Jupiter can hit that date; if not, the earliest they can ship.

- **New dimension:** required delivery date → available-to-promise + lead-time feasibility.
- **Agents:** **Inventory** (ERPNext `Bin`: available − reserved − safety) + **Fulfillment** (ATP vs CTP: if short, fall to `leadTimeDays`/`earliestShipDate`).
- **MCP tool:** `quote_with_delivery`
- **ERPNext (read):** `Bin` per variant/warehouse (`MADRAS-WH-1`).
- **Expected quote:** per-line `canFulfill` + `earliestShipDate`; header `requiredDeliveryDate`. (Mirrors the verified fixture story: requested qty may exceed availableQty → credible later ship date, not a price change.)

### P05 — + destination (logistics / Incoterm) `[U Q Z D L]`

> …delivered to **Rotterdam** (we're in the Netherlands). Include freight, and tell me **on what Incoterm** Jupiter is quoting.

- **New dimension:** destination → freight + Incoterm.
- **Agents:** **Logistics** (DCSA-shaped carrier quote: transit days, rate, can-meet-date).
- **MCP tool:** `quote_with_logistics`
- **ERPNext (write target fields):** `Quotation.incoterm`, `Quotation.named_place`, freight as a `Sales Taxes and Charges`/`Shipping Rule` line.
- **Expected quote:** freight amount, transit days, Incoterm (e.g. `FOB Chennai` or `CIF Rotterdam`), landed total.

### P06 — multi-line basket (multiple distinct SKUs) `[U Q Z D L M]`

> …one inquiry covering **three styles**: 2,000 round-neck tees (TH-TEE-RN-180), 800 piqué polos (TH-POLO-PIQ-220), and 500 fleece hoodies (TH-HOOD-FLC-320). Quote each line, give me the basket total, delivered to Rotterdam by **30 September 2026**.

- **New dimension:** multiple distinct line items in one inquiry.
- **Agents:** Inventory/Fulfillment per line; Logistics on aggregate volume.
- **MCP tool:** `quote_multiline`
- **ERPNext:** one `Opportunity` (inquiry) → one `Quotation` with N item lines (each style may further expand into size lines).
- **Expected quote:** per-style lines, per-line feasibility, basket grand total.

### P07 — + payment term (single one-time payment) `[U Q Z D L M P]`

> …for that 3-style basket we'll pay in **a single payment, 30 days after dispatch (Net-30)**. Does that change the price? Give me the price on **prepaid (Net-0) vs Net-30** so I can compare.

- **New dimension:** one payment term (when the single payment is due).
- **Agents:** **Treasury** (ACTUS PAM working-capital cost of the 30-day gap → price delta).
- **MCP tool:** `quote_with_payment_term` (flag-exposed terms).
- **ERPNext:** `Payment Terms Template` (`Net-0`, `Net-30`) + `Payment Schedule` (1 row, `invoice_portion=100`, `credit_days=0|30`).
- **Expected quote:** price under each term + working-capital delta (consistent with the verified ACTUS demo math).

### P08 — + bilateral due diligence / identity `[U Q Z D L M P DD]`

> …before we commit, please (a) **confirm Jupiter is a live, registered entity via GLEIF**, and (b) have Jupiter **run its own check on Tommy Hilfiger Europe** and tell us what payment terms it's willing to offer based on that. Then re-quote the Net-30 basket.

- **New dimension:** identity check + counterparty DD driving terms.
- **Agents:** **DD** (orchestrates **Credit** [GLEIF+EDGAR → PD/LGD → `recommendedTerms`] + **Info-Collection** [buyer website no-login + disclosed handles only; **no social scraping**]).
- **MCP tools:** `verify_lei_gleif` + `run_due_diligence`
- **ERPNext (read/write):** `Customer` (Tommy) credit summary fields; quote `payment_terms_template` reflects `recommendedTerms`.
- **Expected quote:** GLEIF status (ACTIVE), credit summary, recommended term, re-quoted basket.

### P09 — + target price / short negotiation `[U Q Z D L M P DD N]`

> …our target is **₹300/piece on the round-neck tees**. Ask Jupiter to meet it for the full basket on Net-30, delivered to Rotterdam by 30 Sep 2026; if they can't, let them **counter — up to 3 rounds**. Show me each round and the final price.

- **New dimension:** multi-round, multi-dimensional negotiation.
- **Agents:** full negotiation saga + tactics engine (effective-floor, Rubinstein δ, NBS midpoint, α-utility) with Treasury veto (`minViablePrice`).
- **MCP tool:** `negotiate_quote`
- **Memory:** T2 saga `rounds[]`; each round commits a Quotation **revision** (`amended_from` + `custom_quote_revision`).
- **Expected quote:** per-round offer/counter, final agreed price or escalation, with the bargaining trace in the audit.

### P10 — full capstone + persist to ERPNext with revision + OOR identity `[U Q Z D L M P DD N ERP]`

> …run the whole thing end-to-end for the 3-style, size-split basket — verify identities, do the diligence, quote delivered to Rotterdam by 30 Sep 2026 on Net-30, negotiate to our ₹300 target over up to 3 rounds — and **when we agree, record the final quote in Jupiter's system as a formal quotation**. I want the quotation to show **who issued it** (the Jupiter seller agent and the officer it acts for), the **revision number**, and the **timestamp**.

- **New dimension:** durable persistence of the final quote to ERPNext with full attribution.
- **Agents:** all 14 as routed.
- **MCP tool:** `persist_quote_erpnext` (+ every prior tool).
- **ERPNext (write):** final `Quotation` (submitted), `amended_from` chain for revisions, custom fields `custom_quoted_by_agent=jupiterSellerAgent`, `custom_quoted_by_oor=Jupiter_Chief_Sales_Officer`, `custom_seller_lei`, `custom_seller_agent_aid`, `custom_quote_revision`, `custom_quoted_at`, `custom_negotiation_id`; `opportunity` linked back to the inquiry.
- **Memory:** T2 full saga + T5 audit + signed PDF.
- **Expected quote:** Quotation ID `SAL-QTN-2026-#####[-rev]`, revision number, issuer identity block, grand total, audit reference.

---

# PART 2 — ERPNext SCHEMA, IN SYNC WITH THE PROMPTS

Principle (per instruction "fully leverage all the schemas already available in ERPNext"): **reuse native DocTypes; add custom fields only for what's genuinely new (agent/OOR identity + multi-dimensional inquiry context).** Do **not** fork ERPNext source (GPL); all reads/writes go over REST; all customization lives in the separate `erpnextEnh1` Frappe app.

## 2.1 The Inquiry → native **Opportunity** (+ Opportunity Item) + custom fields

The buyer's inbound inquiry is recorded by the seller as an **Opportunity** (CRM module), with one **Opportunity Item** per requested line (native: `item_code`, `item_name`, `uom`, `qty`, `rate`, `amount`, `description`). The `Opportunity` becomes the parent the final `Quotation` links to via its native `opportunity` field — that's the inquiry→quote join ERPNext already supports.

**Custom fields to add (erpnextEnh1) — Opportunity (header):**

| Custom field | Type | Holds | Used by prompts |
|---|---|---|---|
| `custom_inquiry_id` | Data | = `negotiationId` (saga thread id, joins T2/T5) | all |
| `custom_buyer_lei` | Data | `54930012QJWZMYHNJW95` | all |
| `custom_buyer_agent` | Data | `tommyBuyerAgent` | all |
| `custom_buyer_oor` | Data | `Tommy_Chief_Procurement_Officer` | DD+ |
| `custom_required_delivery_date` | Date | header-level requested date | P04+ |
| `custom_delivery_destination` | Data | e.g. `Rotterdam, NL` | P05+ |
| `custom_incoterm_requested` | Link→Incoterm | requested Incoterm (if any) | P05+ |
| `custom_payment_term_requested` | Link→Payment Term | Net-0/Net-30/Net-60 | P07+ |
| `custom_target_unit_price` | Currency | buyer target (₹300) | P09+ |
| `custom_max_negotiation_rounds` | Int | default 3 | P09+ |
| `custom_inquiry_dimensions_json` | Long Text | verbatim JSON snapshot of the parsed inquiry (audit-safe) | all |

**Custom fields — Opportunity Item (per line):**

| Custom field | Type | Holds |
|---|---|---|
| `custom_size` | Data | size label when not modelled as a distinct variant code |
| `custom_required_delivery_date` | Date | per-line date (basket lines can differ) |
| `custom_target_rate` | Currency | per-line target |

> Sizes are modelled the **native** way: template Item `has_variants=1` + `Item Attribute` "Size" → variant Items `…-S/-M/-L/-XL`. P03's four size lines = four `Opportunity Item` / `Quotation Item` rows with distinct variant `item_code`s. `custom_size` is only a convenience when a buyer references a size against a non-variant item.

## 2.2 The Quote → native **Quotation** (+ Quotation Item) + custom fields

**Native fields already cover most of it:**

| Requirement | Native ERPNext field | Notes |
|---|---|---|
| Quote identity / number | `naming_series` = `SAL-QTN-.YYYY.-` → `SAL-QTN-2026-#####` | |
| Buyer | `quotation_to`=Customer, `party_name`, `customer_name` | Tommy |
| Issue timestamp | `creation` (Frappe base field) + `transaction_date` | |
| Last-modified timestamp | `modified` (Frappe base field) | |
| Validity | `valid_till` | |
| Line items | `items` → `Quotation Item` (`item_code`,`qty`,`uom`,`rate`,`amount`,`warehouse`) | P01–P06 |
| Link back to inquiry | `opportunity` (Link→Opportunity); line `prevdoc_doctype`/`prevdoc_docname` | |
| Destination / Incoterm | `incoterm`, `named_place` | P05 |
| Single payment term | `payment_terms_template` + `payment_schedule` (1 row, 100%) | P07 |
| Terms text | `tc_name`, `terms` | |
| Totals | `total_qty`, `net_total`, `total_taxes_and_charges`, `grand_total`, `rounded_total`, `in_words` | |
| Status lifecycle | `status` ∈ Draft/Open/Replied/Ordered/Lost/Expired | |
| **Revision** | **`amended_from` (Link→Quotation) + `is_submittable`** | native amend chain: `SAL-QTN-2026-00001` → `…-00001-1` → `…-00001-2` |
| Issuer (system user) | `owner`, `modified_by` (Frappe base) | the REST API user; *not* the agent identity |

**The one thing native fields do NOT capture: the agent/OOR identity that issued the quote.** That's the user's explicit "who quoted — jupiter seller agent and their OOR." Add these **custom fields — Quotation:**

| Custom field | Type | Holds | Source |
|---|---|---|---|
| `custom_quoted_by_agent` | Data | `jupiterSellerAgent` | agent card |
| `custom_quoted_by_oor` | Data | `Jupiter_Chief_Sales_Officer` | agent card `vLEImetadata.oorHolderName` |
| `custom_seller_lei` | Data | `3358004DXAMRWRUIYJ05` | agent card |
| `custom_seller_agent_aid` | Data | `EOZN-…` (KERI AID) | agent card `keriIdentifiers.agentAID` |
| `custom_quote_revision` | Int | human-friendly R1/R2/R3 (parallel to `amended_from` chain) | saga round |
| `custom_quoted_at` | Datetime | agent-stamped issue time (ISO) | orchestrator |
| `custom_credential_mode` | Select(`plain`,`vlei`) | `plain` for these 10 | flag `CREDENTIAL_MODE` |
| `custom_signed_envelope_hash` | Data | sha256 envelope hash of the issued quote (links to T5 audit) | `PlainHashSigner` |
| `custom_negotiation_id` | Data | saga `negotiationId` (joins T2/T5/Opportunity) | orchestrator |
| `custom_actus_sim_id` | Data | ACTUS PAM sim id behind the price (P07+) | treasury consult |

**Revision mechanics (native, verified):** every re-quote during negotiation (P09/P10) is an **amend** of the submitted Quotation. ERPNext cancels the prior submitted doc and creates a new one with `amended_from` pointing to it and an incrementing suffix. `custom_quote_revision` carries the friendly counter; `creation`/`custom_quoted_at` carry the timestamp; the custom identity fields carry "who." This satisfies *revision + timestamp + who-quoted (agent + OOR)* with **zero forking** — only Custom Fields.

## 2.3 Dimensions → native mechanisms (summary)

| Prompt dimension | Native ERPNext mechanism |
|---|---|
| Sizes (P03) | Item template + `Item Attribute` "Size" + `Item Variant Attribute` → variant Items |
| Quantity breaks (P02) | `Pricing Rule` (qty slabs) + `Item Price` |
| Delivery date / ATP (P04) | `Bin` (actual/reserved); `Quotation Item` per-line; lead time from Item / fixture |
| Destination / Incoterm (P05) | `Quotation.incoterm` + `named_place`; `Shipping Rule` / freight charge line |
| Multi-line (P06) | multiple `Quotation Item` rows under one `Quotation` |
| Single payment term (P07) | `Payment Terms Template` + `Payment Schedule` (1 row, `invoice_portion=100`) |
| DD / credit terms (P08) | `Customer` + credit summary fields; term chosen from credit `recommendedTerms` |

---

# PART 3 — MULTI-AGENT MEMORY: WHAT PERSISTS IN WHICH DB

Recap of the locked 5-tier model (from `LangGraph-TS-MemoryDesign.md`), refined for the inquiry→quote flow. **The headline the prompts demand:** *the inquiry lands in ERPNext (T4) at intake and is mirrored into the saga (T2); all multi-agent processing happens in agentic memory (T2, `audit.db`); the final negotiated quote is written back to ERPNext (T4) as a Quotation with revision + OOR identity.*

| Tier | Substrate / DB | What it stores in V6 | Lifetime |
|---|---|---|---|
| **T1 Working** | LangGraph `StateGraph` channels (RAM, in-process) | current super-step values: parsed inquiry, current round's offer/counter, in-flight consultations | seconds |
| **T2 Saga / Episodic** | **`audit.db`** (SQLite) via `SqliteSaver` checkpointer; `thread_id = negotiationId` | the agentic memory: full `NegState` per super-step — `inquiry`, `consultations[]` (append-only), `rounds[]`, `tacticsTrace`, `status`, clarify/negotiation round counts | deal + audit retention |
| **T3 Semantic / Cross-thread** | **`store.db`** (SQLite or Postgres; flag `MEMORY_STORE_KIND`) via LangGraph Store + Gemini `text-embedding-004` | buyer profile (Tommy), past-deal outcomes (price/terms/ZOPA), item-spec embeddings (mood/season), demand-portfolio view; namespaced; **reconstructible** from T2+T4 | long-lived |
| **T4 System of record** | **ERPNext MariaDB** via live REST | **Inquiry = `Opportunity`(+Items)**; **Quote = `Quotation`(+Items, +revisions)**; `Item`/variants, `Customer` (Tommy), `Bin` (ATP — always read live), `Sales Order`, `Payment Schedule` | authoritative |
| **T5 Human-readable audit** | **`audit.db`** (SAME file as T2) + signed PDF + GraphQL (port 5000) | provenance-tagged `consultations[]`, decision trail, `envelopeCounter`/`envelopeHash`, ACTUS sim ids, PDF metadata | regulatory |

**Namespaces (T3), privacy-disciplined (recap):**
- `[orgId,"buyers",buyerLEI,"profile"]` — disclosed handles + verified website text + credit summary (DD agent).
- `[orgId,"buyers",buyerLEI,"deals"]` — past outcomes (tactics engine).
- `[orgId,"demand","portfolio"]` — open quotes + committed orders (Demand-Planning).
- `[orgId,"items",itemCode,"spec"]` — item spec embeddings (Quoting).
- `[orgId,"buyer-safe",negotiationId]` — buyer-safe projection (**no effective-floor, no raw PD**) — only thing the buyer agent can read.

**ERPNext → T3 sync (Frappe webhooks, recap):** `Item.on_update`→item spec embed; `Customer.on_update`→buyer profile; `Sales Order.on_submit/cancel`→rebuild demand portfolio; `Bin.on_change`→invalidate ATP cache only (ATP always read live).

**Where each prompt's data ends up (traceability):**

| Prompt | Writes to T2 (saga) | Writes to T4 (ERPNext) | Writes to T5 (audit) | Reads T3 |
|---|---|---|---|---|
| P01–P03 | inquiry + quote draft | (optional) Opportunity | consultations | item spec |
| P04 | + ATP findings | Opportunity; Bin read live | + inventory consult | — |
| P05 | + logistics | Quotation incoterm/freight | + logistics consult | — |
| P06 | + per-line | Opportunity + Quotation (N lines) | + per-line consults | item specs |
| P07 | + treasury | Payment Schedule on Quotation | + ACTUS consult | — |
| P08 | + DD result | Customer credit; term | + GLEIF + credit consult | buyer profile |
| P09 | + rounds[] | Quotation **revisions** | + decision trail | past deals |
| P10 | full saga | final submitted Quotation + identity custom fields | + signed PDF | all |

---

# PART 4 — SCHEMA & DATA GENERATION SCRIPTS (specified, not yet written)

All scripts run **over ERPNext REST** against a running instance (Frappe Cloud or self-hosted `frappe_docker`) — **no ERPNext source embedding** (GPL-safe). They live in `erpnextEnh1/seed/`. Every script exposes flags (Rule 8) with sensible defaults; nothing hardcoded.

**Common flags (all scripts):**
`--erpnext-url` (default `http://localhost:8080`) · `--api-key` · `--api-secret` · `--company "Jupiter Knitting Company"` · `--currency INR` · `--dry-run` (default true; prints payloads, writes nothing) · `--reset` (default false) · `--verbose`.

| # | Script | AI can do / Manual | Purpose | Key flags |
|---|---|---|---|---|
| 00 | `00-bootstrap-masters` | **AI** writes script; **Manual** runs it (needs API creds) | Company, Warehouse `MADRAS-WH-1`, UOM `Nos`, Item Group, Brand `Tommy Hilfiger`, **Item Attribute "Size" {S,M,L,XL}**, Price List (INR selling), GST 18% tax template, Payment Terms `Net-0/Net-30/Net-60`, Customer **Tommy Hilfiger Europe** (+`custom_buyer_lei`) | `--warehouse`, `--tax-rate 18`, `--terms Net-0,Net-30,Net-60` |
| 01 | `01-seed-items-variants` | **AI** writes | Template Items (`TH-TEE-RN-180` etc., `has_variants=1`) + generate variants via `Item Variant Attribute`; `FAB-COTTON-180GSM`; `Item Price` rows | `--items <file>`, `--with-variants` |
| 02 | `02-install-custom-fields` | **AI** writes (core of erpnextEnh1) | Install Custom Field + Property Setter fixtures on Opportunity / Opportunity Item / Quotation / Quotation Item (the identity + dimension fields in Part 2) | `--target plain\|vlei` (which identity fields) |
| 03 | `03-install-webhooks` | **AI** writes | Register Frappe Webhooks (Item/Customer/Sales Order/Bin) → POST to IMPL-V6 MCP server `/sync` endpoint | `--sync-url`, `--events ...` |
| 04 | `04-seed-demo-bins` | **AI** writes | Set `Bin` qty per variant/warehouse so the 10 prompts produce interesting ATP results (some fulfillable, some needing lead time — matches verified `canFulfill=false` fixture) | `--profile happy\|short\|mixed` |
| 90 | `90-export-fixtures` | **AI** writes | Export the customization as reproducible fixtures (so erpnextEnh1 is idempotent across instances) | `--out fixtures/` |

> **Manual steps (Rule 9) are walked ONE AT A TIME when we start** — they are: provision the ERPNext instance, generate API key/secret, set the four env values. I will not list them as a block here; we do Step 1 → you confirm → Step 2, when execution begins.

---

# PART 5 — PROPOSED PROJECT STRUCTURE

## 5.1 `FINAGENTS1/DynDiscProject6/IMPL-V6/` (the new multi-agent system — sibling, not mixed with prior impl)

```
DynDiscProject6/
└─ IMPL-V6/
   ├─ README.md
   ├─ package.json                      # single Node/TS workspace (LangGraph.js, MCP SDK, zod)
   ├─ tsconfig.json
   ├─ .env.example                      # all flags (see 5.3)
   ├─ railway.json                      # Nixpacks, /health, single SSE entry (matches NANDA_DynDisc)
   ├─ SKILL.md                          # NANDA skill descriptor — judge's OpenClaw reads this
   ├─ agent-cards/
   │  ├─ jupiterSellerAgent-card.json   # copied VERBATIM from DynDiscProject5
   │  └─ tommyBuyerAgent-card.json      # copied VERBATIM
   ├─ prompts/                          # the 10 functional prompts, one file each
   │  ├─ P01-unit-price.md … P10-capstone-persist.md
   │  └─ PROMPT-LADDER.md               # the dimension matrix
   ├─ skills/                           # per-capability skill docs OpenClaw can read
   ├─ src/
   │  ├─ mcp/
   │  │  ├─ server-sse.ts               # SINGLE MCP-over-SSE entry; registers tools per iteration
   │  │  └─ tools/                      # one file per MCP tool (maps 1:1 to prompts)
   │  │     ├─ verify_lei_gleif.ts
   │  │     ├─ create_inquiry.ts
   │  │     ├─ quote_unit_price.ts
   │  │     ├─ quote_with_quantity.ts
   │  │     ├─ quote_size_curve.ts
   │  │     ├─ quote_with_delivery.ts
   │  │     ├─ quote_with_logistics.ts
   │  │     ├─ quote_multiline.ts
   │  │     ├─ quote_with_payment_term.ts
   │  │     ├─ run_due_diligence.ts
   │  │     ├─ negotiate_quote.ts
   │  │     └─ persist_quote_erpnext.ts
   │  ├─ orchestrator/                  # LangGraph.js
   │  │  ├─ graphs/
   │  │  │  ├─ negotiation-saga.ts      # StateGraph: ACK→DD_QUOTING→CLARIFY→QUOTED→NEGOTIATING→ACCEPTED/NO_DEAL/ESCALATED
   │  │  │  └─ dvp-saga.ts              # DEFERRED (ITER5+): milestone nodes + interrupts
   │  │  ├─ state/neg-state.ts          # Annotation.Root channels (extend to multi-line inquiry/quote)
   │  │  ├─ memory/
   │  │  │  ├─ checkpointer.ts          # SqliteSaver → audit.db (T2)
   │  │  │  ├─ store.ts                 # LangGraph Store + Gemini embeddings (T3)
   │  │  │  └─ namespaces.ts            # namespace + buyer-safe projection helpers
   │  │  └─ router/consultation-router.ts  # fan-out (ported from DynDiscProject5)
   │  ├─ agents/                        # 14 MODULES (one folder each) — registration fns, not servers
   │  │  ├─ buyer/                      # tommyBuyerAgent: build-inquiry, verify-msg, answer-clarification (minimal)
   │  │  ├─ seller/                     # jupiterSellerAgent: orchestrator shell
   │  │  ├─ dd/                         # NET-NEW: wraps credit + info-collection
   │  │  ├─ info-collection/            # NET-NEW: website(no-login)+disclosed handles+EDGAR/GLEIF/CH (NO scraping)
   │  │  ├─ quoting/                    # NET-NEW: ATP vs CTP → priced quote
   │  │  ├─ demand-planning/            # NET-NEW: sibling of quoting (QUOTE_DEMAND_AWARE)
   │  │  ├─ fulfillment/                # NET-NEW: ATP vs CTP decide/reschedule
   │  │  ├─ dvp/                        # NET-NEW: DEFERRED
   │  │  ├─ credit/                     # REUSED (GLEIF+EDGAR)
   │  │  ├─ inventory/                  # REUSED (ERPNext Bin)
   │  │  ├─ logistics/                  # REUSED (DCSA)
   │  │  ├─ treasury/                   # REUSED (ACTUS PAM)
   │  │  └─ audit-reporting/            # REUSED
   │  ├─ shared/                        # ported + EXTENDED from DynDiscProject5/A2A/js/src/shared
   │  │  ├─ provider-types.ts           # EXTEND: line-item arrays, size, payment-term inputs
   │  │  ├─ inventory-provider.ts  logistics-provider.ts  credit-provider.ts  treasury-provider.ts
   │  │  ├─ actus-client.ts
   │  │  ├─ inquiry-types.ts            # NEW: Inquiry + InquiryLine + dimensions
   │  │  ├─ quote-types.ts              # NEW: Quote + QuoteLine + revision + OOR identity block
   │  │  ├─ negotiation-types.ts        # EXTEND single→multi-line
   │  │  ├─ audit-writer.ts  sqlite-sidecar.ts
   │  │  └─ utils/compliance/gleif-client.ts
   │  ├─ erpnext/                       # ERPNext REST integration (T4)
   │  │  ├─ client.ts                   # REST wrapper (key/secret, flags, retries, defensive branch)
   │  │  ├─ inquiry-repo.ts             # Opportunity create/read
   │  │  ├─ quote-repo.ts               # Quotation create + amend(revision) + custom-field write
   │  │  └─ mappers.ts                  # domain ↔ DocType field mapping (Part 2 tables)
   │  └─ identity/                      # CredentialProvider (plain|vlei), agent-card loader
   ├─ DEMO-DATA/                        # fixtures ported + extended (size curves, multi-line)
   ├─ data/                             # audit.db (T2+T5), store.db (T3) — gitignored
   └─ scripts/                          # test/replay/mode-matrix (ported)
```

## 5.2 `FINAGENTS1/erpnextEnh1/` (NEW — ERPNext customization layer, GPL-safe)

```
erpnextEnh1/
├─ README.md
├─ apps/
│  └─ chainaim_proc/                    # a Frappe APP (not a fork of erpnext)
│     ├─ hooks.py
│     └─ chainaim_proc/
│        ├─ custom/                     # Custom Field + Property Setter JSON
│        │  ├─ opportunity.json  opportunity_item.json
│        │  └─ quotation.json    quotation_item.json
│        ├─ fixtures/                   # exportable: custom fields, Item Attribute Size, Payment Terms
│        └─ webhooks/                   # Item/Customer/Sales Order/Bin → IMPL-V6 /sync
├─ seed/                                # the 6 REST scripts in Part 4 (00..90)
└─ docs/
   └─ FIELD-MAP.md                      # the inquiry/quote ↔ ERPNext field-map tables (Part 2), kept in sync
```

> **Why a separate Frappe app, not edits to `erpnext/`:** keeps customization reproducible (`bench export-fixtures`), upgrade-safe, and avoids touching GPL-3.0 source. IMPL-V6 talks to ERPNext only over REST — the two repos never import each other.

## 5.3 Flags (recap + V6 additions) — `.env.example`

```
# Orchestration / memory (locked)
ORCHESTRATOR=langgraph-ts
CHECKPOINTER_KIND=sqlite
AUDIT_DB_PATH=./data/audit.db          # T2 + T5 share this file
MEMORY_STORE_KIND=memory               # memory | sqlite | postgres   (T3)
EMBEDDING_MODEL=text-embedding-004
CLARIFY_MAX_ROUNDS=2
NEGOTIATION_MAX_ROUNDS=3
QUOTE_DEMAND_AWARE=off                  # on = Quoting consults Demand-Planning

# Provider modes (locked)
INVENTORY_MODE=real                     # ERPNext Bin
CREDIT_MODE=real                        # GLEIF live; EDGAR demo
LOGISTICS_MODE=demo
TREASURY_MODE=real                      # ACTUS
CREDENTIAL_MODE=plain                   # vlei at ITER7
SIGNING_MODE=plain                      # sha256 envelope

# ERPNext (T4) — V6 additions
ERPNEXT_URL=http://localhost:8080
ERPNEXT_API_KEY=
ERPNEXT_API_SECRET=
ERPNEXT_COMPANY=Jupiter Knitting Company
ERPNEXT_CURRENCY=INR
ERPNEXT_DEFAULT_WAREHOUSE=MADRAS-WH-1
QUOTE_PERSIST_MODE=draft                # draft | submit   (submit enables amend-revision chain)
PAYMENT_TERMS_ALLOWED=Net-0,Net-30,Net-60
GST_RATE=18
```

---

# PART 6 — HOW THIS MAPS BACK TO THE LOCKED ITERATION LADDER

The 10 prompts are the **judging/test sequence**; the ITER1–ITER7 ladder is the **build sequence**. Mapping:

| Prompts | Locked iteration | Phase |
|---|---|---|
| P01–P02 | ITER1 (PLAIN GLEIF + base quote) | Phase 1 |
| P03–P06 | ITER2 (ERPNext ATP live, multi-dim: qty+date+sizes+multi-line) | Phase 1 |
| P07 | ITER2/3 (treasury-driven payment term) | Phase 1 |
| P08 | ITER3 (buyer DD + credit + logistics) | Phase 1 |
| P09 | negotiation core (existing tactics engine) | Phase 1 |
| P10 | ITER2+3 capstone + ERPNext quote persistence with revision/OOR | Phase 1 |
| (out of these 10) | ITER4 partial/SKU-split, ITER5 DvP/L-C, ITER6 sample/QC, **ITER7 vLEI** | Phase 2 |

Codebase decision (recap of the open item): **Option B** — promote to the single-process MCP server in `IMPL-V6` — is the right base for P03+ (multi-dim, multi-line, persistence). Option A (extend `NANDA_DynDisc`) only covers P01–P02 and is skippable if we start V6 directly.

---

# PART 7 — OPEN ITEMS TO VERIFY BEFORE WRITING CODE (Rule 2 / Rule 8)

1. **Read before seed scripts:** ERPNext `Opportunity` header full field list; `Item` + `Item Price` + `Pricing Rule` exact fields; `Incoterm`, `Shipping Rule` shape. (Not read this session.)
2. **`DynDiscProject6` current contents** — confirm what's already there before laying down `IMPL-V6` (only confirmed the dir exists).
3. **`erpnextEnh1` does not exist** — must be created.
4. **ERPNext instance target** — Frappe Cloud vs self-hosted `frappe_docker` (affects custom-app install path). Decide before ITER2.
5. **LangGraph Store persistence** — confirm a SQLite/Postgres-backed Store impl in LangGraph.js, else build a thin `BaseStore` adapter (flag `MEMORY_STORE_KIND` already reserved).
6. **`@langchain/google-genai` `GoogleGenerativeAIEmbeddings`** class name — verify on install.
7. **Quotation amend semantics on ERPNext** — confirm the cancel→amend flow is acceptable for in-negotiation revisions, or keep negotiation rounds in T2 and only write the *final* Quotation (simpler; recommended for the demo).
8. **NEST permits SQLite writes** alongside audit DB — assume yes (NANDA_DynDisc writes); confirm on first deploy.

*End of design.*
