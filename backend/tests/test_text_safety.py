"""
PrivAgent Backend Tests — Text Safety Scanner (M7 hardening, Phase 2).

The backend never trusts the extension or the LLM: model-emitted free text
(type.text, select.option, reason) is scanned for sensitive content BEFORE it
can execute in the browser or enter action history / the next LLM prompt.

Golden cases mirror the extension-side heuristic suite in
tests/llmPrivacy.test.ts (kept in sync deliberately).
"""
from __future__ import annotations

import pytest

from app.text_safety import contains_sensitive_content, scan_reason_text, scan_text


class TestStructuredPatterns:
    """Structural PII patterns — identical for text, option, and reason."""

    @pytest.mark.parametrize("sensitive", [
        "ABCDE1234F",                       # project synthetic PAN fixture
        "ref ABCDE1234F done",              # PAN embedded in a sentence
        "rahul.sharma@example.com",         # email
        "9876543210",                       # Indian phone
        "+91 9876543210",                   # phone with country code
        "4111111111111111",                 # Luhn-valid card
        "4111 1111 1111 1111",              # spaced Luhn-valid card
        "123456789012345",                  # 15-digit account-number run
        "password=DemoPassword123",         # labeled credential
        "cvv: 892",                         # labeled CVV
        "otp = 492019",                     # labeled OTP
        "DemoPassword123",                  # credential-shaped token
    ])
    def test_scan_text_blocks_sensitive(self, sensitive: str):
        assert scan_text(sensitive) is not None
        assert contains_sensitive_content(sensitive) is True

    @pytest.mark.parametrize("benign", [
        "Gujarat",                          # single capitalized word
        "Gmail POP3 settings",              # acronym prose
        "Amount 500",                       # short number
        "transactions",                     # single word
        "Savings",                          # select-style option
        "",                                 # empty
    ])
    def test_scan_text_allows_benign(self, benign: str):
        assert scan_text(benign) is None


class TestReasonScanning:
    """Reason-specific rules: structural patterns always apply; the
    person-name rule is context-aware so benign UI reasons survive."""

    @pytest.mark.parametrize("leak", [
        "Account holder Rahul Sharma",      # name echo (short, verb-free)
        "Rahul Sharma",                     # bare name
        "rahul.sharma@example.com is registered",   # email in reason
        "contact 9876543210 for help",      # phone in reason
        "PAN is ABCDE1234F",                # PAN in reason
        "card 4111111111111111 charged",    # card in reason
        "password=hunter2 entered",         # labeled credential in reason
    ])
    def test_reason_blocks_sensitive(self, leak: str):
        assert scan_reason_text(leak) is not None

    @pytest.mark.parametrize("benign", [
        "Clicked Account Details",          # required benign reason
        "Scrolled to transactions",
        "Opened the account details section.",
        "The requested transaction section is not currently visible.",
        "Target located in current viewport",
        "Task completed successfully",
    ])
    def test_reason_allows_benign_ui_phrases(self, benign: str):
        assert scan_reason_text(benign) is None

    def test_long_verb_free_prose_is_not_name_flagged(self):
        # Documented tradeoff: the name rule only fires on short reasons.
        long_prose = (
            "The portfolio summary view contains several widgets and the "
            "monthly statement download control sits below the fold."
        )
        assert scan_reason_text(long_prose) is None


class TestBrowserActionModelValueScanning:
    """Integration: BrowserActionModel rejects sensitive free text."""

    def _make(self):
        from app.models import BrowserActionModel
        return BrowserActionModel

    def test_type_text_with_pii_rejected(self):
        with pytest.raises(Exception, match="text-safety"):
            self._make()(action="type", target="x", text="rahul.sharma@example.com")

    def test_select_option_with_pii_rejected(self):
        with pytest.raises(Exception, match="text-safety"):
            self._make()(action="select", target="x", option="Rahul Sharma")

    def test_reason_with_pii_rejected(self):
        with pytest.raises(Exception, match="text-safety"):
            self._make()(
                action="click", target="x",
                reason="Account holder Rahul Sharma requires service",
            )

    def test_pan_fixture_reason_rejected(self):
        with pytest.raises(Exception, match="text-safety"):
            self._make()(action="click", target="x", reason="Verify PAN ABCDE1234F")

    def test_benign_reason_accepted(self):
        action = self._make()(
            action="click", target="element_details",
            reason="Clicked Account Details",
        )
        assert action.reason == "Clicked Account Details"

    def test_structural_metadata_is_not_value_scanned(self):
        # IDs and amounts must not trip the free-text scanner.
        action = self._make()(action="scroll", direction="down", amount=500)
        assert action.amount == 500
