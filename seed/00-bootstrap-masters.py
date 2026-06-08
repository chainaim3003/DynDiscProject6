#!/usr/bin/env python3
"""
00-bootstrap-masters.py  --  erpnextEnh1 master-data bootstrap (REST-only)

Creates the foundational master records the rest of the V6.1 seeds and the V6.3+
quoting flow depend on, into a running ERPNext instance via the REST API.
Idempotent: existing records are skipped (or replaced with --update). No bench
required. Same scaffold/auth/precedence as 02-install-custom-fields.py.

What it ensures (in dependency order):
  1. Selling Settings.cust_master_name = "Customer Name"  (so Customer docs are
     named by customer_name -> GET /api/resource/Customer/<name> resolves).
  2. UOM            "Nos"                       (usually preexists; idempotent).
  3. Brand          (default "Tommy Hilfiger").
  4. Warehouse      "MADRAS-WH-1" under --company (named "<name> - <abbr>").
  5. Item Attribute "Size" with values S,M,L,XL (abbr == value, so variant item
     codes resolve to e.g. TH-TEE-RN-180-M -- consumed by 01-seed-items-variants).
  6. Payment Term   "Net 0","Net 30","Net 60"  (invoice_portion=100, credit_days=N).
  7. Payment Terms Template wrapping each Payment Term.
  8. Customer       "Tommy Hilfiger Europe B.V." (NO LEI field -- see note below).
  9. Incoterm       FOB,CIF,EXW,DAP             (ensure standard codes exist).
 10. GST 18%        -- PLACEHOLDER behind --with-gst (NOT implemented; see below).

NOTE on buyer LEI (resolved 2026-06-08 against the authoritative schema):
  Customer has NO native LEI field, and DESIGN_6/03 sec 1.3 defines `custom_buyer_lei`
  on **Opportunity**, not Customer. So this script deliberately does NOT put an LEI on
  the Customer. The buyer LEI rides on each Opportunity via the already-installed
  Custom Field. (DESIGN_6/07 V6.1 exit criterion was amended to match.)

NOTE on GST (--with-gst):
  In erpnext v16 the India GST tax templates / output GST accounts are provided by the
  separate `india_compliance` app, which is NOT installed on this instance (frappe +
  erpnext only). The exact GST output-account names and tax-template DocType shapes
  cannot be asserted from official source without that app, so `ensure_gst_18()` is an
  explicit PLACEHOLDER and raises unless the real implementation is wired. It stands in
  for: create/verify a "Sales Taxes and Charges Template" (or "Item Tax Template")
  applying 18% output GST, grounded in the india_compliance DocTypes once confirmed.
  GST is NOT a V6.1 exit criterion (it is exercised in V6.3), so default is OFF.

Grounding (official sources, verified from frappe/erpnext@develop -- the v16 line):
  - Selling Settings.cust_master_name : Select default "Customer Name"
        erpnext/selling/doctype/selling_settings/selling_settings.json
  - UOM autoname field:uom_name        erpnext/setup/doctype/uom/uom.json
  - Brand autoname field:brand         erpnext/setup/doctype/brand/brand.json
  - Warehouse: warehouse_name+company reqd; doc named "<warehouse_name> - <company abbr>"
        erpnext/stock/doctype/warehouse/warehouse.json
  - Item Attribute autoname field:attribute_name; child "Item Attribute Value"
    requires attribute_value + abbr
        erpnext/stock/doctype/item_attribute/item_attribute.json
        erpnext/stock/doctype/item_attribute_value/item_attribute_value.json
  - Payment Term autoname field:payment_term_name; due_date_based_on Select option
    literal "Day(s) after invoice date"; invoice_portion Float; credit_days Int
        erpnext/accounts/doctype/payment_term/payment_term.json
  - Payment Terms Template autoname field:template_name; terms child = "Payment Terms
    Template Detail" (due_date_based_on reqd, invoice_portion reqd, payment_term link,
    credit_days)
        erpnext/accounts/doctype/payment_terms_template/payment_terms_template.json
        erpnext/accounts/doctype/payment_terms_template_detail/payment_terms_template_detail.json
  - Customer autoname naming_series, overridden by Selling Settings to customer_name;
    customer_type Select reqd; customer_group / territory Links
        erpnext/selling/doctype/customer/customer.json
  - Incoterm autoname field:code; code + title reqd
        erpnext/setup/doctype/incoterm/incoterm.json
  - Token auth + /api/resource CRUD: docs.frappe.io/framework/user/en/api/rest

Requires: requests  (pip install requests)

Examples:
  # Dry run against creds in IMPL-V6/.env:
  python 00-bootstrap-masters.py --env-file ../../DynDiscProject6/IMPL-V6/.env --dry-run --verbose

  # Real bootstrap with defaults:
  python 00-bootstrap-masters.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose

  # Custom company + warehouse, no Incoterm ensure:
  python 00-bootstrap-masters.py --company "Jupiter Knitting Company" \
         --warehouse-name MADRAS-WH-1 --ensure-incoterms ""
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("FATAL: 'requests' is required. Install with: pip install requests")


# --------------------------------------------------------------------------- #
# config / env (identical precedence to 02-install-custom-fields.py)
# --------------------------------------------------------------------------- #
def log(verbose: bool, *a):
    if verbose:
        print(*a)


def parse_env_file(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        if "#" in val and not (raw.split("=", 1)[1].strip().startswith(("'", '"'))):
            val = val.split("#", 1)[0].strip()
        env[key] = val
    return env


def resolve_config(args) -> dict:
    """Precedence: explicit CLI flag > --env-file > OS environment."""
    file_env = parse_env_file(Path(args.env_file)) if args.env_file else {}

    def pick(cli_val, env_key, default=None):
        if cli_val is not None:
            return cli_val
        if env_key in file_env and file_env[env_key]:
            return file_env[env_key]
        return os.environ.get(env_key, default)

    url = pick(args.url, "ERPNEXT_URL", "http://localhost:8080")
    key = pick(args.api_key, "ERPNEXT_API_KEY")
    secret = pick(args.api_secret, "ERPNEXT_API_SECRET")
    return {"url": (url or "").rstrip("/"), "key": key, "secret": secret}


# --------------------------------------------------------------------------- #
# generic REST client (works for any DocType, unlike 02 which is Custom-Field only)
# --------------------------------------------------------------------------- #
class ERPNextClient:
    def __init__(self, base_url: str, key: str, secret: str, timeout: int, verbose: bool):
        self.base = base_url
        self.timeout = timeout
        self.verbose = verbose
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"token {key}:{secret}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        })

    def _res(self, doctype: str, name: str | None = None) -> str:
        u = f"{self.base}/api/resource/{urllib.parse.quote(doctype)}"
        if name is not None:
            u += "/" + urllib.parse.quote(name, safe="")
        return u

    def whoami(self) -> str:
        r = self.s.get(f"{self.base}/api/method/frappe.auth.get_logged_user", timeout=self.timeout)
        r.raise_for_status()
        return r.json().get("message", "")

    def get(self, doctype: str, name: str) -> dict | None:
        r = self.s.get(self._res(doctype, name), timeout=self.timeout)
        if r.status_code == 200:
            return r.json().get("data")
        if r.status_code in (403, 404):
            return None
        r.raise_for_status()
        return None

    def exists(self, doctype: str, name: str) -> bool:
        return self.get(doctype, name) is not None

    def list(self, doctype: str, filters: list, limit: int = 1) -> list:
        params = {"filters": json.dumps(filters), "limit_page_length": limit}
        r = self.s.get(self._res(doctype), params=params, timeout=self.timeout)
        if r.status_code == 200:
            return r.json().get("data", [])
        if r.status_code in (403, 404):
            return []
        r.raise_for_status()
        return []

    def create(self, doctype: str, body: dict) -> requests.Response:
        b = dict(body)
        b["doctype"] = doctype
        return self.s.post(self._res(doctype), data=json.dumps(b), timeout=self.timeout)

    def update(self, doctype: str, name: str, body: dict) -> requests.Response:
        return self.s.put(self._res(doctype, name), data=json.dumps(body), timeout=self.timeout)


# --------------------------------------------------------------------------- #
# ensure helpers -- all return one of: created | updated | skipped | failed
# --------------------------------------------------------------------------- #
def _record_outcome(tally: dict, outcome: str):
    tally[outcome] = tally.get(outcome, 0) + 1
    return outcome


def ensure_named(client, dry_run, do_update, verbose, tally,
                 doctype: str, name: str, body: dict, label: str = ""):
    """get-or-create a doc whose document name is deterministic (== `name`)."""
    tag = f"{doctype} '{name}'" + (f" ({label})" if label else "")
    if dry_run:
        log(verbose, f"  [dry-run] would ensure {tag}")
        return _record_outcome(tally, "skipped")
    if client.exists(doctype, name):
        if do_update:
            r = client.update(doctype, name, body)
            if r.status_code == 200:
                print(f"  updated  {tag}")
                return _record_outcome(tally, "updated")
            print(f"  FAILED update {tag}: {r.status_code} {r.text[:300]}")
            return _record_outcome(tally, "failed")
        log(verbose, f"  exists   {tag} (skip; --update to overwrite)")
        return _record_outcome(tally, "skipped")
    r = client.create(doctype, body)
    if r.status_code in (200, 201):
        print(f"  created  {tag}")
        return _record_outcome(tally, "created")
    print(f"  FAILED   {tag}: {r.status_code} {r.text[:300]}")
    return _record_outcome(tally, "failed")


def ensure_by_filter(client, dry_run, do_update, verbose, tally,
                     doctype: str, filters: list, body: dict, label: str = ""):
    """get-or-create a doc whose name is auto-generated (e.g. Warehouse '<n> - <abbr>')."""
    desc = label or json.dumps(filters)
    tag = f"{doctype} [{desc}]"
    if dry_run:
        log(verbose, f"  [dry-run] would ensure {tag}")
        return _record_outcome(tally, "skipped")
    found = client.list(doctype, filters, limit=1)
    if found:
        existing_name = found[0].get("name")
        if do_update and existing_name:
            r = client.update(doctype, existing_name, body)
            if r.status_code == 200:
                print(f"  updated  {tag} -> {existing_name}")
                return _record_outcome(tally, "updated")
            print(f"  FAILED update {tag}: {r.status_code} {r.text[:300]}")
            return _record_outcome(tally, "failed")
        log(verbose, f"  exists   {tag} -> {existing_name} (skip)")
        return _record_outcome(tally, "skipped")
    r = client.create(doctype, body)
    if r.status_code in (200, 201):
        print(f"  created  {tag} -> {r.json().get('data', {}).get('name')}")
        return _record_outcome(tally, "created")
    print(f"  FAILED   {tag}: {r.status_code} {r.text[:300]}")
    return _record_outcome(tally, "failed")


def set_single(client, dry_run, verbose, tally, doctype: str, body: dict):
    """Update a Single DocType (e.g. Selling Settings)."""
    tag = f"{doctype} (single)"
    if dry_run:
        log(verbose, f"  [dry-run] would set {tag} <- {body}")
        return _record_outcome(tally, "skipped")
    r = client.update(doctype, doctype, body)
    if r.status_code == 200:
        print(f"  set      {tag} <- {body}")
        return _record_outcome(tally, "updated")
    print(f"  FAILED   {tag}: {r.status_code} {r.text[:300]}")
    return _record_outcome(tally, "failed")


def require_exists(client, dry_run, doctype: str, name: str) -> bool:
    """Verify a dependency master exists; warn (do not assume) if missing."""
    if dry_run or not name:
        return True
    if client.exists(doctype, name):
        return True
    print(f"  WARNING  dependency {doctype} '{name}' not found on this instance "
          f"-- dependent record may fail. Create it or pass a different value.")
    return False


# --------------------------------------------------------------------------- #
# GST placeholder (Rule 8: explicitly labeled, not fabricated)
# --------------------------------------------------------------------------- #
def ensure_gst_18(client, dry_run, verbose, tally):
    raise NotImplementedError(
        "ensure_gst_18 is a PLACEHOLDER. erpnext v16 India GST templates/accounts come "
        "from the separate `india_compliance` app, which is NOT installed here. Before "
        "implementing: (1) confirm india_compliance is installed (GET /api/method/"
        "frappe.client.get_installed_apps), (2) read its 'Sales Taxes and Charges "
        "Template'/'Item Tax Template' + GST account DocTypes from official source, then "
        "wire a grounded 18%% output-GST template. GST is exercised in V6.3, not V6.1."
    )


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main(argv=None):
    p = argparse.ArgumentParser(description="Bootstrap erpnextEnh1 master data via REST.")
    # connection (same flags as 02)
    p.add_argument("--url", default=None, help="ERPNext base URL (default: env ERPNEXT_URL or http://localhost:8080)")
    p.add_argument("--api-key", default=None, help="API key (default: env ERPNEXT_API_KEY)")
    p.add_argument("--api-secret", default=None, help="API secret (default: env ERPNEXT_API_SECRET)")
    p.add_argument("--env-file", default=None, help="Path to a .env file to read URL/key/secret from")
    p.add_argument("--timeout", type=int, default=30, help="Per-request timeout seconds (default 30)")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="Print actions without calling ERPNext")
    p.add_argument("--update", action="store_true", help="Replace records that already exist instead of skipping")
    # master values (all configurable; sensible defaults)
    p.add_argument("--company", default="Jupiter Knitting Company")
    p.add_argument("--warehouse-name", default="MADRAS-WH-1")
    p.add_argument("--brand", default="Tommy Hilfiger")
    p.add_argument("--uom", default="Nos")
    p.add_argument("--size-attribute", default="Size")
    p.add_argument("--size-values", default="S,M,L,XL",
                   help="Comma list; abbr == value so variant codes resolve (e.g. ...-M)")
    p.add_argument("--payment-terms", default="0,30,60",
                   help="Comma list of net credit-day counts; each makes a Payment Term + Template")
    p.add_argument("--customer-name", default="Tommy Hilfiger Europe B.V.")
    p.add_argument("--customer-type", default="Company", choices=["Company", "Individual", "Partnership"])
    p.add_argument("--customer-group", default="Commercial",
                   help="Must already exist on the instance (verified at runtime)")
    p.add_argument("--territory", default="Rest Of The World",
                   help="Must already exist on the instance (verified at runtime)")
    p.add_argument("--set-customer-naming", dest="set_customer_naming", action="store_true", default=True,
                   help="Ensure Selling Settings.cust_master_name='Customer Name' (default on)")
    p.add_argument("--no-set-customer-naming", dest="set_customer_naming", action="store_false")
    p.add_argument("--ensure-incoterms", default="FOB,CIF,EXW,DAP",
                   help="Comma list of Incoterm codes to ensure (empty string to skip)")
    p.add_argument("--with-gst", action="store_true", default=False,
                   help="Attempt GST 18%% template (PLACEHOLDER -- raises until implemented)")
    args = p.parse_args(argv)

    cfg = resolve_config(args)
    client = None
    if not args.dry_run:
        if not cfg["key"] or not cfg["secret"]:
            sys.exit("FATAL: API key/secret not resolved. Pass --api-key/--api-secret, "
                     "--env-file, or set ERPNEXT_API_KEY / ERPNEXT_API_SECRET.")
        client = ERPNextClient(cfg["url"], cfg["key"], cfg["secret"], args.timeout, args.verbose)
        try:
            user = client.whoami()
        except Exception as e:
            sys.exit(f"FATAL: auth/connectivity check failed against {cfg['url']}: {e}")
        print(f"Authenticated to {cfg['url']} as: {user}")
        if user != "Administrator":
            print(f"  NOTE: bound to '{user}', not Administrator. Needs System Manager rights.")
    else:
        print(f"[dry-run] target {cfg['url']} (no calls will be made)")

    tally: dict = {}

    # 1. Selling Settings -> name Customers by customer_name
    if args.set_customer_naming:
        print("\n[selling-settings]")
        set_single(client, args.dry_run, args.verbose, tally,
                   "Selling Settings", {"cust_master_name": "Customer Name"})

    # 2. UOM
    print("\n[uom]")
    ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                 "UOM", args.uom, {"uom_name": args.uom, "enabled": 1})

    # 3. Brand
    print("\n[brand]")
    ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                 "Brand", args.brand, {"brand": args.brand})

    # 4. Warehouse (name auto = "<warehouse_name> - <company abbr>")
    print("\n[warehouse]")
    require_exists(client, args.dry_run, "Company", args.company)
    ensure_by_filter(client, args.dry_run, args.update, args.verbose, tally,
                     "Warehouse",
                     [["warehouse_name", "=", args.warehouse_name], ["company", "=", args.company]],
                     {"warehouse_name": args.warehouse_name, "company": args.company, "is_group": 0},
                     label=f"{args.warehouse_name} @ {args.company}")

    # 5. Item Attribute "Size" with values (abbr == value)
    print("\n[item-attribute]")
    sizes = [s.strip() for s in args.size_values.split(",") if s.strip()]
    attr_values = [{"attribute_value": s, "abbr": s} for s in sizes]
    ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                 "Item Attribute", args.size_attribute,
                 {"attribute_name": args.size_attribute,
                  "numeric_values": 0,
                  "item_attribute_values": attr_values},
                 label=f"values={','.join(sizes)}")

    # 6 + 7. Payment Terms + wrapping Payment Terms Templates
    print("\n[payment-terms]")
    nets = [n.strip() for n in args.payment_terms.split(",") if n.strip() != ""]
    for n in nets:
        try:
            days = int(n)
        except ValueError:
            print(f"  WARNING  skipping non-integer payment term '{n}'")
            continue
        term_name = f"Net {days}"
        ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                     "Payment Term", term_name,
                     {"payment_term_name": term_name,
                      "invoice_portion": 100.0,
                      "due_date_based_on": "Day(s) after invoice date",
                      "credit_days": days},
                     label="100% invoice portion")
        ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                     "Payment Terms Template", term_name,
                     {"template_name": term_name,
                      "allocate_payment_based_on_payment_terms": 0,
                      "terms": [{
                          "payment_term": term_name,
                          "due_date_based_on": "Day(s) after invoice date",
                          "invoice_portion": 100.0,
                          "credit_days": days,
                      }]},
                     label="template")

    # 8. Customer (NO LEI -- see module docstring)
    print("\n[customer]")
    cg_ok = require_exists(client, args.dry_run, "Customer Group", args.customer_group)
    terr_ok = require_exists(client, args.dry_run, "Territory", args.territory)
    cust_body = {
        "customer_name": args.customer_name,
        "customer_type": args.customer_type,
    }
    if cg_ok and args.customer_group:
        cust_body["customer_group"] = args.customer_group
    if terr_ok and args.territory:
        cust_body["territory"] = args.territory
    ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                 "Customer", args.customer_name, cust_body, label="buyer master")

    # 9. Incoterms (ensure standard codes exist; code+title only)
    incoterm_titles = {
        "EXW": "Ex Works", "FOB": "Free On Board", "CIF": "Cost, Insurance and Freight",
        "DAP": "Delivered At Place", "FCA": "Free Carrier", "CFR": "Cost and Freight",
        "CPT": "Carriage Paid To", "CIP": "Carriage and Insurance Paid To",
        "DPU": "Delivered At Place Unloaded", "DDP": "Delivered Duty Paid",
    }
    codes = [c.strip().upper() for c in args.ensure_incoterms.split(",") if c.strip()]
    if codes:
        print("\n[incoterms]")
        for code in codes:
            title = incoterm_titles.get(code, code)
            ensure_named(client, args.dry_run, args.update, args.verbose, tally,
                         "Incoterm", code, {"code": code, "title": title}, label=title)

    # 10. GST (placeholder)
    if args.with_gst:
        print("\n[gst]")
        ensure_gst_18(client, args.dry_run, args.verbose, tally)

    # summary
    print("\nSummary:", ", ".join(f"{k}={v}" for k, v in sorted(tally.items())) or "(none)")
    failed = tally.get("failed", 0)
    if failed:
        print(f"FAILED: {failed} record(s) did not install.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
