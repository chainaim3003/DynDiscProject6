# IMPL-V6 — Inquiry & Quote Schemas in ERPNext

> Schemas grounded in the actual ERPNext DocType JSON read this session — not from memory.
> Sources verified: `erpnext/erpnext/crm/doctype/opportunity/opportunity.json`, `.../opportunity_item/opportunity_item.json`, `erpnext/erpnext/selling/doctype/quotation/quotation.json`, `.../quotation_item/quotation_item.json`, `erpnext/erpnext/accounts/doctype/payment_schedule/payment_schedule.json`, `erpnext/erpnext/stock/doctype/item_variant_attribute/item_variant_attribute.json`.
> Reuse principle: **use native fields wherever they exist; add Custom Fields (`erpnextEnh1`) only for what's genuinely missing** — agent/OOR identity and a few multi-dimensional inquiry knobs.

---

## 1. INQUIRY SCHEMA

**Parent DocType:** `Opportunity` (CRM module, naming `CRM-OPP-.YYYY.-`).
**Child table:** `Opportunity Item` (one row per requested line).
**Why Opportunity:** it's ERPNext's native inbound-inquiry record; it already links to the seller-side `Quotation` via the Quotation's native `opportunity` field, so the inquiry→quote join is free.

### 1.1 Opportunity (header) — native fields used

| Field (native) | Type | What we put in it | Populated for |
|---|---|---|---|
| `naming_series` | Select | `CRM-OPP-.YYYY.-` → `CRM-OPP-2026-#####` | all |
| `opportunity_from` | Link → DocType | `Customer` | all |
| `party_name` | Dynamic Link | `Tommy Hilfiger Europe B.V.` (Customer name) | all |
| `customer_name` | Data | resolved | all |
| `status` | Select | `Open` at intake | all |
| `opportunity_type` | Link → Opportunity Type | `Sales` | all |
| `transaction_date` | Date | inquiry receipt date | all |
| `company` | Link → Company | `Jupiter Knitting Company` | all |
| `currency` | Link → Currency | `INR` | all |
| `conversion_rate` | Float | `1` | all |
| `expected_closing` | Date | = buyer's required delivery date | all |
| `opportunity_amount` | Currency | seller's first-pass total estimate | all |
| `customer_address` / `address_display` | Link / Text | Tommy's billing address (default) | all |
| `contact_person` / `contact_email` | Link / Data | Tommy contact | all |
| `country` / `territory` | Link / Link | derived from buyer | all |
| `items` | Table → Opportunity Item | the requested lines | all |
| `total` / `base_total` | Currency | computed | all |

### 1.2 Opportunity Item (child) — native fields used

| Field (native) | Type | What we put in it |
|---|---|---|
| `item_code` | Link → Item | variant code, e.g. `TH-TEE-RN-180-M` (one row per size) |
| `item_name` | Data | resolved |
| `description` | Text Editor | resolved |
| `uom` | Link → UOM | `Nos` |
| `qty` | Float | requested quantity for that line |
| `rate` | Currency | buyer's target rate if disclosed; else 0 |
| `amount` | Currency | qty × rate |
| `item_group` / `brand` | Link / Link | resolved |

### 1.3 Custom fields to ADD (erpnextEnh1) — Opportunity

Required because native Opportunity lacks: agent identity, the delivery destination *distinct* from the buyer's billing address, Incoterm, payment-term request, negotiation params, audit linkage.

| Custom field | Type | Holds | Populated for prompts |
|---|---|---|---|
| `custom_inquiry_id` | Data | `negotiationId` (saga thread id; joins T2/T5) | all |
| `custom_buyer_lei` | Data | `54930012QJWZMYHNJW95` | all |
| `custom_buyer_agent` | Data | `tommyBuyerAgent` | all |
| `custom_buyer_oor` | Data | `Tommy_Chief_Procurement_Officer` | P05, P08, P10 |
| `custom_required_delivery_date` | Date | header-level required date (also mirrored to `expected_closing`) | all |
| `custom_delivery_destination` | Data | e.g. `Rotterdam, NL`, `Hamburg, DE` | all |
| `custom_incoterm_requested` | Link → Incoterm | requested Incoterm if specified | when stated |
| `custom_payment_term_requested` | Link → Payment Term | `Net-0` / `Net-30` / `Net-60` | P01–P10 |
| `custom_compare_terms_requested` | Long Text (JSON array) | e.g. `["Net-0","Net-30"]` for compare-mode | P02 |
| `custom_target_basket_json` | Long Text | per-style target rates, e.g. `{"TH-TEE-RN-180":300,"TH-POLO-PIQ-220":520}` | P07, P08, P09, P10 |
| `custom_max_negotiation_rounds` | Int | 0 (firm) / 1 / 2 / 3 | P07 (1), P08 (3), P09 (2), P10 (3) |
| `custom_demand_aware` | Check | `1` if buyer asked us to consider our order book | P09, P10 |
| `custom_dd_required` | Check | `1` if buyer asked seller to run DD on itself | P05, P08, P10 |
| `custom_inquiry_dimensions_json` | Long Text | verbatim parsed inquiry JSON snapshot (audit-safe) | all |

