#!/usr/bin/env python3
"""
90-export-fixtures.py  --  REST equivalent of `bench export-fixtures` for erpnextEnh1.

Pulls the installed configuration records back out of a running ERPNext instance via REST
and writes them as fixture JSON arrays (the shape `bench export-fixtures` produces and that
chainaim_proc/hooks.py `fixtures` round-trips). Useful when you don't have bench/CLI access
to the container but still want reproducible, committable fixtures. Uses _seedlib.py.

Default exports (filtered to the 4 erpnextEnh1 target doctypes):
  - Custom Field    where dt        in (Opportunity, Opportunity Item, Quotation, Quotation Item)
  - Property Setter where doc_type  in (same 4)

Each record is fetched in full (GET /api/resource/<DocType>/<name>) and volatile server
metadata (creation/modified/owner/idx/docstatus/_*) is scrubbed so the output is stable and
diff-friendly. `name` and `doctype` are retained (Custom Field names are deterministic
"<dt>-<fieldname>", matching bench output).

Grounding:
  - List + filters + fetch: /api/resource CRUD (docs.frappe.io REST API).
  - Custom Field is filtered by `dt`; Property Setter by `doc_type` (their respective
    target-doctype link fields) -- same filter bench uses for these fixtures.

Examples:
  python 90-export-fixtures.py --env-file ../../DynDiscProject6/IMPL-V6/.env --dry-run --verbose
  python 90-export-fixtures.py --env-file ../../DynDiscProject6/IMPL-V6/.env
  python 90-export-fixtures.py --doctypes "Custom Field" --out-dir ./exported
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _seedlib import add_connection_args, make_client, print_summary, record_outcome, log  # noqa: E402

# DocType -> (target-doctype link fieldname used to filter, output filename stem)
EXPORTABLE = {
    "Custom Field":   ("dt",       "custom_field"),
    "Property Setter": ("doc_type", "property_setter"),
}

# server-managed keys never written to fixtures
VOLATILE = {
    "creation", "modified", "modified_by", "owner", "idx", "docstatus",
    "parent", "parentfield", "parenttype", "_user_tags", "_comments",
    "_assign", "_liked_by", "_seen", "lft", "rgt", "old_parent",
}


def scrub(doc: dict) -> dict:
    return {k: v for k, v in doc.items()
            if k not in VOLATILE and not k.startswith("__") and v is not None}


def export_doctype(client, args, tally, doctype, target_dts):
    link_field, stem = EXPORTABLE[doctype]
    flt = [[link_field, "in", target_dts]] if target_dts else []
    out_path = Path(args.out_dir) / f"{stem}.json"

    if args.dry_run:
        log(args.verbose, f"  [dry-run] would export {doctype} where {link_field} in "
                          f"{target_dts or 'ALL'} -> {out_path}")
        return record_outcome(tally, "skipped")

    names = [r["name"] for r in client.list(doctype, flt, limit=0, fields=["name"])]
    records = []
    skipped_sysgen = 0
    for name in names:
        full = client.get(doctype, name)
        if not full:
            continue
        # By default, drop is_system_generated records (stock ERPNext UI/print
        # defaults that merely sit on the target doctypes) so the fixture holds
        # only THIS app's own customizations. --include-system-generated keeps them.
        if not args.include_system_generated and full.get("is_system_generated"):
            skipped_sysgen += 1
            continue
        records.append(scrub(full))
    records.sort(key=lambda d: d.get("name", ""))
    if skipped_sysgen:
        log(args.verbose, f"  skipped {skipped_sysgen} is_system_generated {doctype} record(s) "
                          f"(use --include-system-generated to keep)")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(records, indent=1) + "\n", encoding="utf-8")
    print(f"  exported {len(records):>3} {doctype} record(s) -> {out_path}")
    return record_outcome(tally, "created" if records else "skipped")


def main(argv=None):
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="Export erpnextEnh1 fixtures via REST.")
    add_connection_args(p)
    p.add_argument("--doctypes", default="Custom Field,Property Setter",
                   help=f"Comma list to export. Valid: {list(EXPORTABLE)}")
    p.add_argument("--filter-dt",
                   default="Opportunity,Opportunity Item,Quotation,Quotation Item",
                   help="Target doctypes to filter by (empty string = export ALL of each type)")
    p.add_argument("--out-dir",
                   default=str(here.parent / "apps" / "chainaim_proc" / "chainaim_proc" / "fixtures"),
                   help="Directory to write <stem>.json fixture files")
    p.add_argument("--include-system-generated", action="store_true",
                   help="Include is_system_generated records (default: exclude, so fixtures "
                        "hold only this app's own customizations, not stock ERPNext UI/print state)")
    args = p.parse_args(argv)

    selected = [d.strip() for d in args.doctypes.split(",") if d.strip()]
    unknown = [d for d in selected if d not in EXPORTABLE]
    if unknown:
        sys.exit(f"FATAL: unknown --doctypes entries: {unknown}. Valid: {list(EXPORTABLE)}")
    target_dts = [s.strip() for s in args.filter_dt.split(",") if s.strip()]

    client, cfg = make_client(args)
    print(f"\nExport target dir: {args.out_dir}")
    print(f"Filter doctypes: {target_dts or 'ALL'}")
    tally: dict = {}
    for doctype in selected:
        print(f"\n[{doctype}]")
        export_doctype(client, args, tally, doctype, target_dts)

    return print_summary(tally)


if __name__ == "__main__":
    raise SystemExit(main())
