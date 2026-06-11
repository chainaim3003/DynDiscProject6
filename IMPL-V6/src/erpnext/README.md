# Local ERPNext setup (system-of-record for IMPL-V6)

This is the procedure to stand up the **ERPNext instance that this agent talks to**. The
client in this folder (`client.ts`) speaks the Frappe REST dialect (`token <key>:<secret>`
auth, `/api/resource` CRUD, `/api/method` calls) against `ERPNEXT_URL` (default
`http://localhost:8080`). Nothing here runs unless that instance exists, is reachable, has
the agent's custom fields installed, and has master data + demo stock seeded.

All paths below are grounded in the repo as checked out under
`...\FINAGENTS\FINAGENTS1\`:

```
FINAGENTS1\
  frappe_docker\                      # upstream frappe_docker (brings ERPNext up)
    pwd.yml                           # single-file quick-start (ERPNext v16.21.1, port 8080)
  erpnextEnh1\                        # the agent's ERPNext customization + seed layer
    apps\chainaim_proc\               # Frappe app: 38 Custom Fields on Opportunity/Quotation (+items)
    seed\                             # numbered REST seeds (00..04, verify)
  DynDiscProject6\IMPL-V6\.env        # the creds/flags the seeds AND the agent both read
```

> **Why this order matters:** the agent runs with `INVENTORY_MODE=real` and
> `CREDIT_MODE=real`, so quoting reads ERPNext `Item Price`/`Bin` and persist writes
> `Opportunity`/`Quotation` with custom fields. If masters, items, custom fields, or bins
> are missing, the agent **fails loud** (it never fabricates data) — so seed everything
> first.

---

## Prerequisites

- **Docker Desktop** running (the quick-start is multi-container).
- **Python 3** with `requests` (`pip install requests`) — the seeds are REST scripts.
- The IMPL-V6 `.env` filled in (you'll add the API key/secret in Step 3).

---

## Step 1 — Bring up ERPNext (frappe_docker quick-start)

From `FINAGENTS1\frappe_docker`:

```bash
docker compose -f pwd.yml up -d
```

This starts MariaDB, Redis, the Frappe/ERPNext backend, workers, and an nginx `frontend`
published on **host port 8080** (`pwd.yml` → `frontend.ports: "8080:8080"`). A one-shot
`create-site` container runs `bench new-site … --install-app erpnext --set-default frontend`
with admin password `admin`.

**Expected result:** after ~2–5 min, `docker compose -f pwd.yml ps` shows the services up,
and `http://localhost:8080` loads the ERPNext login. Site creation takes a while on first
run — watch it with `docker compose -f pwd.yml logs -f create-site` until it finishes.

> This matches `ERPNEXT_URL=http://localhost:8080` in IMPL-V6/.env, and the IMPL-V6
> container reaches it via `host.docker.internal:8080` (see `docker/docker-compose.yml`).

---

## Step 2 — Complete the setup wizard (Company must match `.env`)

Log in at `http://localhost:8080` as **Administrator / admin** and complete the first-run
setup wizard. The values you pick here must match IMPL-V6/.env, because the seeds and the
agent assume them:

| Wizard field | Value | Why |
|---|---|---|
| Company Name | `Jupiter Knitting Company` | `ERPNEXT_COMPANY` in `.env` |
| Company Abbreviation | `JKC` | Warehouse is named `MADRAS-WH-1 - JKC` (`ERPNEXT_DEFAULT_WAREHOUSE`) |
| Country | `India` | INR + GST 18% context |
| Currency | `INR` | `ERPNEXT_CURRENCY` |

**Expected result:** the ERPNext desk loads, and `Jupiter Knitting Company` (abbr `JKC`)
exists under Accounting → Company.

> The abbreviation **must** be `JKC` — `00-bootstrap-masters.py` names the warehouse
> `"<warehouse_name> - <company abbr>"`, and `.env` expects `MADRAS-WH-1 - JKC`. A
> different abbr breaks the inventory (Bin) lookups.

---

## Step 3 — Generate an API key/secret and put them in `.env`

The agent and the seeds authenticate with a Frappe API token (`token <key>:<secret>`), not a
password. Generate one for the user the agent will act as (Administrator is fine for local):

1. In ERPNext, open the **Administrator** user record (search "User", open Administrator).
2. Scroll to the **API Access** section → **Generate Keys**.
3. Copy the **API Key** and the **API Secret** (the secret is shown **once**).

Put them in `DynDiscProject6\IMPL-V6\.env`:

```
ERPNEXT_URL=http://localhost:8080
ERPNEXT_API_KEY=<api key from step 3>
ERPNEXT_API_SECRET=<api secret from step 3>
ERPNEXT_COMPANY=Jupiter Knitting Company
ERPNEXT_CURRENCY=INR
ERPNEXT_DEFAULT_WAREHOUSE=MADRAS-WH-1 - JKC
```

