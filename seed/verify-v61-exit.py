#!/usr/bin/env python3
"""
verify-v61-exit.py  --  check the three V6.1 exit criteria against a live ERPNext instance.

Read-only (GET only; no writes). Reads URL/key/secret from --env-file (or env / CLI),
identical precedence/auth to the seeds. Prints PASS/FAIL per criterion and exits nonzero
if any fail. No secrets on the command line.

Criteria (DESIGN_6/07 V6.1, as amended 2026-06-08):
  1. Customer "Tommy Hilfiger Europe B.V." exists (NO LEI on Customer -- buyer LEI is on
     Opportunity per 03 sec 1.3).
  2. Item variant "TH-TEE-RN-180-M" exists and is linked to its template.
  3. Custom Field "Opportunity-custom_inquiry_id" exists on Opportunity.

Examples:
  python verify-v61-exit.py --env-file ..\\..\\DynDiscProject6\\IMPL-V6\\.env
  python verify-v61-exit.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _seedlib import add_connection_args, make_client  # noqa: E402


def check(client, doctype, name, expect: dict):
    """expect: {field: expected_value}. Returns (ok, detail)."""
    doc = client.get(doctype, name)
    if not doc:
        return False, f"{doctype} '{name}' NOT FOUND"
    misses = []
    for f, want in expect.items():
        got = doc.get(f)
        if got != want:
            misses.append(f"{f}={got!r} (expected {want!r})")
    if misses:
        return False, f"{doctype} '{name}' found but " + "; ".join(misses)
    shown = ", ".join(f"{f}={doc.get(f)!r}" for f in expect) or "exists"
    return True, f"{doctype} '{name}' -> {shown}"


def main(argv=None):
    p = argparse.ArgumentParser(description="Verify V6.1 exit criteria (read-only).")
    add_connection_args(p)  # --url/--api-key/--api-secret/--env-file/--timeout/--verbose/--dry-run/--update
    args = p.parse_args(argv)
    args.dry_run = False  # this tool only reads; force a real (GET-only) connection

    client, cfg = make_client(args)
    print(f"\nVerifying V6.1 exit criteria against {cfg['url']}\n")

    checks = [
        ("Customer", "Tommy Hilfiger Europe B.V.", {"customer_name": "Tommy Hilfiger Europe B.V."}),
        ("Item", "TH-TEE-RN-180-M", {"variant_of": "TH-TEE-RN-180"}),
        ("Custom Field", "Opportunity-custom_inquiry_id",
         {"dt": "Opportunity", "fieldname": "custom_inquiry_id"}),
    ]

    all_ok = True
    for i, (doctype, name, expect) in enumerate(checks, 1):
        ok, detail = check(client, doctype, name, expect)
        all_ok = all_ok and ok
        print(f"  [{i}] {'PASS' if ok else 'FAIL'}  {detail}")

    print("\nRESULT:", "ALL PASS -- V6.1 exit criteria met." if all_ok else "FAILURES present.")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
