#!/usr/bin/env python3
"""
03-install-webhooks.py  --  erpnextEnh1 outbound Webhook installer (REST-only).

Registers ERPNext outbound Webhooks that POST to an IMPL-V6 /sync endpoint on the
configured doc events. Idempotent; uses the shared _seedlib.py scaffold.

================================  DESIGN-GAP FLAG  ================================
The baseline design docs DESIGN_6/01..07 do NOT define inbound ERPNext->IMPL-V6
webhooks or a /sync endpoint. DESIGN_6/04-Orchestration-Design.md describes the
ERPNext integration as REST READ/WRITE (e.g. line 57: Inventory reads `Bin` live via
`/api/resource/Bin`); the only webhooks it mentions (lines 63/228/318) belong to the
DEFERRED DvP saga (external bank/chain), explicitly "not built for these 10 prompts".

This installer exists because a prior-session handoff listed it. Therefore:
  - The target URL (--sync-url) is a REQUIRED input with NO fabricated default.
  - The payload contract (--payload-template) defaults to a minimal, clearly-labeled
    ASSUMED envelope -- it is NOT taken from any design doc. Confirm/replace it against
    the actual IMPL-V6 /sync handler before relying on it.
  - Before running this, confirm webhooks are actually part of the architecture (vs the
    REST read/write model the design describes).
==================================================================================

Webhooks registered (5; from handoff):
  Item        -> on_update     Customer  -> on_update
  Sales Order -> on_submit     Sales Order -> on_cancel
  Bin         -> on_change

Grounding (official source, verified frappe/frappe@develop -- the v16 line):
  - Webhook DocType: autoname="prompt" (name supplied explicitly on insert);
    fields: webhook_doctype (Link DocType, reqd), webhook_docevent (Select; valid:
    after_insert/on_update/on_submit/on_cancel/on_trash/on_update_after_submit/
    on_change/workflow_transition), request_url (Small Text, reqd), request_method
    (Select POST/PUT/DELETE, reqd, default POST), request_structure (Select ""/Form
    URL-Encoded/JSON), webhook_json (Code/Jinja), webhook_data (Table->Webhook Data),
    enabled (Check default 1), enable_security (Check), webhook_secret (Password),
    timeout (Int default 5).
        frappe/integrations/doctype/webhook/webhook.json
  - When enable_security=1 + webhook_secret set, frappe signs the body with HMAC-SHA256
    and sends header X-Frappe-Webhook-Signature.

Examples:
  python 03-install-webhooks.py --env-file ../../DynDiscProject6/IMPL-V6/.env \
      --sync-url https://impl-v6.example/sync --dry-run --verbose
  python 03-install-webhooks.py --env-file ../../DynDiscProject6/IMPL-V6/.env \
      --sync-url https://impl-v6.example/sync --webhook-secret "$SYNC_SECRET"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _seedlib import (  # noqa: E402
    add_connection_args, make_client, ensure_named, print_summary,
)

# (logical name, target DocType, doc event) -- name used as the prompt-autoname doc name
WEBHOOKS = [
    ("jkc-item-on-update",          "Item",        "on_update"),
    ("jkc-customer-on-update",      "Customer",    "on_update"),
    ("jkc-sales-order-on-submit",   "Sales Order", "on_submit"),
    ("jkc-sales-order-on-cancel",   "Sales Order", "on_cancel"),
    ("jkc-bin-on-change",           "Bin",         "on_change"),
]

# ASSUMED minimal payload (NOT from a design doc). __EVENT__/__DOCTYPE__ are filled
# per-webhook via .replace(); {{ doc.* }} are Jinja expressions evaluated by frappe at
# fire time. (Built as a literal string to avoid str.format colliding with JSON/Jinja braces.)
DEFAULT_PAYLOAD_TEMPLATE = (
    '{\n'
    '  "event": "__EVENT__",\n'
    '  "doctype": "__DOCTYPE__",\n'
    '  "name": "{{ doc.name }}",\n'
    '  "modified": "{{ doc.modified }}"\n'
    '}'
)


def build_webhook_body(name, doctype, event, url, method, template, secret):
    webhook_json = template.replace("__EVENT__", event).replace("__DOCTYPE__", doctype)
    body = {
        "name": name,                       # prompt-autoname: supply explicitly
        "webhook_doctype": doctype,
        "webhook_docevent": event,
        "request_url": url,
        "request_method": method,
        "request_structure": "JSON",
        "webhook_json": webhook_json,
        "enabled": 1,
        "timeout": 5,
    }
    if secret:
        body["enable_security"] = 1
        body["webhook_secret"] = secret
    return body


def main(argv=None):
    p = argparse.ArgumentParser(description="Install ERPNext outbound Webhooks via REST.")
    add_connection_args(p)
    p.add_argument("--sync-url", default=os.environ.get("WEBHOOK_SYNC_URL"),
                   help="REQUIRED for a real run: IMPL-V6 /sync endpoint URL (no default; "
                        "or set env WEBHOOK_SYNC_URL). NOT defined by the design docs.")
    p.add_argument("--request-method", default="POST", choices=["POST", "PUT", "DELETE"])
    p.add_argument("--webhook-secret", default=os.environ.get("WEBHOOK_SECRET"),
                   help="If set, enables HMAC security (X-Frappe-Webhook-Signature).")
    p.add_argument("--payload-template", default=None,
                   help="Path to a file with a custom Jinja JSON body ({event}/{doctype} "
                        "(__EVENT__/__DOCTYPE__ placeholders + {{ doc.* }} Jinja). "
                        "Default = ASSUMED minimal envelope.")
    p.add_argument("--only", default="all",
                   help="Comma list of webhook logical names to install (default: all)")
    args = p.parse_args(argv)

    url = args.sync_url
    if not args.dry_run and not url:
        sys.exit("FATAL: --sync-url is required for a real run (the design docs do not "
                 "define this endpoint). Pass --sync-url or set WEBHOOK_SYNC_URL.")
    if args.dry_run and not url:
        url = "<SET --sync-url>"

    template = DEFAULT_PAYLOAD_TEMPLATE
    if args.payload_template:
        template = Path(args.payload_template).read_text(encoding="utf-8")

    if args.only.strip().lower() == "all":
        selected = WEBHOOKS
    else:
        want = {s.strip() for s in args.only.split(",") if s.strip()}
        selected = [w for w in WEBHOOKS if w[0] in want]
        unknown = want - {w[0] for w in WEBHOOKS}
        if unknown:
            sys.exit(f"FATAL: unknown --only entries: {sorted(unknown)}. "
                     f"Valid: {[w[0] for w in WEBHOOKS]}")

    print("DESIGN-GAP: webhooks/'/sync' are NOT defined in DESIGN_6/01..07 "
          "(design uses REST read/write). Confirm contract before relying on this.")
    if not args.webhook_secret:
        print("NOTE: no --webhook-secret -> webhooks unsigned. Set one for production.")

    client, cfg = make_client(args)
    tally: dict = {}
    print(f"\nTarget /sync URL: {url}")
    for name, doctype, event in selected:
        body = build_webhook_body(name, doctype, event, url, args.request_method,
                                  template, args.webhook_secret)
        print(f"\n[{name}]  {doctype} -> {event}")
        if args.verbose and args.dry_run:
            print("  body:", json.dumps({k: v for k, v in body.items()
                                         if k != "webhook_secret"}, indent=2)[:600])
        ensure_named(client, args, tally, "Webhook", name, body, label=f"{doctype}/{event}")

    return print_summary(tally)


if __name__ == "__main__":
    raise SystemExit(main())