### 1.4 Custom fields — Opportunity Item (per line)

| Custom field | Type | Holds |
|---|---|---|
| `custom_size` | Data | size label (`S`/`M`/`L`/`XL`) — convenience copy when needed |
| `custom_required_delivery_date` | Date | per-line date when basket lines have different dates |
| `custom_destination` | Data | per-line destination (e.g. P04: tees → Rotterdam, polos → Hamburg) |
| `custom_target_rate` | Currency | per-line target if buyer stated one |
| `custom_canFulfill` | Check | feasibility result from Inventory consult (written by agent) |
| `custom_earliest_ship_date` | Date | per-line earliest credible ship date (written by agent) |

### 1.5 Sizes: native variants, no custom doctype

Size split → **one Opportunity Item row per size**, each pointing at the **variant Item** code:

- Template Item `TH-TEE-RN-180` (`has_variants = 1`)
- Item Attribute `Size` with values `S, M, L, XL`
- Variant Items `TH-TEE-RN-180-S`, `TH-TEE-RN-180-M`, `TH-TEE-RN-180-L`, `TH-TEE-RN-180-XL` — each linked back to the template via `Item Variant Attribute` (`variant_of` = template, `attribute` = `Size`, `attribute_value` = `M` etc.).

Same model for `TH-POLO-PIQ-220-*` and `TH-HOOD-FLC-320-*`.

### 1.6 Example REST payload — P04 inquiry

```json
POST /api/resource/Opportunity
{
  "opportunity_from": "Customer",
  "party_name": "Tommy Hilfiger Europe B.V.",
  "status": "Open",
  "opportunity_type": "Sales",
  "transaction_date": "2026-06-07",
  "company": "Jupiter Knitting Company",
  "currency": "INR",
  "expected_closing": "2026-09-30",
  "custom_inquiry_id": "NEG-1780500000001",
  "custom_buyer_lei": "54930012QJWZMYHNJW95",
  "custom_buyer_agent": "tommyBuyerAgent",
  "custom_required_delivery_date": "2026-09-30",
  "custom_delivery_destination": "Rotterdam, NL",
  "custom_payment_term_requested": "Net-30",
  "custom_max_negotiation_rounds": 0,
  "custom_dd_required": 0,
  "items": [
    { "item_code": "TH-TEE-RN-180-S",  "uom": "Nos", "qty": 1000, "custom_size": "S", "custom_destination": "Rotterdam, NL" },
    { "item_code": "TH-TEE-RN-180-M",  "uom": "Nos", "qty": 2000, "custom_size": "M", "custom_destination": "Rotterdam, NL" },
    { "item_code": "TH-TEE-RN-180-L",  "uom": "Nos", "qty": 1500, "custom_size": "L", "custom_destination": "Rotterdam, NL" },
    { "item_code": "TH-TEE-RN-180-XL", "uom": "Nos", "qty":  500, "custom_size": "XL","custom_destination": "Rotterdam, NL" },
    { "item_code": "TH-POLO-PIQ-220-S",  "uom": "Nos", "qty": 400, "custom_size": "S", "custom_destination": "Hamburg, DE" },
    { "item_code": "TH-POLO-PIQ-220-M",  "uom": "Nos", "qty": 800, "custom_size": "M", "custom_destination": "Hamburg, DE" },
    { "item_code": "TH-POLO-PIQ-220-L",  "uom": "Nos", "qty": 600, "custom_size": "L", "custom_destination": "Hamburg, DE" },
    { "item_code": "TH-POLO-PIQ-220-XL", "uom": "Nos", "qty": 200, "custom_size": "XL","custom_destination": "Hamburg, DE" }
  ]
}
```

---

## 2. QUOTE SCHEMA

