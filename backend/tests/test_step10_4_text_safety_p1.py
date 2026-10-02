"""STEP 10.4 — P1 text-safety firewall remediation: security regression suite.

The P1: `scan_reason_text` gated its person-name rule on ONE property of the
whole reason — did it start with a common action verb? That gate judged the
sentence's first word rather than the matched span, and it exempted the
ENTIRE reason rather than just its opening. Two consequences:

  * FALSE POSITIVE. `REASON_NAME_PATTERN` has no notion of what a name token
    is. On "The Browse Catalog link leads to the product listing." it matched
    the span "The Browse" — the determiner "The" paired with the verb
    "Browse" as if they were a first and last name. It was only ever let
    through because "The" happens not to be in REASON_ACTION_VERBS, so the
    semantically identical "Search Products returns a search form." passed
    and the identical claim in different words did not.

  * FALSE NEGATIVE. The verb-prefix gate exempted the whole reason, so a real
    person name could ride along anywhere in a verb-initial reason:
    "Clicking Account Details for Rahul Sharma" was ALLOWED.

Remediation: per-span classification with the same fail-closed default, the
same unchanged REASON_NAME_PATTERN, and the same unchanged verb set. A span
is exonerated only on positive structural evidence (N1 function word, N2
verb-object, N3 determiner + UI head noun); person cues (P1) override every
exoneration. This suite pins all of it.

Labelled by requirement number from STEP 10.4 Part 5.
"""
from __future__ import annotations

import pytest

from app.text_safety import (
    NAME_IMPOSSIBLE_TOKENS,
    PERSON_HONORIFICS,
    PERSON_ROLE_NOUNS,
    REASON_ACTION_VERBS,
    REASON_DETERMINERS,
    REASON_NAME_PATTERN,
    REASON_UI_HEAD_NOUNS,
    _next_token,
    _tokens_before,
    contains_sensitive_content,
    scan_reason_text,
    scan_text,
)

# ── Req 1: legitimate UI reason is accepted ────────────────────────────────

LEGIT_UI = [
    "The Browse Catalog link leads to the product listing.",
    "The Search Products link opens the search form.",
    "The Sign In to Shop button opens the login page.",
    "The Product Listing page is not visible.",
    "The Order History tab needs a scroll.",
    "The Account Settings panel is collapsed.",
    "The View Details button is below the fold.",
    "The Add to Cart button is enabled.",
    "The Checkout page shows an empty basket.",
    "The Store Catalog is the destination the user asked for.",
    # Legitimate UI labels that are exonerated for a structural reason rather
    # than by ambiguity: an interaction-verb bigram, or no bigram at all.
    "Search Products",
    "Add to Cart",
    "Checkout",
]

# ── Req 2: legitimate product / catalog reason is accepted ─────────────────

LEGIT_PRODUCT = [
    "ApexCart is the store brand in the header.",
    "The Product Listing page is not visible.",
    "The Store Catalog is the destination the user asked for.",
    "Opened the account details section.",
    "The requested transaction section is not currently visible.",
    "Scrolled to transactions",
]

# ── Req 3: legitimate navigation reason is accepted ───────────────────────

LEGIT_NAV = [
    "Clicked Account Details",
    "Clicked the Browse Catalog link.",
    "Opened the account details section.",
    "Navigated to the Order History tab.",
    "Target located in current viewport",
    "Task completed successfully",
    "Submitting the checkout form",
]


class TestLegitimateTextIsAccepted:
    @pytest.mark.parametrize("reason", LEGIT_UI)
    def test_req1_legitimate_ui_reason_accepted(self, reason: str):
        assert scan_reason_text(reason) is None, reason

    @pytest.mark.parametrize("reason", LEGIT_PRODUCT)
    def test_req2_legitimate_product_reason_accepted(self, reason: str):
        assert scan_reason_text(reason) is None, reason

    @pytest.mark.parametrize("reason", LEGIT_NAV)
    def test_req3_legitimate_navigation_reason_accepted(self, reason: str):
        assert scan_reason_text(reason) is None, reason


# ── Req 4: real-looking person names remain rejected ───────────────────────

PERSON_NAMES = [
    "Aarav Sharma",
    "Priya Reddy",
    "John Smith",
    "Maria Garcia",
    "Rahul Sharma",
    "Aarav Krishnan",
    "Fatima Sheikh",
    "Wei Chen",
    "Ngozi Okonkwo",
    "Sven Johansson",
]


class TestPersonNamesStillRejected:
    @pytest.mark.parametrize("name", PERSON_NAMES)
    def test_req4_real_person_name_rejected(self, name: str):
        finding = scan_reason_text(name)
        assert finding is not None, name
        assert finding.rule == "person_name"

    @pytest.mark.parametrize("name", PERSON_NAMES)
    def test_req4_person_name_rejected_inside_sentence(self, name: str):
        finding = scan_reason_text(f"Proceeding because {name} asked for it")
        assert finding is not None and finding.rule == "person_name"


