"""
PHASE 18.7 / A8 — PROVIDER RELIABILITY (backend half).

HTTP 200 is not a valid action. Before A8 the route silently REWROTE the
model's action — turning ``navigate`` into ``scroll``, inventing a missing
``direction``/``amount``, and deleting every field that did not fit — so a
malformed-but-200 response became a real browser action.

These tests pin the replacement: a strict applicability gate that REFUSES, and
exactly three meaning-preserving normalizations that are still permitted.
"""

import pytest

from app.models import BrowserActionModel
from app.reasoner import (
    ReasoningError,
    assert_model_action_applicable,
    normalize_model_action_shape,
)


def _refuses(raw) -> str:
    with pytest.raises(ReasoningError) as exc:
        assert_model_action_applicable(raw)
    return exc.value.kind


class TestTheObservedDefectClass:
    """Every unused field filled with the literal string "down"."""

    THE_DEFECT = {
        "action": "scroll",
        "amount": 500,
        "direction": "down",
        "option": "down",
        "reason": "more results",
        "target": "down",
        "text": "down",
        "url": "down",
    }

    def test_the_whole_payload_is_refused(self):
        assert _refuses(self.THE_DEFECT) == "model_contract"

    def test_each_inapplicable_field_alone_is_refused(self):
        for field in ("option", "target", "text", "url"):
            raw = {"action": "scroll", "amount": 500, "direction": "down", field: "down"}
            assert _refuses(raw) == "model_contract", field


class TestInapplicableAndMissingFields:
    def test_a_missing_required_field_is_refused(self):
        assert _refuses({"action": "scroll", "direction": "down"}) == "model_contract"
        assert _refuses({"action": "click"}) == "model_contract"
        assert _refuses({"action": "type", "target": "t"}) == "model_contract"
        assert _refuses({"action": "navigate"}) == "model_contract"
        assert _refuses({"action": "pressKey"}) == "model_contract"

    def test_an_empty_required_field_is_refused(self):
        assert _refuses({"action": "click", "target": "   "}) == "model_contract"

    def test_an_invalid_enum_is_refused_not_defaulted(self):
        assert _refuses({"action": "scroll", "direction": "sideways", "amount": 500}) == "model_contract"
        assert _refuses({"action": "scroll", "direction": None, "amount": 500}) == "model_contract"

    def test_a_wrong_field_type_is_refused(self):
        assert _refuses({"action": "scroll", "direction": "down", "amount": "500"}) == "model_contract"
        assert _refuses({"action": "scroll", "direction": "down", "amount": True}) == "model_contract"
        assert _refuses({"action": "type", "target": "t", "text": 42}) == "model_contract"

    def test_an_out_of_range_amount_is_refused_not_clamped(self):
        assert _refuses({"action": "scroll", "direction": "down", "amount": 999999}) == "model_contract"
        assert _refuses({"action": "scroll", "direction": "down", "amount": 0}) == "model_contract"

    def test_an_unknown_action_type_is_left_to_the_schema_model(self):
        # The 17.10 classification of an unknown enum as a genuine STRUCTURE
        # error is deliberate; the applicability gate must not shadow it.
        raw = {"action": "teleport", "target": "x"}
        assert_model_action_applicable(raw)
        with pytest.raises(Exception):
            BrowserActionModel.model_validate(raw)


class TestValidActionsPass:
    @pytest.mark.parametrize(
        "raw",
        [
            {"action": "click", "target": "el_1"},
            {"action": "scroll", "direction": "down", "amount": 500},
            {"action": "type", "target": "el_1", "text": "hello"},
            {"action": "select", "target": "el_1", "option": "red"},
            {"action": "navigate", "url": "https://example.com/a"},
            {"action": "pressKey", "key": "Enter"},
            {"action": "pressKey", "key": "Enter", "target": "el_1"},
        ],
    )
    def test_accepted(self, raw):
        assert_model_action_applicable(raw)

    def test_a_reason_is_always_allowed_and_changes_nothing(self):
        raw = {"action": "click", "target": "el_1", "reason": "because"}
        assert_model_action_applicable(raw)


class TestOnlyMeaningPreservingNormalizationsRemain:
    def test_enum_case_is_normalized(self):
        out = normalize_model_action_shape({"action": "scroll", "direction": " Down ", "amount": 500})
        assert out["direction"] == "down"

    def test_a_numeric_string_amount_is_normalized(self):
        out = normalize_model_action_shape({"action": "scroll", "direction": "down", "amount": " 500 "})
        assert out["amount"] == 500

    def test_the_presskey_alias_table_still_applies(self):
        out = normalize_model_action_shape({"action": "pressKey", "key": "enter"})
        assert out["key"] == "Enter"

    def test_normalization_invents_nothing_and_strips_nothing(self):
        raw = {"action": "scroll", "direction": "down", "amount": 500, "target": "down"}
        out = normalize_model_action_shape(raw)
        assert out["target"] == "down"
        assert out["action"] == "scroll"
        assert set(out) == set(raw)

    def test_the_action_type_is_never_rewritten(self):
        out = normalize_model_action_shape({"action": "navigate", "url": "down"})
        assert out["action"] == "navigate"
        assert out["url"] == "down"

    def test_a_missing_amount_is_not_invented(self):
        out = normalize_model_action_shape({"action": "scroll", "direction": "down"})
        assert "amount" not in out
        assert _refuses(out) == "model_contract"
