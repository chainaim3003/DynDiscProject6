#!/usr/bin/env python3
"""
04-seed-demo-bins.py  --  erpnextEnh1 demo stock (Bin) seeder via Stock Reconciliation (REST-only).

Sets ABSOLUTE on-hand quantity per (variant item_code, warehouse) so the V6.x ATP / canFulfill
evals (P01 happy, P03 ATP-short, P06 split) have deterministic stock to read from ERPNext Bin.
Idempotent; uses the shared _seedlib.py scaffold (same import surface as seeds 01/03/90).

WHY Stock Reconciliation (not a direct Bin write):
  Bin.actual_qty is system-derived from the Stock Ledger -- you cannot POST it directly. A *submitted*
  Stock Reconciliation is ERPNext's supported way to set an absolute qty per (item, warehouse); it
  posts the Stock Ledger Entries that update Bin.actual_qty. This seed READS Bin only (idempotency).

Grounding (official sources, fetched this session from frappe/erpnext@develop -- the v16 line):
  - Stock Reconciliation (parent): is_submittable=1 (MUST be submitted to move stock); reqd fields
    company, posting_date, posting_time, items; purpose in {"Opening Stock","Stock Reconciliation"};
    a custom posting date requires set_posting_time=1; naming_series "MAT-RECO-.YYYY.-".
        erpnext/stock/doctype/stock_reconciliation/stock_reconciliation.json
  - Stock Reconciliation Item (child): item_code (Link Item, reqd), warehouse (Link, reqd),
    qty (Float = absolute target), valuation_rate (Currency), allow_zero_valuation_rate (Check).
    On a clean instance with no cost basis, a qty>0 line needs either a valuation_rate or
    allow_zero_valuation_rate=1, else submit fails on missing valuation.
        erpnext/stock/doctype/stock_reconciliation_item/stock_reconciliation_item.json
  - Opening-entry difference account: stock_reconciliation.validate_expense_account() treats the doc
    as an OPENING entry when purpose=="Opening Stock" OR no Stock Ledger Entry exists yet (first stock
    on the instance). In that case expense_account ("Difference Account") MUST be a Balance-Sheet
    (non-"Profit and Loss") account, else OpeningEntryAccountError. ERPNext auto-defaults
    expense_account to Company.stock_adjustment_account (a P&L account), which FAILS for an opening
    entry -- so this seed sets expense_account to the company's account_type=="Temporary" account
    (Balance Sheet) for opening entries, and leaves it unset otherwise.
        erpnext/stock/doctype/stock_reconciliation/stock_reconciliation.py (validate_expense_account)
  - Submit over REST: frappe/client.py submit(doc) -> frappe.get_doc(doc).submit(). The current
    (develop/v16) parameter name is `doc` (the legacy frappe-client lib's `doclist` is stale).
    Flow used here: INSERT a draft via POST /api/resource/Stock Reconciliation, then
    POST /api/method/frappe.client.submit with {"doc": <inserted-doc-dict>} to set docstatus=1.
        frappe/frappe/client.py (def submit), cross-checked vs frappe/frappe-client submit().

Profiles -- per-template absolute on-hand qty, applied to every size variant of that template:
  happy : TEE 50000 / POLO 50000 / HOOD 50000   -> every line canFulfill=true (P01)
  short : TEE 35000 / POLO 35000 / HOOD 35000   -> canFulfill=false vs the P03 40,000 ask
  mixed : TEE 50000 (full) / POLO 1000 (partial) / HOOD 0 (back-ordered)  -> P06 full/partial/backorder

GROUNDING NOTE (Rule 2/3 -- read before trusting the numbers):
  DESIGN_6/05 defines exactly ONE concrete ATP number: P03 short = 35,000 on hand vs a 40,000 ask.
  - "short" (35,000) is therefore design-grounded.
  - "happy" exact value is immaterial: no eval asserts the level, only canFulfill=true; any value
    above the largest demo ask (40,000) suffices. 50,000 was chosen for round headroom.
  - "mixed": DESIGN_6/05 P06 specifies only the SHAPE ("1 style fully fulfillable, 1 partial, 1
    mostly back-ordered"), NOT numbers. The style->role mapping (TEE=full, POLO=partial,
    HOOD=backorder), the partial level (1000) and the backorder level (0) are OPERATOR-CHOSEN,
    approved 2026-06-08 -- they are NOT from DESIGN_6. "partial" (1000) is only partial relative to
    asks > 1000. Override any of this with --profile / --qty / --templates without editing internals.

Examples:
  python 04-seed-demo-bins.py --env-file ../../DynDiscProject6/IMPL-V6/.env --profile short --dry-run --verbose
  python 04-seed-demo-bins.py --env-file ../../DynDiscProject6/IMPL-V6/.env --profile happy --verbose
  python 04-seed-demo-bins.py --env-file ../../DynDiscProject6/IMPL-V6/.env --profile mixed
  python 04-seed-demo-bins.py --env-file ../../DynDiscProject6/IMPL-V6/.env --qty 12345 --templates TH-TEE-RN-180
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _seedlib import (  # noqa: E402
    add_connection_args, make_client, require_exists, print_summary, record_outcome, log,
)

# Per-template absolute on-hand qty by profile. Keyed by template item_code; applied to every size.
# See the GROUNDING NOTE in the module docstring before changing any of these numbers.
PROFILES = {
    "happy": {"TH-TEE-RN-180": 50000, "TH-POLO-PIQ-220": 50000, "TH-HOOD-FLC-320": 50000},
    "short": {"TH-TEE-RN-180": 35000, "TH-POLO-PIQ-220": 35000, "TH-HOOD-FLC-320": 35000},
    "mixed": {"TH-TEE-RN-180": 50000, "TH-POLO-PIQ-220": 1000,  "TH-HOOD-FLC-320": 0},
}


def resolve_qty(profile_map, template, qty_override):
    """Absolute target qty for a template. --qty overrides the profile. No invented fallback (Rule 2)."""
    if qty_override is not None:
        return float(qty_override)
    if template in profile_map:
        return float(profile_map[template])
    return None  # signals "not defined" -> caller FATALs rather than guess


def current_bin_qty(client, item_code, warehouse):
    """Read system-derived Bin.actual_qty for (item, warehouse). 0.0 if no Bin row exists yet."""
    rows = client.list("Bin", {"item_code": item_code, "warehouse": warehouse},
                        limit=1, fields=["actual_qty"])
    if rows:
        return float(rows[0].get("actual_qty") or 0.0)
    return 0.0


def is_opening_entry(client, purpose):
    """Mirror stock_reconciliation.validate_expense_account(): opening if purpose is 'Opening Stock'
    OR there is not a single Stock Ledger Entry yet (first stock on the instance)."""
    if purpose == "Opening Stock":
        return True
    return not client.list("Stock Ledger Entry", {}, limit=1)


def resolve_difference_account(client, company, override):
    """Resolve a Balance-Sheet (non-P&L) difference account for an opening entry. No name guessing:
    explicit --difference-account wins; else the company's account_type='Temporary' account; else FATAL."""
    if override:
        acct = client.get("Account", override)
        if acct is None:
            sys.exit(f"FATAL: --difference-account '{override}' not found in ERPNext.")
        if acct.get("report_type") == "Profit and Loss":
            sys.exit(f"FATAL: --difference-account '{override}' is a Profit and Loss account; an opening "
                     f"entry requires a Balance-Sheet (Asset/Liability/Equity) account.")
        return override
    rows = client.list("Account", {"company": company, "account_type": "Temporary", "is_group": 0},
                       limit=5, fields=["name", "report_type"])
    bs = [r for r in rows if r.get("report_type") != "Profit and Loss"]
    if len(bs) == 1:
        return bs[0]["name"]
    if not bs:
        sys.exit("FATAL: this is an opening entry (no prior stock) and no Balance-Sheet difference account "
                 "could be auto-resolved (no non-group account_type='Temporary' account for company "
                 f"'{company}'). Pass --difference-account <your 'Temporary Opening' or other Balance-Sheet "
                 "account>. (Rule 2: refusing to guess an account name.)")
    names = ", ".join(r["name"] for r in bs)
    sys.exit(f"FATAL: multiple Temporary accounts found ({names}); disambiguate with --difference-account.")


