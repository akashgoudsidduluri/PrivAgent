"""
READ-ONLY DIAGNOSIS — is the reasoner-layer `person_name` rule misfiring on
ordinary shopping vocabulary?

Three separate real-Chrome runs were refused at cycle 1 with
    "Model-emitted reason rejected by text-safety scan (rule=person_name)"
while a direct Groq probe at the same moment returned HTTP 200.

This asks whether the rule fires on PRODUCT names (a false positive) rather
than on anything resembling an actual person's name. Nothing is modified: this
only reads the rule and reports what it matches.

Model-authored text is not user PII and is printed here only to characterise
the rule. No user-supplied sensitive value exists in this fixture.
"""
import sys

sys.path.insert(0, ".")

from app.text_safety import scan_reason_text

SAMPLES = [
    # Ordinary shopping / catalog vocabulary a reasoner plausibly writes.
    "Open the store catalog and view the first product listed",
    "Navigate to the commerce catalog to browse products",
    "Clicking the first product card to view its details",
    "Alpha Widget is the first product in the catalog listing",
    "Office Bag is the first product shown in the catalog",
    "XXL Black Baggy Bag is the first qualifying product",
    "Go to the catalog page and open the first product",
    # Genuinely person-shaped strings, as a NEGATIVE control for the diagnosis.
    "Account holder Rahul Sharma",
    "Contact Rahul Sharma for details",
]

print(f"{'rule fired?':<12} {'rule':<14} reason text")
print("-" * 100)
for s in SAMPLES:
    f = scan_reason_text(s)
    if f:
        print(f"{'FIRED':<12} {f.rule:<14} {s!r}")
    else:
        print(f"{'-':<12} {'-':<14} {s!r}")