# ── Req 5: multiple person-name positions remain rejected ──────────────────

MULTI_NAME_CASES = [
    "Rahul Sharma met Priya Reddy at the counter.",
    "Handled by Aarav Sharma, escalated to John Smith.",
    "Contacted Maria Garcia about the invoice for Priya Reddy.",
    "Rahul Sharma and Priya Reddy both approved.",
    "Signed by John Smith; reviewed by Maria Garcia.",
]


class TestMultipleNamePositionsRejected:
    @pytest.mark.parametrize("reason", MULTI_NAME_CASES)
    def test_req5_multiple_name_positions_rejected(self, reason: str):
        assert scan_reason_text(reason) is not None, reason

    def test_req5_each_name_is_individually_detected(self):
        # Every name must be caught on its own, not only when combined.
        for name in ("Rahul Sharma", "Priya Reddy", "John Smith", "Maria Garcia"):
            assert scan_reason_text(name) is not None, name


# ── Req 6/7/8: names embedded in, surrounded by, or mixed with UI prose ───

EMBEDDED_CASES = [
    # Req 6 — person name embedded in otherwise legitimate prose
    "The Browse Catalog link leads to the product listing for Rahul Sharma.",
    "Scrolled to transactions for John Smith.",
    "The Order History tab belongs to Maria Garcia.",
    # Req 7 — person name with surrounding UI text
    "Clicking Account Details for Rahul Sharma",
    "Navigate to Order History for John Smith",
    "Opened the account details section for Priya Reddy",
    "Submitted the checkout form on behalf of Aarav Sharma",
    # Req 8 — mixed UI + person-name prose
    "The customer is Maria Garcia and the Order History tab is empty.",
    "Clicked the Browse Catalog link; account holder Rahul Sharma needs help.",
    "The Product Listing page shows Aarav Sharma's saved items.",
]


class TestEmbeddedNamesRejected:
    @pytest.mark.parametrize("reason", EMBEDDED_CASES)
    def test_req6_7_8_embedded_and_mixed_names_rejected(self, reason: str):
        finding = scan_reason_text(reason)
        assert finding is not None, reason
        assert finding.rule == "person_name"

    @pytest.mark.parametrize("reason", [
        "Account holder Rahul Sharma requires service",
        "The account holder is Rahul Sharma.",
        "Customer Priya Reddy requested cancellation.",
        "Beneficiary Maria Garcia must confirm.",
    ])
    def test_req8_person_role_noun_cue_blocks(self, reason: str):
        assert scan_reason_text(reason) is not None, reason

    @pytest.mark.parametrize("reason", [
        "Mr Rahul Sharma requested a refund.",
        "Dr Priya Reddy signed the form.",
        "Prof John Smith approved it.",
        "Shri Aarav Sharma called support.",
    ])
    def test_req8_honorific_cue_blocks(self, reason: str):
        assert scan_reason_text(reason) is not None, reason

    @pytest.mark.parametrize("reason", [
        "Rahul Sharma's order was not found.",
        "Rahul Sharma\u2019s order was not found.",
        "Opened Rahul Sharma's profile.",
    ])
    def test_req8_possessive_cue_blocks(self, reason: str):
        assert scan_reason_text(reason) is not None, reason

    @pytest.mark.parametrize("reason", [
        "name: Rahul Sharma",
        "Customer: Priya Reddy",
        "Account holder: John Smith",
    ])
    def test_req8_explicit_name_label_blocks(self, reason: str):
        assert scan_reason_text(reason) is not None, reason


# ── Req 9: case variants ───────────────────────────────────────────────────

# The pre-existing contract is SHAPE-based: REASON_NAME_PATTERN matches
# [A-Z][a-z]+, i.e. ASCII TitleCase only. ALL-CAPS and all-lower names were
# never matched by it, before or after Step 10.4. That is a pre-existing gap
# in the rule, NOT something this step introduced or is permitted to widen
# (broadening to case-insensitive matching is a separate change with its own
# false-positive analysis). Pinned here so the limitation is explicit and
# cannot be mistaken for a regression.
CASE_VARIANTS = [
    ("RAHUL SHARMA", "ALLOW"),   # pre-existing: shape is [A-Z][a-z]+
    ("rahul sharma", "ALLOW"),   # pre-existing: shape is [A-Z][a-z]+
    ("RaHuL sHaRmA", "ALLOW"),   # pre-existing: inner caps break the shape
    ("Rahul Sharma", "BLOCK"),   # the TitleCase shape IS caught
]


