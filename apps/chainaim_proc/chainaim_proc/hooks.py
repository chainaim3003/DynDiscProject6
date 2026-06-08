app_name = "chainaim_proc"
app_title = "Chainaim Proc"
app_publisher = "ChainAIM"
app_description = "ERPNext customization layer (Custom Fields, fixtures, webhooks) for the DynDisc V6 agent. REST-only / GPL-safe."
app_email = "dev@chainaim.local"
app_license = "mit"

# Fixtures
# --------
# Export/import the erpnextEnh1 Custom Fields as fixtures. This makes the 38
# fields defined in chainaim_proc/custom/*.json portable across sites via
# `bench export-fixtures` / `bench migrate`. The REST seed script
# (../../seed/02-install-custom-fields.py) installs the SAME fields without bench;
# this hook keeps the app bench-installable too, for parity.
fixtures = [
    {
        "doctype": "Custom Field",
        "filters": {
            "dt": ["in", ["Opportunity", "Opportunity Item", "Quotation", "Quotation Item"]]
        },
    },
    # Property Setters created by THIS app (none yet). is_system_generated=0
    # excludes stock ERPNext UI/print defaults that merely sit on these doctypes,
    # matching seed/90-export-fixtures.py's default so both install paths agree.
    {
        "doctype": "Property Setter",
        "filters": {
            "doc_type": ["in", ["Opportunity", "Opportunity Item", "Quotation", "Quotation Item"]],
            "is_system_generated": 0,
        },
    },
]

# Document Events
# ---------------
# Webhooks to the IMPL-V6 /sync endpoint are registered via REST (seed
# 03-install-webhooks.py), not via doc_events, to keep this app code-free and
# GPL-safe. Left here as the extension point if in-process hooks are needed later.
# doc_events = {
#     "Item": {"on_update": "chainaim_proc.sync.item_on_update"},
# }

# Automatically update python controller files with type annotations for this app.
export_python_type_annotations = True

# Require all whitelisted methods to have type annotations
require_type_annotated_api_methods = True