**Verify the token works** (this is the exact gate the client's `whoami()` uses):

```bash
curl -s http://localhost:8080/api/method/frappe.auth.get_logged_user \
  -H "Authorization: token <ERPNEXT_API_KEY>:<ERPNEXT_API_SECRET>"
```

**Expected result:** `{"message":"Administrator"}`. A `401/403` or HTML page means the
key/secret is wrong or not yet generated.

---

## Step 4 — Install the agent's Custom Fields (38)

The agent writes `custom_*` fields on `Opportunity`/`Quotation` (and their item rows) and
dedupes Opportunities on `custom_inquiry_id`. Install them via the REST seed (no bench
needed). From `FINAGENTS1\erpnextEnh1\seed`:

```bash
# dry run first — prints what it would create, calls nothing destructive
python 02-install-custom-fields.py --env-file ../../DynDiscProject6/IMPL-V6/.env --dry-run --verbose

# real install
python 02-install-custom-fields.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose
```

**Expected result:** the summary reports the 38 Custom Fields created (14 Opportunity, 6
Opportunity Item, 11 Quotation, 7 Quotation Item — per `chainaim_proc/custom/*.json`). Re-running
is idempotent (existing fields are skipped; use `--update` to replace).

---

## Step 5 — Seed master data, items, webhooks, and demo stock

Run the numbered seeds **in order**, all pointed at the same `.env`. From
`FINAGENTS1\erpnextEnh1\seed`:

```bash
# 0) Masters: Selling Settings, UOM, Brand, Warehouse MADRAS-WH-1,
#    Item Attribute "Size" (S/M/L/XL), Payment Terms (Net 0/30/60),
#    Customer "Tommy Hilfiger Europe B.V.", Incoterms.
python 00-bootstrap-masters.py --env-file ../../DynDiscProject6/IMPL-V6/.env --company "Jupiter Knitting Company" --verbose

# 1) Items + size variants (e.g. TH-TEE-RN-180-M) and their selling Item Prices.
python 01-seed-items-variants.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose

# 3) Webhooks (event wiring on ERPNext side).
python 03-install-webhooks.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose

# 4) Demo Bin stock so ATP / availability checks (INVENTORY_MODE=real) return real numbers.
python 04-seed-demo-bins.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose
```

Every seed accepts `--dry-run` (preview), `--update` (replace existing), `--verbose`, and
`--timeout`. Run a `--dry-run` first if you want to see actions before they hit ERPNext.

**Expected result:** each script prints a summary with a non-error exit; the warehouse
`MADRAS-WH-1 - JKC`, the Tommy Hilfiger customer, the variant items with selling prices,
and demo bins all exist in ERPNext.

> **GST note (grounded in `00-bootstrap-masters.py`):** ERPNext India GST tax templates come
> from the separate `india_compliance` app, which is **not** installed here. So GST is **not**
> seeded as an ERPNext tax template — `GST_RATE=18` in `.env` is applied by the agent's own
> pricing, not by ERPNext. The seed's `--with-gst` is an explicit placeholder and will raise;
> leave it off.

---

## Step 6 — Verify the instance is agent-ready

```bash
# A) erpnextEnh1's own V6.1 exit-criteria check:
cd FINAGENTS1/erpnextEnh1/seed
python verify-v61-exit.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose

# B) From IMPL-V6 — confirm the custom fields the agent needs are present:
cd ../../DynDiscProject6/IMPL-V6
npx tsx scripts/check-erpnext-custom-fields.ts

# C) End-to-end smoke (live GLEIF + ERPNext): runs the saga and writes an Opportunity.
npx tsx scripts/smoke-saga.ts
```

**Expected result:** (A) and (B) report all required masters/fields present; (C) completes
the saga and creates an ERPNext `Opportunity` (and, on a deal, a `Quotation`). Because
`IDEMPOTENT_WRITES=on` (default), re-running the same `negotiationId` will **not** create
duplicate docs.

---

## Optional — bench install instead of REST seeds (parity path)

If you run a real Frappe bench, you can install the customizations as an app instead of
POSTing them, and the same 38 Custom Fields load on migrate (from `hooks.py` `fixtures`):

```bash
bench get-app /path/to/FINAGENTS1/erpnextEnh1/apps/chainaim_proc
bench --site <site> install-app chainaim_proc
bench --site <site> migrate
```

You still run the `00/01/03/04` seeds for master data, items, webhooks, and bins.

---

## Teardown / reset

```bash
cd FINAGENTS1/frappe_docker
docker compose -f pwd.yml down          # stop, keep data volumes
docker compose -f pwd.yml down -v       # stop AND wipe volumes (full reset → re-run from Step 1)
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `whoami` returns 401/403 | API key/secret wrong or not generated | redo Step 3; regenerate keys |
| `whoami` returns HTML, not JSON | hitting the desk, not the API; wrong URL/port | confirm `http://localhost:8080`, site is up |
| Agent: "ERPNext API key/secret not resolved" | `.env` blank or not loaded | fill `ERPNEXT_API_KEY`/`SECRET` in IMPL-V6/.env |
| Bin / availability empty | demo bins not seeded, or wrong warehouse abbr | re-run `04-seed-demo-bins.py`; confirm warehouse is `MADRAS-WH-1 - JKC` |
| Quote can't price an Item | items/Item Prices not seeded | re-run `01-seed-items-variants.py` |
| Persist fails on unknown `custom_*` field | custom fields not installed | re-run `02-install-custom-fields.py` |
| Site creation hangs | first-run image pull + migrate is slow | `docker compose -f pwd.yml logs -f create-site` and wait |
