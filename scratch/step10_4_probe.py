"""STEP 10.4 Part 1 — exact reproduction + characterization of the P1.

Read-only probe. Does not modify any production file.
"""
from __future__ import annotations

import re
import sys

sys.path.insert(0, "backend")

from app.text_safety import (  # noqa: E402
    FULL_NAME_PATTERN,
    REASON_ACTION_VERBS,
    REASON_NAME_PATTERN,
    _starts_with_action_verb,
    scan_reason_text,
    scan_text,
)

SEP = "=" * 78

CASES = [
    "The Browse Catalog link leads to the product listing.",
    "The Browse Catalog link is the catalog page for this store.",
    "Browse Catalog is the listing page.",
    "Search Products returns a search form.",
    "Sign In to Shop opens the login page.",
    "ApexCart is the store brand in the header.",
    "Clicked Account Details",
    "Opened the account details section.",
    "Account holder Rahul Sharma requires service",
    "Rahul Sharma",
    "Clicking Account Details for Rahul Sharma",
    "Navigate to Order History for John Smith",
]


def show(label: str, text: str) -> None:
    print(f"\n{label}: {text!r}")
    for name, pat in (("FULL_NAME_PATTERN", FULL_NAME_PATTERN),
                      ("REASON_NAME_PATTERN", REASON_NAME_PATTERN)):
        hits = [m.group(0) for m in pat.finditer(text)]
        print(f"    {name:<20} hits={hits}")
    first_word = re.split(r"\s+", text.strip().lower(), maxsplit=1)[0] if text.strip() else ""
    stripped = first_word.rstrip(".,;:!")
    print(f"    first_word          ={first_word!r} -> stripped={stripped!r} "
          f"in REASON_ACTION_VERBS={stripped in REASON_ACTION_VERBS}")
    print(f"    _starts_with_action_verb = {_starts_with_action_verb(text)}")
    f = scan_reason_text(text)
    if f is None:
        print("    scan_reason_text    = ALLOW (None)")
    else:
        print(f"    scan_reason_text    = BLOCK rule={f.rule!r} span={f.snippet!r}")
    ft = scan_text(text)
    print(f"    scan_text (field)   = {'ALLOW' if ft is None else f'BLOCK {ft.rule!r}'}")


print(SEP)
print("PART 1 — EXACT REPRODUCTION")
print(SEP)
for c in CASES:
    show("reason", c)

print()
print(SEP)
print("FIXTURE VOCABULARY — bare TitleCase labels")
print(SEP)
for w in ["Browse Catalog", "Search Products", "ApexCart", "Sign In to Shop",
          "Product Listing", "View Details", "Add to Cart", "Checkout",
          "Account Settings", "Order History", "Store Catalog"]:
    show("bare", w)

print()
print(SEP)
print("SYNTHETIC PERSON NAMES — must stay blocked")
print(SEP)
for n in ["Aarav Sharma", "Priya Reddy", "John Smith", "Maria Garcia"]:
    show("name", n)

print()
print(SEP)
print("KEY OBSERVATION — current exemption is WHOLE-REASON")
print(SEP)
leak = "Clicking Account Details for Rahul Sharma"
f = scan_reason_text(leak)
print(f"  {leak!r}")
print(f"  -> {'ALLOWED (person name NOT detected)' if f is None else f'BLOCK {f}'}")
print("  The action-verb PREFIX exempts the ENTIRE reason, not just the span.")
print("  REASON_NAME_PATTERN would match:", [m.group(0) for m in REASON_NAME_PATTERN.finditer(leak)])
print("  ...but the gate short-circuits before the pattern is consulted.")

print()
print(f"REASON_ACTION_VERBS size = {len(REASON_ACTION_VERBS)}")
print("note: 'the' is not a member ->", "the" in REASON_ACTION_VERBS)