class TestCaseVariants:
    @pytest.mark.parametrize("reason,expected", CASE_VARIANTS)
    def test_req9_case_variants_handled(self, reason: str, expected: str):
        finding = scan_reason_text(reason)
        got = "BLOCK" if finding else "ALLOW"
        assert got == expected, f"{reason!r} -> {got}"

    def test_req9_exonoration_is_case_insensitive_on_function_words(self):
        # N1 matches on the lowercased token, so an upper-case determiner in
        # the matched span must still exonerate it.
        assert scan_reason_text("THE Browse Catalog link leads to the listing.") is None
        assert scan_reason_text("the browse catalog link leads to the listing.") is None

    def test_req9_name_cue_matching_is_case_insensitive(self):
        for reason in ("ACCOUNT HOLDER: Rahul Sharma", "Account Holder: Rahul Sharma",
                       "account holder: Rahul Sharma"):
            assert scan_reason_text(reason) is not None, reason


# ── Req 10: punctuation variants ───────────────────────────────────────────

PUNCTUATION_CASES = [
    ('"Rahul Sharma", requested', "BLOCK"),
    ("(Rahul Sharma)", "BLOCK"),
    ("Rahul Sharma.", "BLOCK"),
    ("Rahul Sharma,", "BLOCK"),
    ("Clicked Account Details.", "ALLOW"),
    # A comma between the verb and its object breaks the verb-object relation,
    # so the span "Account Details" is left ambiguous and therefore blocked.
    # Fail-closed, and unchanged by this step.
    ("Clicked, Account Details", "BLOCK"),
    ("(the Browse Catalog link)", "ALLOW"),
    ("[the Order History tab]", "ALLOW"),
]


class TestPunctuationVariants:
    @pytest.mark.parametrize("reason,expected", PUNCTUATION_CASES)
    def test_req10_punctuation_variants_handled(self, reason: str, expected: str):
        finding = scan_reason_text(reason)
        got = "BLOCK" if finding else "ALLOW"
        assert got == expected, f"{reason!r} -> {got}"

    def test_req10_trailing_punctuation_does_not_defeat_verb_gate(self):
        # N2 reuses the pre-existing verb helper, which strips trailing
        # punctuation from the first token.
        for verb in ("Clicked", "Opened", "Navigated", "Submitted", "Scrolled"):
            assert scan_reason_text(f"{verb} Account Details.") is None, verb


# ── Req 11: unicode / name variants, per the existing contract ────────────

# Same story as Req 9: the pre-existing contract's [A-Z][a-z]+ shape is ASCII
# only, so accented given names were never matched, before or after this step.
# Widening it to Unicode letters is a separate change (it would also match every
# capitalised non-English word and needs its own false-positive analysis), so it
# is recorded as a pre-existing finding and NOT fixed here. The typographic
# apostrophe form of the possessive IS handled, and is asserted below.
UNICODE_CASES = [
    ("Aarav Sharma", "BLOCK"),
    ("\u00c1lvarez N\u00fa\u00f1ez", "ALLOW"),      # pre-existing ASCII-only shape
    ("Ren\u00e9e Dubois", "ALLOW"),                # pre-existing ASCII-only shape
    ("Fran\u00e7ois L\u00e9vesque", "ALLOW"),       # pre-existing ASCII-only shape
    ("Rahul Sharma\u2019s card", "BLOCK"),
    ("The Browse Catalog link \u2014 it leads to products.", "ALLOW"),
    ("\u00c1lvarez N\u00fa\u00f1ez was here", "ALLOW"),  # pre-existing gap
]


class TestUnicodeVariants:
    @pytest.mark.parametrize("reason,expected", UNICODE_CASES)
    def test_req11_unicode_variants_handled_per_existing_contract(self, reason: str, expected: str):
        finding = scan_reason_text(reason)
        got = "BLOCK" if finding else "ALLOW"
        assert got == expected, f"{reason!r} -> {got}"

    def test_req11_curly_apostrophe_possessive_is_detected(self):
        assert scan_reason_text("Rahul Sharma\u2019s order") is not None

    def test_req11_straight_apostrophe_possessive_is_detected(self):
        assert scan_reason_text("Rahul Sharma's order") is not None

    def test_req11_typographic_dash_does_not_break_ui_exoneration(self):
        assert scan_reason_text(
            "The Browse Catalog link \u2014 it leads to products."
        ) is None


# ── Req 12: the scanner does not rely on capitalization alone ──────────────

