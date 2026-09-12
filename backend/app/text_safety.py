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
# Details". Reasons therefore use a narrower name rule: only short,
# verb-free reasons that contain a TitleCase name bigram are flagged.

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

# A TitleCase bigram anywhere in a verb-free reason (person-name-shaped).
# Reasons that START with a common action verb are exempt (see below).
REASON_NAME_PATTERN = re.compile(r"\b[A-Z][a-z]+\s+[A-Z][a-z]+\b")


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


def scan_reason_text(candidate: str) -> Optional[TextSafetyFinding]:
    """Scan model-emitted `reason` text.

    Same structural patterns as scan_text. The person-name rule applies to
    reasons that do NOT start with a common action verb: benign UI reasons
    conventionally begin with a verb ("Clicked Account Details", "Scrolled
    to transactions") and stay exempt, while name echoes like "Account
    holder Rahul Sharma requires service" are caught regardless of length.

    Documented tradeoff (heuristic, privacy-first): a verb-free reason that
    merely mentions a TitleCase UI label (e.g. "The Account Details section
    requires scrolling") is over-blocked — the same tradeoff the extension
    applies to type.text / select.option. Privacy wins over convenience.
    """
    if not candidate:
        return None

    finding = _scan_structured(candidate)
    if finding:
        return finding

    if not _starts_with_action_verb(candidate):
        m = REASON_NAME_PATTERN.search(candidate)
        if m:
            return TextSafetyFinding(rule="person_name", snippet=m.group(0))

    return None


def contains_sensitive_content(candidate: str) -> bool:
    """Boolean convenience wrapper for model validators."""
    return scan_text(candidate) is not None
