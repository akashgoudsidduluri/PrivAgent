"""
PrivAgent Backend — Text Safety Scanner (Milestone 7, Phase 2).

Server-side, INDEPENDENT mirror of the extension's free-text PII heuristics.
The backend never trusts the extension (or the LLM): any model-emitted free
text (`type.text`, `select.option`, `reason`) is scanned for sensitive content
BEFORE it can (a) execute in the browser or (b) enter action history and
re-enter an LLM prompt on a subsequent step.

This is a heuristic leakage damper (defense-in-depth), NOT a security
guarantee. The primary boundary remains structural: raw sensitive values never
enter the pipeline at all (M4 allowlist + forbidden-key scanning). These
patterns catch an untrusted LLM attempting to smuggle values through free-text
fields. Deliberately privacy-first: over-blocking benign text costs less than
leaking PII.

Rule set mirrors extension/src/agent/actionValidator.ts (kept in sync by the
golden tests in both suites).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

EMAIL_PATTERN = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}", re.IGNORECASE)

# Indian mobile numbers, boundary/separator-context anchored to avoid amounts.
INDIAN_PHONE_PATTERN = re.compile(r"(?:^|[\s(-])(\+?91[-\s]?)?[6-9]\d{9}(?=$|[\s).,])")

# Contextual phone detection (M8 phone-gap remediation).
#
# INDIAN_PHONE_PATTERN only matches a bare 10-digit run beginning with [6-9] or
# one carrying separators, so "Support line 5551234567" matched nothing. The
# leading-digit restriction is deliberate (Indian mobile numbering plan) and is
# NOT relaxed. Instead a bare 10-digit run is accepted only when all three gates
# hold, mirroring extension/src/privacy/patterns.ts:hasContextualPhone:
#   shape   exactly 10 digits, not adjacent to another digit or a dash
#   context a phone-intent word within 48 chars either side
#   guard   an explicit non-phone identifier label before the run wins
# A bare 10-digit number is far more often an order/invoice/tracking/reference
# number, so a bare "\d{10}" rule is deliberately NOT used.
PHONE_INTENT_WORD = re.compile(
    r"\b(?:phone|telephone|tel|mobile|cellphone|contact(?:\s+number|\s+no)?|"
    r"support(?:\s+line)?|line|hotline|helpline|call(?:\s+us)?|dial|"
    r"reach(?:\s+us)?|ring|sms|whatsapp|enquir(?:y|ies)|inquir(?:y|ies))\b",
    re.IGNORECASE,
)
NON_PHONE_LABEL_WORD = re.compile(
    r"\b(?:id|ids|identifier|no|nos|num|code|zip|zipcode|postal|pin|invoice|inv|"
    r"order|ord|tracking|track|reference|ref|acct|account|serial|ser|timestamp|"
    r"time|epoch|sku|ean|isbn|upc|ssn|pan|aadhar|aadhaar|uid|utr|neft|ifsc|hash|"
    r"uuid|guid|token|otp|mmid|trans|transaction|txn|doc|document|policy|passport|"
    r"license|licence|lic|permit|reg|registration)\b",
    re.IGNORECASE,
)
PHONE_CONTEXT_WINDOW_CHARS = 48
_BARE_TEN_DIGIT = re.compile(r"(?<![\d-])(\d{10})(?![\d-])")
_TRAILING_LABEL = re.compile(r"([A-Za-z][A-Za-z\s._-]{0,24})\s*[:=#-]?\s*$")


def _has_contextual_phone(candidate: str) -> bool:
    """True when a bare 10-digit run is introduced as a phone number."""
    if not candidate or not any(ch.isdigit() for ch in candidate):
        return False
    for m in _BARE_TEN_DIGIT.finditer(candidate):
        at = m.start()
        before = candidate[max(0, at - PHONE_CONTEXT_WINDOW_CHARS):at]
        after = candidate[at + 10:at + 10 + PHONE_CONTEXT_WINDOW_CHARS]
        if not PHONE_INTENT_WORD.search(before) and not PHONE_INTENT_WORD.search(after):
            continue
        label_match = _TRAILING_LABEL.search(before)
        if label_match and NON_PHONE_LABEL_WORD.search(label_match.group(1)):
            continue
        return True
    return False

# PAN: privacy-first over-approximation — 4th char accepts any letter so the
# project's own synthetic fixture 'ABCDE1234F' is caught (audit HIGH-1).
PAN_PATTERN = re.compile(r"\b[A-Z]{3}[A-Z][A-Z]\d{4}[A-Z]\b")

# Labeled credentials: "password: x", "cvv = 123", "pin-1234", etc.
LABELLED_CREDENTIAL_PATTERN = re.compile(r"(?:password|passcode|cvv|otp|pin)\s*[:=]\s*\S+", re.IGNORECASE)

# Full person names: two consecutive capitalized words (privacy-first).
FULL_NAME_PATTERN = re.compile(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\b")

# Credential-shaped tokens: single 8+ char token mixing upper, lower, digit.
CREDENTIAL_TOKEN_PATTERN = re.compile(r"\b(?=[^\s]*[A-Z])(?=[^\s]*[a-z])(?=[^\s]*\d)[^\s]{8,}\b")

# Structured account numbers: 9+ digit runs (pure digit strings).
ACCOUNT_NUMBER_PATTERN = re.compile(r"\b\d{9,}\b")

# ── Reason-field scanning (M7 hardening, Phase 2) ──────────────────────────
#
# `reason` is model-emitted free text that re-enters action history and the
# next LLM prompt. It must be scanned, but the generic full-name heuristic
# would false-positive on legitimate UI reasons like "Clicked Account
# Details".
#
# STEP 10.4 (P1 remediation). The previous rule gated the person-name check
# on ONE property of the whole reason: did it begin with a common action verb?
# That gate was both too blunt and unsafe:
#
#   * FALSE POSITIVE (the P1). REASON_NAME_PATTERN has no notion of what a
#     name token is. On "The Browse Catalog link leads to the product
#     listing." it matches the span "The Browse" — the English determiner
#     "The" paired with the verb "Browse" as if they were a first name and a
#     surname. The only reason this was ever allowed through was that "The"
#     happens not to be in REASON_ACTION_VERBS. Rephrasing the same sentence
#     to start with a listed verb ("Search Products returns a search form.")
#     passed, so the verdict depended on the sentence's first word rather
#     than on the matched span.
#
#   * FALSE NEGATIVE (a live PII leak, found during the 10.4 audit). The
#     verb-prefix gate exempted the ENTIRE reason, not just the opening. A
#     reason beginning with a verb could carry a real person name anywhere in
#     its body: "Clicking Account Details for Rahul Sharma" was ALLOWED. The
#     old docstring's claim that name echoes "are caught regardless of length"
#     was false — they were caught only when the reason did not begin with a
#     verb.
#
# The rule is now evaluated PER SPAN, with the same fail-closed default and
# the same (unchanged) REASON_NAME_PATTERN. A span is only exonerated when it
# carries positive structural evidence that it is not a person name:
#
#   N1  one of the two tokens is a closed-class English function word. No
#       person name contains "The", "In", "Of", "Is" or "And", so a bigram
#       built from one cannot be a name. This is the fix for the P1.
#   N2  the span's own first token is an interaction verb, i.e. the span is
#       the object of an action. This is a strict SUBSET of the old
#       whole-reason exemption ("clicked Account Details" is a span-initial
#       verb, therefore also reason-initial), so it grants nothing the old
#       rule did not already grant, while no longer exempting the rest of the
#       sentence.
#   N3  the span is introduced either by a determiner or by an interaction
#       verb, AND is immediately followed by a UI element head noun. This
#       covers both "the Browse Catalog link" and the far more common
#       "click Shop Now button" (the exact phrasing the real model produced
#       for the canonical task). This is a grammar class, not a content
#       allowlist: it contains no product, brand or site vocabulary, and it
#       cannot exonerate a bare bigram. N3 is required to avoid trading the
#       determiner false positive for a new one.
#
# The verb side of N3 deliberately stops at a preposition. In "Clicking
# Account Details for Rahul Sharma" the span "Rahul Sharma" is introduced by
# "for", not by the verb, so N3 does not fire and the name is blocked. That
# preposition boundary is exactly what the old whole-reason gate was missing.
#
# P1 (person cues) is checked FIRST and overrides every exoneration:
# possessive, honorific, a preceding person-role noun, or a "name:"-style
# label makes the span a person name regardless of its surroundings.
#
# Anything not positively exonerated stays BLOCKED. Precision, not coverage,
# is the goal: fewer false positives at equal or stronger true-positive
# protection.

# Common action verbs that start benign UI reasons. If a reason starts with
# one of these, the person-name rule is skipped.
REASON_ACTION_VERBS = frozenset({
    "click", "clicked", "clicking", "scroll", "scrolled", "scrolling",
    "type", "typed", "typing", "select", "selected", "selecting",
    "navigate", "navigated", "navigating", "open", "opened", "opening",
    "close", "closed", "closing", "submit", "submitted", "submitting",
    "fill", "filled", "filling", "enter", "entered", "entering",
    "find", "finding", "found", "locate", "locating", "located",
    "reveal", "revealing", "search", "searching", "wait", "waiting",
    "retry", "retrying", "retried", "proceed", "proceeding", "proceeded",
    "skip", "skipping", "skipped", "stop", "stopped", "stopping",
    "reveal", "target", "targeting", "focus", "focusing", "complete",
    "completed", "completing", "finish", "finished", "verify", "verified",
    "verifying", "task", "step", "action",
})

# A TitleCase bigram anywhere in a reason (person-name-shaped). Unchanged by
# Step 10.4: the pattern still proposes every candidate span, and the
# per-span classifier above decides which proposals are real names. Matches
# are consumed left-to-right and NON-OVERLAPPING, exactly as before — that
# consumption is load-bearing, because it is what keeps "The Browse Catalog"
# from ever being re-proposed as the pair ("Browse", "Catalog").
REASON_NAME_PATTERN = re.compile(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\b")

# N1 — closed-class English tokens that can never be a person-name token.
# Deliberately restricted to genuine function words. Name particles ("de",
# "van", "von", "bin", "al") are NOT listed, because they do appear in real
# surnames ("Maria de Garcia"). N1 only ever EXONERATES a span, and only when
# one of its two tokens is present, so an unlucky inclusion here could at
# worst excuse a bigram that also satisfies N3's strict double gate.
NAME_IMPOSSIBLE_TOKENS = frozenset({
    # articles and demonstratives
    "a", "an", "the", "this", "that", "these", "those",
    # conjunctions and subordinators
    "and", "or", "but", "nor", "so", "yet", "because", "although", "though",
    "while", "when", "if", "as", "than",
    # prepositions
    "of", "in", "on", "at", "to", "for", "from", "with", "by", "into",
    "onto", "about", "after", "before", "during", "over", "under",
    "between", "through", "within", "without", "across", "per", "via",
    # pronouns and copula
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "them",
    "us", "is", "are", "was", "were", "be", "been", "being", "there", "here",
})

# N3 — determiners that place a noun phrase in a definite/known position.
# Indefinite "a"/"an" is excluded on purpose: an indefinite reference is
# exactly how a newly introduced proper noun is introduced.
REASON_DETERMINERS = frozenset({
    "the", "this", "that", "its", "their", "our", "your", "his",
    "each", "every", "another", "other", "next", "previous", "main", "top",
    "first", "last", "left", "right", "upper", "lower", "inner", "outer",
})

# N3 — UI element head nouns. A structural grammar class, deliberately free
# of product, brand, site or catalogue vocabulary. A bigram is only exonerated
# when it is in determiner position AND is directly followed by one of these.
REASON_UI_HEAD_NOUNS = frozenset({
    "link", "links", "button", "buttons", "menu", "menus", "tab", "tabs",
    "panel", "panels", "section", "sections", "page", "pages", "card",
    "cards", "tile", "tiles", "dropdown", "dialog", "modal", "toolbar",
    "sidebar", "breadcrumb", "field", "fields", "option", "options", "item",
    "items", "entry", "nav", "navbar", "header", "footer", "icon", "icons",
    "widget", "widgets", "control", "controls", "checkbox", "radio",
    "toggle", "switch",
})

# P1 — person cues. Checked first; they override every exoneration rule.
PERSON_HONORIFICS = frozenset({
    "mr", "mrs", "ms", "miss", "dr", "prof", "sir", "madam", "shri", "smt",
    "mx",
})

PERSON_ROLE_NOUNS = frozenset({
    "holder", "holders", "owner", "owners", "customer", "customers", "client",
    "clients", "user", "users", "member", "members", "patient", "patients",
    "subscriber", "subscribers", "employee", "employees", "manager",
    "managers", "recipient", "recipients", "sender", "senders", "payer",
    "payee", "beneficiary", "beneficiaries", "applicant", "applicants",
    "claimant", "claimants", "nominee", "guardian", "guardians", "dependent",
    "dependents", "doctor", "representative", "representatives", "resident",
    "residents", "guest", "guests", "taxpayer", "staff", "person", "persons",
    "name", "names", "addressee", "spouse", "parent", "guardian",
})

PERSON_LABEL_PATTERN = re.compile(
    r"\b(?:name|names|customer|holder|owner|payee|beneficiary|recipient|"
    r"applicant|claimant|guardian|nominee)\s*[:=]",
    re.IGNORECASE,
)

_WORD_TOKEN = re.compile(r"[A-Za-z]+")
PERSON_CUE_LOOKBEHIND_TOKENS = 3

# P1 (possessive). Two forms are checked:
#   * a possessive attached directly to the span ("Rahul Sharma's order")
#   * a possessive attached to a capitalized token that FOLLOWS the span.
# The second form exists because the non-overlapping scan consumes the
# leftmost pair: on "Opened Rahul Sharma's profile." the proposed span is
# "Opened Rahul", so the possessive on "Sharma" is two tokens away and would
# otherwise never be seen. A capitalized token carrying a possessive is
# strong person evidence regardless of where the span boundary fell.
# Cost: "The Product Listing's items" is now also blocked. That is the
# contract's stated privacy-first trade — over-blocking benign prose costs
# less than leaking a name — and it only adds blocking, never removes it.
POSSESSIVE_SUFFIX_PATTERN = re.compile(r"^\s*[A-Z][a-z]+['\u2019]s\b")
_POSSESSIVE_TAIL = ("'s", "\u2019s", "'S", "\u2019S")


@dataclass(frozen=True)
class TextSafetyFinding:
    rule: str
    snippet: str


def _luhn_valid(digits: str) -> bool:
    total = 0
    reverse = digits[::-1]
    for i, ch in enumerate(reverse):
        digit = ord(ch) - 48
        if i % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0


def _scan_structured(candidate: str) -> Optional[TextSafetyFinding]:
    """High-precision structured PII/credential patterns (shared by all fields)."""
    # Luhn-validated credit card candidate (13–19 digits, optional separators)
    collapsed = re.sub(r"[-\s]", "", candidate)
    for run in re.findall(r"\d{13,19}", collapsed):
        if _luhn_valid(run):
            return TextSafetyFinding(rule="credit_card", snippet=run[:6] + "…")

    m = LABELLED_CREDENTIAL_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="labelled_credential", snippet=m.group(0)[:24] + "…")

    m = PAN_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="pan", snippet=m.group(0))

    m = ACCOUNT_NUMBER_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="account_number", snippet=m.group(0)[:4] + "…")

    m = EMAIL_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="email", snippet=m.group(0))

    m = INDIAN_PHONE_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="phone", snippet=m.group(0)[:6] + "…")

    if _has_contextual_phone(candidate):
        return TextSafetyFinding(rule="phone", snippet="contextual…")

    m = CREDENTIAL_TOKEN_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="credential_token", snippet=m.group(0)[:6] + "…")

    return None


def scan_text(candidate: str) -> Optional[TextSafetyFinding]:
    """Scan free text for PII/credential-shaped content.

    Returns the first matching finding, or None when the text is considered
    safe. Mirrors the extension-side containsSensitiveContent() ordering.
    Used for `type.text` and `select.option`.
    """
    if not candidate:
        return None

    finding = _scan_structured(candidate)
    if finding:
        return finding

    m = FULL_NAME_PATTERN.search(candidate)
    if m:
        return TextSafetyFinding(rule="person_name", snippet=m.group(0))

    return None


def _starts_with_action_verb(reason: str) -> bool:
    first_word = re.split(r"\s+", reason.strip().lower(), maxsplit=1)[0] if reason.strip() else ""
    return first_word.rstrip(".,;:!") in REASON_ACTION_VERBS


def _tokens_before(candidate: str, start: int) -> list[str]:
    """Lowercased word tokens immediately preceding `start` (nearest last)."""
    return [t.lower() for t in _WORD_TOKEN.findall(candidate[:start])]


def _next_token(candidate: str, end: int) -> str:
    """Lowercased word token immediately following `end`, or ""."""
    m = _WORD_TOKEN.search(candidate, end)
    return m.group(0).lower() if m else ""


def _has_person_cue(candidate: str, match: re.Match[str]) -> bool:
    """True when the span is used as a person reference (P1).

    P1 is checked before any exoneration rule, so a bigram is treated as a
    name whenever it carries possessive, honorific, person-role or explicit
    name-label context, however benign the surrounding grammar looks.
    """
    span = match.group(0)

    # Possessive directly attached to the span: "Rahul Sharma's order",
    # including the typographic apostrophe.
    after = candidate[match.end():]
    if after[:2] in _POSSESSIVE_TAIL:
        return True

    # Possessive on a capitalized token following the span, e.g. the span
    # "Opened Rahul" in "Opened Rahul Sharma's profile."
    if POSSESSIVE_SUFFIX_PATTERN.match(after):
        return True

    before = _tokens_before(candidate, match.start())
    if before:
        if before[-1] in PERSON_HONORIFICS:
            return True
        window = set(before[-PERSON_CUE_LOOKBEHIND_TOKENS:])
        if window & PERSON_ROLE_NOUNS:
            return True

    return bool(PERSON_LABEL_PATTERN.search(candidate[:match.start()].rstrip() + " "))


def _is_ui_label_span(candidate: str, match: re.Match[str]) -> bool:
    """True when the span is positively evidenced as NOT a person name.

    Returns True only on N1 / N2 / N3. Anything not positively exonerated is
    reported as a person name by the caller (fail-closed).
    """
    span = match.group(0)
    tokens = [t.lower() for t in _WORD_TOKEN.findall(span)]

    # N1 — a closed-class function word cannot be a name token.
    if any(t in NAME_IMPOSSIBLE_TOKENS for t in tokens):
        return True

    # N2 — the span is the object of an interaction ("Clicked Account
    # Details"). Uses the pre-existing, unchanged verb set.
    if _starts_with_action_verb(span):
        return True

    # N3 — introduced by a determiner OR by an interaction verb, and
    # immediately followed by a UI element head noun ("the Browse Catalog
    # link", "click Shop Now button"). Double-gated on both sides, and the
    # introducing token must not be a preposition.
    if tokens_before_span := _tokens_before(candidate, match.start()):
        introducer = tokens_before_span[-1]
        introduced_by = introducer in REASON_DETERMINERS or introducer in REASON_ACTION_VERBS
        if introduced_by and _next_token(candidate, match.end()) in REASON_UI_HEAD_NOUNS:
            return True

    return False


def scan_reason_text(candidate: str) -> Optional[TextSafetyFinding]:
    """Scan model-emitted `reason` text.

    Same structured patterns as scan_text, in the same order. The
    person-name rule is evaluated per candidate span (see the block comment
    above REASON_NAME_PATTERN for the Step 10.4 rationale): a span is
    exonerated only by positive structural evidence that it is a UI/label
    mention, and person cues override every exoneration.

    The whole-reason "starts with an action verb" gate is GONE. It exempted
    the entire reason, which let a real name through anywhere in a
    verb-initial reason ("Clicking Account Details for Rahul Sharma"), and it
    judged the sentence's first word rather than the matched span, which is
    why "The Browse Catalog link ..." was rejected while the semantically
    identical "Search Products returns a search form." was not.

    Documented residual tradeoff (heuristic, privacy-first): a bare TitleCase
    bigram with no disambiguating context ("Browse Catalog is the listing
    page.") is still over-blocked, as is a determinate UI noun phrase whose
    head noun is outside REASON_UI_HEAD_NOUNS. Privacy wins over convenience.
    """
    if not candidate:
        return None

    finding = _scan_structured(candidate)
    if finding:
        return finding

    for m in REASON_NAME_PATTERN.finditer(candidate):
        if _has_person_cue(candidate, m):
            return TextSafetyFinding(rule="person_name", snippet=m.group(0))
        if not _is_ui_label_span(candidate, m):
            return TextSafetyFinding(rule="person_name", snippet=m.group(0))

    return None


def contains_sensitive_content(candidate: str) -> bool:
    """Boolean convenience wrapper for model validators."""
    return scan_text(candidate) is not None