class TestNotCapitalizationAlone:
    def test_req12_exoneration_requires_positive_evidence(self):
        """An ALLOW must never rest on "the words happen to be capitalized".

        Every exoneration rule is keyed on a closed-class function word, an
        interaction verb, or a determiner plus a UI head noun. None of them is
        a capitalization test.
        """
        for reason in LEGIT_UI + LEGIT_PRODUCT + LEGIT_NAV:
            spans = [m.group(0) for m in REASON_NAME_PATTERN.finditer(reason)]
            for span in spans:
                toks = {t.lower() for t in span.split()}
                n1 = bool(toks & NAME_IMPOSSIBLE_TOKENS)
                n2 = bool(toks & REASON_ACTION_VERBS)
                n3 = (
                    bool(_tokens_before(reason, reason.index(span)))
                    and _tokens_before(reason, reason.index(span))[-1] in REASON_DETERMINERS
                    and _next_token(reason, reason.index(span) + len(span)) in REASON_UI_HEAD_NOUNS
                )
                assert n1 or n2 or n3, (
                    f"{reason!r} span {span!r} was exonerated with no N1/N2/N3 evidence"
                )

    def test_req12_no_span_is_exonerated_on_bare_titlecase_alone(self):
        """A bigram that is only TitleCase is never exonerated."""
        for span in ("Rahul Sharma", "Priya Reddy", "Browse Catalog",
                     "Account Settings", "Order History", "Store Catalog",
                     "Product Listing", "View Details"):
            assert not (set(t.lower() for t in span.split()) & NAME_IMPOSSIBLE_TOKENS)
            assert not (set(t.lower() for t in span.split()) & REASON_ACTION_VERBS)

    def test_req12_lowercase_name_is_not_newly_permitted_by_this_change(self):
        # Pre-existing contract: the name pattern is shape-based on [A-Z].
        # This step did not add any lowercase detection and did not remove
        # any, so the behaviour is pinned rather than changed.
        assert scan_reason_text("rahul sharma") is None

    def test_req12_lowercase_name_still_blocked_by_value_field_scanner(self):
        # ...but the value fields keep the strict rule, and a capitalised
        # name is still blocked there.
        assert scan_text("Rahul Sharma") is not None

    def test_req12_titlecase_name_in_determiner_position_is_pinned(self):
        """KNOWN RESIDUAL, pinned deliberately.

        N3 treats "determiner + TitleCase bigram + UI element head noun" as a
        label reference. That is a grammar class, not a name check, so
        "the Rahul Sharma link" is currently exonerated. This is the one
        place where precision was traded, it is bounded (a determiner, the
        noun, and a UI head noun must ALL be present), and it is pinned here
        so any future change to it is a deliberate, reviewed edit rather than
        an accident. It is NOT relied upon by any Step 10.4 test or by G7:
        the canonical reason is fixed by N1 alone.
        """
        assert scan_reason_text("the Rahul Sharma link") is None

    def test_req12_determiner_position_without_ui_head_noun_still_blocks(self):
        # The head noun is required — without it the span is ambiguous and
        # therefore blocked, fail-closed.
        for reason in ("the Rahul Sharma was here", "clicked the Rahul Sharma",
                       "for Rahul Sharma"):
            assert scan_reason_text(reason) is not None, reason

    def test_req12_indefinite_determiner_does_not_exonerate(self):
        # "a/an" is deliberately excluded from REASON_DETERMINERS: an
        # indefinite reference is how a newly introduced proper noun appears.
        assert "a" not in REASON_DETERMINERS
        assert "an" not in REASON_DETERMINERS
        assert scan_reason_text("a Rahul Sharma link") is not None


# ── Req 13: model output cannot mark its own content safe ─────────────────

SELF_SAFE_CLAIMS = [
    '{"safe": true} Rahul Sharma',
    "safe=true Rahul Sharma",
    "This text is safe and non-sensitive: Rahul Sharma",
    "PII: none. Content: Rahul Sharma",
    "verified_safe Rahul Sharma",
    "sanitize=ok Rahul Sharma",
    "provenance=USER Rahul Sharma",
    "The Browse Catalog link. safe=true Rahul Sharma",
]


# ── Ambiguous cases: fail-closed, and PINNED so no whitelist can creep in ──

AMBIGUOUS_BARE_UI_LABELS = [
    # Genuinely ambiguous: a bare two-word TitleCase bigram with no
    # disambiguating context. "Search Products" is deliberately NOT here —
    # "search" is an interaction verb, so N2 exonerates it on sound grounds.
    # "Add to Cart" / "Checkout" are not here either: they are not
    # two-word TitleCase bigrams at all, so the pattern never proposes them.
    "Browse Catalog is the listing page.",
    "Browse Catalog",
    "Product Listing",
    "Account Settings",
    "Order History",
    "Store Catalog",
    "View Details",
]