**Parent DocType:** `Quotation` (Selling module, naming `SAL-QTN-.YYYY.-`, **`is_submittable: 1`** — meaning quotes are submittable documents with a formal lifecycle).
**Child table:** `Quotation Item` (one row per quoted line — sizes expand here too).
**Link back to inquiry:** native `Quotation.opportunity` (Link → Opportunity) + per-line `prevdoc_doctype`/`prevdoc_docname`.
**Revision:** **native `amended_from` chain** (Link → Quotation) + `is_submittable`. Cancel + amend creates a new doc with suffixed name (`SAL-QTN-2026-00001` → `…-00001-1` → `…-00001-2`), preserving the chain. **No custom revision mechanism needed.**

### 2.1 Quotation (header) — native fields used

| Field (native) | Type | What we put in it | Populated for |
|---|---|---|---|
| `naming_series` | Select | `SAL-QTN-.YYYY.-` | all |
| `quotation_to` | Link → DocType | `Customer` | all |
| `party_name` | Dynamic Link | `Tommy Hilfiger Europe B.V.` | all |
| `customer_name` | Data | resolved | all |
| `transaction_date` | Date | quote issue date | all |
| `valid_till` | Date | issue + N days (configurable) | all |
| `order_type` | Select | `Sales` | all |
| `company` | Link → Company | `Jupiter Knitting Company` | all |
| `currency` | Link → Currency | `INR` | all |
| `selling_price_list` | Link → Price List | `Jupiter Standard - INR` | all |
| `items` | Table → Quotation Item | priced lines | all |
| `incoterm` | Link → Incoterm | e.g. `FOB` / `CIF` | all |
| `named_place` | Data | e.g. `Rotterdam` / `Chennai` | all |
| `taxes` | Table → Sales Taxes and Charges | GST 18% row | all |
| `taxes_and_charges` | Link → Tax Template | `India GST 18%` | all |
| `payment_terms_template` | Link → Payment Terms Template | `Net-0` / `Net-30` / `Net-60` | all |
| `payment_schedule` | Table → Payment Schedule | **1 row, `invoice_portion = 100`** | all |
| `tc_name` / `terms` | Link / Text Editor | T&C text | all |
| `total_qty`, `net_total`, `total_taxes_and_charges`, `grand_total`, `rounded_total`, `in_words` | Currency / Float | computed | all |
| `status` | Select | `Draft` → `Open`/`Replied` → `Ordered`/`Lost`/`Expired` | all |
| `opportunity` | Link → Opportunity | the inquiry this quote answers | all |
| **`amended_from`** | Link → Quotation | **revision chain** (set automatically on amend) | P09, P10 |
| `creation` / `modified` (Frappe base) | Datetime | native issue/modify timestamps | all |
| `owner` / `modified_by` (Frappe base) | Data | API user that posted it | all |

### 2.2 Quotation Item (child) — native fields used

| Field (native) | Type | What we put in it |
|---|---|---|
| `item_code` | Link → Item | variant code (e.g. `TH-TEE-RN-180-M`) |
| `item_name` | Data | resolved |
| `description` | Text Editor | resolved |
| `uom` | Link → UOM | `Nos` |
| `qty` | Float | quoted qty for that line |
| `rate` | Currency | quoted unit rate |
| `amount` | Currency | qty × rate |
| `warehouse` | Link → Warehouse | source warehouse (`MADRAS-WH-1`) |
| `item_tax_template` | Link → Item Tax Template | per-line tax override (rare) |
| `customer_item_code` | Data | buyer's SKU if disclosed |
| **`prevdoc_doctype`** | Data | `"Opportunity"` |
| **`prevdoc_docname`** | Data | the Opportunity name |

### 2.3 Custom fields to ADD (erpnextEnh1) — Quotation

The user's explicit ask: "*revision, timestamp, who quoted — jupiter seller agent and their OOR*." Revision and timestamp are **already native**. Only **agent/OOR identity** needs custom fields:

| Custom field | Type | Holds | Source |
|---|---|---|---|
| `custom_quoted_by_agent` | Data | `jupiterSellerAgent` | agent card |
| `custom_quoted_by_oor` | Data | `Jupiter_Chief_Sales_Officer` | agent card `vLEImetadata.oorHolderName` |
| `custom_seller_lei` | Data | `3358004DXAMRWRUIYJ05` | agent card |
| `custom_seller_agent_aid` | Data | `EOZN-bHzYFTcmDsjGtdcthVEidqHkz8KAomhKLmZlDHc` | agent card `keriIdentifiers.agentAID` |
| `custom_seller_oor_aid` | Data | `EOvdixBXJx2n6hNT-t7o-P0HMMUPuBeZMLR7qhsOd6El` | agent card `keriIdentifiers.oorHolderAID` |
| `custom_quote_revision` | Int | friendly counter R1/R2/R3 (parallel to `amended_from` chain) | saga round |
| `custom_quoted_at` | Datetime | agent-stamped ISO issue time | orchestrator |
| `custom_credential_mode` | Select(`plain`,`vlei`) | `plain` for these 10; `vlei` from ITER7 | flag `CREDENTIAL_MODE` |
| `custom_signed_envelope_hash` | Data | sha256 envelope hash of the issued quote (joins T5 audit) | `PlainHashSigner` |
| `custom_negotiation_id` | Data | saga `negotiationId` (joins T2/T5/Opportunity) | orchestrator |
| `custom_actus_sim_id` | Data | ACTUS PAM sim id behind the price | treasury consult (P02, P05, P07, P08, P10) |

