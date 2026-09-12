"""
PrivAgent Backend Tests — Milestone 7 Action Validation (defense-in-depth).

The extension-side M5 validator remains the authoritative gate, but the backend
must reject structurally inappropriate actions one boundary earlier.

Covers BrowserActionModel hardening:
  - Field applicability per action type (click with text, scroll with url, ...)
  - Required fields per action type
  - Bounded scroll amount and direction
  - URL protocol safety (no javascript:, data:, etc.)
  - Script-injection syntax rejection in type text
  - Cross-boundary forbidden-key rejection for outbound actions
"""
import pytest
from pydantic import ValidationError

from app.models import BrowserActionModel, BrowserActionType


class TestActionShapeValidation:
    def test_valid_click(self):
        action = BrowserActionModel(action="click", target="det_acc_1")
        assert action.action is BrowserActionType.click

    def test_click_with_text_field_rejected(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="click", target="x", text="something")

    def test_scroll_with_url_field_rejected(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(
                action="scroll", direction="down", amount=500,
                url="https://example.com",
            )

    def test_click_missing_target_rejected(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="click")

    def test_scroll_missing_amount_rejected(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="scroll", direction="down")

    def test_type_requires_target_and_text(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="type", target="x")
        with pytest.raises(ValidationError):
            BrowserActionModel(action="type", text="hello")
        ok = BrowserActionModel(action="type", target="x", text="hello")
        assert ok.text == "hello"

    def test_select_requires_target_and_option(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="select", target="x")
        ok = BrowserActionModel(action="select", target="x", option="savings")
        assert ok.option == "savings"

    def test_unknown_field_rejected(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="click", target="x", eval="alert(1)")

    def test_navigate_rejects_javascript_url(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="navigate", url="javascript:alert(1)")

    def test_navigate_rejects_data_url(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="navigate", url="data:text/html,hello")

    def test_navigate_accepts_https(self):
        ok = BrowserActionModel(action="navigate", url="https://example.com/page")
        assert ok.url == "https://example.com/page"

    def test_scroll_direction_restricted(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="scroll", direction="sideways", amount=100)

    def test_scroll_amount_bounded(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="scroll", direction="down", amount=0)
        with pytest.raises(ValidationError):
            BrowserActionModel(action="scroll", direction="down", amount=99999)
        ok = BrowserActionModel(action="scroll", direction="down", amount=5000)
        assert ok.amount == 5000

    def test_type_text_rejects_script_injection(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="type", target="x", text="<script>alert(1)</script>")
        with pytest.raises(ValidationError):
            BrowserActionModel(action="type", target="x", text="javascript:void(0)")

    def test_empty_target_rejected(self):
        with pytest.raises(ValidationError):
            BrowserActionModel(action="click", target="   ")