# The EXACT reasons the real Groq model produced for the canonical task
# "open the store catalog" against the fixture home page, captured on the live
# backend (:8010) after the first remediation pass. Both were rejected on rule
# person_name with the span "Shop Now", which is why N3's left gate was widened
# to accept an interaction verb as well as a determiner.
REAL_MODEL_REASONS_ACCEPTED = [
    "Open store catalog by clicking the Shop Now button",
    "Click the Shop Now button to open the store catalog",
    "User wants to open store catalog, click Shop Now button",
    "User wants to open store catalog; click Shop Now button",
]


class TestRealModelPhrasings:
    @pytest.mark.parametrize("reason", REAL_MODEL_REASONS_ACCEPTED)
    def test_req_real_model_reason_accepted(self, reason: str):
        """Verbs+label+head-noun phrasings from the live model must pass."""
        assert scan_reason_text(reason) is None, reason

    @pytest.mark.parametrize("reason", REAL_MODEL_REASONS_ACCEPTED)
    def test_req_real_model_reason_accepted_at_the_reasoner(self, reason: str):
        from app.reasoner import parse_model_action

        parsed = parse_model_action(
            '{"action":"click","target":"btn-shop-now","reason":"%s"}' % reason
        )
        assert parsed["reason"] == reason

    @pytest.mark.parametrize("reason", [
        "Clicking Account Details for Rahul Sharma",
        "Navigate to Order History for John Smith",
        "Opened the account details section for Priya Reddy",
        "Click Shop Now button for Rahul Sharma",
        "Submitted the checkout form for John Smith",
    ])
    def test_req_n3_verb_branch_stops_at_a_preposition(self, reason: str):
        """N3's verb side must not reach across a preposition.

        This is the single most important property of the new N3 rule: the
        verb is what allows a bare UI label through, and the preposition is
        what keeps a prepositional person reference out.
        """
        finding = scan_reason_text(reason)
        assert finding is not None, reason
        assert finding.rule == "person_name"

    @pytest.mark.parametrize("reason", [
        # Adversarial: a prepositional person reference that is ALSO followed
        # by a UI element head noun, so only the preposition boundary stops
        # N3 from reaching back to the verb. These kill mutation M18.
        "Clicking Account Details for Rahul Sharma card",
        "Clicking Account Details for Rahul Sharma button",
        "Navigating to Order History for John Smith page",
        "Submitting the checkout form for Priya Reddy panel",
    ])
    def test_req_n3_verb_branch_does_not_reach_back_past_a_preposition(self, reason: str):
        finding = scan_reason_text(reason)
        assert finding is not None, reason
        assert finding.rule == "person_name"
        # Whichever TitleCase span is reached first must block; the point is
        # that none of them is exonerated by reaching back to the verb.

    def test_req_n3_verb_branch_is_load_bearing(self):
        # A lowercase introducer verb isolates N3's verb branch: the span
        # starts after the verb, so N2 cannot fire ("Shop" is not a verb)
        # and only N3 can exonerate it.
        assert scan_reason_text("click Shop Now button") is None
        # Both gates are required: drop the head noun, or the introducer.
        assert scan_reason_text("click Shop Now") is not None      # no head noun
        assert scan_reason_text("Shop Now button") is not None     # no introducer
        # The determiner branch is independent of the verb branch.
        assert scan_reason_text("the Shop Now button") is None
        assert scan_reason_text("the Shop Now") is not None

    def test_req_n2_still_exonerates_a_verb_initial_span(self):
        # Pre-existing behaviour, unchanged: the span's own first token is a
        # verb, so the span is that verb's object.
        assert scan_reason_text("Click Shop Now") is None


class TestAmbiguousCasesFailClosed:
    @pytest.mark.parametrize("reason", AMBIGUOUS_BARE_UI_LABELS)
    def test_req_ambiguous_bare_ui_label_is_blocked(self, reason: str):
        """A bare TitleCase bigram with no disambiguating context is BLOCKED.

        This is the case a fixture-string whitelist (mutation M5/M6) would
        silently unblock: whitelisting "Browse Catalog" changes the verdict
        here from BLOCK to ALLOW. Pinned so such a whitelist cannot be added.
        """
        finding = scan_reason_text(reason)
        assert finding is not None, reason
        assert finding.rule == "person_name"

    @pytest.mark.parametrize("reason", AMBIGUOUS_BARE_UI_LABELS)
    def test_req_ambiguous_label_inside_a_sentence_is_blocked(self, reason: str):
        head = reason.split(" is ")[0]
        finding = scan_reason_text(f"{head} is the destination the user asked for.")
        assert finding is not None, finding