### 2.4 Custom fields — Quotation Item (per line)

| Custom field | Type | Holds | Populated for |
|---|---|---|---|
| `custom_size` | Data | size label (convenience copy) | P01–P10 |
| `custom_destination` | Data | per-line destination (multi-destination basket) | P04, P10 |
| `custom_required_delivery_date` | Date | per-line date (multi-date basket) | P06 |
| `custom_promised_ship_date` | Date | seller's commit date for this line | P03, P06, P10 |
| `custom_split_index` | Int | 1, 2, … for split-shipment lines under one logical line | P06, P10 |
| `custom_canFulfill` | Check | from Inventory consult | P03, P06, P10 |
| `custom_lead_time_days` | Int | from Inventory consult | P03, P06, P10 |

### 2.5 Revision lifecycle (native, no custom logic)

Each negotiation round that produces a *new* offer from the seller commits a revision **using native ERPNext semantics**:

1. First quote → `Quotation` `SAL-QTN-2026-00001`, `Submit` → `status = Open`, `custom_quote_revision = 1`.
2. Buyer rejects/counters → seller `Cancel` the doc, then `Amend` → creates `SAL-QTN-2026-00001-1` with `amended_from = SAL-QTN-2026-00001`, `custom_quote_revision = 2`.
3. Repeat for R3 if needed.
4. On agreement → final revision stays `status = Open` (will move to `Ordered` when the Sales Order is raised).

**Alternative (simpler for demo):** keep all intra-negotiation rounds in T2 saga only; only the **final** agreed quote is written to ERPNext (one Quotation, `custom_quote_revision = N` where N = final round number). This avoids the cancel-amend churn. P10 explicitly demands persistence of the **final** quote — both options satisfy that. **Default: simpler option (final-only persistence). Flag `QUOTE_PERSIST_MODE = final | every-round`.**

### 2.6 Single one-time payment — exact Payment Schedule shape

For every quote, `payment_schedule` is **one row at 100%**. Examples:

```jsonc
// Net-0 (prepaid)
[{ "payment_term": "Net-0",  "invoice_portion": 100, "credit_days": 0,  "due_date": "<transaction_date>" }]

// Net-30
[{ "payment_term": "Net-30", "invoice_portion": 100, "credit_days": 30, "due_date": "<transaction_date + 30d>" }]

// Net-60
[{ "payment_term": "Net-60", "invoice_portion": 100, "credit_days": 60, "due_date": "<transaction_date + 60d>" }]
```

Seed (`erpnextEnh1/seed/00-bootstrap-masters`) creates the corresponding `Payment Term` and `Payment Terms Template` rows.

### 2.7 Example REST payload — P10 final persisted quote (skeleton)