def main(argv=None):
    p = argparse.ArgumentParser(
        description="Seed demo on-hand stock per variant via a submitted Stock Reconciliation (REST).")
    add_connection_args(p)
    p.add_argument("--profile", choices=sorted(PROFILES.keys()), default="happy",
                   help="Per-template qty profile (default happy). See module docstring GROUNDING NOTE.")
    p.add_argument("--qty", type=float, default=None,
                   help="Override profile: uniform absolute qty for ALL targeted variants.")
    p.add_argument("--templates", default="TH-TEE-RN-180,TH-POLO-PIQ-220,TH-HOOD-FLC-320",
                   help="Comma list of template item_codes (same derivation as seed 01).")
    p.add_argument("--sizes", default="S,M,L,XL", help="Comma list of size suffixes (same as seed 01).")
    p.add_argument("--warehouse", default="MADRAS-WH-1 - JKC",
                   help="Target warehouse (note the ' - JKC' company-abbr suffix in the real name).")
    p.add_argument("--company", default="Jupiter Knitting Company", help="Company for the Stock Reconciliation.")
    p.add_argument("--valuation-rate", type=float, default=0.0,
                   help="Per-line cost basis. 0.0 (default) sets allow_zero_valuation_rate=1 "
                        "(valuation is immaterial to the qty-based ATP demo).")
    p.add_argument("--purpose", choices=["Stock Reconciliation", "Opening Stock"],
                   default="Stock Reconciliation",
                   help="Stock Reconciliation purpose (default 'Stock Reconciliation').")
    p.add_argument("--naming-series", default="MAT-RECO-.YYYY.-", help="Stock Reconciliation naming series.")
    p.add_argument("--difference-account", default=None,
                   help="expense_account / 'Difference Account'. Only used for an OPENING entry (first stock "
                        "on the instance, or --purpose 'Opening Stock'), which ERPNext requires to be a "
                        "Balance-Sheet (non-P&L) account. Default: auto-resolve the company's account_type="
                        "'Temporary' account; FATAL if none. For non-opening reruns it is left unset so "
                        "ERPNext defaults to the Stock Adjustment account.")
    p.add_argument("--posting-date", default=None,
                   help="Optional YYYY-MM-DD; when set, set_posting_time=1 is sent. Default: server Today.")
    p.add_argument("--posting-time", default=None, help="Optional HH:MM:SS; only used with --posting-date.")
    p.add_argument("--force", action="store_true",
                   help="Repost even if Bin.actual_qty already equals the target (default: skip matches).")
    args = p.parse_args(argv)

    templates = [t.strip() for t in args.templates.split(",") if t.strip()]
    sizes = [s.strip() for s in args.sizes.split(",") if s.strip()]
    if not templates or not sizes:
        sys.exit("FATAL: need at least one template and one size.")
    profile_map = PROFILES[args.profile]

    # Build the target list (variant item_code -> absolute qty). FATAL if any template lacks a qty.
    targets = []
    for tmpl in templates:
        qty = resolve_qty(profile_map, tmpl, args.qty)
        if qty is None:
            sys.exit(f"FATAL: no qty for template '{tmpl}' in profile '{args.profile}' and no --qty given. "
                     f"Pass --qty or add '{tmpl}' to the profile. (Rule 2: refusing to invent a quantity.)")
        for size in sizes:
            targets.append((f"{tmpl}-{size}", qty))

    client, cfg = make_client(args)
    tally: dict = {}

    print(f"\n[profile={args.profile}] warehouse='{args.warehouse}' purpose='{args.purpose}' "
          f"-> {len(targets)} variant(s)")

    # Dependencies -- verify, never assume (seeded by 00 / 01).
    require_exists(client, args, "Company", args.company)
    require_exists(client, args, "Warehouse", args.warehouse)
    for code, _ in targets:
        require_exists(client, args, "Item", code)

    # Opening-entry difference account (grounded in stock_reconciliation.validate_expense_account):
    # required as a Balance-Sheet account when this is an opening entry. Resolved only on a live run.
    expense_account = None
    if args.dry_run:
        log(args.verbose, "  [dry-run] opening-entry check + difference-account resolution skipped (no calls).")
    elif is_opening_entry(client, args.purpose):
        expense_account = resolve_difference_account(client, args.company, args.difference_account)
        log(args.verbose, f"  opening entry -> difference (expense) account: {expense_account}")
    else:
        log(args.verbose, "  not an opening entry -> leaving expense_account unset (ERPNext defaults it).")

    # Decide which lines to (re)post -- absolute-qty idempotency keyed on Bin.actual_qty.
    child = []  # list of (item_code, qty) to include in the reconciliation
    for code, qty in targets:
        if args.dry_run:
            log(args.verbose, f"  [dry-run] would set Bin actual_qty: {code} @ '{args.warehouse}' -> {qty:g}")
            child.append((code, qty))
            continue
        cur = current_bin_qty(client, code, args.warehouse)
        if not args.force and cur == qty:
            log(args.verbose, f"  skip     {code}: Bin already at {qty:g}")
            record_outcome(tally, "skipped")
            continue
        log(args.verbose, f"  plan     {code}: {cur:g} -> {qty:g}")
        child.append((code, qty))

    if not child:
        print("  nothing to do (all Bins already at target; use --force to repost).")
        return print_summary(tally)

    # Build the Stock Reconciliation child rows.
    items_body = []
    for code, qty in child:
        row = {"item_code": code, "warehouse": args.warehouse, "qty": qty}
        if args.valuation_rate and args.valuation_rate > 0:
            row["valuation_rate"] = args.valuation_rate
        else:
            row["allow_zero_valuation_rate"] = 1
        items_body.append(row)

    body = {
        "naming_series": args.naming_series,
        "company": args.company,
        "purpose": args.purpose,
        "items": items_body,
    }
    if expense_account:
        body["expense_account"] = expense_account
    if args.posting_date:
        body["set_posting_time"] = 1
        body["posting_date"] = args.posting_date
        if args.posting_time:
            body["posting_time"] = args.posting_time

    if args.dry_run:
        print(f"  [dry-run] would INSERT Stock Reconciliation ({len(items_body)} line(s)) then submit "
              f"via frappe.client.submit; no calls made.")
        for _ in child:
            record_outcome(tally, "skipped")
        return print_summary(tally)

    # 1) INSERT draft (docstatus=0).
    r = client.create("Stock Reconciliation", body)
    if r.status_code not in (200, 201):
        print(f"  FAILED insert Stock Reconciliation: {r.status_code} {r.text[:400]}")
        for _ in child:
            record_outcome(tally, "failed")
        return print_summary(tally)
    draft = r.json().get("data", {})
    name = draft.get("name")
    print(f"  created  Stock Reconciliation {name} (draft, docstatus=0)")

    # 2) SUBMIT (docstatus=1) -> posts Stock Ledger Entries -> updates Bin.actual_qty.
    rs = client.call_method("frappe.client.submit", {"doc": draft})
    if rs.status_code != 200:
        print(f"  FAILED submit {name}: {rs.status_code} {rs.text[:400]}")
        print(f"  NOTE: draft {name} remains in ERPNext for inspection (not cancelled).")
        for _ in child:
            record_outcome(tally, "failed")
        return print_summary(tally)
    submitted = rs.json().get("message", {}) or {}
    ds = submitted.get("docstatus")
    if ds != 1:
        print(f"  WARNING  {name} submit returned docstatus={ds!r} (expected 1). Verify in ERPNext.")
    else:
        print(f"  submitted {name} (docstatus=1) -> {len(items_body)} Bin line(s) updated")
    for _ in child:
        record_outcome(tally, "updated")

    # 3) Optional post-submit confirmation (verbose): re-read Bin.actual_qty.
    if args.verbose:
        print("  [verify] post-submit Bin.actual_qty:")
        for code, qty in child:
            cur = current_bin_qty(client, code, args.warehouse)
            flag = "OK" if cur == qty else "MISMATCH"
            print(f"    {flag:8} {code}: actual_qty={cur:g} (target {qty:g})")

    return print_summary(tally)


if __name__ == "__main__":
    raise SystemExit(main())