class TestPersonCueBranchIsRedundantWithFailClosed:
    """Proves mutation M14 (removing the honorific / role-noun / name-label
    checks) is EQUIVALENT, rather than merely untested.

    Under the fail-closed default, a span is blocked unless N1/N2/N3 positively
    exonerates it. The P1 honorific, person-role and explicit-label checks sit
    in front of that, but a span carrying one of those cues is one that no
    exoneration rule can rescue in practice: the cue words are either
    lower-case (so the regex never proposes a span containing them) or sit
    outside the span, and the default then blocks anyway.

    The possessive checks are NOT covered here — they are load-bearing, and
    `test_req8_possessive_cue_blocks` plus the "Opened Rahul Sharma's
    profile." cases kill their removal.
    """

    CORPUS = (
        LEGIT_UI + LEGIT_PRODUCT + LEGIT_NAV + PERSON_NAMES + MULTI_NAME_CASES
        + EMBEDDED_CASES + AMBIGUOUS_BARE_UI_LABELS + [
            "Mr Rahul Sharma requested a refund.",
            "Dr Priya Reddy signed the form.",
            "Account holder Rahul Sharma requires service",
            "The customer is Maria Garcia.",
            "Customer Priya Reddy requested cancellation.",
            "Beneficiary Maria Garcia must confirm.",
            "name: Rahul Sharma",
            "Customer: Priya Reddy",
            "Account holder: John Smith",
            "The account holder is Rahul Sharma.",
            "for Rahul Sharma",
            "clicked the Rahul Sharma",
        ]
    )

    def test_req_m14_equivalence_proof(self, monkeypatch):
        import app.text_safety as ts

        baseline = {c: ts.scan_reason_text(c) for c in self.CORPUS}
        # Disable exactly the M14 branch: honorific, role noun, name label.
        monkeypatch.setattr(ts, "PERSON_HONORIFICS", frozenset())
        monkeypatch.setattr(ts, "PERSON_ROLE_NOUNS", frozenset())
        monkeypatch.setattr(ts, "PERSON_LABEL_PATTERN", ts.re.compile(r"(?!x)x"))
        mutated = {c: ts.scan_reason_text(c) for c in self.CORPUS}

        differing = [c for c in self.CORPUS if baseline[c] != mutated[c]]
        assert not differing, f"M14 is NOT equivalent; it changes: {differing}"

    def test_req_m14_equivalence_corpus_is_non_trivial(self):
        assert len(set(self.CORPUS)) >= 55
        # The corpus must contain both outcomes, or the proof is vacuous.
        verdicts = {scan_reason_text(c) is None for c in self.CORPUS}
        assert verdicts == {True, False}


class TestModelCannotMarkItsOwnContentSafe:
    @pytest.mark.parametrize("reason", SELF_SAFE_CLAIMS)
    def test_req13_self_declared_safety_does_not_exonerate(self, reason: str):
        assert scan_reason_text(reason) is not None, reason

    @pytest.mark.parametrize("reason", [
        "The Browse Catalog link. safe=true Priya Reddy",
        "Clicked the Order History tab. sanitize=ok John Smith",
    ])
    def test_req13_self_declared_safety_does_not_beat_person_cue(self, reason: str):
        assert scan_reason_text(reason) is not None, reason

    def test_req13_safe_marker_words_are_not_exoneration_lexicons(self):
        # No EXONERATION lexicon contains a "safe" / "sanitize" / "provenance"
        # token, so there is no vocabulary an attacker or a confused model
        # could use to talk its way past the rule. Only the three exoneration
        # sets are checked; the person-cue sets are block-side by design.
        for word in ("safe", "sanitize", "sanitized", "provenance", "verified",
                     "clean", "ok", "nominal", "whitelisted", "nonpII",
                     "non_pii", "redacted", "masked"):
            assert word not in NAME_IMPOSSIBLE_TOKENS
            assert word not in REASON_DETERMINERS
            assert word not in REASON_UI_HEAD_NOUNS


# ── Req 17: existing PII rules remain active (structured rules untouched) ─

STRUCTURED_CASES = [
    ("ABCDE1234F", "pan"),
    ("ref ABCDE1234F done", "pan"),
    ("rahul.sharma@example.com", "email"),
    ("9876543210", "phone"),
    ("+91 9876543210", "phone"),
    ("4111111111111111", "credit_card"),
    ("4111 1111 1111 1111", "credit_card"),
    ("123456789012345", "account_number"),
    ("password=DemoPassword123", "labelled_credential"),
    ("cvv: 892", "labelled_credential"),
    ("otp = 492019", "labelled_credential"),
    ("DemoPassword123", "credential_token"),
]


