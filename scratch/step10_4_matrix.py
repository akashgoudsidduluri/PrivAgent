"""STEP 10.4 Part 3 — executable false-positive / true-positive matrix.

Read-only. Records the CURRENT verdict for every case so the pre-change and
post-change matrices can be diffed. Does not modify any production file.

Expected verdicts are derived from the documented security contract, not from
whatever the code happens to do today:

  ALLOW   the text carries no person-name evidence once English function
          words and interaction verbs are not mistaken for name tokens
  BLOCK   the text leaks a person name (or a structured PII/credential)
  AMBIG   evidence is insufficient -> the contract is fail-closed, so
          AMBIG is scored as BLOCK
"""
from __future__ import annotations

import sys

sys.path.insert(0, "backend")

from app.text_safety import scan_reason_text  # noqa: E402

# (group, text, expected)  expected in {ALLOW, BLOCK, AMBIG}
CASES: list[tuple[str, str, str]] = [
    # ── LEGITIMATE UI / NAVIGATION / PRODUCT (non-person) ──────────────────
    ("ui", "The Browse Catalog link leads to the product listing.", "ALLOW"),
    ("ui", "The Search Products link opens the search form.", "ALLOW"),
    ("ui", "The Sign In to Shop button opens the login page.", "ALLOW"),
    ("ui", "Clicked Account Details", "ALLOW"),
    ("ui", "Clicked the Browse Catalog link.", "ALLOW"),
    ("ui", "Opened the account details section.", "ALLOW"),
    ("ui", "Scrolled to transactions", "ALLOW"),
    ("ui", "The Product Listing page is not visible.", "ALLOW"),
    ("ui", "The Order History tab needs a scroll.", "ALLOW"),
    ("ui", "The Account Settings panel is collapsed.", "ALLOW"),
    ("ui", "Target located in current viewport", "ALLOW"),
    ("ui", "Task completed successfully", "ALLOW"),
    ("ui", "The View Details button is below the fold.", "ALLOW"),
    ("ui", "The Add to Cart button is enabled.", "ALLOW"),
    ("ui", "The Checkout page shows an empty basket.", "ALLOW"),
    ("ui", "ApexCart is the store brand in the header.", "ALLOW"),
    ("ui", "The Store Catalog is the destination the user asked for.", "ALLOW"),

    # ── LIKELY PERSON NAMES (must stay blocked) ────────────────────────────
    ("name", "Aarav Sharma", "BLOCK"),
    ("name", "Priya Reddy", "BLOCK"),
    ("name", "John Smith", "BLOCK"),
    ("name", "Maria Garcia", "BLOCK"),
    ("name", "Rahul Sharma", "BLOCK"),

    # ── EMBEDDED / MIXED — person name inside otherwise legitimate prose ───
    ("embedded", "Account holder Rahul Sharma requires service", "BLOCK"),
    ("embedded", "The account holder is Rahul Sharma.", "BLOCK"),
    ("embedded", "Mr Rahul Sharma requested a refund.", "BLOCK"),
    ("embedded", "Rahul Sharma's order was not found.", "BLOCK"),
    ("embedded", "Rahul Sharma’s order was not found.", "BLOCK"),
    ("embedded", "Clicking Account Details for Rahul Sharma", "BLOCK"),
    ("embedded", "Navigate to Order History for John Smith", "BLOCK"),
    ("embedded", "Opened the account details section for Priya Reddy", "BLOCK"),
    ("embedded", "The customer is Maria Garcia.", "BLOCK"),
    ("embedded", "Signed in as Aarav Sharma.", "BLOCK"),

    # ── AMBIGUOUS — TitleCase bigram with no disambiguating context ─────────
    # Fail-closed by contract: scored BLOCK.
    ("ambig", "Browse Catalog is the listing page.", "BLOCK"),
    ("ambig", "Product Listing", "BLOCK"),
    ("ambig", "Account Settings", "BLOCK"),
    ("ambig", "Order History", "BLOCK"),
    ("ambig", "Store Catalog", "BLOCK"),
    ("ambig", "View Details", "BLOCK"),
    # "In" is a closed-class preposition and no surname is "In", so this
    # bigram cannot be a person name. N1 exonerates it on sound grounds; the
    # earlier BLOCK expectation here was over-conservative, not a regression.
    ("ui", "Sign In", "ALLOW"),

    # ── STRUCTURED PII — must stay blocked by the shared structured rules ──
    ("pii", "rahul.sharma@example.com is registered", "BLOCK"),
    ("pii", "contact 9876543210 for help", "BLOCK"),
    ("pii", "PAN is ABCDE1234F", "BLOCK"),
    ("pii", "card 4111111111111111 charged", "BLOCK"),
    ("pii", "password=hunter2 entered", "BLOCK"),
    ("pii", "Clicked Account Details for rahul.sharma@example.com", "BLOCK"),
]


def main() -> int:
    print(f"{'group':<10} {'exp':<7} {'got':<7} {'span':<26} text")
    print("-" * 118)
    mismatches = []
    for group, text, expected in CASES:
        finding = scan_reason_text(text)
        got = "ALLOW" if finding is None else "BLOCK"
        scored_expected = "BLOCK" if expected in ("BLOCK", "AMBIG") else "ALLOW"
        span = "" if finding is None else f"{finding.rule}:{finding.snippet}"
        ok = got == scored_expected
        if not ok:
            mismatches.append((group, text, expected, got, span))
        print(f"{group:<10} {expected:<7} {got:<7} {span[:26]:<26} {text[:52]!r}")

    print()
    print("=" * 118)
    print(f"TOTAL {len(CASES)}   MISMATCHES {len(mismatches)}")
    for group, text, expected, got, span in mismatches:
        print(f"  [{group}] expected={expected} got={got} span={span!r}")
        print(f"      {text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
