#!/usr/bin/env python3
"""
_seedlib.py  --  shared scaffold for the erpnextEnh1 REST seeds (01, 03, 04, 90).

Factored out of the proven 00-bootstrap-masters.py / 02-install-custom-fields.py so the
later seeds share ONE generic, idempotent ERPNext REST client instead of diverging copies.
00 and 02 remain standalone (already live-verified); they may be migrated onto this lib later.

Public surface:
    parse_env_file(path) -> dict
    add_connection_args(parser)                       # --url/--api-key/--api-secret/--env-file/...
    resolve_config(args) -> {"url","key","secret"}
    make_client(args) -> (ERPNextClient | None, cfg)  # None when --dry-run; runs whoami gate
    ERPNextClient                                     # get/exists/list/create/update/call_method
    ensure_named(...) / ensure_by_filter(...) / set_single(...) / require_exists(...)
    print_summary(tally) -> int                       # returns process exit code

Grounding: token auth + /api/resource CRUD + /api/method call -> docs.frappe.io REST API.
Requires: requests
"""

from __future__ import annotations

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
# env / config (CLI flag > --env-file > OS environment)
# --------------------------------------------------------------------------- #
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


def add_connection_args(p):
    p.add_argument("--url", default=None, help="ERPNext base URL (default: env ERPNEXT_URL or http://localhost:8080)")
    p.add_argument("--api-key", default=None, help="API key (default: env ERPNEXT_API_KEY)")
    p.add_argument("--api-secret", default=None, help="API secret (default: env ERPNEXT_API_SECRET)")
    p.add_argument("--env-file", default=None, help="Path to a .env file to read URL/key/secret from")
    p.add_argument("--timeout", type=int, default=30, help="Per-request timeout seconds (default 30)")
    p.add_argument("--verbose", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="Print actions without calling ERPNext")
    p.add_argument("--update", action="store_true", help="Replace records that already exist instead of skipping")
    return p


def resolve_config(args) -> dict:
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


def log(verbose: bool, *a):
    if verbose:
        print(*a)