```json
POST /api/resource/Quotation
{
  "quotation_to": "Customer",
  "party_name": "Tommy Hilfiger Europe B.V.",
  "company": "Jupiter Knitting Company",
  "currency": "INR",
  "selling_price_list": "Jupiter Standard - INR",
  "transaction_date": "2026-06-07",
  "valid_till": "2026-07-07",
  "order_type": "Sales",
  "opportunity": "CRM-OPP-2026-00042",
  "incoterm": "CIF",
  "named_place": "Rotterdam",
  "taxes_and_charges": "India GST 18%",
  "payment_terms_template": "Net-30",
  "tc_name": "Jupiter Standard T&C v3",

  "custom_quoted_by_agent": "jupiterSellerAgent",
  "custom_quoted_by_oor":   "Jupiter_Chief_Sales_Officer",
  "custom_seller_lei":      "3358004DXAMRWRUIYJ05",
  "custom_seller_agent_aid":"EOZN-bHzYFTcmDsjGtdcthVEidqHkz8KAomhKLmZlDHc",
  "custom_seller_oor_aid":  "EOvdixBXJx2n6hNT-t7o-P0HMMUPuBeZMLR7qhsOd6El",
  "custom_quote_revision": 3,
  "custom_quoted_at": "2026-06-07T11:42:17Z",
  "custom_credential_mode": "plain",
  "custom_signed_envelope_hash": "sha256:8b3c1f…",
  "custom_negotiation_id": "NEG-1780500000001",
  "custom_actus_sim_id": "ACTUS-PAM-2026-06-07-00073",

  "items": [
    { "item_code": "TH-TEE-RN-180-S",  "uom":"Nos", "qty": 3000, "rate": 300, "warehouse":"MADRAS-WH-1",
      "prevdoc_doctype":"Opportunity", "prevdoc_docname":"CRM-OPP-2026-00042",
      "custom_size":"S", "custom_destination":"Rotterdam, NL", "custom_promised_ship_date":"2026-09-15", "custom_canFulfill":1 },
    { "item_code": "TH-TEE-RN-180-M",  "uom":"Nos", "qty": 6000, "rate": 300, "warehouse":"MADRAS-WH-1",
      "prevdoc_doctype":"Opportunity", "prevdoc_docname":"CRM-OPP-2026-00042",
      "custom_size":"M", "custom_destination":"Rotterdam, NL", "custom_promised_ship_date":"2026-09-22", "custom_canFulfill":1 }
    // … L, XL, polos, hoodies
  ],

  "payment_schedule": [
    { "payment_term":"Net-30", "invoice_portion":100, "credit_days":30, "due_date":"2026-07-07" }
  ]
}
```

---

## 3. Inquiry/Quote field coverage across the 10 prompts

| Capability needed | Inquiry holds it in… | Quote holds it in… |
|---|---|---|
| Buyer identity (LEI) | `custom_buyer_lei` | (mirrored in audit; not on Quotation) |
| Seller identity (agent + OOR + LEI + AIDs) | — | `custom_quoted_by_agent`, `custom_quoted_by_oor`, `custom_seller_lei`, `custom_seller_agent_aid`, `custom_seller_oor_aid` |
| Items + sizes | `items[]` with variant `item_code` | `items[]` with variant `item_code` |
| Quantities | `items[].qty` | `items[].qty` |
| Required delivery date | `expected_closing` + `custom_required_delivery_date` (header); `custom_required_delivery_date` (line) | `valid_till`, `custom_promised_ship_date` (line) |
| Destination(s) | `custom_delivery_destination` (header), `custom_destination` (line) | `named_place` + `custom_destination` (line) |
| Incoterm | `custom_incoterm_requested` | `incoterm` (native) |
| Single payment term | `custom_payment_term_requested` | `payment_terms_template` + `payment_schedule[0]` (`invoice_portion=100`) |
| Compare prepaid vs Net-30 (P02) | `custom_compare_terms_requested = ["Net-0","Net-30"]` | two `Quotation` drafts (one per term) |
| Target prices (P07–P10) | `custom_target_basket_json`, `custom_target_rate` (line) | (no quote field — captured in audit and used by tactics engine) |
| Negotiation rounds | `custom_max_negotiation_rounds` | revisions via `amended_from` chain + `custom_quote_revision` |
| Demand-aware (P09) | `custom_demand_aware = 1` | — (affects pricing/feasibility, not a stored field) |
| DD-driven term (P05, P08, P10) | `custom_dd_required = 1` | `payment_terms_template` reflects the term DD allowed |
| Split shipment (P06, P10) | (none on inquiry) | per-line `custom_split_index`, `custom_promised_ship_date`, `custom_canFulfill` |
| Revision number | — | **`amended_from`** (native chain) + `custom_quote_revision` |
| Timestamp | `transaction_date`, native `creation` | `transaction_date`, native `creation`, `custom_quoted_at` |
| ACTUS audit linkage | — | `custom_actus_sim_id`, `custom_signed_envelope_hash`, `custom_negotiation_id` |

---

## 4. What still needs verification before generating the Custom Field fixtures

(per Rule 3 — these I have **not** read this session):

1. **`Item` DocType field list** — to confirm `has_variants`, `variant_of`, `lead_time_days`, `safety_stock` are present in this ERPNext version (continuation-prompt §10 notes version-dependence).
2. **`Item Price` and `Pricing Rule`** — to express quantity-break pricing for P02/P03's volume.
3. **`Incoterm` doctype** — confirm options match (FOB, CIF, EXW, DAP, …).
4. **`Shipping Rule` vs adding freight as a `Sales Taxes and Charges` line** — pick one pattern for the freight line in the quote.
5. **`Payment Term`** — confirm the doctype has the fields needed to seed `Net-0`/`Net-30`/`Net-60`.

These reads belong with the `erpnextEnh1/seed/` script work — not blocking the Custom Field design above.

*End of schemas.*
