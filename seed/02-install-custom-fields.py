#!/usr/bin/env python3
"""
02-install-custom-fields.py  --  erpnextEnh1 Custom Field installer (REST-only)

Installs the 4 Custom Field fixtures (Opportunity, Opportunity Item, Quotation,
Quotation Item) into a running ERPNext instance via the REST API. No bench, no app
install required. Idempotent: existing fields are skipped (or updated with --update).

Grounding (official sources, verified):
  - Custom Field DocType envelope: frappe/frappe@develop
        frappe/custom/doctype/custom_field/custom_field.py (auto-generated types block).
        Each record posts as {"doctype":"Custom Field","dt":<TargetDocType>, ...}.
        Doc name is auto-derived as  "<dt>-<fieldname>".
  - Token auth + /api/resource CRUD: docs.frappe.io/framework/user/en/api/rest
  - Field specs: DESIGN_6/03-Inquiry-and-Quote-Schemas.md  (sections 1.3, 1.4, 2.3, 2.4)

Requires: requests  (pip install requests)

Examples:
  # Dry run against defaults from ../../IMPL-V6/.env (reads URL + key + secret):
  python 02-install-custom-fields.py --env-file ../../DynDiscProject6/IMPL-V6/.env --dry-run

  # Real install, only the two parent doctypes, verbose:
  python 02-install-custom-fields.py --doctypes opportunity,quotation --verbose

  # Re-run and update any drifted definitions, then emit the flat fixtures file:
  python 02-install-custom-fields.py --update \
         --emit-fixtures ../apps/chainaim_proc/fixtures/custom_field.json
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


# ----- the 4 fixture files this installer manages (file stem -> filename) -----
DEFAULT_FIXTURES = {
    "opportunity": "opportunity.json",
    "opportunity_item": "opportunity_item.json",
    "quotation": "quotation.json",
    "quotation_item": "quotation_item.json",
}

# Keys we forward to ERPNext when creating a Custom Field. Anything else in a
# fixture record is ignored (defensive; we never send unknown keys).
ALLOWED_KEYS = {
    "dt", "fieldname", "label", "fieldtype", "options", "insert_after",
    "read_only", "reqd", "default", "description", "in_list_view",
    "in_standard_filter", "in_global_search", "permlevel", "no_copy",
    "unique", "hidden", "depends_on", "non_negative", "length", "precision",
    "translatable", "fetch_from", "fetch_if_empty", "allow_on_submit",
    "mandatory_depends_on", "read_only_depends_on", "bold", "collapsible",
}


def log(verbose: bool, *a):
    if verbose:
        print(*a)


def parse_env_file(path: Path) -> dict:
    """Minimal .env parser (KEY=VALUE, ignores blanks/comments). No external dep."""
    env = {}
    if not path.exists():
        return env
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        # strip inline comments only when value is unquoted
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


class ERPNextClient:
    DOCTYPE = "Custom Field"

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

    def _res_url(self, name: str | None = None) -> str:
        u = f"{self.base}/api/resource/{urllib.parse.quote(self.DOCTYPE)}"
        if name is not None:
            u += "/" + urllib.parse.quote(name, safe="")
        return u

    def whoami(self) -> str:
        r = self.s.get(f"{self.base}/api/method/frappe.auth.get_logged_user",
                       timeout=self.timeout)
        r.raise_for_status()
        return r.json().get("message", "")

    def exists(self, name: str) -> bool:
        r = self.s.get(self._res_url(name), timeout=self.timeout)
        if r.status_code == 200:
            return True
        if r.status_code in (403, 404):
            return False
        r.raise_for_status()
        return False

    def create(self, body: dict) -> requests.Response:
        return self.s.post(self._res_url(), data=json.dumps(body), timeout=self.timeout)

    def update(self, name: str, body: dict) -> requests.Response:
        return self.s.put(self._res_url(name), data=json.dumps(body), timeout=self.timeout)


def build_body(record: dict) -> dict:
    body = {k: v for k, v in record.items() if k in ALLOWED_KEYS}
    body["doctype"] = ERPNextClient.DOCTYPE
    return body


def is_insert_after_error(resp: requests.Response) -> bool:
    text = resp.text or ""
    return ("insert_after" in text.lower()
            or "Insert After" in text
            or "DoesNotExistError" in text)


def install_record(client, record, dry_run, do_update, verbose):
    """Returns one of: created | updated | skipped | created_no_anchor | failed."""
    dt = record["dt"]
    fieldname = record["fieldname"]
    name = f"{dt}-{fieldname}"
    body = build_body(record)

    if dry_run:
        log(verbose, f"  [dry-run] would ensure {name}  ({record.get('fieldtype')})")
        return "skipped"

    if client.exists(name):
        if do_update:
            r = client.update(name, body)
            if r.status_code == 200:
                print(f"  updated  {name}")
                return "updated"
            print(f"  FAILED update {name}: {r.status_code} {r.text[:300]}")
            return "failed"
        log(verbose, f"  exists   {name} (skip; use --update to overwrite)")
        return "skipped"

    r = client.create(body)
    if r.status_code in (200, 201):
        print(f"  created  {name}")
        return "created"

    # graceful degradation: retry without the (unverified) placement anchor
    if "insert_after" in body and is_insert_after_error(r):
        retry = dict(body)
        bad_anchor = retry.pop("insert_after", None)
        r2 = client.create(retry)
        if r2.status_code in (200, 201):
            print(f"  created  {name}  (WARNING: insert_after '{bad_anchor}' "
                  f"rejected; field appended instead)")
            return "created_no_anchor"
        print(f"  FAILED   {name}: {r2.status_code} {r2.text[:300]}")
        return "failed"

    print(f"  FAILED   {name}: {r.status_code} {r.text[:300]}")
    return "failed"


def main(argv=None):
    here = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(description="Install erpnextEnh1 Custom Fields via REST.")
    p.add_argument("--url", default=None, help="ERPNext base URL (default: env ERPNEXT_URL or http://localhost:8080)")
    p.add_argument("--api-key", default=None, help="API key (default: env ERPNEXT_API_KEY)")
    p.add_argument("--api-secret", default=None, help="API secret (default: env ERPNEXT_API_SECRET)")
    p.add_argument("--env-file", default=None, help="Path to a .env file to read URL/key/secret from")
    p.add_argument("--custom-dir", default=str(here.parent / "apps" / "chainaim_proc" / "chainaim_proc" / "custom"),
                   help="Directory containing the 4 fixture JSON files")
    p.add_argument("--doctypes", default="all",
                   help="Comma list of fixture stems to install: opportunity,opportunity_item,"
                        "quotation,quotation_item (default: all)")
    p.add_argument("--update", action="store_true", help="Update fields that already exist instead of skipping")
    p.add_argument("--dry-run", action="store_true", help="Print actions without calling ERPNext")
    p.add_argument("--emit-fixtures", default=None,
                   help="Also write a flat custom_field.json (bench export-fixtures shape) to this path")
    p.add_argument("--timeout", type=int, default=30, help="Per-request timeout seconds (default 30)")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)

    custom_dir = Path(args.custom_dir)
    if not custom_dir.is_dir():
        sys.exit(f"FATAL: --custom-dir not found: {custom_dir}")

    if args.doctypes.strip().lower() == "all":
        selected = list(DEFAULT_FIXTURES.keys())
    else:
        selected = [s.strip() for s in args.doctypes.split(",") if s.strip()]
        unknown = [s for s in selected if s not in DEFAULT_FIXTURES]
        if unknown:
            sys.exit(f"FATAL: unknown --doctypes entries: {unknown}. "
                     f"Valid: {list(DEFAULT_FIXTURES)}")

    # Load + collect all records (also used for --emit-fixtures).
    all_records, plan = [], []
    for stem in selected:
        fpath = custom_dir / DEFAULT_FIXTURES[stem]
        if not fpath.exists():
            sys.exit(f"FATAL: fixture missing: {fpath}")
        data = json.loads(fpath.read_text(encoding="utf-8"))
        records = data.get("custom_fields", [])
        for rec in records:
            if "dt" not in rec or "fieldname" not in rec:
                sys.exit(f"FATAL: record missing dt/fieldname in {fpath}: {rec}")
        plan.append((stem, records))
        all_records.extend(records)

    total = sum(len(r) for _, r in plan)
    print(f"Loaded {total} custom fields across {len(plan)} doctype(s) from {custom_dir}")

    if args.emit_fixtures:
        out = Path(args.emit_fixtures)
        out.parent.mkdir(parents=True, exist_ok=True)
        flat = [build_body(r) for r in all_records]
        out.write_text(json.dumps(flat, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote flat fixtures ({len(flat)} records) -> {out}")

    cfg = resolve_config(args)
    if not args.dry_run:
        if not cfg["key"] or not cfg["secret"]:
            sys.exit("FATAL: API key/secret not resolved. Pass --api-key/--api-secret "
                     "or --env-file, or set ERPNEXT_API_KEY / ERPNEXT_API_SECRET.")
        client = ERPNextClient(cfg["url"], cfg["key"], cfg["secret"], args.timeout, args.verbose)
        try:
            user = client.whoami()
        except Exception as e:
            sys.exit(f"FATAL: auth/connectivity check failed against {cfg['url']}: {e}")
        print(f"Authenticated to {cfg['url']} as: {user}")
        if user != "Administrator":
            print(f"  NOTE: bound to '{user}', not Administrator. Needs System Manager rights to create Custom Fields.")
    else:
        client = None
        print(f"[dry-run] target {cfg['url']} (no calls will be made)")

    tally = {}
    for stem, records in plan:
        print(f"\n[{stem}]  ({len(records)} fields)")
        for rec in records:
            outcome = install_record(client, rec, args.dry_run, args.update, args.verbose) \
                if not args.dry_run else \
                install_record(client, rec, True, args.update, args.verbose)
            tally[outcome] = tally.get(outcome, 0) + 1

    print("\nSummary:", ", ".join(f"{k}={v}" for k, v in sorted(tally.items())) or "(none)")
    failed = tally.get("failed", 0)
    if failed:
        print(f"FAILED: {failed} field(s) did not install.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