# --------------------------------------------------------------------------- #
# generic REST client
# --------------------------------------------------------------------------- #
class ERPNextClient:
    def __init__(self, base_url, key, secret, timeout=30, verbose=False):
        self.base = base_url
        self.timeout = timeout
        self.verbose = verbose
        self.s = requests.Session()
        self.s.headers.update({
            "Authorization": f"token {key}:{secret}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        })

    def _res(self, doctype, name=None):
        u = f"{self.base}/api/resource/{urllib.parse.quote(doctype)}"
        if name is not None:
            u += "/" + urllib.parse.quote(name, safe="")
        return u

    def whoami(self):
        r = self.s.get(f"{self.base}/api/method/frappe.auth.get_logged_user", timeout=self.timeout)
        r.raise_for_status()
        return r.json().get("message", "")

    def get(self, doctype, name):
        r = self.s.get(self._res(doctype, name), timeout=self.timeout)
        if r.status_code == 200:
            return r.json().get("data")
        if r.status_code in (403, 404):
            return None
        r.raise_for_status()
        return None

    def exists(self, doctype, name):
        return self.get(doctype, name) is not None

    def list(self, doctype, filters, limit=1, fields=None):
        params = {"filters": json.dumps(filters), "limit_page_length": limit}
        if fields:
            params["fields"] = json.dumps(fields)
        r = self.s.get(self._res(doctype), params=params, timeout=self.timeout)
        if r.status_code == 200:
            return r.json().get("data", [])
        if r.status_code in (403, 404):
            return []
        r.raise_for_status()
        return []

    def create(self, doctype, body):
        b = dict(body)
        b["doctype"] = doctype
        return self.s.post(self._res(doctype), data=json.dumps(b), timeout=self.timeout)

    def update(self, doctype, name, body):
        return self.s.put(self._res(doctype, name), data=json.dumps(body), timeout=self.timeout)

    def call_method(self, dotted_path, payload=None):
        """POST /api/method/<dotted.path> (for whitelisted server methods)."""
        url = f"{self.base}/api/method/{dotted_path}"
        return self.s.post(url, data=json.dumps(payload or {}), timeout=self.timeout)


def make_client(args):
    """Returns (client_or_None, cfg). None client => dry-run. Runs whoami gate otherwise."""
    cfg = resolve_config(args)
    if args.dry_run:
        print(f"[dry-run] target {cfg['url']} (no calls will be made)")
        return None, cfg
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
    return client, cfg


# --------------------------------------------------------------------------- #
# ensure helpers -- return: created | updated | skipped | failed
# --------------------------------------------------------------------------- #
def record_outcome(tally, outcome):
    tally[outcome] = tally.get(outcome, 0) + 1
    return outcome


def ensure_named(client, args, tally, doctype, name, body, label=""):
    tag = f"{doctype} '{name}'" + (f" ({label})" if label else "")
    if args.dry_run:
        log(args.verbose, f"  [dry-run] would ensure {tag}")
        return record_outcome(tally, "skipped")
    if client.exists(doctype, name):
        if args.update:
            r = client.update(doctype, name, body)
            if r.status_code == 200:
                print(f"  updated  {tag}")
                return record_outcome(tally, "updated")
            print(f"  FAILED update {tag}: {r.status_code} {r.text[:300]}")
            return record_outcome(tally, "failed")
        log(args.verbose, f"  exists   {tag} (skip; --update to overwrite)")
        return record_outcome(tally, "skipped")
    r = client.create(doctype, body)
    if r.status_code in (200, 201):
        print(f"  created  {tag}")
        return record_outcome(tally, "created")
    print(f"  FAILED   {tag}: {r.status_code} {r.text[:300]}")
    return record_outcome(tally, "failed")


def ensure_by_filter(client, args, tally, doctype, filters, body, label=""):
    desc = label or json.dumps(filters)
    tag = f"{doctype} [{desc}]"
    if args.dry_run:
        log(args.verbose, f"  [dry-run] would ensure {tag}")
        return record_outcome(tally, "skipped")
    found = client.list(doctype, filters, limit=1)
    if found:
        existing = found[0].get("name")
        if args.update and existing:
            r = client.update(doctype, existing, body)
            if r.status_code == 200:
                print(f"  updated  {tag} -> {existing}")
                return record_outcome(tally, "updated")
            print(f"  FAILED update {tag}: {r.status_code} {r.text[:300]}")
            return record_outcome(tally, "failed")
        log(args.verbose, f"  exists   {tag} -> {existing} (skip)")
        return record_outcome(tally, "skipped")
    r = client.create(doctype, body)
    if r.status_code in (200, 201):
        print(f"  created  {tag} -> {r.json().get('data', {}).get('name')}")
        return record_outcome(tally, "created")
    print(f"  FAILED   {tag}: {r.status_code} {r.text[:300]}")
    return record_outcome(tally, "failed")


def set_single(client, args, tally, doctype, body):
    tag = f"{doctype} (single)"
    if args.dry_run:
        log(args.verbose, f"  [dry-run] would set {tag} <- {body}")
        return record_outcome(tally, "skipped")
    r = client.update(doctype, doctype, body)
    if r.status_code == 200:
        print(f"  set      {tag} <- {body}")
        return record_outcome(tally, "updated")
    print(f"  FAILED   {tag}: {r.status_code} {r.text[:300]}")
    return record_outcome(tally, "failed")


def require_exists(client, args, doctype, name):
    """Verify a dependency exists; warn (never silently assume) if missing."""
    if args.dry_run or not name:
        return True
    if client.exists(doctype, name):
        return True
    print(f"  WARNING  dependency {doctype} '{name}' not found -- dependent record may fail. "
          f"Create it or pass a different value.")
    return False


def print_summary(tally) -> int:
    print("\nSummary:", ", ".join(f"{k}={v}" for k, v in sorted(tally.items())) or "(none)")
    failed = tally.get("failed", 0)
    if failed:
        print(f"FAILED: {failed} record(s) did not install.")
        return 1
    return 0
