#!/usr/bin/env python3
"""
01-seed-items-variants.py  --  erpnextEnh1 Item template + variant seeder (REST-only).

Creates the templated garment Items and their per-size variants used across the V6.x
quoting flow. Idempotent; uses the shared _seedlib.py scaffold.

What it ensures (grounded in DESIGN_6/03 sec 2 + official Item mechanics):
  - For each template family (default TH-TEE-RN-180, TH-POLO-PIQ-220, TH-HOOD-FLC-320):
      * a template Item with has_variants=1, variant_based_on="Item Attribute",
        attributes=[{attribute: "Size"}]
      * one variant Item per size S,M,L,XL with explicit, deterministic item_code
        "<template>-<size>" (e.g. TH-TEE-RN-180-M) and
        attributes=[{attribute:"Size", attribute_value:<size>}], variant_of=<template>.
  - Optionally (--with-fabric) a non-variant fabric Item.

Grounding (official sources, verified from frappe/erpnext@develop -- the v16 line):
  - DESIGN_6/03 sec 2: template TH-TEE-RN-180 (has_variants=1); variants
    TH-TEE-RN-180-S/M/L/XL linked via Item Variant Attribute (variant_of=template,
    attribute=Size, attribute_value=S/M/L/XL); "Same model for TH-POLO-PIQ-220-*
    and TH-HOOD-FLC-320-*" (DESIGN_6/03 lines 86-90, 114-121).
  - Item: reqd fields item_code (autoname field:item_code), item_group (Link), stock_uom
    (Link); has_variants (Check), variant_of (Link Item), variant_based_on
    (Select default "Item Attribute"), attributes (Table -> "Item Variant Attribute").
        erpnext/stock/doctype/item/item.json
  - Item Variant Attribute child: attribute (Link Item Attribute, reqd), attribute_value (Data).
        erpnext/stock/doctype/item_variant_attribute/item_variant_attribute.json
  - Variant item_code rule: make_variant_item_code() -> "{template_item_code}-{abbr}",
    where abbr is the Item Attribute Value abbr (00 seeds abbr == value, so size M -> "-M").
    Variant attributes are server-validated by validate_item_variant_attributes().
        erpnext/controllers/item_variant.py (create_variant / make_variant_item_code)

CAVEAT (flagged, not hallucinated):
  - FAB-COTTON-180GSM is NOT defined in DESIGN_6/03 (it appears only in a prior session
    handoff). It is therefore OFF by default and gated behind --with-fabric. Confirm the
    fabric SKU/UOM against the design before relying on it.
  - lead_time_days / safety_stock have NO values specified in 03, so they are unset unless
    you pass --lead-time-days / --safety-stock. No values are invented.

Examples:
  python 01-seed-items-variants.py --env-file ../../DynDiscProject6/IMPL-V6/.env --dry-run --verbose
  python 01-seed-items-variants.py --env-file ../../DynDiscProject6/IMPL-V6/.env --verbose
  python 01-seed-items-variants.py --templates TH-TEE-RN-180 --sizes S,M,L,XL --with-fabric
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _seedlib import (  # noqa: E402
    add_connection_args, make_client, ensure_named, require_exists, print_summary, record_outcome, log,
)


def main(argv=None):
    p = argparse.ArgumentParser(description="Seed templated Items + per-size variants via REST.")
    add_connection_args(p)
    p.add_argument("--templates", default="TH-TEE-RN-180,TH-POLO-PIQ-220,TH-HOOD-FLC-320",
                   help="Comma list of template item_codes (each gets size variants)")
    p.add_argument("--sizes", default="S,M,L,XL", help="Comma list of size attribute values")
    p.add_argument("--size-attribute", default="Size", help="Item Attribute name (seeded by 00)")
    p.add_argument("--item-group", default="Products", help="Item Group for garments (verified at runtime)")
    p.add_argument("--stock-uom", default="Nos", help="Stock UOM (seeded by 00)")
    p.add_argument("--brand", default="Tommy Hilfiger", help="Brand (seeded by 00)")
    p.add_argument("--lead-time-days", type=int, default=None, help="Optional; unset if not passed (not in 03)")
    p.add_argument("--safety-stock", type=float, default=None, help="Optional; unset if not passed (not in 03)")
    # fabric (NOT in 03 -- explicit opt-in)
    p.add_argument("--with-fabric", action="store_true", default=False,
                   help="Also seed a non-variant fabric Item (NOT in 03; confirm before use)")
    p.add_argument("--fabric-item", default="FAB-COTTON-180GSM")
    p.add_argument("--fabric-item-group", default="Raw Material")
    p.add_argument("--fabric-uom", default="Meter")
    args = p.parse_args(argv)

    templates = [t.strip() for t in args.templates.split(",") if t.strip()]
    sizes = [s.strip() for s in args.sizes.split(",") if s.strip()]
    if not templates or not sizes:
        sys.exit("FATAL: need at least one template and one size.")

    client, cfg = make_client(args)
    tally: dict = {}

    # dependencies seeded by 00 -- verify, don't assume
    require_exists(client, args, "Item Attribute", args.size_attribute)
    require_exists(client, args, "Item Group", args.item_group)
    require_exists(client, args, "UOM", args.stock_uom)
    require_exists(client, args, "Brand", args.brand)

    def base_fields(item_group):
        f = {"item_group": item_group, "stock_uom": args.stock_uom, "brand": args.brand}
        if args.lead_time_days is not None:
            f["lead_time_days"] = args.lead_time_days
        if args.safety_stock is not None:
            f["safety_stock"] = args.safety_stock
        return f

    for tmpl in templates:
        print(f"\n[template {tmpl}]")
        tbody = dict(base_fields(args.item_group))
        tbody.update({
            "item_code": tmpl,
            "item_name": tmpl,
            "has_variants": 1,
            "variant_based_on": "Item Attribute",
            "attributes": [{"attribute": args.size_attribute}],
        })
        ensure_named(client, args, tally, "Item", tmpl, tbody, label="template")

        print(f"[variants of {tmpl}]")
        for size in sizes:
            code = f"{tmpl}-{size}"   # deterministic; matches make_variant_item_code with abbr==value
            vbody = dict(base_fields(args.item_group))
            vbody.update({
                "item_code": code,
                "item_name": code,
                "variant_of": tmpl,
                "variant_based_on": "Item Attribute",
                "attributes": [{"attribute": args.size_attribute, "attribute_value": size}],
            })
            ensure_named(client, args, tally, "Item", code, vbody, label=f"{args.size_attribute}={size}")

    if args.with_fabric:
        print(f"\n[fabric {args.fabric_item}]  (NB: not defined in DESIGN_6/03)")
        require_exists(client, args, "Item Group", args.fabric_item_group)
        require_exists(client, args, "UOM", args.fabric_uom)
        fbody = {
            "item_code": args.fabric_item,
            "item_name": args.fabric_item,
            "item_group": args.fabric_item_group,
            "stock_uom": args.fabric_uom,
            "has_variants": 0,
        }
        ensure_named(client, args, tally, "Item", args.fabric_item, fbody, label="fabric / raw material")

    return print_summary(tally)


if __name__ == "__main__":
    raise SystemExit(main())