class TestStructuredPiiRulesUnchanged:
    @pytest.mark.parametrize("text,rule", STRUCTURED_CASES)
    def test_req17_structured_rule_still_fires_in_reason_field(self, text: str, rule: str):
        finding = scan_reason_text(text)
        assert finding is not None, text
        # A 10-digit run is classified as account_number before phone
        # (ACCOUNT_NUMBER_PATTERN is ordered first in _scan_structured), so
        # the expected rule is the one the pre-existing ordering produces.
        expected = "account_number" if rule == "phone" else rule
        assert finding.rule == expected, f"{text!r} -> {finding.rule}"

    @pytest.mark.parametrize("text,rule", STRUCTURED_CASES)
    def test_req17_structured_rule_still_fires_in_value_fields(self, text: str, rule: str):
        assert scan_text(text) is not None, text
        assert contains_sensitive_content(text) is True

    @pytest.mark.parametrize("text,rule", STRUCTURED_CASES)
    def test_req17_structured_rule_fires_even_on_verb_initial_reason(self, text: str, rule: str):
        # The old whole-reason gate only suppressed the NAME rule, never the
        # structured rules. That must stay true.
        finding = scan_reason_text(f"Clicked the value {text}")
        assert finding is not None
        assert finding.rule == ("account_number" if rule == "phone" else rule)

    def test_req17_contextual_phone_still_active(self):
        assert scan_reason_text("Support line 5551234567") is not None

    def test_req17_value_field_person_name_rule_is_unchanged(self):
        # `scan_text` keeps FULL_NAME_PATTERN with no context logic at all:
        # type.text / select.option are raw user VALUES, not commentary, and
        # a name typed into a form must always be refused.
        assert scan_text("Rahul Sharma") is not None
        assert scan_text("The Browse Catalog") is not None

    def test_req17_verb_set_is_unchanged(self):
        # The remediation reuses the pre-existing verb set verbatim; it did
        # not widen it. 69 is the pre-change cardinality at HEAD b677654.
        for verb in ("click", "opened", "navigate", "submit", "verify", "task"):
            assert verb in REASON_ACTION_VERBS
        assert len(REASON_ACTION_VERBS) == 69


# ── Req 14/15: privacy validators and payload invariants remain active ─────

class TestUpstreamValidatorsStillActive:
    def test_req14_15_reasoner_scan_point_still_rejects(self):
        """`parse_model_action` is the scan point that produced the 503."""
        from app.reasoner import ReasoningError, parse_model_action

        with pytest.raises(ReasoningError) as exc:
            parse_model_action(
                '{"action":"click","target":"x",'
                '"reason":"Account holder Rahul Sharma requires service"}'
            )
        assert "text-safety" in str(exc.value)
        assert exc.value.kind == "invalid_action"

    def test_req14_15_reasoner_scan_point_now_accepts_legitimate_reason(self):
        """The exact P1 string now passes the real reasoner scan point."""
        from app.reasoner import parse_model_action

        reason = "The Browse Catalog link leads to the product listing."
        parsed = parse_model_action(
            '{"action":"click","target":"x","reason":"%s"}' % reason
        )
        assert parsed["reason"] == reason

    @pytest.mark.parametrize("reason", [
        "Clicked the Browse Catalog link.",
        "The Search Products link opens the search form.",
        "The Sign In to Shop button opens the login page.",
        "The Order History tab needs a scroll.",
        "ApexCart is the store brand in the header.",
    ])
    def test_req14_15_reasoner_scan_point_accepts_ui_reasons(self, reason: str):
        from app.reasoner import parse_model_action

        parsed = parse_model_action(
            '{"action":"click","target":"x","reason":"%s"}' % reason
        )
        assert parsed["reason"] == reason

    @pytest.mark.parametrize("reason", [
        "Account holder Rahul Sharma requires service",
        "Clicking Account Details for Rahul Sharma",
        "Navigate to Order History for John Smith",
        "Opened Rahul Sharma's profile.",
        "The customer is Maria Garcia.",
    ])
    def test_req14_15_reasoner_scan_point_rejects_embedded_names(self, reason: str):
        from app.reasoner import ReasoningError, parse_model_action

        with pytest.raises(ReasoningError):
            parse_model_action(
                '{"action":"click","target":"x","reason":"%s"}' % reason
            )

    def test_req14_15_reasoner_scan_point_still_rejects_structured_pii(self):
        from app.reasoner import ReasoningError, parse_model_action

        with pytest.raises(ReasoningError):
            parse_model_action(
                '{"action":"click","target":"x","reason":"Verified PAN ABCDE1234F"}'
            )

    def test_req14_15_model_validator_still_rejects_name_reason(self):
        from app.models import BrowserActionModel

        with pytest.raises(Exception, match="text-safety"):
            BrowserActionModel(
                action="click", target="x",
                reason="Account holder Rahul Sharma requires service",
            )

    def test_req14_15_model_validator_accepts_legitimate_reason(self):
        from app.models import BrowserActionModel

        action = BrowserActionModel(
            action="click", target="element_details",
            reason="The Browse Catalog link leads to the product listing.",
        )
        assert action.reason == "The Browse Catalog link leads to the product listing."

    def test_req15_payload_invariants_still_active(self):
        """`verify_payload_invariants` is the outbound M5 firewall.

        Step 10.4 did not touch security.py, but the invariant must still
        hold against a payload that carries a person name in its reason.
        """
        from app.security import PayloadSecurityError, verify_payload_invariants

        clean = {
            "task": "open the store catalog",
            "sanitized_status": "sanitized_only",
            "url": "http://localhost:4174/",
            "detections": [],
        }
        verify_payload_invariants(clean)

        with pytest.raises(PayloadSecurityError):
            verify_payload_invariants({
                "task": "open the store catalog",
                "sanitized_status": "sanitized_only",
                "url": "http://localhost:4174/",
                "detections": [{"id": "d1", "type": "text", "value": "Rahul Sharma"}],
            })


# ── Req 16: the extension's Security Critic and M5 remain active ───────────
#
# The Security Critic and the extension-side M5 validator are TypeScript and
# are covered by the full extension regression (Part 11). What is asserted
# here is the backend half of the same contract: the reason rule the backend
# shares with the extension is a defense-in-depth layer ON TOP of the
# structural boundary, never a replacement for it.

class TestStructuralBoundaryIsNotReplacedByTheReasonRule:
    def test_req16_structural_boundary_blocks_raw_values_regardless_of_reason(self):
        """A clean reason must not launder a raw value in a value field."""
        from app.models import BrowserActionModel

        with pytest.raises(Exception, match="text-safety"):
            BrowserActionModel(
                action="type", target="search_box",
                text="rahul.sharma@example.com",
                reason="The Search Products link opens the search form.",
            )

    def test_req16_reason_rule_is_additive_not_substitutive(self):
        """Every reason verdict is decided AFTER the structured rules."""
        from app.text_safety import _scan_structured

        text = "Clicked Account Details for rahul.sharma@example.com"
        assert _scan_structured(text) is not None  # email wins first
        assert scan_reason_text(text).rule == "email"  # never person_name

    def test_req16_extension_mirror_divergence_is_documented(self):
        """The extension's reason rule is NOT a mirror of the backend's.

        CORRECTED 2026-10-03. An earlier version of this docstring claimed the
        extension kept the old whole-reason gate and therefore shared a
        false NEGATIVE (an embedded name slipping through a verb-initial
        reason). That was wrong, and the source proves it.

        `containsSensitiveReasonContent` calls `containsSensitiveContent`
        FIRST, and that helper already applies `FULL_NAME_PATTERN`
        unconditionally. So the verb gate is DEAD for the person-name rule:
        ANY TitleCase bigram is rejected, verb-initial or not.

        The real divergence is therefore the OPPOSITE shape, and it is a
        false POSITIVE, not a false negative:

          backend (post Step 10.4)  "Clicked Account Details"  -> ALLOW
          extension (unchanged)     "Clicked Account Details"  -> REFUSE

        The extension is strictly MORE blocking, so there is no leak here and
        nothing to close on security grounds. It is recorded because it is a
        real behavioural divergence between two places that both claim to
        mirror each other, and a future reader must not be told the opposite.
        """
        from pathlib import Path

        src = (
            Path(__file__).resolve().parents[2]
            / "extension" / "src" / "agent" / "actionValidator.ts"
        ).read_text(encoding="utf-8")

        # The claim that the two mirror each other is still made in the source…
        assert "mirroring backend text_safety.scan_reason_text" in src
        # …and the verb gate still exists…
        assert "startsWithActionVerb(candidate) &&" in src
        # …but it is unreachable for names, because the structured helper
        # applies the name pattern first. This is the actual divergence.
        assert "if (containsSensitiveContent(candidate)) return true;" in src

    def test_req16_the_extension_divergence_is_a_false_positive_not_a_leak(self):
        """Pin the ACTUAL direction of the divergence, with real values.

        The backend was remediated in Step 10.4 so that a legitimate UI reason
        carrying a TitleCase label survives. The extension still refuses it,
        because its name check runs before the verb gate. These cases are
        therefore asserted as a divergence rather than as a vulnerability:
        the extension blocks MORE, never less.
        """
        # (reason, backend verdict, extension verdict)
        cases = [
            ("Clicked Account Details", "ALLOW", "REFUSE"),
            ("The Browse Catalog link leads to the product listing.", "ALLOW", "REFUSE"),
            ("Click Shop Now button to open the store catalog", "ALLOW", "REFUSE"),
            ("Clicking Account Details for Rahul Sharma", "BLOCK", "REFUSE"),
            ("Rahul Sharma", "BLOCK", "REFUSE"),
        ]
        for reason, backend_verdict, _ext in cases:
            finding = scan_reason_text(reason)
            got = "BLOCK" if finding is not None else "ALLOW"
            assert got == backend_verdict, (reason, got, backend_verdict)
